import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { once } from 'node:events';
import { eq } from 'drizzle-orm';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { createDatabase } from '../src/db/client.js';
import { users, notificationEvents } from '../src/db/schema.js';
import { EchoScheduleRepository } from '../src/db/repositories/echo-schedule-repository.js';
import { NotificationRepository } from '../src/db/repositories/notification-repository.js';
import { RuntimeRepository } from '../src/db/repositories/runtime-repository.js';
import { createApiServer } from '../src/http/api-server.js';
import { createTemporalWorker } from '../src/temporal/worker.js';
import { notificationActivities } from '../src/notifications/worker.js';
import { defaultEchoSchedule, echoScheduleWorkflowId } from '../src/echo/schedule.js';
import { EchoScheduleProvisioner } from '../src/echo/worker.js';

const database = createDatabase(process.env.DATABASE_URL!);
after(() => database.close());
async function fixture() {
  const [user] = await database.db.insert(users).values({ authProvider: 'echo-test', authSubject: randomUUID(), name: 'Echo schedule test' }).returning();
  const due = new Date(); due.setUTCDate(due.getUTCDate() + 1); due.setUTCHours(9, 0, 0, 0);
  let now = new Date(due.getTime() - 1);
  const repo = new EchoScheduleRepository(database.db, () => now);
  const push = new NotificationRepository(database.db);
  const registration = { installationSecret: randomUUID(), revision: 1, registrationId: randomUUID(), platform: 'ios' as const, token: `synthetic-${randomUUID()}`, enabled: true, foreground: false };
  const installation = randomUUID(); await push.register(user!.id, installation, registration);
  const plan = await repo.save(user!.id, { ...defaultEchoSchedule(), enabled: true, weekdays: [1, 2, 3, 4, 5, 6, 7] });
  return { user: user!.id, due: due.getTime(), repo, push, plan, registration, installation, at: (value: number) => { now = new Date(value); },
    events: () => database.db.select().from(notificationEvents).where(eq(notificationEvents.userId, user!.id)) };
}

test('owned schedule API requires auth, validates config, preserves category preferences and fences stale edits', async () => {
  const repo = new EchoScheduleRepository(database.db);
  const server = createApiServer(new RuntimeRepository(database.db), { echoSchedules: repo, notifications: new NotificationRepository(database.db) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v1/`;
  const request = (path: string, method = 'GET', body?: unknown, token = 'instant-dev-alice') => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    assert.equal((await request('echo/schedule', 'GET', undefined, 'wrong')).status, 401);
    const initial = await (await request('echo/schedule')).json(); assert.equal(initial.enabled, false);
    assert.equal((await request('echo/schedule', 'PUT', { ...initial, weekdays: [] })).status, 400);
    assert.equal((await request('echo/schedule', 'PUT', { ...initial, userId: randomUUID() })).status, 400);
    await request('notifications/settings', 'PATCH', { chat: false });
    const input = { ...initial, enabled: true, timeZone: 'Asia/Shanghai' };
    const response = await request('echo/schedule', 'PUT', input); assert.equal(response.status, 200);
    const saved = await response.json(); assert.ok(saved.revision);
    assert.deepEqual(await (await request('echo/schedule', 'PUT', input)).json(), saved, 'lost-response retry retains revision');
    assert.equal((await request('echo/schedule', 'PUT', { ...input, stopTime: '19:00' })).status, 409);
    assert.equal((await (await request('echo/schedule', 'GET', undefined, 'instant-dev-bob')).json()).enabled, false);
    const preferences = await (await request('notifications/settings')).json(); assert.equal(preferences.chat, false); assert.equal(preferences.echoSchedule, undefined);
    await request('notifications/settings', 'PATCH', { echo: false });
    assert.deepEqual(await (await request('echo/schedule')).json(), saved, 'category edits preserve the schedule');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('calendar reminder is once per revision/day, expires in 15 minutes and rejects early/late/incorrect occurrences', async () => {
  const f = await fixture(); assert.equal((await f.repo.plan(f.user)).nextAt, f.due);
  await f.repo.remind(f.user, f.plan.revision!, f.due); assert.equal((await f.events()).length, 0);
  f.at(f.due); await f.repo.remind(f.user, f.plan.revision!, f.due + 1000);
  await f.repo.remind(f.user, f.plan.revision!, f.due); await f.repo.remind(f.user, f.plan.revision!, f.due);
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0]!.category, 'echo');
  assert.equal(events[0]!.expiresAt.getTime(), f.due + 15 * 60_000);
  let calls = 0;
  await notificationActivities(f.push, { async send(input) { calls++; assert.equal(input.category, 'echo'); return { status: 'sent' }; } }).deliverNotification(events[0]!.id);
  assert.equal(calls, 1);
  const g = await fixture(); g.at(g.due + 15 * 60_000); await g.repo.remind(g.user, g.plan.revision!, g.due); assert.equal((await g.events()).length, 0);
});

test('schedule edits, disabled category and foreground presence suppress reminders without changing automatic stop config', async () => {
  const f = await fixture(); f.at(f.due); await f.repo.remind(f.user, f.plan.revision!, f.due);
  const [event] = await f.events();
  const changed = await f.repo.save(f.user, { ...f.plan, reminderTime: '09:30' });
  await notificationActivities(f.push, { async send() { assert.fail('Stale schedule delivery'); } }).deliverNotification(event!.id);
  await f.repo.remind(f.user, f.plan.revision!, f.due); assert.equal((await f.events()).length, 1);
  assert.notEqual(changed.revision, f.plan.revision);
  for (const mode of ['category', 'foreground', 'schedule']) {
    const g = await fixture(); g.at(g.due);
    if (mode === 'category') await g.push.updateSettings(g.user, { echo: false });
    if (mode === 'foreground') await g.push.register(g.user, g.installation, { ...g.registration, revision: 2, foreground: true });
    if (mode === 'schedule') await g.repo.save(g.user, { ...g.plan, enabled: false });
    await g.repo.remind(g.user, g.plan.revision!, g.due);
    assert.ok((await g.events()).every(event => event.status === 'suppressed'));
    assert.equal((await g.repo.get(g.user)).autoStop, true);
  }
});

test('Temporal discovery starts one durable schedule and revision signals cancel the old timer', { timeout: 60000 }, async () => {
  const f = await fixture();
  class Scoped extends EchoScheduleRepository { override async list(after?: string) { return (await super.list(after)).filter(row => row.userId === f.user); } }
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const queue = `echo-test-${randomUUID()}`; let revision = f.plan.revision!; const delivered: string[] = []; let plans = 0;
  let planned!: () => void; let ready = new Promise<void>(resolve => { planned = resolve; });
  const worker = await createTemporalWorker({ address: env.address, namespace: 'default', taskQueue: queue }, {
    async planEchoReminder() { plans++; planned(); return { revision, nextAt: delivered.length ? null : (await env.currentTimeMs()) + 60_000 }; },
    async sendEchoReminder(_user: string, value: string) { delivered.push(value); },
  });
  try {
    await worker.worker.runUntil(async () => {
      const provisioner = new EchoScheduleProvisioner(new Scoped(database.db), env.client, queue);
      await provisioner.scan(); await ready;
      const handle = env.client.workflow.getHandle(echoScheduleWorkflowId(f.user));
      revision = randomUUID(); ready = new Promise<void>(resolve => { planned = resolve; });
      await handle.signal('echoScheduleChanged', revision); await ready;
      await handle.signal('echoScheduleChanged', revision);
      await handle.result(); assert.deepEqual(delivered, [revision]); assert.ok(plans >= 2);
    });
  } finally { await worker.close(); await env.teardown(); }
});
