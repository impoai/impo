import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { conversations, messages, todayBriefs, todaySettings, users, notificationEvents, userProfiles, listeningBatches } from '../src/db/schema.js';
import { TodayRepository } from '../src/db/repositories/today-repository.js';
import { todayStep } from '../src/today/worker.js';
import { RebyteGateway } from '../src/rebyte/gateway.js';
import { createApiServer, type ApiRepository } from '../src/http/api-server.js';
import { FakeRebyte } from './helpers/fake-rebyte.js';
import { ProfileRepository } from '../src/db/repositories/profile-repository.js';
import { modelModes } from '../src/model-modes.js';
import { briefConfigVersion } from '../src/today/contract.js';
import type { BriefContextProvider } from '../src/today/context.js';
import { defaultBriefPreferences } from '../src/today/content.js';

const slots = [{ id: 'morning', label: 'Morning Brief', hour: 0, enabled: true }];
const context = (userId: string) => ({ userId, scheduledAt: Date.now(), tickId: randomUUID(), idempotencyKey: randomUUID(), signal: AbortSignal.timeout(20000) });
const quiet = JSON.stringify({ title: 'A little room for your day', summary: 'There is not enough shared information for personal suggestions yet.', cards: [] });

async function fixture(t: TestContext, provider: BriefContextProvider = {}) {
  const db = createDatabase(process.env.DATABASE_URL!);
  const repository = new TodayRepository(db.db, undefined, undefined, provider);
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
    await db.db.delete(listeningBatches).where(eq(listeningBatches.userId, userId));
    await db.db.delete(users).where(eq(users.id, userId)); await db.db.delete(users).where(eq(users.id, otherId));
    await db.close();
  });
  return { db, repository, fake, gateway, userId, otherId, baseURL };
}

test('Brief only receives confirmed self speech and withdraws after a speaker correction', async t => {
  const f = await fixture(t);
  const confirmed = randomUUID(), unconfirmed = randomUUID(), at = new Date(Date.now() - 60000);
  for (const id of [confirmed, unconfirmed]) await f.db.db.insert(listeningBatches).values({
    id, userId: f.userId, clientBatchId: randomUUID(), streamId: randomUUID(), sequence: 1, sessionId: randomUUID(), contentHash: 'test',
    startedAt: new Date(at.getTime() - 7 * 86400000), endedAt: new Date(at.getTime() - 7 * 86400000 + 4000), segments: [], audioMilliseconds: 4000, status: 'transcribed', transcribedAt: new Date(at.getTime() - 7 * 86400000),
    transcript: 'I prefer walking. Someone else is moving abroad. Misassigned words.',
    utterances: [
      { speaker: 'a', startMs: 0, endMs: 1000, text: 'I prefer walking.' },
      { speaker: 'b', startMs: 1100, endMs: 2000, text: 'Someone else is moving abroad.' },
      { speaker: 'a', startMs: 2100, endMs: 3000, text: 'Misassigned words.' },
    ], ...(id === confirmed ? { speakerReview: { revision: 1, status: 'confirmed' as const, selfSpeakerIds: ['a'], excludedUtteranceIds: ['u3'] }, speakerReviewedAt: at } : {}),
  });
  await f.repository.ensureDue(f.userId);
  const row = (await f.repository.claim(f.userId))!;
  const input = await f.repository.input(row);
  assert.equal(input.sources.length, 1, 'recent confirmation makes an older recording available to the next Brief');
  assert.equal(input.sources[0]!.recordId, confirmed);
  assert.equal(input.sources[0]!.text, 'I prefer walking.');
  assert.ok(!JSON.stringify(input).includes('abroad'));
  const prepared = await f.repository.patch(row, { providerSessionId: 'session' });
  await f.repository.complete({ ...prepared, input }, JSON.parse(quiet), { providerAgentId: null, providerTurnId: 'turn', providerItemId: 'item' });
  assert.equal((await f.repository.view(await f.repository.owned(f.userId, row.id))).status, 'completed');
  await f.db.db.update(listeningBatches).set({ speakerReview: { revision: 2, status: 'not_present', selfSpeakerIds: [], excludedUtteranceIds: [] } }).where(eq(listeningBatches.id, confirmed));
  const withdrawn = await f.repository.view(await f.repository.owned(f.userId, row.id));
  assert.equal(withdrawn.status, 'withdrawn'); assert.equal(withdrawn.content, null); assert.deepEqual(withdrawn.sources, []);
});

