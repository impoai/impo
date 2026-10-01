import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedFileBytes, contentDisposition, FileDownloads, mediaType, parseFileId, turnFiles } from '../src/rebyte/files.js';
import { ServiceError } from '../src/errors.js';
import type { SessionArtifact } from '../src/rebyte/gateway.js';

const binding = '3f1c2b7a-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const artifact = (id: string, path: string, turn = 'turn_1', created = 1): SessionArtifact => ({
  id, path, turn_id: turn, created_at: created, size_bytes: 10, session_id: 'sess_1', environment_id: 'env_1', object: 'agent.session.artifact',
});

test('only a Turn\'s files under /workspace/outputs/ are delivered, in publication order', () => {
  const files = turnFiles([
    artifact('artifact_b', '/workspace/outputs/b.xlsx', 'turn_1', 2),
    artifact('artifact_a', '/workspace/outputs/语言模型.pdf', 'turn_1', 1),
    artifact('artifact_c', '/workspace/outputs/c.pdf', 'turn_2'),
    artifact('artifact_d', '/workspace/notes.txt'),
    artifact('artifact_e', '/workspace/outputs-old/e.pdf'),
    artifact('artifact_escape', '/workspace/outputs/../secret.txt'),
    artifact('artifact_empty', '/workspace/outputs/'),
    { ...artifact('artifact_invalid', '/workspace/outputs/x.pdf'), size_bytes: -1 },
  ], 'turn_1', binding);
  assert.deepEqual(files.map(file => file.data.name), ['语言模型.pdf', 'b.xlsx']);
  assert.deepEqual(files[0], { type: 'data-instant-file', id: `${binding}_artifact_a`, data: { schemaVersion: 1, fileId: `${binding}_artifact_a`, name: '语言模型.pdf', mediaType: 'application/pdf', sizeBytes: 10 } });
  assert.equal(files[1]!.data.mediaType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('download byte limits reject truncated and excessive streams', async () => {
  const read = async (text: string, size: number) => {
    const parts = [];
    for await (const part of boundedFileBytes(new Response(text).body!, size)) parts.push(part);
    return Buffer.concat(parts).toString();
  };
  assert.equal(await read('12345', 5), '12345');
  await assert.rejects(read('1234', 5), /incomplete/);
  await assert.rejects(read('123456', 5), /exceeded/);
});

test('file IDs round-trip and reject anything else', () => {
  assert.deepEqual(parseFileId(`${binding.toUpperCase()}_artifact_036c9b83`), { bindingId: binding, artifactId: 'artifact_036c9b83' });
  for (const value of ['', binding, `${binding}_file_1`, `${binding}_artifact_1/content`, `x_artifact_1`]) {
    assert.throws(() => parseFileId(value), (error: unknown) => error instanceof ServiceError && error.status === 404);
  }
});

test('media types come from the extension and default to octet-stream', () => {
  assert.equal(mediaType('Report.PDF'), 'application/pdf');
  assert.equal(mediaType('photo.jpeg'), 'image/jpeg');
  assert.equal(mediaType('archive.tar.gz'), 'application/octet-stream');
  assert.equal(mediaType('README'), 'application/octet-stream');
});

test('content disposition keeps an ASCII fallback and the exact UTF-8 name', () => {
  assert.equal(contentDisposition('后训练 "指南".pdf'), `attachment; filename="___ ____.pdf"; filename*=UTF-8''%E5%90%8E%E8%AE%AD%E7%BB%83%20%22%E6%8C%87%E5%8D%97%22.pdf`);
  assert.equal(contentDisposition("it's (v2).txt"), `attachment; filename="it's (v2).txt"; filename*=UTF-8''it%27s%20%28v2%29.txt`);
});

test('downloads check binding ownership before any provider call and hide provider errors', async () => {
  const calls: string[] = [];
  const stream = () => new Response('bytes').body!;
  const gateway = {
    artifact: async (sessionId: string, artifactId: string) => {
      calls.push(`meta ${sessionId} ${artifactId}`);
      if (artifactId === 'artifact_gone') throw Object.assign(new Error('missing'), { status: 404 });
      if (artifactId === 'artifact_down') throw Object.assign(new Error('secret upstream detail'), { status: 500 });
      if (artifactId === 'artifact_big') return { ...artifact(artifactId, '/workspace/outputs/big.zip'), size_bytes: 200 * 1024 * 1024 };
      return artifact(artifactId, artifactId === 'artifact_scratch' ? '/workspace/tmp.py' : '/workspace/outputs/r.pdf');
    },
    artifactContent: async (sessionId: string, artifactId: string) => { calls.push(`content ${sessionId} ${artifactId}`); return new Response(stream()); },
  };
  const downloads = new FileDownloads({ ownedProviderSession: async (userId, bindingId) => (userId === 'alice' && bindingId === binding ? 'sess_1' : undefined) }, gateway);
  const signal = new AbortController().signal;
  const status = (code: number, name: string) => (error: unknown) => error instanceof ServiceError && error.status === code && error.code === name;

  const file = await downloads.open('alice', `${binding}_artifact_ok`, signal);
  assert.deepEqual({ ...file, body: undefined }, { name: 'r.pdf', mediaType: 'application/pdf', sizeBytes: 10, body: undefined });
  assert.equal(await new Response(file.body).text(), 'bytes');
  await assert.rejects(downloads.open('bob', `${binding}_artifact_ok`, signal), status(404, 'not_found'));
  await assert.rejects(downloads.open('alice', `${binding}_artifact_scratch`, signal), status(404, 'not_found'));
  await assert.rejects(downloads.open('alice', `${binding}_artifact_gone`, signal), status(404, 'not_found'));
  await assert.rejects(downloads.open('alice', `${binding}_artifact_down`, signal), (error: unknown) => status(503, 'file_unavailable')(error) && !(error as Error).message.includes('secret'));
  await assert.rejects(downloads.open('alice', `${binding}_artifact_big`, signal), status(413, 'file_too_large'));
  assert.deepEqual(calls.filter(call => call.startsWith('content')), ['content sess_1 artifact_ok'], 'bytes are read only for an owned, delivered, bounded file');
});
