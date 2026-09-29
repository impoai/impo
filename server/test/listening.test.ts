import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { GeminiTranscriber, TranscriptionError } from '../src/listening/transcriber.js';

for (const scenario of ['success', 'failure', 'processing', 'malformed', 'silence'] as const) {
  test(`Gemini ${scenario}: upload protocol, response parsing and remote cleanup`, async () => {
    let deleted = false; let called = false;
    let base = '';
    const server = createServer(async (req, res) => {
      let body = ''; for await (const part of req) body += part;
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/upload/v1beta/files') {
        assert.equal(req.headers['x-goog-api-key'], 'test-key');
        assert.equal(req.headers['x-goog-upload-header-content-length'], '5');
        res.setHeader('X-Goog-Upload-URL', `${base}/upload-data`); res.end('{}');
      } else if (req.url === '/upload-data') {
        assert.equal(body, 'audio'); assert.equal(req.headers['x-goog-api-key'], undefined);
        res.end(JSON.stringify({ file: { name: 'files/test', uri: 'https://files.invalid/test', state: scenario === 'processing' ? 'PROCESSING' : 'ACTIVE' } }));
      } else if (req.method === 'DELETE') {
        deleted = true; res.end('{}');
      } else if (req.method === 'GET') {
        res.end(JSON.stringify({ state: 'ACTIVE' }));
      } else {
        called = true; const input = JSON.parse(body);
        assert.equal(input.store, false); assert.equal(input.model, 'gemini-3.5-transcribe');
        assert.deepEqual(input.input, [{ type: 'audio', uri: 'https://files.invalid/test', mime_type: 'audio/mp4' }]);
        if (scenario === 'failure') { res.statusCode = 429; res.end('{"private":"do not leak"}'); }
        else if (scenario === 'silence') res.end(JSON.stringify({status:'completed', object:'interaction'}));
        else if (scenario === 'malformed') res.end('{}');
        else res.end(JSON.stringify({ status: 'completed', steps: [{ content: [{ type: 'text', text: '你好。Hello.' }] }] }));
      }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const transcriber = new GeminiTranscriber({ apiKey: 'test-key', baseURL: base, timeoutMs: 3000 });
      const result = transcriber.transcribe(Buffer.from('audio'), 'audio/mp4', new AbortController().signal);
      if (scenario === 'failure' || scenario === 'malformed') await assert.rejects(result, error => error instanceof TranscriptionError && error.retryable && !error.message.includes('private'));
      else assert.equal((await result).transcript, scenario === 'silence' ? '' : '你好。Hello.');
      assert.equal(called, true); assert.equal(deleted, true);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
