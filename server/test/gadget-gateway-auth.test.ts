import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createApiServer, type ApiRepository } from '../src/http/api-server.js';

const serviceToken = 'gateway-service-token-0123456789abcdef';
const clerk = { mode: 'clerk' as const, secretKey: 'sk_test_0000000000000000000000000000000000000000' };

async function listen(t: TestContext, options: Parameters<typeof createApiServer>[1] = {}) {
  const calls: unknown[][] = [];
  const repository = {
    findOrCreateUser: async (...args: unknown[]) => { calls.push(['findOrCreateUser', ...args]); return { id: 'user-1' }; },
    acceptMessage: async (...args: unknown[]) => { calls.push(['acceptMessage', ...args]); return { messageId: 'm1', submissionId: 's1' }; },
  } as unknown as ApiRepository;
  const server = createApiServer(repository, options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const message = (base: string, headers: Record<string, string>, path = '/api/v1/conversation/messages') => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ clientMessageId: 'c1', text: 'hello from a gadget' }),
});
const gateway = (subject: string, token = serviceToken) => ({ Authorization: `Bearer ${token}`, 'X-Impo-Gadget-Subject': subject });

test('the gadget gateway posts a chat message as the paired account', async t => {
  const { base, calls } = await listen(t, { auth: clerk, gadgetGateway: { serviceToken } });
  const response = await message(base, gateway('user_abc123'));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { messageId: 'm1', submissionId: 's1' });
  assert.deepEqual(calls[0], ['findOrCreateUser', 'clerk', 'user_abc123', 'Impo user']);
  assert.deepEqual(calls[1]!.slice(0, 2), ['acceptMessage', 'user-1']);
});

test('the gadget gateway credential is checked before anything else', async t => {
  const { base, calls } = await listen(t, { auth: clerk, gadgetGateway: { serviceToken } });
  assert.equal((await message(base, gateway('user_abc123', 'wrong-token'))).status, 401);
  assert.equal((await message(base, { 'X-Impo-Gadget-Subject': 'user_abc123' })).status, 401);
  assert.equal((await message(base, gateway('not a subject'))).status, 400);
  assert.equal(calls.length, 0);
});

test('a server without a gateway token rejects the gadget header', async t => {
  const { base, calls } = await listen(t, { auth: clerk });
  assert.equal((await message(base, gateway('user_abc123'))).status, 401);
  assert.equal(calls.length, 0);
});

test('the gadget gateway is limited to chat and its submissions', async t => {
  const { base, calls } = await listen(t, { auth: clerk, gadgetGateway: { serviceToken } });
  for (const [method, path] of [['GET', '/api/v1/conversation'], ['GET', '/api/v1/profile'], ['DELETE', '/api/v1/account'],
    ['POST', '/api/v1/tasks'], ['POST', '/api/v1/submissions/s1/cancel'], ['GET', '/api/v1/memories']] as const) {
    const response = await fetch(base + path, { method, headers: gateway('user_abc123') });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.equal(calls.length, 0);
});

test('a deleted account cannot be reached through the gadget gateway', async t => {
  const accounts = { closedIdentity: async () => ({ userId: 'user-1' }) } as unknown as NonNullable<Parameters<typeof createApiServer>[1]>['accounts'];
  const { base, calls } = await listen(t, { auth: clerk, gadgetGateway: { serviceToken }, accounts });
  assert.equal((await message(base, gateway('user_abc123'))).status, 410);
  assert.equal(calls.length, 0);
});

test('requests without the gadget header still need a session token', async t => {
  const { base, calls } = await listen(t, { auth: clerk, gadgetGateway: { serviceToken } });
  assert.equal((await message(base, { Authorization: `Bearer ${serviceToken}` })).status, 401);
  assert.equal(calls.length, 0);
});
