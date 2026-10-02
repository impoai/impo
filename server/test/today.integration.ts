import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { conversations, messages, todayBriefs, todaySettings, users, notificationEvents, userProfiles } from '../src/db/schema.js';
import { TodayRepository } from '../src/db/repositories/today-repository.js';
import { todayStep } from '../src/today/worker.js';
import { RebyteGateway } from '../src/rebyte/gateway.js';
import { createApiServer, type ApiRepository } from '../src/http/api-server.js';
import { FakeRebyte } from './helpers/fake-rebyte.js';
import { ProfileRepository } from '../src/db/repositories/profile-repository.js';
import { modelModes } from '../src/model-modes.js';
import { briefConfigVersion } from '../src/today/contract.js';

const slots = [{ id: 'morning', label: 'Morning Brief', hour: 0, enabled: true }];
const context = (userId: string) => ({ userId, scheduledAt: Date.now(), tickId: randomUUID(), idempotencyKey: randomUUID(), signal: AbortSignal.timeout(20000) });
const quiet = JSON.stringify({ title: 'A little room for your day', summary: 'There is not enough shared information for personal suggestions yet.', cards: [] });

async function fixture(t: TestContext) {
  const db = createDatabase(process.env.DATABASE_URL!);
  const repository = new TodayRepository(db.db);
  const userId = randomUUID(); const otherId = randomUUID();
  await db.db.insert(users).values([userId, otherId].map(id => ({ id, authProvider: 'today-test', authSubject: id, name: 'Test user' })));
  await repository.configure(userId, { timeZone: 'Asia/Shanghai', locale: 'en', slots });
  const fake = new FakeRebyte(); const baseURL = await fake.listen();
  const gateway = new RebyteGateway({ apiKey: 'instant-fake-rebyte-key', baseURL, model: 'test-model', timeoutMs: 2000 });
  t.after(async () => {
    await fake.close();
    await db.db.delete(todayBriefs).where(eq(todayBriefs.userId, userId));
    await db.db.delete(todaySettings).where(eq(todaySettings.userId, userId));
    await db.db.delete(messages).where(eq(messages.userId, userId));
    await db.db.delete(conversations).where(eq(conversations.userId, userId));
    await db.db.delete(userProfiles).where(eq(userProfiles.userId, userId));
    await db.db.delete(users).where(eq(users.id, userId)); await db.db.delete(users).where(eq(users.id, otherId));
    await db.close();
  });
  return { db, repository, fake, gateway, userId, otherId, baseURL };
}

