import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { once } from 'node:events';
import { eq } from 'drizzle-orm';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { createDatabase } from '../src/db/client.js';
import { users, notificationEvents, scheduledTasks, scheduledTaskRuns, accountDeletions } from '../src/db/schema.js';
import { ScheduledTaskRepository } from '../src/db/repositories/scheduled-task-repository.js';
import { RuntimeRepository } from '../src/db/repositories/runtime-repository.js';
import { AccountDeletionRepository } from '../src/db/repositories/account-deletion-repository.js';
import { NotificationRepository } from '../src/db/repositories/notification-repository.js';
import { createApiServer } from '../src/http/api-server.js';
import { DevelopmentWorker } from '../src/worker/worker.js';
import { createTemporalWorker } from '../src/temporal/worker.js';
import { scheduledTaskWorkflowId, type ScheduledTaskInput } from '../src/scheduling/contract.js';
import { ScheduledTaskProvisioner } from '../src/scheduling/worker.js';

const database = createDatabase(process.env.DATABASE_URL!);
after(() => database.close());
const input: ScheduledTaskInput = { title: 'Daily research', goal: 'Research the latest AI news and cite sources.', enabled: true,
  schedule: { frequency: 'daily', timeZone: 'UTC', runAt: null, time: '09:00', weekdays: [] } };