test('Brief guidance persists preferences and cooldowns, fences actions and feedback by owner and current state', { timeout: 30000 }, async t => {
  let status: 'disconnected' | 'connected' = 'disconnected';
  const f = await fixture(t, { connectors: {
    list: async () => [{ toolkit: 'gmail', name: 'Gmail', featured: true, status }],
    getStatus: async () => ({ status }), refresh: async () => ({ status }),
  } });
  await f.repository.configure(f.userId, { timeZone: 'Asia/Shanghai', locale: 'en', briefClientVersion: 2, contentPreferences: defaultBriefPreferences });
  const card = { type: 'connect', eyebrow: 'Email', title: 'Get help reviewing email', body: 'Connect Gmail to ask Impo for help reviewing your inbox.', sourceIds: [], contextIds: ['connection:gmail:disconnected'], action: { id: 'connect:gmail', label: 'Connect Gmail', prompt: null } };
  f.fake.answers.push(JSON.stringify({ title: 'A useful next step', summary: 'Bring email into Impo when you are ready.', cards: [card] }));
  const step = todayStep(f.repository, f.gateway, 'test-model', 15);
  await step.run(context(f.userId));
  const first = (await f.repository.list(f.userId, 1)).briefs[0]!;
  assert.equal(first.content!.schemaVersion, 2); const cardId = first.content!.cards[0]!.id!;
  assert.equal((await f.repository.cardAction(f.userId, first.id, cardId)).action.kind, 'connect');
  assert.ok((await f.repository.settings(f.userId))!.topics['connection:gmail']!.shownAt);
  await assert.rejects(f.repository.cardAction(f.otherId, first.id, cardId), { code: 'not_found' });
  await assert.rejects(f.repository.feedback(f.otherId, first.id, cardId, { action: 'dismiss' }), { code: 'not_found' });
  const notifications = await f.db.db.select().from(notificationEvents).where(eq(notificationEvents.userId, f.userId));
  assert.equal(notifications.length, 1, 'one nonempty edition records one notification event');
  await step.run(context(f.userId));
  assert.equal(f.fake.sessions.length, 1);
  await f.repository.configure(f.userId, { timeZone: 'Asia/Shanghai', locale: 'en', contentPreferences: { ...defaultBriefPreferences, categories: { ...defaultBriefPreferences.categories, connect: false } } });
  assert.equal((await f.repository.list(f.userId, 1)).briefs[0]!.content!.cards.length, 0);
  await f.repository.configure(f.userId, { timeZone: 'Asia/Shanghai', locale: 'en', contentPreferences: defaultBriefPreferences });
  status = 'connected';
  await assert.rejects(f.repository.cardAction(f.userId, first.id, cardId), { code: 'brief_action_expired' });
  status = 'disconnected';
  await f.repository.feedback(f.userId, first.id, cardId, { action: 'snooze' });
  assert.equal((await f.repository.list(f.userId, 1)).briefs[0]!.content!.cards.length, 0);
  await f.repository.resetTopics(f.userId);
  assert.equal((await f.repository.list(f.userId, 1)).briefs[0]!.content!.cards.length, 1);
  await f.repository.feedback(f.userId, first.id, cardId, { action: 'dismiss' });
  assert.equal((await f.repository.settings(f.userId))!.topics['connection:gmail']!.dismissed, true);
  await f.repository.configure(f.userId, { timeZone: 'Asia/Shanghai', locale: 'en', slots: [{ id: 'later', label: 'Later', hour: 0, enabled: true }] });
  await f.repository.ensureDue(f.userId); const next = (await f.repository.claim(f.userId))!;
  const input = await f.repository.input(next);
  assert.equal(input.guidance!.contexts.length, 0, 'dismissal and cooldown persist across slots and workers');
  assert.deepEqual((await f.repository.settings(f.userId))!.contentPreferences, defaultBriefPreferences, 'legacy context sync preserves category preferences');
  await f.repository.release(next);
});

