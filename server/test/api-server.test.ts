import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createApiServer, type ApiRepository } from '../src/http/api-server.js';

function notImplemented(name: string) {
  return () => { throw new Error(`Unexpected call to ${name}: authentication must reject before any repository access`); };
}

// Auth must reject before touching the repository; every method here is a trap.
const stubRepository = {
  health: notImplemented('health'), findUser: notImplemented('findUser'), findOrCreateUser: notImplemented('findOrCreateUser'),
  acceptMessage: notImplemented('acceptMessage'), getConversation: notImplemented('getConversation'),
  getSubmission: notImplemented('getSubmission'), cancelSubmission: notImplemented('cancelSubmission'), readEvents: notImplemented('readEvents'),
} as unknown as ApiRepository;

async function listen(t: TestContext, options: Parameters<typeof createApiServer>[1] = {}) {
  const server = createApiServer(stubRepository, options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return base;
}

test('clerk auth mode rejects a request with no Authorization header', async t => {
  const base = await listen(t, { auth: { mode: 'clerk', secretKey: 'sk_test_0000000000000000000000000000000000000000' } });
  const response = await fetch(`${base}/api/v1/conversation`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'unauthorized');
});

test('clerk auth mode rejects a malformed Bearer token without any network call', async t => {
  const base = await listen(t, { auth: { mode: 'clerk', secretKey: 'sk_test_0000000000000000000000000000000000000000' } });
  const response = await fetch(`${base}/api/v1/conversation`, { headers: { authorization: 'Bearer not-a-real-jwt' } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'unauthorized');
});

test('a stale instant-dev-* header is rejected once the server is configured for clerk mode', async t => {
  const base = await listen(t, { auth: { mode: 'clerk', secretKey: 'sk_test_0000000000000000000000000000000000000000' } });
  const response = await fetch(`${base}/api/v1/conversation`, { headers: { authorization: 'Bearer instant-dev-alice' } });
  assert.equal(response.status, 401);
});

test('local-dev remains the default and its fixed identities keep working unchanged', async t => {
  const base = await listen(t);
  const anonymous = await fetch(`${base}/api/v1/conversation`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error.code, 'unauthorized');
  const wrongMode = await fetch(`${base}/api/v1/conversation`, { headers: { authorization: 'Bearer sk_test_looks_like_a_clerk_token' } });
  assert.equal(wrongMode.status, 401);
});