test('Today editions: concurrent workers, cross-tick dedup, history pagination, API ownership and deletion', { timeout: 30000 }, async t => {
  const f = await fixture(t); f.fake.answers.push(quiet);
  const step = todayStep(f.repository, f.gateway, 'test-model', 15);
  await Promise.all([step.run(context(f.userId)), step.run(context(f.userId))]);
  await step.run(context(f.userId));
  assert.equal(f.fake.sessions.length, 1);
  const first = (await f.repository.list(f.userId, 1)).briefs[0]!;
  assert.equal(first.status, 'completed'); assert.ok(first.content);
  const notifications = await f.db.db.select().from(notificationEvents).where(eq(notificationEvents.userId, f.userId));
  assert.equal(notifications.length, 1, 'Concurrent/retried hourly steps create only one notification event');
  assert.equal(notifications[0]!.category, 'brief'); assert.equal(notifications[0]!.targetId, first.id);
  assert.equal(notifications[0]!.status, 'suppressed', 'No registered installation means no historical delivery');
  const stored = await f.repository.owned(f.userId, first.id);
  assert.ok(stored.providerSessionId); assert.ok(stored.providerTurnId); assert.ok(stored.providerItemId);
  const session = f.fake.sessions[0]!;
  assert.equal(session.environment.type, 'none', 'a scheduled brief still has no Sandbox');
  assert.ok(session.agent.instructions.includes('## Impo'));
  assert.ok(session.agent.instructions.includes('## Scheduled task'));
  assert.ok(!session.agent.instructions.includes('## Main conversation'));
  const dynamic = JSON.parse(String(session.agent.instructions).split('\n').at(-1)!);
  assert.deepEqual(dynamic.profile, stored.input!.profile);
  assert.equal(dynamic.localDate, stored.localDate);
  assert.equal(dynamic.timeZone, 'Asia/Shanghai');
  assert.equal(dynamic.locale, 'en');
  assert.equal(stored.configVersion, briefConfigVersion);
  // Another edition and another date append without overwriting the first one.
  await f.repository.configure(f.userId, { timeZone: 'Asia/Shanghai', locale: 'en', slots: [{ id: 'evening', label: 'Evening Brief', hour: 0, enabled: true }] });
  f.fake.answers.push(quiet); await step.run(context(f.userId));
  const second = (await f.repository.list(f.userId, 1)).briefs[0]!;
  assert.notEqual(first.id, second.id);
  const future = await f.repository.ensureDue(f.userId, new Date(Date.now() + 86400_000));
  assert.ok(future); const page1 = await f.repository.list(f.userId, 1); const page2 = await f.repository.list(f.userId, 1, page1.nextCursor!);
  assert.notEqual(page1.briefs[0]!.id, page2.briefs[0]!.id);
  const identities = { findUser: async (subject: string) => ({ id: subject === 'alice' ? f.userId : f.otherId }) } as ApiRepository;
  const api = createApiServer(identities, { today: f.repository }); api.listen(0, '127.0.0.1'); await once(api, 'listening');
  t.after(async () => { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); });
  const address = api.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/v1/today`;
  const request = (path: string, who = 'alice', method = 'GET') => fetch(base + path, { method, headers: { Authorization: `Bearer instant-dev-${who}` } });
  const empty = await request('/briefs?limit=10', 'bob');
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { briefs: [], nextCursor: null });
  assert.equal((await request(`/briefs/${first.id}`, 'bob')).status, 404);
  assert.equal((await request(`/briefs/${first.id}`, 'bob', 'DELETE')).status, 404);
  assert.equal((await request('/briefs?date=2026-99-99')).status, 400);
  assert.equal((await request('/briefs?cursor=bad')).status, 400);
  const byDay = await (await request(`/briefs?date=${first.localDate}`)).json(); assert.equal(byDay.briefs.length, 2);
  assert.equal((await request(`/briefs/${second.id}`, 'alice', 'DELETE')).status, 200);
  const deleted = await f.repository.ensureDue(f.userId); assert.equal(deleted!.status, 'deleted');
  assert.equal((await f.repository.owned(f.userId, first.id)).status, 'completed');
});

test('Today recovers unknown Session creation without a second model run and repairs invalid JSON once', { timeout: 30000 }, async t => {
  const f = await fixture(t); f.fake.answers.push('not json', quiet); f.fake.holdNextCreate = true;
  const profiles = new ProfileRepository(f.db.db);
  await profiles.update(f.userId, { mode: 'Power' });
  const impatient = new RebyteGateway({ apiKey: 'instant-fake-rebyte-key', baseURL: f.baseURL, model: 'test-model', timeoutMs: 150 });
  await assert.rejects(todayStep(f.repository, impatient, 'test-model', 15, modelModes).run(context(f.userId)));
  assert.equal(f.fake.sessions.length, 1);
  assert.equal(f.fake.sessions[0]!.agent.model, modelModes.Power);
  await profiles.update(f.userId, { mode: 'Balanced' });
  f.fake.releaseCreateResponses();
  await todayStep(f.repository, f.gateway, 'test-model', 15, modelModes).run(context(f.userId));
  assert.equal(f.fake.sessions.length, 1);
  assert.equal(f.fake.sessions[0]!.agent.model, modelModes.Power, 'recovery keeps the model from the durable creation intent');
  const brief = (await f.repository.list(f.userId, 10)).briefs[0]!;
  assert.equal((await f.repository.owned(f.userId, brief.id)).model, modelModes.Power);
  assert.equal(f.fake.sessions[0]!.turns.length, 2);
  assert.equal((await f.repository.list(f.userId, 10)).briefs[0]!.status, 'completed');
});

test('source changes and deletion during generation cannot publish stale content; inputs are bounded and frozen', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const conversationId = randomUUID(); const messageId = randomUUID();
  await f.db.db.insert(conversations).values({ id: conversationId, userId: f.userId });
  await f.db.db.insert(messages).values({ id: messageId, userId: f.userId, conversationId, sequence: 1, role: 'user', text: 'Send the proposal tomorrow. '.repeat(3000), status: 'completed' });
  const queued = await f.repository.ensureDue(f.userId); assert.ok(queued);
  const row = (await f.repository.claim(f.userId))!;
  const input = await f.repository.input(row); assert.equal(input.truncated, true); assert.ok(JSON.stringify(input).length < 30000);
  assert.equal(input.sources[0]!.occurredLocalDate, input.localDate);
  const after = await f.repository.owned(f.userId, row.id); assert.deepEqual(await f.repository.input(after), input);
  await f.repository.delete(f.userId, row.id);
  await assert.rejects(f.repository.patch(row, { content: { title: 'Stale', summary: 'Should never appear', cards: [] }, status: 'completed' }));
  // A new edition cites the owned source, then disappears if that source is edited.
  await f.repository.configure(f.userId, { timeZone: 'Asia/Shanghai', locale: 'en', slots: [{ id: 'midday', label: 'Midday Brief', hour: 0, enabled: true }] });
  f.fake.answers.push(JSON.stringify({ title: 'A follow-up', summary: 'A proposal was mentioned.', cards: [{ style: 'plan', eyebrow: 'Follow-up', title: 'Review the proposal', body: 'Your message mentions a proposal.', bullets: [], sourceIds: [`message:${messageId}`], links: [] }] }));
  await todayStep(f.repository, f.gateway, 'test-model', 15).run(context(f.userId));
  const brief = (await f.repository.list(f.userId, 10)).briefs[0]!; assert.equal(brief.status, 'completed');
  await f.db.db.update(messages).set({ text: 'Corrected note' }).where(eq(messages.id, messageId));
  const withdrawn = await f.repository.view(await f.repository.owned(f.userId, brief.id));
  assert.equal(withdrawn.status, 'withdrawn'); assert.equal(withdrawn.content, null); assert.deepEqual(withdrawn.sources, []);
});
