import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { once } from 'node:events';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { AccountDeletionRepository } from '../src/db/repositories/account-deletion-repository.js';
import { RuntimeRepository } from '../src/db/repositories/runtime-repository.js';
import { NotificationRepository } from '../src/db/repositories/notification-repository.js';
import { createApiServer } from '../src/http/api-server.js';
import { deletionGraceMs } from '../src/accounts/contract.js';
import { accountDeletionActivities } from '../src/accounts/worker.js';

const database = createDatabase(process.env.DATABASE_URL!);
after(() => database.close());
const runtime = new RuntimeRepository(database.db);
async function fixture() {
  const subject = randomUUID();
  const alice = await runtime.findOrCreateUser('account-test', subject, 'Alice');
  const bob = await runtime.findOrCreateUser('account-test', randomUUID(), 'Bob');
  let now = new Date();
  const repo = new AccountDeletionRepository(database.db, () => now);
  return { alice: alice.id, bob: bob.id, subject, repo, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
const confirmed = (challenge: { challengeId: string; token: string }) => ({ challengeId: challenge.challengeId, token: challenge.token, confirmation: 'DELETE' });

test('both confirmations are required; tokens are owned, short-lived and replaced by a new warning', async () => {
  const f = await fixture();
  const first = await f.repo.prepare(f.alice);
  await assert.rejects(f.repo.confirm(f.alice, { ...confirmed(first), confirmation: 'delete' }), { code: 'deletion_confirmation_required' });
  await assert.rejects(f.repo.confirm(f.bob, confirmed(first)), { code: 'deletion_confirmation_required' });
  const second = await f.repo.prepare(f.alice);
  await assert.rejects(f.repo.confirm(f.alice, confirmed(first)), { code: 'deletion_confirmation_required' });
  f.advance(301_000);
  await assert.rejects(f.repo.confirm(f.alice, confirmed(second)), { code: 'deletion_confirmation_expired' });
  assert.equal((await database.db.select().from(s.users).where(eq(s.users.id, f.alice))).length, 1);
});

test('deletion removes owned relational data atomically, captures cloud handles and preserves another user', async () => {
  const f = await fixture();
  for (const userId of [f.alice, f.bob]) {
    await runtime.acceptMessage(userId, { clientMessageId: randomUUID(), text: 'Private text' });
    const [message] = await database.db.select().from(s.messages).where(eq(s.messages.userId, userId));
    await database.db.insert(s.messageClientActions).values({ id: randomUUID(), userId, messageId: message!.id,
      part: { type: 'dynamic-tool', toolName: 'impo_open_link', toolCallId: randomUUID(), state: 'output-available', input: {}, output: { kind: 'client_action' } } });
    await database.db.insert(s.userProfiles).values({ userId });
    await database.db.insert(s.memoryDatabases).values({ userId, databaseName: `impo-mem-${userId}`, url: 'file:unused' });
    await database.db.insert(s.memoryState).values({ userId });
    await database.db.insert(s.connectorConnections).values({ userId, toolkit: 'gmail', generation: randomUUID(), entityId: `owned-${userId}`, authConfigId: 'config-test', status: 'pending' });
    const notifications = new NotificationRepository(database.db);
    await notifications.updateSettings(userId, { chat: false });
    await notifications.register(userId, randomUUID(), { installationSecret: randomUUID(), revision: 1, registrationId: randomUUID(), token: 'synthetic-' + userId, platform: 'ios', enabled: true, foreground: false });
  }
  const receipt = await f.repo.confirm(f.alice, confirmed(await f.repo.prepare(f.alice)));
  const job = await f.repo.work(receipt.requestId);
  assert.equal(job!.manifest!.connections[0]!.entityId, `owned-${f.alice}`);
  assert.equal(job!.manifest!.conversationIds.length, 1);
  for (const table of [s.messageClientActions, s.userProfiles, s.conversations, s.messages, s.runtimeSubmissions, s.outboxJobs, s.memoryDatabases, s.memoryState, s.connectorConnections, s.notificationSettings, s.pushInstallations]) {
    assert.equal((await database.db.select().from(table).where(eq(table.userId, f.alice))).length, 0);
    assert.ok((await database.db.select().from(table).where(eq(table.userId, f.bob))).length > 0);
  }
  assert.equal((await database.db.select().from(s.users).where(eq(s.users.id, f.alice))).length, 0);
  await assert.rejects(runtime.findOrCreateUser('account-test', f.subject, 'Restored?'), { code: 'account_deleted' });
  assert.equal((await runtime.findOrCreateUser('account-test', randomUUID(), 'A new account')).id.length, 36);
});

test('concurrent confirmation is idempotent and stale credentials cannot recreate the identity', async () => {
  const f = await fixture(), input = confirmed(await f.repo.prepare(f.alice));
  const receipts = await Promise.all(Array.from({ length: 4 }, () => f.repo.confirm(f.alice, input)));
  assert.equal(new Set(receipts.map(r => r.requestId)).size, 1);
  for (let i = 0; i < 8; i++) await assert.rejects(runtime.findOrCreateUser('account-test', f.subject, 'Old token'), { code: 'account_deleted' });
  assert.equal((await f.repo.status(receipts[0]!.requestId, input.token)).status, 'deleting');
  await assert.rejects(f.repo.status(receipts[0]!.requestId, randomUUID()), { code: 'not_found' });
});

test('provider failures retry independently; final sweep is required and scrubs the cloud manifest', async () => {
  const f = await fixture(); const receipt = await f.repo.confirm(f.alice, confirmed(await f.repo.prepare(f.alice)));
  let attempts = 0, otherCalls = 0;
  const activity = accountDeletionActivities(f.repo, {
    upstream: async (userId, manifest) => { assert.equal(userId, f.alice); assert.equal(manifest.authSubject, f.subject); if (++attempts === 1) throw new Error('secret-must-not-escape'); },
    independent: async () => { otherCalls++; },
  });
  await assert.rejects(activity.cleanupAccount(receipt.requestId), { message: 'Account cleanup will retry' });
  assert.equal(otherCalls, 1);
  assert.equal((await f.repo.work(receipt.requestId))!.lastError, 'upstream');
  assert.ok(await activity.cleanupAccount(receipt.requestId) > 0);
  await assert.rejects(f.repo.complete(receipt.requestId));
  f.advance(deletionGraceMs + 1);
  await activity.cleanupAccount(receipt.requestId); await activity.finishAccountDeletion(receipt.requestId);
  const [row] = await database.db.select().from(s.accountDeletions).where(eq(s.accountDeletions.id, receipt.requestId));
  assert.equal(row!.status, 'completed'); assert.equal(row!.manifest, null);
  assert.equal((await f.repo.status(receipt.requestId, receipt.receiptToken!)).status, 'deleted');
  assert.equal(await activity.cleanupAccount(receipt.requestId), 0);
});

test('HTTP deletion requires login, two steps and a valid receipt; closed sessions are fenced', async () => {
  const repo = new AccountDeletionRepository(database.db);
  const server = createApiServer(runtime, { accounts: repo, accountDeletionEnabled: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, method = 'GET', body?: unknown, token = 'instant-dev-alice') => fetch(origin + '/api/v1/' + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    assert.equal((await call('account/deletion-challenge', 'POST', {}, 'wrong')).status, 401);
    assert.equal((await call('account', 'DELETE', {})).status, 400);
    const challenge = await (await call('account/deletion-challenge', 'POST', {})).json();
    const response = await call('account', 'DELETE', confirmed(challenge)); assert.equal(response.status, 202);
    const receipt = await response.json();
    assert.equal((await call('conversation')).status, 410);
    assert.equal((await call('account', 'DELETE', confirmed(challenge))).status, 202);
    assert.equal((await call(`account/deletions/${receipt.requestId}`, 'GET', undefined, receipt.receiptToken)).status, 200);
    assert.equal((await call(`account/deletions/${receipt.requestId}`)).status, 404);
    assert.equal((await call('account/deletion-challenge', 'POST', {}, 'instant-dev-bob')).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Temporal runs both cleanup sweeps and removes only the owned workflow history', { timeout: 120000 }, async () => {
  const { TestWorkflowEnvironment } = await import('@temporalio/testing');
  const { createTemporalWorker } = await import('../src/temporal/worker.js');
  const { createAccountCleanup } = await import('../src/accounts/cleanup.js');
  const { loadConfig } = await import('../src/config.js');
  const env = await TestWorkflowEnvironment.createLocal();
  const queue = `accounts-${randomUUID()}`;
  let sweeps = 0, finished = false;
  const worker = await createTemporalWorker({ address: env.address, namespace: 'default', taskQueue: queue }, {
    cleanupAccount: async () => { sweeps++; return sweeps === 1 ? 100 : 0; },
    finishAccountDeletion: async () => { assert.equal(sweeps, 2); finished = true; },
    deliverNotification: async () => ({ done: false, retryAfterMs: 60_000 }),
  });
  try {
    await worker.worker.runUntil(async () => {
      await env.client.workflow.execute('accountDeletionWorkflow', { workflowId: `delete-test-${randomUUID()}`, taskQueue: queue, args: [randomUUID()] });
      assert.equal(finished, true);
      const owned = await env.client.workflow.start('notificationWorkflow', { workflowId: `owned-${randomUUID()}`, taskQueue: queue, args: ['test'] });
      const other = await env.client.workflow.start('notificationWorkflow', { workflowId: `other-${randomUUID()}`, taskQueue: queue, args: ['test'] });
      const cleanup = createAccountCleanup(loadConfig('worker'), env.client);
      const manifest = { authProvider: 'test', authSubject: 'test', conversationIds: [], sessionIds: [], agentIds: [], objectKeys: [], memoryDatabaseName: '', connections: [], workflows: [owned.workflowId] };
      // Production activities retry while Temporal's asynchronous deletion is pending.
      for (let i = 0; ; i++) {
        try { await cleanup.workflows!(randomUUID(), manifest); break; }
        catch (error) { if (!(error instanceof Error) || error.message !== 'Workflow history deletion is still pending' || i >= 45) throw error; }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      await assert.rejects(owned.describe(), { name: 'WorkflowNotFoundError' });
      assert.equal((await other.describe()).status.name, 'RUNNING');
      await other.terminate();
    });
  } finally { await worker.close(); await env.teardown(); }
});
