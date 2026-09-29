import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageChunk } from 'ai';

type Status = 'queued' | 'running' | 'waiting_device' | 'completed' | 'failed' | 'cancelled';
type Scenario = 'text' | 'tool' | 'tool_timeout' | 'slow_text' | 'broken_stream';
type RecordValue = Record<string, unknown>;
interface Device { id: string; owner: string; installationId: string; tools: string[] }
interface Invocation {
  id: string; owner: string; submissionId: string; toolCallId: string; deviceId: string;
  expiresAt: string; toolName: string; input: { text: string }; executionId?: string;
  receipt?: { canonical: string; body: RecordValue };
}
interface Submission {
  id: string; owner: string; userMessageId: string; assistantMessageId: string;
  status: Status; scenario: Scenario; invocation?: Invocation; resultCount: number;
  chunks: UIMessageChunk[]; subscribers: Set<(chunk: UIMessageChunk) => void>;
  timers: Set<ReturnType<typeof setTimeout>>;
}
export interface FixtureOptions { toolTimeoutMs?: number; slowTextMs?: number }
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const terminal = (s: Status) => ['completed', 'failed', 'cancelled'].includes(s);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function string(body: RecordValue, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) {
    throw new HttpError(400, 'invalid_request', `${key} must be a nonempty string`);
  }
  return value;
}
async function body(req: IncomingMessage): Promise<RecordValue> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(400, 'invalid_request', 'Expected application/json');
  }
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new HttpError(413, 'request_too_large', 'JSON body exceeds 64 KiB');
    buffers.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as RecordValue;
  } catch { throw new HttpError(400, 'invalid_request', 'Expected a JSON object'); }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

