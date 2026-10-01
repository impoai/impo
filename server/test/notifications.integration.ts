import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { once } from 'node:events';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { users, notificationEvents, notificationDeliveries, pushInstallations } from '../src/db/schema.js';
import { NotificationRepository, enqueueNotification } from '../src/notifications/repository.js';
import { notificationActivities, NotificationProvisioner } from '../src/notifications/worker.js';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { createTemporalWorker } from '../src/temporal/worker.js';
import { DevelopmentWorker } from '../src/worker/worker.js';
import { RuntimeRepository } from '../src/persistence/runtime-repository.js';
import { createApiServer } from '../src/http/api-server.js';
import type { Registration } from '../src/notifications/contract.js';

const database = createDatabase(process.env.DATABASE_URL!);
after(() => database.close());
async function fixture() {
  const [alice, bob] = await database.db.insert(users).values(['a', 'b'].map(name => ({ authProvider: 'push-test', authSubject: randomUUID(), name }))).returning();
  const repo = new NotificationRepository(database.db);
  const id = randomUUID();
  const registration: Registration = { installationSecret: randomUUID(), revision: 1, registrationId: randomUUID(), platform: 'android', token: 'test-' + randomUUID(), enabled: true, foreground: false };
  await repo.register(alice!.id, id, registration);
  return { repo, alice: alice!.id, bob: bob!.id, id, registration };
}
async function enqueue(userId: string, sourceKey = randomUUID(), category: 'chat' | 'tasks' | 'brief' = 'chat') {
  await database.db.transaction(tx => enqueueNotification(tx, { userId, sourceKey, category, targetId: randomUUID() }));
  const [event] = await database.db.select().from(notificationEvents).where(eq(notificationEvents.sourceKey, sourceKey));
  return event!;
}
test('source retries create one event and one delivery; retryable FCM failure recovers', async () => {
  const f = await fixture(); const source = randomUUID();
  const event = await enqueue(f.alice, source); await enqueue(f.alice, source);
  assert.equal((await f.repo.deliveries(event.id)).length, 1);
  let sends = 0;
  const activity = notificationActivities(f.repo, { async send(input) {
    assert.equal(input.registrationId, f.registration.registrationId);
    sends++; return sends === 1 ? { status: 'pending', code: 'http_503' } : { status: 'sent', messageId: 'fcm/receipt' };
  } });
  assert.equal((await activity.deliverNotification(event.id)).done, false);
  assert.equal((await activity.deliverNotification(event.id)).done, true);
  await activity.deliverNotification(event.id); assert.equal(sends, 2);
});
test('foreground on any account device suppresses Chat and Tasks, including before send; Brief remains independent', async () => {
  const f = await fixture(); const pending = await enqueue(f.alice);
  await f.repo.register(f.alice, randomUUID(), { ...f.registration, installationSecret: randomUUID(), registrationId: randomUUID(), token: null, enabled: false, foreground: true });
  assert.equal((await enqueue(f.alice)).status, 'suppressed');
  assert.equal((await enqueue(f.alice, randomUUID(), 'tasks')).status, 'suppressed');
  assert.equal((await enqueue(f.alice, randomUUID(), 'brief')).status, 'pending');
  let sends = 0;
  assert.equal((await notificationActivities(f.repo, { async send() { sends++; return { status: 'sent' }; } }).deliverNotification(pending.id)).done, true);
  assert.equal(sends, 0);
  await database.db.update(pushInstallations).set({ presenceAt: new Date(Date.now() - 61_000) }).where(eq(pushInstallations.userId, f.alice));
  assert.equal((await enqueue(f.alice)).status, 'pending');
});
test('preferences sync by owner, cancel pending delivery and do not backfill after re-enable', async () => {
  const f = await fixture(); const event = await enqueue(f.alice);
  await f.repo.updateSettings(f.alice, { chat: false, brief: false });
  assert.deepEqual(await f.repo.settings(f.alice), { chat: false, tasks: true, brief: false });
  assert.deepEqual(await f.repo.settings(f.bob), { chat: true, tasks: true, brief: true });
  assert.equal((await enqueue(f.alice)).status, 'suppressed');
  const activity = notificationActivities(f.repo, { async send() { assert.fail('Disabled category was delivered'); } });
  await activity.deliverNotification(event.id);
  await f.repo.updateSettings(f.alice, { chat: true });
  await activity.deliverNotification(event.id);
});
test('account transfer needs installation possession, fences old requests and suppresses old-account delivery', async () => {
  const f = await fixture(); const event = await enqueue(f.alice);
  await assert.rejects(f.repo.register(f.bob, f.id, { ...f.registration, revision: 2, installationSecret: randomUUID() }), { code: 'registration_conflict' });
  const next = { ...f.registration, revision: 3, registrationId: randomUUID() };
  await f.repo.register(f.bob, f.id, next);
  await assert.rejects(f.repo.register(f.alice, f.id, { ...f.registration, revision: 2 }), { code: 'registration_conflict' });
  await assert.rejects(f.repo.revoke(f.alice, f.id, { ...f.registration, revision: 4 }), { code: 'not_found' });
  await notificationActivities(f.repo, { async send() { assert.fail('Old account delivery'); } }).deliverNotification(event.id);
  await f.repo.revoke(f.bob, f.id, { ...next, revision: 4 });
  assert.equal((await enqueue(f.bob)).status, 'suppressed');
});
test('token rotation fences pending deliveries; invalid tokens are disabled without logging their value', async () => {
  const f = await fixture(); const old = await enqueue(f.alice);
  await f.repo.register(f.alice, f.id, { ...f.registration, revision: 2, token: 'rotated-' + randomUUID() });
  await notificationActivities(f.repo, { async send() { assert.fail('Old token delivery'); } }).deliverNotification(old.id);
  const event = await enqueue(f.alice);
  await notificationActivities(f.repo, { async send() { return { status: 'failed', code: 'UNREGISTERED', invalidToken: true }; } }).deliverNotification(event.id);
  const [row] = await database.db.select().from(pushInstallations).where(eq(pushInstallations.id, f.id));
  assert.equal(row!.token, null); assert.equal(row!.enabled, false);
});
test('HTTP endpoints enforce authentication, ownership, shape and category validation', async () => {
  const repo = new NotificationRepository(database.db);
  const server = createApiServer(new RuntimeRepository(database.db), { notifications: repo });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  async function request(path: string, method = 'GET', body?: unknown, token = 'instant-dev-alice') {
    return fetch(`http://127.0.0.1:${port}/api/v1/notifications/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  try {
    assert.equal((await request('settings', 'GET', undefined, 'wrong')).status, 401);
    assert.equal((await request('settings', 'PATCH', { chat: 'yes' })).status, 400);
    assert.equal((await request('settings', 'PATCH', { echo: true })).status, 400);
    const changed = await request('settings', 'PATCH', { tasks: false }); assert.equal(changed.status, 200);
    assert.equal((await changed.json()).tasks, false);
    assert.equal((await (await request('settings', 'GET', undefined, 'instant-dev-bob')).json()).tasks, true);
    const id = randomUUID(); const registration = { installationSecret: randomUUID(), revision: 1, registrationId: randomUUID(), platform: 'ios', token: null, enabled: false, foreground: true };
    assert.equal((await request(`installations/${id}`, 'PUT', registration)).status, 200);
    const revoke = { installationSecret: registration.installationSecret, registrationId: registration.registrationId, revision: 2 };
    assert.equal((await request(`installations/${id}`, 'DELETE', revoke, 'instant-dev-bob')).status, 404);
    assert.equal((await request(`installations/${id}`, 'DELETE', revoke)).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('real completion hooks enqueue Chat/Task once and cancellation creates no alert', async () => {
  const f = await fixture(); const runtime = new RuntimeRepository(database.db);
  const worker = new DevelopmentWorker(runtime, { leaseMs: 2000, pollIntervalMs: 1 });
  const chat = await runtime.acceptMessage(f.alice, { clientMessageId: randomUUID(), text: 'Notification completion test' });
  while (await worker.tick(new AbortController().signal)) { /* Drain durable completion stages. */ }
  const [event] = await database.db.select().from(notificationEvents).where(eq(notificationEvents.sourceKey, `turn/${chat.submissionId}`));
  assert.equal(event?.category, 'chat'); assert.equal(event?.status, 'pending');
  const task = await runtime.createUserTask(f.alice, { clientMessageId: randomUUID(), text: 'Notification task test' });
  while (await worker.tick(new AbortController().signal)) { /* Drain task stages. */ }
  const [taskEvent] = await database.db.select().from(notificationEvents).where(eq(notificationEvents.sourceKey, `turn/${task.submissionId}`));
  assert.equal(taskEvent?.category, 'tasks'); assert.equal(taskEvent?.targetId, task.taskId);
  const cancelled = await runtime.acceptMessage(f.alice, { clientMessageId: randomUUID(), text: 'Cancelled test' });
  await runtime.cancelSubmission(f.alice, cancelled.submissionId);
  assert.equal((await database.db.select().from(notificationEvents).where(eq(notificationEvents.sourceKey, `turn/${cancelled.submissionId}`))).length, 0);
});
test('Temporal outbox discovery deduplicates workflows and resumes a retryable delivery', { timeout: 60000 }, async () => {
  const f = await fixture(); const event = await enqueue(f.alice);
  class ScopedRepository extends NotificationRepository {
    override async pending() { return (await super.pending()).filter(row => row.id === event.id); }
  }
  const repository = new ScopedRepository(database.db);
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const queue = `push-test-${randomUUID()}`; let sends = 0;
  const activities = notificationActivities(repository, { async send() { sends++; return sends === 1 ? { status: 'pending', code: 'UNAVAILABLE' } : { status: 'sent', messageId: 'test/receipt' }; } });
  const worker = await createTemporalWorker({ address: env.address, namespace: 'default', taskQueue: queue }, activities);
  try {
    await worker.worker.runUntil(async () => {
      const provisioner = new NotificationProvisioner(repository, env.client, queue);
      await Promise.all([provisioner.scan(), provisioner.scan()]);
      await env.client.workflow.getHandle(`impo/notification/${event.id}`).result();
      assert.equal(sends, 2);
      const [saved] = await database.db.select().from(notificationEvents).where(eq(notificationEvents.id, event.id));
      assert.equal(saved!.status, 'done');
      assert.equal((await repository.pending()).length, 0);
    });
  } finally { await worker.close(); await env.teardown(); }
});
