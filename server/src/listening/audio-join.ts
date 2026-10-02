import { spawn } from 'node:child_process';

const sampleRate = 16_000;
const maxPcmBytes = sampleRate * 2 * 302;

/** Decode untrusted media through stdin, with no file or network protocols available. */
async function decode(audio: Buffer, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // The seek cache supports M4A files with trailing metadata. FFmpeg unlinks its
    // temporary cache automatically; neither paths nor network URLs are accepted.
    const process = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'cache,pipe',
      '-read_ahead_limit', '-1', '-i', 'cache:pipe:0', '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'ignore'], signal });
    let length = 0, oversized = false;
    const chunks: Buffer[] = [];
    process.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxPcmBytes) { oversized = true; process.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    process.on('error', reject);
    process.stdin.on('error', () => { /* The exit code reports invalid input. */ });
    process.on('close', code => {
      if (code !== 0 || oversized || !length || length % 2) reject(new Error('echo_audio_decode_failed'));
      else resolve(Buffer.concat(chunks));
    });
    process.stdin.end(audio);
  });
}

/** One continuous media timeline gives the diarizer a shared speaker namespace for the batch. */
export async function joinAudio(items: Array<{ audio: Buffer }>, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  for (const item of items) {
    const pcm = await decode(item.audio, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
    bytes += pcm.length;
    if (bytes > maxPcmBytes) throw new Error('echo_audio_too_long');
    chunks.push(pcm);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + bytes, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes, 40);
  return Buffer.concat([header, ...chunks]);
}