/** Loopback fixture only. All state is in memory; this is not the durable runtime. */
export function createFixtureServer(options: FixtureOptions = {}) {
  const submissions = new Map<string, Submission>();
  const devices = new Map<string, Device>();
  const invocations = new Map<string, Invocation>();
  const inputs = new Map<string, { canonical: string; response: RecordValue }>();
  const toolTimeoutMs = options.toolTimeoutMs ?? 5000;
  const slowTextMs = options.slowTextMs ?? 300;

  function emit(s: Submission, chunk: UIMessageChunk) {
    s.chunks.push(chunk);
    for (const subscriber of s.subscribers) subscriber(chunk);
  }
  function status(s: Submission, next: Status) {
    s.status = next;
    emit(s, { type: 'data-instant-submission', data: { schemaVersion: 1, submissionId: s.id, status: next } });
  }
  function later(s: Submission, ms: number, callback: () => void) {
    const timer = setTimeout(() => { s.timers.delete(timer); if (!terminal(s.status)) callback(); }, ms);
    s.timers.add(timer);
  }
  function finish(s: Submission, next: 'completed' | 'failed' | 'cancelled') {
    if (terminal(s.status)) return;
    for (const timer of s.timers) clearTimeout(timer);
    s.timers.clear();
    status(s, next);
    emit(s, { type: 'finish', finishReason: next === 'completed' ? 'stop' : 'other' });
  }
  function text(s: Submission, value: string) {
    const id = `text-${s.id}-${s.chunks.length}`;
    emit(s, { type: 'text-start', id });
    emit(s, { type: 'text-delta', id, delta: value });
    emit(s, { type: 'text-end', id });
  }
  function start(s: Submission, deviceId?: string) {
    emit(s, { type: 'start', messageId: s.assistantMessageId });
    status(s, 'running');
    if (s.scenario === 'tool' || s.scenario === 'tool_timeout') {
      const wait = s.scenario === 'tool_timeout' ? 250 : toolTimeoutMs;
      const invocation: Invocation = {
        id: randomUUID(), owner: s.owner, submissionId: s.id, toolCallId: randomUUID(), deviceId: deviceId!,
        expiresAt: new Date(Date.now() + wait).toISOString(), toolName: 'instant_test_echo', input: { text: '来自 Swift 的回声 👋' },
      };
      s.invocation = invocation;
      invocations.set(invocation.id, invocation);
      emit(s, { type: 'tool-input-available', toolCallId: invocation.toolCallId, toolName: invocation.toolName, input: invocation.input });
      status(s, 'waiting_device');
      emit(s, { type: 'data-instant-device-request', data: {
        schemaVersion: 1, invocationId: invocation.id, toolCallId: invocation.toolCallId,
        deviceId: invocation.deviceId, expiresAt: invocation.expiresAt,
      } });
      later(s, wait, () => {
        emit(s, { type: 'tool-output-error', toolCallId: invocation.toolCallId, errorText: 'device_timeout' });
        finish(s, 'failed');
      });
    } else {
      // Complete code points are encoded by the SDK; network fragmentation is tested in Swift separately.
      later(s, 15, () => text(s, '你好，'));
      later(s, s.scenario === 'slow_text' ? slowTextMs : 40, () => {
        text(s, 'Instant 👋');
        finish(s, 'completed');
      });
    }
  }
  function getOwned<T extends { owner: string }>(map: Map<string, T>, id: string, owner: string): T {
    const value = map.get(id);
    if (!value || value.owner !== owner) throw new HttpError(404, 'not_found', 'Resource not found');
    return value;
  }
  function view(s: Submission) {
    return { submissionId: s.id, messageId: s.assistantMessageId, status: s.status,
      resultCount: s.resultCount, subscriberCount: s.subscribers.size };
  }
  function checkDevice(invocation: Invocation, data: RecordValue, owner: string) {
    const deviceId = string(data, 'deviceId');
    getOwned(devices, deviceId, owner);
    if (deviceId !== invocation.deviceId) throw new HttpError(403, 'wrong_device', 'This invocation belongs to another device');
  }
  function checkActive(invocation: Invocation): Submission {
    const s = submissions.get(invocation.submissionId)!;
    if (terminal(s.status) || Date.now() >= Date.parse(invocation.expiresAt)) {
      throw new HttpError(410, 'invocation_expired', 'Invocation is no longer executable');
    }
    return s;
  }
  async function stream(s: Submission, res: ServerResponse) {
    if (s.scenario === 'broken_stream') {
      // Deliberate protocol fault fixture: no finish/DONE, incomplete JSON event.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' });
      res.write(`data: ${JSON.stringify({ type: 'start', messageId: s.assistantMessageId })}\n\n`);
      res.end('data: {"type":"text-delta"');
      return;
    }
    let release: (() => void) | undefined;
    let subscriber: ((chunk: UIMessageChunk) => void) | undefined;
    const cleanup = () => {
      if (subscriber) s.subscribers.delete(subscriber);
      release?.();
    };
    res.once('close', cleanup);
    const output = createUIMessageStream({
      execute: async ({ writer }) => {
        // Synchronous snapshot + registration has no asynchronous gap on Node's event loop.
        for (const chunk of s.chunks) writer.write(chunk);
        if (terminal(s.status) || res.destroyed) return;
        await new Promise<void>(resolve => {
          release = resolve;
          subscriber = chunk => {
            writer.write(chunk);
            if (chunk.type === 'finish') cleanup();
          };
          s.subscribers.add(subscriber);
        });
      },
      onError: () => 'fixture_stream_error',
    });
    try {
      const encoded = createUIMessageStreamResponse({ stream: output });
      res.writeHead(encoded.status, Object.fromEntries(encoded.headers));
      // SDK owns wire encoding; Node pipeline owns close/error/backpressure handling.
      // A cancelled subscriber tears down this pipeline, never the fixture runtime.
      await pipeline(Readable.fromWeb(encoded.body as NodeReadableStream<Uint8Array>), res);
    } finally {
      cleanup();
      res.off('close', cleanup);
    }
  }

  const server = createServer((req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    void route(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const safe = error instanceof HttpError ? error : new HttpError(500, 'internal_error', 'Fixture server error');
      json(res, safe.status, { error: { code: safe.code, message: safe.message, retryable: false }, requestId });
    });
  });
  server.on('close', () => {
    for (const s of submissions.values()) for (const timer of s.timers) clearTimeout(timer);
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method;
    if (url.pathname === '/health' && method === 'GET') { json(res, 200, { status: 'ok', mode: 'fixture' }); return; }
    const token = req.headers.authorization;
    const owner = token === 'Bearer instant-test-alice' ? 'alice' : token === 'Bearer instant-test-bob' ? 'bob' : undefined;
    if (!owner) throw new HttpError(401, 'unauthorized', 'Fixture identity required');
    if (!url.pathname.startsWith('/api/v1/')) throw new HttpError(404, 'not_found', 'Route not found');
    const path = url.pathname.slice('/api/v1'.length);
    if (path === '/devices/register' && method === 'POST') {
      const data = await body(req);
      const installationId = string(data, 'installationId');
      if (!Array.isArray(data.tools) || data.tools.some(t => typeof t !== 'string' || t !== 'instant_test_echo')) {
        throw new HttpError(400, 'invalid_request', 'Only the fixture tool instant_test_echo is supported');
      }
      let device = [...devices.values()].find(d => d.owner === owner && d.installationId === installationId);
      if (!device) {
        device = { id: randomUUID(), owner, installationId, tools: [...data.tools] };
        devices.set(device.id, device);
      } else { device.tools = [...data.tools]; }
      json(res, 200, { deviceId: device.id }); return;
    }
    if (path === '/conversation/messages' && method === 'POST') {
      const data = await body(req);
      const clientMessageId = string(data, 'clientMessageId');
      string(data, 'text');
      const scenario = data.scenario ?? 'text';
      if (!['text', 'tool', 'tool_timeout', 'slow_text', 'broken_stream'].includes(scenario as string)) {
        throw new HttpError(400, 'invalid_request', 'Unknown fixture scenario');
      }
      const normalized = { ...data, scenario };
      const key = `${owner}:${clientMessageId}`;
      const fingerprint = canonical(normalized);
      const prior = inputs.get(key);
      if (prior) {
        if (prior.canonical !== fingerprint) throw new HttpError(409, 'idempotency_conflict', 'Message ID reused with different input');
        json(res, 202, prior.response); return;
      }
      let deviceId: string | undefined;
      if (scenario === 'tool' || scenario === 'tool_timeout') {
        deviceId = string(data, 'deviceId');
        const device = getOwned(devices, deviceId, owner);
        if (!device.tools.includes('instant_test_echo')) throw new HttpError(400, 'invalid_request', 'Device does not support this tool');
      }
      const s: Submission = {
        id: randomUUID(), owner, userMessageId: randomUUID(), assistantMessageId: randomUUID(), scenario: scenario as Scenario,
        status: 'queued', chunks: [], subscribers: new Set(), resultCount: 0, timers: new Set(),
      };
      submissions.set(s.id, s);
      const response = { messageId: s.userMessageId, submissionId: s.id };
      inputs.set(key, { canonical: fingerprint, response });
      start(s, deviceId); // Fixture execution belongs to the server, never to GET /stream.
      json(res, 202, response); return;
    }
    const submissionRoute = /^\/submissions\/([^/]+)(?:\/(stream|cancel))?$/.exec(path);
    if (submissionRoute) {
      const s = getOwned(submissions, submissionRoute[1], owner);
      if (method === 'GET' && !submissionRoute[2]) { json(res, 200, view(s)); return; }
      if (method === 'GET' && submissionRoute[2] === 'stream') { await stream(s, res); return; }
      if (method === 'POST' && submissionRoute[2] === 'cancel') {
        await body(req);
        if (!terminal(s.status)) {
          if (s.invocation) emit(s, { type: 'tool-output-error', toolCallId: s.invocation.toolCallId, errorText: 'cancelled' });
          emit(s, { type: 'abort', reason: 'cancelled' });
          finish(s, 'cancelled');
        }
        json(res, 200, view(s)); return;
      }
    }
    const pendingRoute = /^\/devices\/([^/]+)\/tool-invocations$/.exec(path);
    if (pendingRoute && method === 'GET') {
      const device = getOwned(devices, pendingRoute[1], owner);
      const pending = [...invocations.values()].filter(i => i.owner === owner && i.deviceId === device.id && !i.receipt &&
        !terminal(submissions.get(i.submissionId)!.status) && Date.parse(i.expiresAt) > Date.now());
      json(res, 200, { invocations: pending.map(i => ({ invocationId: i.id, toolCallId: i.toolCallId, deviceId: i.deviceId,
        expiresAt: i.expiresAt, toolName: i.toolName, input: i.input })) }); return;
    }
    const invocationRoute = /^\/device-tool-invocations\/([^/]+)\/(claim|result)$/.exec(path);
    if (invocationRoute && method === 'POST') {
      const invocation = getOwned(invocations, invocationRoute[1], owner);
      const data = await body(req);
      checkDevice(invocation, data, owner);
      if (invocationRoute[2] === 'claim') {
        checkActive(invocation);
        const device = devices.get(invocation.deviceId)!;
        if (!device.tools.includes(invocation.toolName)) throw new HttpError(403, 'tool_unavailable', 'Device capability was revoked');
        invocation.executionId ??= randomUUID();
        json(res, 200, { executionId: invocation.executionId, expiresAt: invocation.expiresAt }); return;
      }
      const executionId = string(data, 'executionId');
      if (!invocation.executionId) throw new HttpError(409, 'not_claimed', 'Claim before returning a result');
      if (executionId !== invocation.executionId) throw new HttpError(409, 'execution_mismatch', 'Execution ID mismatch');
      if (typeof data.success !== 'boolean' || (data.success && (!('output' in data) || 'error' in data)) ||
          (!data.success && (typeof data.error !== 'string' || !data.error || 'output' in data))) {
        throw new HttpError(400, 'invalid_request', 'Expected success/output or failure/error');
      }
      // The echo schema is part of the fixture contract, not an arbitrary function RPC.
      if (data.success) {
        const output = data.output as RecordValue | null;
        if (!output || typeof output !== 'object' || Array.isArray(output) || typeof output.echo !== 'string') {
          throw new HttpError(400, 'invalid_request', 'Echo output must contain an echo string');
        }
      }
      const fingerprint = canonical(data);
      if (invocation.receipt) {
        if (invocation.receipt.canonical !== fingerprint) throw new HttpError(409, 'result_conflict', 'Result differs from stored receipt');
        json(res, 200, { accepted: true, duplicate: true }); return;
      }
      const s = checkActive(invocation);
      invocation.receipt = { canonical: fingerprint, body: data };
      s.resultCount++;
      if (data.success) {
        emit(s, { type: 'tool-output-available', toolCallId: invocation.toolCallId, output: data.output });
        text(s, `工具完成：${(data.output as RecordValue).echo}`);
        finish(s, 'completed');
      } else {
        emit(s, { type: 'tool-output-error', toolCallId: invocation.toolCallId, errorText: data.error as string });
        text(s, `工具失败：${data.error}`);
        finish(s, 'failed');
      }
      json(res, 200, { accepted: true, duplicate: false }); return;
    }
    throw new HttpError(404, 'not_found', 'Route not found');
  }
  return server;
}
