import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createApiServer, type ApiRepository } from '../src/http/api-server.js';
import { ServiceError } from '../src/errors.js';
import { TranscriptionError } from '../src/listening/transcriber.js';
import { GeminiDictation, type Dictation } from '../src/voice/dictation.js';

const audio = Buffer.from('fake aac bytes').toString('base64');
const headers = { authorization: 'Bearer instant-dev-alice', 'content-type': 'application/json' };

function fixture(options: { stored?: Map<string, string>; transcript?: string | Error } = {}) {
  const stored = options.stored ?? new Map<string, string>();
  const calls = { transcribe: 0, accepted: [] as Array<{ clientMessageId: string; text: string }> };
  const repository = {
    findUser: async () => ({ id: 'user-alice' }),
    findUserMessage: async (_userId: string, clientMessageId: string) => stored.has(clientMessageId) ? { text: stored.get(clientMessageId)! } : undefined,
    acceptMessage: async (_userId: string, input: { clientMessageId: string; text: string }) => {
      const previous = stored.get(input.clientMessageId);
      if (previous !== undefined && previous !== input.text) throw new ServiceError(409, 'idempotency_conflict', 'Message ID already has different content');
      stored.set(input.clientMessageId, input.text);
      calls.accepted.push(input);
      return { messageId: `message-${input.clientMessageId}`, submissionId: `submission-${input.clientMessageId}` };
    },
  } as unknown as ApiRepository;
  const dictation: Dictation = {
    model: 'test',
    async transcribe() {
      calls.transcribe += 1;
      const result = options.transcript ?? 'Remind me to call the dentist';
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { repository, dictation, calls };
}

async function listen(t: TestContext, repository: ApiRepository, dictation?: Dictation) {
  const server = createApiServer(repository, { dictation });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

test('a voice message is transcribed, accepted as the user message, and its text returned', async t => {
  const { repository, dictation, calls } = fixture();
  const base = await listen(t, repository, dictation);
  const response = await post(`${base}/conversation/voice-messages`, { clientMessageId: 'voice-1', audio, mimeType: 'audio/mp4' });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { messageId: 'message-voice-1', submissionId: 'submission-voice-1', text: 'Remind me to call the dentist' });
  assert.deepEqual(calls.accepted.map(input => input.text), ['Remind me to call the dentist']);
});

test('a retried voice message replays the stored text without transcribing again', async t => {
  const { repository, dictation, calls } = fixture({ stored: new Map([['voice-1', 'Already accepted']]) });
  const base = await listen(t, repository, dictation);
  const response = await post(`${base}/conversation/voice-messages`, { clientMessageId: 'voice-1', audio, mimeType: 'audio/mp4' });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).text, 'Already accepted');
  assert.equal(calls.transcribe, 0);
});

test('silence is reported as empty_transcript and nothing is accepted', async t => {
  const { repository, dictation, calls } = fixture({ transcript: '' });
  const base = await listen(t, repository, dictation);
  const response = await post(`${base}/conversation/voice-messages`, { clientMessageId: 'voice-2', audio, mimeType: 'audio/mp4' });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'empty_transcript');
  assert.equal(calls.accepted.length, 0);
});

test('provider failures become a retryable transcription_unavailable error', async t => {
  const { repository, dictation } = fixture({ transcript: new TranscriptionError('Transcription service returned 503', true, 'provider_http_503') });
  const base = await listen(t, repository, dictation);
  const response = await post(`${base}/conversation/voice-messages`, { clientMessageId: 'voice-3', audio, mimeType: 'audio/mp4' });
  assert.equal(response.status, 503);
  const { error } = await response.json();
  assert.equal(error.code, 'transcription_unavailable');
  assert.equal(error.retryable, true);
});

test('voice input rejects unsupported audio types, bad base64 and unknown fields', async t => {
  const { repository, dictation, calls } = fixture();
  const base = await listen(t, repository, dictation);
  for (const body of [
    { clientMessageId: 'v', audio, mimeType: 'text/plain' },
    { clientMessageId: 'v', audio: 'not base64!', mimeType: 'audio/mp4' },
    { clientMessageId: 'v', audio, mimeType: 'audio/mp4', text: 'smuggled' },
  ]) assert.equal((await post(`${base}/conversation/voice-messages`, body)).status, 400);
  assert.equal(calls.transcribe, 0);
});

test('voice routes report unavailable when no transcriber is configured', async t => {
  const { repository } = fixture();
  const base = await listen(t, repository);
  const response = await post(`${base}/voice/transcriptions`, { audio, mimeType: 'audio/mp4' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'voice_unavailable');
});

test('the transcription route returns text only and accepts nothing', async t => {
  const { repository, dictation, calls } = fixture();
  const base = await listen(t, repository, dictation);
  const response = await post(`${base}/voice/transcriptions`, { audio, mimeType: 'audio/mp4' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'Remind me to call the dentist' });
  assert.equal(calls.accepted.length, 0);
});

test('GeminiDictation sends inline audio without storage and joins text parts', async t => {
  const requests: Array<{ path: string; key: string | undefined; body: any }> = [];
  let reply: unknown = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '帮我明天下午三点' }, { type: 'text', text: '提醒我打电话。' }] }] };
  const provider = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url!, key: req.headers['x-goog-api-key'] as string | undefined, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    });
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const dictation = new GeminiDictation({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`, model: 'gemini-3.5-transcribe', timeoutMs: 5000 });
  assert.equal(await dictation.transcribe(Buffer.from('clip'), 'audio/mp4', AbortSignal.timeout(5000)), '帮我明天下午三点 提醒我打电话。');
  assert.equal(requests[0]!.path, '/v1beta/interactions');
  assert.equal(requests[0]!.key, 'test-key');
  assert.equal(requests[0]!.body.store, false);
  assert.deepEqual(requests[0]!.body.input, [{ type: 'audio', data: Buffer.from('clip').toString('base64'), mime_type: 'audio/mp4' }]);
  // A completed interaction with no steps is silence, not an error.
  reply = { status: 'completed' };
  assert.equal(await dictation.transcribe(Buffer.from('clip'), 'audio/mp4', AbortSignal.timeout(5000)), '');
  reply = { status: 'in_progress' };
  await assert.rejects(dictation.transcribe(Buffer.from('clip'), 'audio/mp4', AbortSignal.timeout(5000)), TranscriptionError);
});