async function fixture() {
  const [user] = await database.db.insert(users).values({ authProvider: 'schedule-test', authSubject: randomUUID(), name: 'Schedule test' }).returning();
  let now = new Date('2027-01-01T08:00:00Z');
  const repo = new ScheduledTaskRepository(database.db, { provider: 'development' }, () => now);
  return { user: user!.id, repo, at: (date: string) => { now = new Date(date); } };
}
test('schedule API enforces auth, ownership, validation, idempotency and revision conflicts', async () => {
  const repo = new ScheduledTaskRepository(database.db);
  const server = createApiServer(new RuntimeRepository(database.db), { scheduledTasks: repo });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/scheduled-tasks`;
  const request = (path = '', method = 'GET', body?: unknown, token = 'instant-dev-alice') => fetch(base + path, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await request('', 'GET', undefined, 'wrong')).status, 401);
    const body = { ...input, clientRequestId: randomUUID() };
    assert.equal((await request('', 'POST', { ...body, userId: randomUUID() })).status, 400);
    const responses = await Promise.all([request('', 'POST', body), request('', 'POST', body)]);
    assert.equal(responses[0]!.status, 201);
    const first = await responses[0]!.json(); assert.deepEqual(await responses[1]!.json(), first);
    assert.equal((await request('', 'POST', { ...body, title: 'Different' })).status, 409);
    for (const [path, method, value] of [[`/${first.id}`, 'GET', undefined], [`/${first.id}/runs`, 'GET', undefined], [`/${first.id}`, 'PUT', { ...input, revision: first.revision }], [`/${first.id}`, 'DELETE', { revision: first.revision }]] as const)
      assert.equal((await request(path, method, value, 'instant-dev-bob')).status, 404);
    const update = { ...input, enabled: false, revision: first.revision };
    const paused = await (await request(`/${first.id}`, 'PUT', update)).json(); assert.equal(paused.nextRunAt, null);
    assert.deepEqual(await (await request(`/${first.id}`, 'PUT', update)).json(), paused);
    assert.equal((await request(`/${first.id}`, 'PUT', { ...input, title: 'Changed', revision: first.revision })).status, 409);
    assert.equal((await request(`/${first.id}/runs?before=bad`)).status, 400);
    assert.equal((await request(`/${first.id}`, 'DELETE', { revision: paused.revision })).status, 200);
    assert.equal((await request(`/${first.id}`)).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('atomic admission deduplicates timers, skips overlaps and catches up only once after an outage', async () => {
  const f = await fixture(), plan = await f.repo.create(f.user, randomUUID(), input), at = Date.parse(plan.nextRunAt!);
  assert.equal(await f.repo.fire(f.user, plan.id, plan.revision, at), undefined);
  f.at('2027-01-01T09:00:00Z');
  const receipts = await Promise.all(Array.from({ length: 6 }, () => f.repo.fire(f.user, plan.id, plan.revision, at)));
  assert.equal(receipts.filter(Boolean).length, 1); assert.equal((await f.repo.runs(f.user, plan.id)).runs.length, 1);
  f.at('2027-01-02T09:00:00Z'); await f.repo.fire(f.user, plan.id, plan.revision, Date.parse('2027-01-02T09:00Z'));
  assert.equal((await f.repo.runs(f.user, plan.id)).runs[0]!.status, 'skipped_overlap');
  const runtime = new RuntimeRepository(database.db); await runtime.cancelSubmission(f.user, receipts.find(Boolean)!.submissionId);
  f.at('2027-01-07T10:00:00Z'); await f.repo.fire(f.user, plan.id, plan.revision, Date.parse('2027-01-03T09:00Z'));
  assert.equal((await f.repo.get(f.user, plan.id)).nextRunAt, '2027-01-08T09:00:00.000Z');
  assert.equal((await f.repo.runs(f.user, plan.id)).runs.length, 3);
});
test('paused, changed and deleted schedules fence stale timers; once completes after one admission', async () => {
  const f = await fixture();
  const first = await f.repo.create(f.user, randomUUID(), input);
  const paused = await f.repo.update(f.user, first.id, first.revision, { ...input, enabled: false });
  f.at('2027-01-01T09:00Z'); await f.repo.fire(f.user, first.id, first.revision, Date.parse(first.nextRunAt!));
  assert.equal((await f.repo.runs(f.user, first.id)).runs.length, 0);
  const resumed = await f.repo.update(f.user, first.id, paused.revision, input);
  await f.repo.remove(f.user, first.id, resumed.revision); f.at('2027-01-02T09:00Z');
  await f.repo.fire(f.user, first.id, resumed.revision, Date.parse(resumed.nextRunAt!));
  assert.equal((await f.repo.plan(f.user, first.id)).nextAt, null);
  const once = await f.repo.create(f.user, randomUUID(), { ...input, schedule: { frequency: 'once', timeZone: 'UTC', runAt: '2027-01-02T10:00:00Z', time: null, weekdays: [] } });
  f.at('2027-01-02T11:00Z'); await f.repo.fire(f.user, once.id, once.revision, Date.parse(once.nextRunAt!));
  assert.equal((await f.repo.plan(f.user, once.id)).nextAt, null);
  assert.equal((await f.repo.runs(f.user, once.id)).runs.length, 1);
});
test('scheduled completion has its own preference and suppresses notifications in foreground', async () => {
  for (const mode of ['enabled', 'disabled', 'foreground']) {
    const f = await fixture(), push = new NotificationRepository(database.db);
    await push.updateSettings(f.user, { tasks: false, scheduledTasks: mode !== 'disabled' });
    await push.register(f.user, randomUUID(), { installationSecret: randomUUID(), revision: 1, registrationId: randomUUID(), platform: 'ios', token: `synthetic-${randomUUID()}`, enabled: true, foreground: mode === 'foreground' });
    const plan = await f.repo.create(f.user, randomUUID(), input); f.at('2027-01-01T09:00Z');
    const receipt = await f.repo.fire(f.user, plan.id, plan.revision, Date.parse(plan.nextRunAt!));
    const worker = new DevelopmentWorker(new RuntimeRepository(database.db), { leaseMs: 2000, pollIntervalMs: 1 });
    while (await worker.tick(new AbortController().signal)) { /* Drain durable task stages. */ }
    const [event] = await database.db.select().from(notificationEvents).where(eq(notificationEvents.sourceKey, `turn/${receipt!.submissionId}`));
    assert.equal(event!.category, 'scheduledTasks'); assert.equal(event!.targetId, receipt!.taskId);
    assert.equal(event!.status, mode === 'enabled' ? 'pending' : 'suppressed');
    assert.equal((await f.repo.runs(f.user, plan.id)).runs[0]!.status, 'completed');
  }
});
test('account deletion captures every schedule workflow and atomically removes schedules and history', async () => {
  const f = await fixture(), plan = await f.repo.create(f.user, randomUUID(), input);
  f.at('2027-01-01T09:00Z'); await f.repo.fire(f.user, plan.id, plan.revision, Date.parse(plan.nextRunAt!));
  const accounts = new AccountDeletionRepository(database.db), challenge = await accounts.prepare(f.user);
  await accounts.confirm(f.user, { challengeId: challenge.challengeId, token: challenge.token, confirmation: 'DELETE' });
  const [deletion] = await database.db.select().from(accountDeletions).where(eq(accountDeletions.userId, f.user));
  assert.ok(deletion!.manifest!.workflows.includes(scheduledTaskWorkflowId(f.user, plan.id)));
  assert.equal((await database.db.select().from(scheduledTasks).where(eq(scheduledTasks.userId, f.user))).length, 0);
  assert.equal((await database.db.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.userId, f.user))).length, 0);
  assert.equal(await f.repo.fire(f.user, plan.id, plan.revision, Date.parse(plan.nextRunAt!)), undefined);
});
test('Temporal discovery and revision signals replace a durable timer without duplicate starts', { timeout: 60000 }, async () => {
  const f = await fixture(), plan = await f.repo.create(f.user, randomUUID(), input);
  class Scoped extends ScheduledTaskRepository { override async discover(after?: string) { return (await super.discover(after)).filter(row => row.id === plan.id); } }
  const env = await TestWorkflowEnvironment.createTimeSkipping(), queue = `schedule-${randomUUID()}`;
  let revision = plan.revision, plans = 0, planned!: () => void;
  let ready = new Promise<void>(resolve => { planned = resolve; }); const starts: string[] = [];
  const worker = await createTemporalWorker({ address: env.address, namespace: 'default', taskQueue: queue }, {
    async planScheduledTask() { plans++; planned(); return { revision, nextAt: starts.length ? null : (await env.currentTimeMs()) + 60000 }; },
    async startScheduledTask(_user: string, _id: string, value: string) { starts.push(value); },
  });
  try { await worker.worker.runUntil(async () => {
    const provisioner = new ScheduledTaskProvisioner(new Scoped(database.db), env.client, queue);
    await provisioner.scan(); await ready;
    const handle = env.client.workflow.getHandle(scheduledTaskWorkflowId(f.user, plan.id));
    revision = randomUUID(); ready = new Promise<void>(resolve => { planned = resolve; });
    await handle.signal('taskScheduleChanged', revision); await ready;
    await provisioner.scan(); await handle.result(); assert.deepEqual(starts, [revision]); assert.ok(plans >= 2);
  }); } finally { await worker.close(); await env.teardown(); }
});
