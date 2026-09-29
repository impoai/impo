import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { createFixtureServer } from '../src/server.js';

const alice = 'instant-test-alice';
const bob = 'instant-test-bob';
const echo = '来自 Swift 的回声 👋';

type Submission = {
  submissionId: string;
  messageId: string;
  status: string;
  resultCount: number;
  subscriberCount: number;
};
type Invocation = {
  invocationId: string;
  toolCallId: string;
  deviceId: string;
  expiresAt: string;
  toolName: string;
  input: { text: string };
};
type Receipt = { executionId: string; expiresAt: string };
type APIError = { error: { code: string; message: string; retryable: boolean }; requestId: string };

async function fixture(t: TestContext, options: Parameters<typeof createFixtureServer>[0] = {}) {
  const server = createFixtureServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  const request = (path: string, init: RequestInit = {}, token = alice) => fetch(`${base}/api/v1${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(5_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  });
  const post = (path: string, body: unknown, token = alice) => request(path, { method: 'POST', body: JSON.stringify(body) }, token);
  const json = async <T>(response: Promise<Response>, status = 200): Promise<T> => {
    const result = await response;
    const body = await result.json();
    assert.equal(result.status, status, JSON.stringify(body));
    return body as T;
  };
  const register = (installationId = 'test-device', token = alice) => json<{ deviceId: string }>(
    post('/devices/register', { installationId, tools: ['instant_test_echo'] }, token),
  );
  const submit = (scenario = 'text', deviceId?: string, token = alice) => json<{ submissionId: string; messageId: string }>(
    post('/conversation/messages', { clientMessageId: crypto.randomUUID(), text: 'hello', scenario, ...(deviceId ? { deviceId } : {}) }, token), 202,
  );
  const snapshot = (id: string) => json<Submission>(request(`/submissions/${id}`));
  const pending = (deviceId: string) => json<{ invocations: Invocation[] }>(request(`/devices/${deviceId}/tool-invocations?status=pending`));
  const invocation = async (deviceId: string) => {
    const data = await until(() => pending(deviceId), value => value.invocations.length === 1);
    return data.invocations[0]!;
  };
  const claim = (id: string, deviceId: string) => json<Receipt>(post(`/device-tool-invocations/${id}/claim`, { deviceId }));
  return { base, request, post, json, register, submit, snapshot, pending, invocation, claim };
}

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 3_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`Condition did not become true; last value: ${JSON.stringify(value)}`);
}

async function errorCode(response: Promise<Response>, status: number, code: string) {
  const result = await response;
  assert.equal(result.status, status);
  const body = await result.json() as APIError;
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, 'string');
  assert.equal(body.error.retryable, false);
  assert.equal(typeof body.requestId, 'string');
}

async function streamChunks(response: Promise<Response>) {
  const result = await response;
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
  assert.match(result.headers.get('content-type') ?? '', /^text\/event-stream/);
  const raw = await result.text();
  const data = raw.split(/\r?\n\r?\n/).flatMap(frame => {
    const lines = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
    return lines.length ? [lines.join('\n')] : [];
  });
  assert.equal(data.at(-1), '[DONE]', 'A normal stream must have a terminal marker');
  return data.slice(0, -1).map(part => JSON.parse(part) as UIMessageChunk);
}

// Feed received wire events through the real SDK reducer, independently of the
// Swift implementation. This catches incompatible event shapes and ordering.
async function officialMessage(chunks: UIMessageChunk[]) {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let latest: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream, terminateOnError: true })) latest = message;
  assert.ok(latest);
  return latest;
}

const messageText = (message: UIMessage) => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('');

test('health and UTF-8 text stream work with the official AI SDK reducer and late replay', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await fetch(`${f.base}/health`)).json(), { status: 'ok', mode: 'fixture' });
  const created = await f.submit();
  const chunks = await streamChunks(f.request(`/submissions/${created.submissionId}/stream`));
  const message = await officialMessage(chunks);
  const completed = await f.snapshot(created.submissionId);
  assert.equal(completed.status, 'completed');
  assert.notEqual(created.messageId, completed.messageId, 'User and assistant messages have different IDs');
  assert.equal(message.id, completed.messageId);
  assert.equal(messageText(message), '你好，Instant 👋');
  assert.equal(chunks[0]?.type, 'start');
  assert.ok(chunks.some(chunk => chunk.type === 'finish'));
  const replay = await officialMessage(await streamChunks(f.request(`/submissions/${created.submissionId}/stream`)));
  assert.equal(replay.id, message.id);
  assert.equal(messageText(replay), messageText(message));
});

test('message idempotency returns original IDs, detects conflicts, and is scoped by user', async t => {
  const f = await fixture(t);
  const body = { clientMessageId: 'same-message', text: 'hello', scenario: 'text' };
  const first = await f.json<{ submissionId: string; messageId: string }>(f.post('/conversation/messages', body), 202);
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => f.json(f.post('/conversation/messages', body), 202)));
  for (const retry of concurrent) assert.deepEqual(retry, first);
  await errorCode(f.post('/conversation/messages', { ...body, text: 'different' }), 409, 'idempotency_conflict');
  const otherUser = await f.json<{ submissionId: string }>(f.post('/conversation/messages', body, bob), 202);
  assert.notEqual(otherUser.submissionId, first.submissionId);
});

test('resources and device registration enforce user ownership', async t => {
  const f = await fixture(t);
  const device = await f.register('same-installation');
  assert.deepEqual(await f.register('same-installation'), device);
  const otherDevice = await f.register('same-installation', bob);
  assert.notEqual(otherDevice.deviceId, device.deviceId);
  const created = await f.submit('slow_text');
  for (const path of [`/submissions/${created.submissionId}`, `/submissions/${created.submissionId}/stream`, `/devices/${device.deviceId}/tool-invocations?status=pending`]) {
    await errorCode(f.request(path, {}, bob), 404, 'not_found');
  }
  await errorCode(f.post(`/submissions/${created.submissionId}/cancel`, {}, bob), 404, 'not_found');
  await errorCode(f.post('/conversation/messages', { clientMessageId: 'foreign-device', text: 'hello', scenario: 'tool', deviceId: otherDevice.deviceId }), 404, 'not_found');
});

test('tool claim and result retries execute once and reconstruct a valid SDK message', async t => {
  const f = await fixture(t);
  const { deviceId } = await f.register();
  const created = await f.submit('tool', deviceId);
  const invocation = await f.invocation(deviceId);
  assert.equal(invocation.toolName, 'instant_test_echo');
  assert.deepEqual(invocation.input, { text: echo });
  await errorCode(f.post(`/device-tool-invocations/${invocation.invocationId}/result`, { deviceId, executionId: 'unclaimed', success: true, output: { echo } }), 409, 'not_claimed');
  const receipt = await f.claim(invocation.invocationId, deviceId);
  assert.deepEqual(await f.claim(invocation.invocationId, deviceId), receipt);
  assert.equal((await f.pending(deviceId)).invocations.length, 1, 'Claimed work remains discoverable until finished');
  const resultPath = `/device-tool-invocations/${invocation.invocationId}/result`;
  const body = { deviceId, executionId: receipt.executionId, success: true, output: { echo } };
  await errorCode(f.post(resultPath, { ...body, executionId: 'wrong-execution' }), 409, 'execution_mismatch');
  assert.deepEqual(await f.json(f.post(resultPath, body)), { accepted: true, duplicate: false });
  assert.deepEqual(await f.json(f.post(resultPath, body)), { accepted: true, duplicate: true });
  await errorCode(f.post(resultPath, { ...body, output: { echo: 'changed' } }), 409, 'result_conflict');
  const finished = await until(() => f.snapshot(created.submissionId), value => value.status === 'completed');
  assert.equal(finished.resultCount, 1);
  assert.deepEqual((await f.pending(deviceId)).invocations, []);
  const chunks = await streamChunks(f.request(`/submissions/${created.submissionId}/stream`));
  const message = await officialMessage(chunks);
  assert.equal(messageText(message), `工具完成：${echo}`);
  assert.ok(chunks.some(chunk => chunk.type === 'tool-output-available' && chunk.toolCallId === invocation.toolCallId));
});

test('tool ownership is checked before claims and before returning duplicate result receipts', async t => {
  const f = await fixture(t);
  const { deviceId } = await f.register('target');
  const other = await f.register('other');
  const foreign = await f.register('foreign', bob);
  await f.submit('tool', deviceId);
  const invocation = await f.invocation(deviceId);
  const path = `/device-tool-invocations/${invocation.invocationId}`;
  await errorCode(f.post(`${path}/claim`, { deviceId: other.deviceId }), 403, 'wrong_device');
  await errorCode(f.post(`${path}/claim`, { deviceId: foreign.deviceId }, bob), 404, 'not_found');
  const receipt = await f.claim(invocation.invocationId, deviceId);
  const body = { deviceId, executionId: receipt.executionId, success: true, output: { echo } };
  await f.json(f.post(`${path}/result`, body));
  await errorCode(f.post(`${path}/result`, body, bob), 404, 'not_found');
  await errorCode(f.post(`${path}/result`, { ...body, deviceId: other.deviceId }), 403, 'wrong_device');
});

test('accepted tool failure becomes a failed run with a complete, renderable stream', async t => {
  const f = await fixture(t);
  const { deviceId } = await f.register();
  const created = await f.submit('tool', deviceId);
  const invocation = await f.invocation(deviceId);
  const receipt = await f.claim(invocation.invocationId, deviceId);
  assert.deepEqual(await f.json(f.post(`/device-tool-invocations/${invocation.invocationId}/result`, {
    deviceId, executionId: receipt.executionId, success: false, error: 'permission_denied',
  })), { accepted: true, duplicate: false });
  await until(() => f.snapshot(created.submissionId), value => value.status === 'failed');
  const chunks = await streamChunks(f.request(`/submissions/${created.submissionId}/stream`));
  assert.ok(chunks.some(chunk => chunk.type === 'tool-output-error' && chunk.errorText === 'permission_denied'));
  assert.equal(messageText(await officialMessage(chunks)), '工具失败：permission_denied');
});

test('device timeout completes without a subscriber and rejects late claims/results', async t => {
  const f = await fixture(t, { toolTimeoutMs: 100 });
  const { deviceId } = await f.register();
  const created = await f.submit('tool_timeout', deviceId);
  const invocation = await f.invocation(deviceId);
  const receipt = await f.claim(invocation.invocationId, deviceId);
  const failed = await until(() => f.snapshot(created.submissionId), value => value.status === 'failed');
  assert.equal(failed.resultCount, 0);
  assert.equal(failed.subscriberCount, 0);
  await errorCode(f.post(`/device-tool-invocations/${invocation.invocationId}/claim`, { deviceId }), 410, 'invocation_expired');
  await errorCode(f.post(`/device-tool-invocations/${invocation.invocationId}/result`, {
    deviceId, executionId: receipt.executionId, success: true, output: { echo },
  }), 410, 'invocation_expired');
  const chunks = await streamChunks(f.request(`/submissions/${created.submissionId}/stream`));
  assert.ok(chunks.some(chunk => chunk.type === 'tool-output-error' && chunk.errorText === 'device_timeout'));
  await officialMessage(chunks);
});

test('disconnecting the device stream preserves pending work and releases the subscriber', async t => {
  const f = await fixture(t);
  const { deviceId } = await f.register();
  const created = await f.submit('tool', deviceId);
  const controller = new AbortController();
  const response = await f.request(`/submissions/${created.submissionId}/stream`, { signal: controller.signal });
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await until(() => f.snapshot(created.submissionId), value => value.subscriberCount === 1);
  controller.abort();
  await reader.cancel().catch(() => {});
  const disconnected = await until(() => f.snapshot(created.submissionId), value => value.subscriberCount === 0);
  assert.equal(disconnected.status, 'waiting_device');
  const invocation = await f.invocation(deviceId);
  const receipt = await f.claim(invocation.invocationId, deviceId);
  await f.json(f.post(`/device-tool-invocations/${invocation.invocationId}/result`, {
    deviceId, executionId: receipt.executionId, success: true, output: { echo },
  }));
  const completed = await until(() => f.snapshot(created.submissionId), value => value.status === 'completed');
  assert.equal(completed.resultCount, 1);
  const replay = await officialMessage(await streamChunks(f.request(`/submissions/${created.submissionId}/stream`)));
  assert.equal(messageText(replay), `工具完成：${echo}`);
});

test('one disconnected viewer does not stop the run or another viewer', async t => {
  const f = await fixture(t, { slowTextMs: 150 });
  const created = await f.submit('slow_text');
  const controller = new AbortController();
  const first = await f.request(`/submissions/${created.submissionId}/stream`, { signal: controller.signal });
  const firstReader = first.body!.getReader();
  await firstReader.read();
  const second = streamChunks(f.request(`/submissions/${created.submissionId}/stream`));
  await until(() => f.snapshot(created.submissionId), value => value.subscriberCount === 2);
  controller.abort();
  await firstReader.cancel().catch(() => {});
  assert.equal(messageText(await officialMessage(await second)), '你好，Instant 👋');
  const completed = await until(() => f.snapshot(created.submissionId), value => value.subscriberCount === 0);
  assert.equal(completed.status, 'completed');
});

test('explicit cancellation is idempotent and prevents a late device result from completing the run', async t => {
  const f = await fixture(t);
  const { deviceId } = await f.register();
  const created = await f.submit('tool', deviceId);
  const invocation = await f.invocation(deviceId);
  const receipt = await f.claim(invocation.invocationId, deviceId);
  const cancelPath = `/submissions/${created.submissionId}/cancel`;
  assert.equal((await f.json<Submission>(f.post(cancelPath, {}))).status, 'cancelled');
  assert.equal((await f.json<Submission>(f.post(cancelPath, {}))).status, 'cancelled');
  await errorCode(f.post(`/device-tool-invocations/${invocation.invocationId}/result`, {
    deviceId, executionId: receipt.executionId, success: true, output: { echo },
  }), 410, 'invocation_expired');
  assert.equal((await f.snapshot(created.submissionId)).resultCount, 0);
  assert.deepEqual((await f.pending(deviceId)).invocations, []);
  const chunks = await streamChunks(f.request(`/submissions/${created.submissionId}/stream`));
  assert.ok(chunks.some(chunk => chunk.type === 'abort'));
  const other = await f.submit();
  await until(() => f.snapshot(other.submissionId), value => value.status === 'completed');
  assert.equal((await f.json<Submission>(f.post(`/submissions/${other.submissionId}/cancel`, {}))).status, 'completed');
});

test('authentication and malformed bodies fail with structured errors', async t => {
  const f = await fixture(t);
  await errorCode(f.request('/conversation/messages', { method: 'POST', body: '{}' }, 'bad-token'), 401, 'unauthorized');
  await errorCode(fetch(`${f.base}/api/v1/conversation/messages`, { method: 'POST', body: '{}' }), 401, 'unauthorized');
  await errorCode(f.request('/conversation/messages', { method: 'POST', body: '{broken' }), 400, 'invalid_request');
  for (const body of [{}, { clientMessageId: 'missing-text' }, { clientMessageId: 'bad-text', text: 42 }, { clientMessageId: 'bad-scenario', text: 'hello', scenario: 'unknown' }]) {
    await errorCode(f.post('/conversation/messages', body), 400, 'invalid_request');
  }
  await errorCode(f.post('/devices/register', { installationId: 'no-tools', tools: 'instant_test_echo' }), 400, 'invalid_request');
  const { deviceId } = await f.register();
  await f.submit('tool', deviceId);
  const invocation = await f.invocation(deviceId);
  const receipt = await f.claim(invocation.invocationId, deviceId);
  await errorCode(f.post(`/device-tool-invocations/${invocation.invocationId}/result`, {
    deviceId, executionId: receipt.executionId, success: 'true', output: { echo },
  }), 400, 'invalid_request');
});

test('intentionally truncated transport does not masquerade as a finished stream', async t => {
  const f = await fixture(t);
  const created = await f.submit('broken_stream');
  const response = await f.request(`/submissions/${created.submissionId}/stream`);
  assert.equal(response.status, 200);
  // HTTP can end normally while the application protocol is truncated. A
  // consumer must validate protocol completion, not only fetch success.
  await assert.rejects(streamChunks(Promise.resolve(response)), /terminal marker/);
});
