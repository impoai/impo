import { ServiceError } from '../errors.js';
import { TranscriptionError } from '../listening/transcriber.js';

/** Hold-to-talk clips are short; the client caps a hold at two minutes of low-bitrate AAC. */
export const maxDictationBytes = 2 * 1024 * 1024;
export const dictationMimeTypes = ['audio/mp4', 'audio/m4a', 'audio/aac', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/flac'] as const;

/** Composer speech to text. Returns an empty string when the clip holds no speech. */
export interface Dictation {
  readonly model: string;
  transcribe(audio: Buffer, mimeType: string, signal: AbortSignal): Promise<string>;
}

/**
 * Gemini Transcribe with inline audio: one request, no Files API round trips, and nothing
 * is stored (`store: false`). The default cleaned-up mode drops fillers, which suits a message.
 */
export class GeminiDictation implements Dictation {
  readonly model: string;
  constructor(private readonly options: { apiKey: string; baseURL: string; model: string; timeoutMs: number }) { this.model = options.model; }

  async transcribe(audio: Buffer, mimeType: string, signal: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseURL}/v1beta/interactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.options.apiKey },
        body: JSON.stringify({ model: this.model, store: false, input: [{ type: 'audio', data: audio.toString('base64'), mime_type: mimeType }] }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new TranscriptionError('Transcription service is unreachable', true, 'provider_unreachable');
    }
    // Never include the response body: it can echo request content.
    if (!response.ok) throw new TranscriptionError(`Transcription service returned ${response.status}`, response.status === 429 || response.status >= 500, `provider_http_${response.status}`);
    const body = await response.json() as { status?: string; steps?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    if (body.status !== 'completed') throw new TranscriptionError('Transcription did not complete', true, 'interaction_incomplete');
    // A completed interaction with no steps is Gemini's valid silence result.
    return (body.steps ?? []).flatMap(step => step.content ?? [])
      .filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text!).join(' ').trim();
  }
}

/** Local development without a Gemini key: deterministic text, no audio leaves the machine. */
export class DevelopmentDictation implements Dictation {
  readonly model = 'development';
  async transcribe(audio: Buffer): Promise<string> { return `Development transcript for ${audio.length} bytes of audio.`; }
}

/** Decode and bound a base64 clip from a JSON body. */
export function dictationAudio(value: unknown, mimeType: unknown): { audio: Buffer; mimeType: string } {
  if (typeof mimeType !== 'string' || !(dictationMimeTypes as readonly string[]).includes(mimeType)) {
    throw new ServiceError(400, 'invalid_request', 'Unsupported audio type');
  }
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxDictationBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new ServiceError(400, 'invalid_request', 'Audio must be nonempty base64 within the size limit');
  }
  return { audio: Buffer.from(value, 'base64'), mimeType };
}

/** Transcribe for a request: provider failures become safe API errors, silence becomes 422. */
export async function transcribeRequest(dictation: Dictation, clip: { audio: Buffer; mimeType: string }, signal: AbortSignal): Promise<string> {
  const started = Date.now();
  let text: string;
  try { text = await dictation.transcribe(clip.audio, clip.mimeType, signal); }
  catch (error) {
    if (signal.aborted) throw error;
    const reason = error instanceof TranscriptionError ? error.code : 'transcription_failed';
    console.log(JSON.stringify({ event: 'voice.transcription_failed', at: new Date().toISOString(), reason, bytes: clip.audio.length, ms: Date.now() - started }));
    throw new ServiceError(503, 'transcription_unavailable', 'Voice transcription is temporarily unavailable', error instanceof TranscriptionError ? error.retryable : true);
  }
  // Metrics only; transcript text is never logged.
  console.log(JSON.stringify({ event: 'voice.transcribed', at: new Date().toISOString(), model: dictation.model, bytes: clip.audio.length, chars: text.length, ms: Date.now() - started }));
  if (!text) throw new ServiceError(422, 'empty_transcript', 'No speech was recognized');
  return text;
}