test('Brief publication rechecks connection changes after generation starts', async t => {
  let status: 'disconnected' | 'connected' = 'disconnected';
  const f = await fixture(t, { connectors: { list: async () => [{ toolkit: 'gmail', name: 'Gmail', featured: true, status }], getStatus: async () => ({ status }), refresh: async () => ({ status }) } });
  await f.repository.configure(f.userId, { timeZone: 'Asia/Shanghai', locale: 'en', briefClientVersion: 2 });
  await f.repository.ensureDue(f.userId); const row = (await f.repository.claim(f.userId))!;
  const input = await f.repository.input(row);
  const { parseBriefContentV2 } = await import('../src/today/content.js');
  const content = parseBriefContentV2(JSON.stringify({ title: 'Email help', summary: 'Connect when useful.', cards: [{ type: 'connect', eyebrow: 'Email', title: 'Connect Gmail', body: 'Ask Impo to help review email.', sourceIds: [], contextIds: ['connection:gmail:disconnected'], action: { id: 'connect:gmail', label: 'Connect Gmail', prompt: null } }] }), input);
  status = 'connected';
  await f.repository.complete({ ...row, input }, content, { providerAgentId: null, providerTurnId: 'turn', providerItemId: 'item' });
  assert.equal((await f.repository.owned(f.userId, row.id)).status, 'withdrawn');
  assert.equal((await f.db.db.select().from(notificationEvents).where(eq(notificationEvents.userId, f.userId))).length, 0);
});

test('Today editions: concurrent workers, cross-tick dedup, history pagination, API ownership and deletion', { timeout: 30000 }, async t => {
  const f = await fixture(t); f.fake.answers.push(quiet);
  const step = todayStep(f.repository, f.gateway, 'test-model', 15);
  await Promise.all([step.run(context(f.userId)), step.run(context(f.userId))]);
  await step.run(context(f.userId));
  assert.equal(f.fake.sessions.length, 1);
  const first = (await f.repository.list(f.userId, 1)).briefs[0]!;
  assert.equal(first.status, 'completed'); assert.ok(first.content);
  const notifications = await f.db.db.select().from(notificationEvents).where(eq(notificationEvents.userId, f.userId));
  assert.equal(notifications.length, 0, 'Empty editions must not send contentless notifications');
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
  f.fake.answers.push(JSON.stringify({ title: 'A follow-up', summary: 'Prepare your next step.', cards: [{ type: 'suggestion', eyebrow: 'Follow-up', title: 'Review the proposal', body: 'Read the proposal once before sending it tomorrow.', bullets: [], sourceIds: [`message:${messageId}`], contextIds: [], links: [], action: null }] }));
  await todayStep(f.repository, f.gateway, 'test-model', 15).run(context(f.userId));
  const brief = (await f.repository.list(f.userId, 10)).briefs[0]!; assert.equal(brief.status, 'completed');
  await f.db.db.update(messages).set({ text: 'Corrected note' }).where(eq(messages.id, messageId));
  const withdrawn = await f.repository.view(await f.repository.owned(f.userId, brief.id));
  assert.equal(withdrawn.status, 'withdrawn'); assert.equal(withdrawn.content, null); assert.deepEqual(withdrawn.sources, []);
});
