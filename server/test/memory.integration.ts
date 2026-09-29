import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { conversations, listeningBatches, memoryDatabases, memoryRuns, memoryState, messages, runtimeSubmissions, sessionBindings, users } from '../src/db/schema.js';
import { DEVELOPMENT_AGENT_CONFIG_ID } from '../src/db/seed.js';
import { MemoryTranscriptArchive } from '../src/listening/transcript-archive.js';
import { DevelopmentEmbedder } from '../src/memory/embedder.js';
import { LocalFileProvider } from '../src/memory/provider.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { MemoryStore } from '../src/memory/store.js';
import { memoryStep } from '../src/memory/worker.js';
import { RebyteGateway } from '../src/rebyte/gateway.js';
import { FakeRebyte } from './helpers/fake-rebyte.js';
import { createApiServer, type ApiRepository } from '../src/http/api-server.js';

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL || new URL(databaseURL).pathname !== '/instant_test') throw new Error('Run the isolated test-db.mjs --memory harness.');
const context = (userId: string) => ({ userId, scheduledAt: Date.now(), tickId: randomUUID(), idempotencyKey: randomUUID(), signal: AbortSignal.timeout(20000) });
const hourAgo = () => new Date(Date.now() - 3600_000);

async function fixture(t: TestContext) {
  const db = createDatabase(databaseURL!);
  const directory = await mkdtemp(join(tmpdir(), 'instant-memory-'));
  const userId = randomUUID();
  await db.db.insert(users).values({ id: userId, authProvider: 'memory-test', authSubject: userId, name: 'Memory user' });
  const conversationId = randomUUID(), bindingId = randomUUID();
  await db.db.insert(conversations).values({ id: conversationId, userId });
  await db.db.insert(sessionBindings).values({ id: bindingId, userId, conversationId, agentConfigVersionId: DEVELOPMENT_AGENT_CONFIG_ID, status: 'failed', isCurrent: false });
  const archive = new MemoryTranscriptArchive();
  const repository = new MemoryRepository(db.db, archive);
  const store = new MemoryStore(db.db, new LocalFileProvider(directory), new DevelopmentEmbedder());
  const fake = new FakeRebyte(); const baseURL = await fake.listen();
  const gateway = new RebyteGateway({ apiKey: 'instant-fake-rebyte-key', baseURL, model: 'test-model', timeoutMs: 2000 });
  let sequence = 0;
  /** A completed chat Turn; text is in PostgreSQL here, as in the development runtime. */
  const chat = async (text: string, reply: string, completedAt = hourAgo()) => {
    const userMessageId = randomUUID(), assistantMessageId = randomUUID(), id = randomUUID();
    await db.db.insert(messages).values([{ id: userMessageId, userId, conversationId, sequence: ++sequence, role: 'user', text, status: 'completed' },
      { id: assistantMessageId, userId, conversationId, sequence: ++sequence, role: 'assistant', text: reply, status: 'completed' }]);
    await db.db.insert(runtimeSubmissions).values({ id, userId, conversationId, bindingId, userMessageId, assistantMessageId, status: 'completed', completedAt });
    return `chat:${id}`;
  };
  /** A transcribed Echo recording whose text lives only in the archive. */
  const echo = async (transcript: string, transcribedAt = hourAgo()) => {
    const id = randomUUID(), clientBatchId = randomUUID(), startedAt = new Date(transcribedAt.getTime() - 60_000);
    await db.db.insert(listeningBatches).values({ id, userId, clientBatchId, streamId: randomUUID(), sequence: 1, sessionId: randomUUID(), contentHash: 'test',
      startedAt, endedAt: transcribedAt, segments: [], audioMilliseconds: 60_000, status: 'transcribed', transcribedAt });
    await archive.put({ userId, recordId: clientBatchId, kind: 'echo-batch', startedAt, endedAt: transcribedAt, transcript, utterances: [], model: 'test' });
    return `echo:${id}`;
  };
  const step = (now?: () => Date) => memoryStep(repository, store, gateway, { model: 'test-model', pollMs: 15, ...(now ? { now } : {}) });
  t.after(async () => {
    store.close(); await fake.close();
    await db.db.delete(memoryRuns).where(eq(memoryRuns.userId, userId));
    await db.db.delete(memoryState).where(eq(memoryState.userId, userId));
    await db.db.delete(memoryDatabases).where(eq(memoryDatabases.userId, userId));
    await db.db.delete(runtimeSubmissions).where(eq(runtimeSubmissions.userId, userId));
    await db.db.delete(messages).where(eq(messages.userId, userId));
    await db.db.delete(sessionBindings).where(eq(sessionBindings.userId, userId));
    await db.db.delete(conversations).where(eq(conversations.userId, userId));
    await db.db.delete(listeningBatches).where(eq(listeningBatches.userId, userId));
    await db.db.delete(users).where(eq(users.id, userId));
    await db.close(); await rm(directory, { recursive: true, force: true });
  });
  return { db, userId, repository, store, fake, gateway, baseURL, chat, echo, step };
}

test('hourly consolidation adds, updates and deletes memories from chat and Echo, once per item', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const coffee = await f.chat('I drink black coffee every morning, no sugar.', 'Noted!');
  const trip = await f.echo('[Speaker 1] I am flying to Tokyo next Friday for the design conference.');
  await f.chat('What is the capital of France?', 'Paris.');
  f.fake.answers.push(
    JSON.stringify({ facts: [
      { text: 'Drinks black coffee every morning without sugar', categories: ['user_preferences'], sourceIds: [coffee] },
      { text: 'Flying to Tokyo for a design conference', categories: ['travel', 'professional_details'], sourceIds: [trip], expiresAt: '2026-10-09T23:59:59Z' },
    ] }),
    JSON.stringify({ operations: [
      { op: 'add', text: 'Drinks black coffee every morning without sugar', categories: ['user_preferences'], sourceIds: [coffee] },
      { op: 'add', text: 'Flying to Tokyo for a design conference', categories: ['travel', 'professional_details'], sourceIds: [trip], expiresAt: '2026-10-09T23:59:59Z' },
    ] }));
  // Two Activity attempts at once: one Session, one Agent run.
  await Promise.all([f.step().run(context(f.userId)), f.step().run(context(f.userId))]);
  assert.equal(f.fake.sessions.length, 1);
  const session = f.fake.sessions[0]!;
  assert.equal(session.environment.type, 'none');
  assert.deepEqual(session.agent.tools, []);
  assert.ok(session.agent.instructions.includes('## Memory consolidation'));
  const extract = JSON.parse(session.turns[0]!.text);
  assert.equal(extract.phase, 'extract');
  assert.equal(extract.evidence.length, 3, 'chat turns and the archived Echo transcript are read');
  assert.ok(extract.evidence.some((e: { id: string; text: string }) => e.id === trip && e.text.includes('Tokyo')));
  assert.deepEqual(JSON.parse(session.turns[1]!.text).existing, [], 'the first run has no memories to compare');
  let memories = await f.store.list(f.userId);
  assert.deepEqual(memories.map(m => m.content).sort(), ['Drinks black coffee every morning without sugar', 'Flying to Tokyo for a design conference']);
  assert.deepEqual(memories.find(m => m.content.includes('Tokyo'))!.categories, ['travel', 'professional_details']);
  const [run] = await f.db.db.select().from(memoryRuns).where(eq(memoryRuns.userId, f.userId));
  assert.equal(run!.status, 'completed'); assert.equal(run!.added, 2);
  assert.ok(!JSON.stringify(run).includes('coffee'), 'PostgreSQL keeps references, not memory or evidence text');

  // Nothing new: no Agent run. New chat corrects one memory and cancels another.
  await f.step().run(context(f.userId));
  assert.equal(f.fake.sessions.length, 1);
  const tea = await f.chat('I switched from coffee to green tea. Also the Tokyo trip is cancelled.', 'Got it.');
  // A small store is shown whole, in list order: m1..mN.
  memories = await f.store.list(f.userId);
  const coffeeMemory = memories.find(m => m.content.includes('coffee'))!, tripMemory = memories.find(m => m.content.includes('Tokyo'))!;
  const ref = (id: string) => `m${memories.findIndex(m => m.id === id) + 1}`;
  f.fake.answers.push(
    JSON.stringify({ facts: [{ text: 'Drinks green tea instead of coffee', categories: ['user_preferences'], sourceIds: [tea] }, { text: 'Tokyo trip is cancelled', categories: ['travel'], sourceIds: [tea] }] }),
    JSON.stringify({ operations: [
      { op: 'update', ref: ref(coffeeMemory.id), text: 'Drinks green tea; stopped drinking coffee', categories: ['food', 'user_preferences'], sourceIds: [tea] },
      { op: 'delete', ref: ref(tripMemory.id), reason: 'The user cancelled the Tokyo trip' },
    ] }));
  await f.step().run(context(f.userId));
  assert.equal(JSON.parse(f.fake.sessions[1]!.turns[1]!.text).existing.length, 2);
  memories = await f.store.list(f.userId);
  assert.deepEqual(memories.map(m => m.content), ['Drinks green tea; stopped drinking coffee']);
  assert.equal(memories[0]!.id, coffeeMemory.id, 'an update keeps the memory identity');
  assert.deepEqual(memories[0]!.categories, ['food', 'user_preferences'], 'an update may re-categorize');
  assert.deepEqual(memories[0]!.sourceIds, [coffee, tea]);
  assert.deepEqual((await f.store.history(f.userId, coffeeMemory.id)).map(h => h.event), ['ADD', 'UPDATE']);
  assert.deepEqual((await f.store.history(f.userId, tripMemory.id)).map(h => h.event), ['ADD', 'DELETE']);
});

test('the planner defers an active conversation; invalid Agent output skips the window; expired memories are swept', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.chat('Remind me: dentist on Friday.', 'Sure.', new Date(Date.now() - 5 * 60_000));
  await f.step().run(context(f.userId));
  assert.equal(f.fake.sessions.length, 0, 'the newest message is five minutes old: still talking');

  const later = () => new Date(Date.now() + 30 * 60_000);
  f.fake.answers.push('not json');
  await f.step(later).run(context(f.userId));
  assert.equal(f.fake.sessions.length, 1);
  const [failed] = await f.db.db.select().from(memoryRuns).where(eq(memoryRuns.userId, f.userId));
  assert.equal(failed!.status, 'failed'); assert.equal(failed!.errorCode, 'invalid_facts');
  await f.step(later).run(context(f.userId));
  assert.equal(f.fake.sessions.length, 1, 'a failed window is not retried forever');

  const id = await f.chat('My passport renewal appointment is tomorrow.', 'Good luck.', new Date(Date.now() - 2 * 60_000));
  f.fake.answers.push(JSON.stringify({ facts: [{ text: 'Passport renewal appointment', categories: ['travel'], sourceIds: [id], expiresAt: '2020-01-01' }] }),
    JSON.stringify({ operations: [{ op: 'add', text: 'Passport renewal appointment', categories: ['travel'], sourceIds: [id], expiresAt: '2020-01-01' }] }));
  await f.step(later).run(context(f.userId));
  assert.equal((await f.store.list(f.userId)).length, 0, 'an already expired memory is swept in the same tick');
  const [state] = await f.db.db.select().from(memoryState).where(eq(memoryState.userId, f.userId));
  assert.ok(state!.sweptAt);
});

test('a large backlog drains in bounded windows and cursors never re-read an item', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const base = Date.now() - 3 * 3600_000;
  for (let i = 0; i < 70; i++) await f.echo(`Recording ${i}: ${'words '.repeat(80)}`, new Date(base + i * 1000));
  for (let i = 0; i < 6; i++) f.fake.answers.push(JSON.stringify({ facts: [] }));
  await f.step().run(context(f.userId));
  const runs = await f.db.db.select().from(memoryRuns).where(eq(memoryRuns.userId, f.userId)).orderBy(memoryRuns.createdAt);
  assert.ok(runs.length >= 2 && runs.length <= 3, `bounded runs per tick (${runs.length})`);
  const seen = f.fake.sessions.flatMap(s => JSON.parse(s.turns[0]!.text).evidence.map((e: { id: string }) => e.id));
  assert.equal(new Set(seen).size, seen.length, 'no item appears in two windows');
  assert.ok(f.fake.sessions.every(s => s.turns[0]!.text.length < 40_000));
  while ((await f.repository.pending(f.userId)).count) await f.step().run(context(f.userId));
  const all = f.fake.sessions.flatMap(s => JSON.parse(s.turns[0]!.text).evidence.map((e: { id: string }) => e.id));
  assert.equal(all.length, 70); assert.equal(new Set(all).size, 70);
});

test('an unknown Session creation is reconciled without a second Agent run, and applying a run twice changes nothing', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const id = await f.chat('Call me Sam, not Samuel.', 'Will do, Sam.');
  f.fake.answers.push(JSON.stringify({ facts: [{ text: 'Prefers to be called Sam', categories: ['user_preferences'], sourceIds: [id] }] }),
    JSON.stringify({ operations: [{ op: 'add', text: 'Prefers to be called Sam', categories: ['user_preferences'], sourceIds: [id] }] }));
  f.fake.holdNextCreate = true;
  const impatient = new RebyteGateway({ apiKey: 'instant-fake-rebyte-key', baseURL: f.baseURL, model: 'test-model', timeoutMs: 150 });
  await assert.rejects(memoryStep(f.repository, f.store, impatient, { model: 'test-model', pollMs: 15 }).run(context(f.userId)));
  assert.equal(f.fake.sessions.length, 1);
  f.fake.releaseCreateResponses();
  // The lease of the interrupted attempt must lapse before another attempt may claim the run.
  await f.db.db.update(memoryRuns).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(memoryRuns.userId, f.userId));
  await f.step().run(context(f.userId));
  assert.equal(f.fake.sessions.length, 1); assert.equal(f.fake.sessions[0]!.turns.length, 2);
  const [memory] = await f.store.list(f.userId);
  assert.equal(memory!.content, 'Prefers to be called Sam');
  const [run] = await f.db.db.select().from(memoryRuns).where(eq(memoryRuns.userId, f.userId));
  assert.equal(run!.status, 'completed'); assert.equal(run!.attempts, 2);
  const replay = await f.store.apply(f.userId, [{ key: `${run!.id}/0`, event: 'ADD', id: memory!.id, content: memory!.content, categories: ['user_preferences'], sourceIds: [id], expiresAt: null }]);
  assert.deepEqual(replay, { added: 0, updated: 0, deleted: 0 });
  assert.equal(await f.store.count(f.userId), 1);
});

test('memories API: per-category summary and pages, owner-only reads and forgetting', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const bob = randomUUID();
  await f.db.db.insert(users).values({ id: bob, authProvider: 'memory-test', authSubject: bob, name: 'Other user' });
  const changes = Array.from({ length: 5 }, (_, i) => ({ key: `seed/${i}`, event: 'ADD' as const, id: randomUUID(), content: `Memory ${i}`,
    categories: (i < 3 ? ['health'] : i === 3 ? ['health', 'food'] : ['travel']) as Array<'health' | 'food' | 'travel'>, sourceIds: [], expiresAt: null }));
  await f.store.apply(f.userId, changes);
  const identities = { findUser: async (subject: string) => ({ id: subject === 'alice' ? f.userId : bob }) } as ApiRepository;
  const api = createApiServer(identities, { memories: f.store }); api.listen(0, '127.0.0.1'); await once(api, 'listening');
  // Cleanup runs here, before the fixture closes the database.
  try {
  const address = api.address(); assert.ok(address && typeof address === 'object');
  const request = (path: string, who = 'alice', method = 'GET') => fetch(`http://127.0.0.1:${address.port}/api/v1/memories${path}`, { method, headers: { Authorization: `Bearer instant-dev-${who}` } });

  assert.deepEqual(await (await request('/summary')).json(), { total: 5, categories: { health: 4, food: 1, travel: 1 } });
  const first = await (await request('?category=health&limit=3')).json();
  assert.equal(first.memories.length, 3); assert.ok(first.nextCursor);
  const second = await (await request(`?category=health&limit=3&cursor=${first.nextCursor}`)).json();
  assert.equal(second.memories.length, 1); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.memories, ...second.memories].map((m: { id: string }) => m.id)).size, 4);
  assert.deepEqual(second.memories[0].categories.length >= 1, true);
  assert.equal((await request('?category=secrets')).status, 400);
  assert.equal((await request('?limit=0')).status, 400);

  assert.deepEqual(await (await request('/summary', 'bob')).json(), { total: 0, categories: {} });
  assert.deepEqual(await (await request('', 'bob')).json(), { memories: [], nextCursor: null });
  assert.equal((await f.db.db.select().from(memoryDatabases).where(eq(memoryDatabases.userId, bob))).length, 0, 'reading never provisions a database');
  const target = changes[3]!.id;
  assert.equal((await request(`/${target}`, 'bob', 'DELETE')).status, 404);
  assert.equal((await request(`/${target}`, 'alice', 'DELETE')).status, 200);
  assert.equal((await request(`/${target}`, 'alice', 'DELETE')).status, 404);
  assert.deepEqual(await (await request('/summary')).json(), { total: 4, categories: { health: 3, travel: 1 } });
  assert.deepEqual((await f.store.history(f.userId, target)).map(h => h.event), ['ADD', 'FORGET']);
  } finally {
    api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
    await f.db.db.delete(memoryDatabases).where(eq(memoryDatabases.userId, bob)); await f.db.db.delete(users).where(eq(users.id, bob));
  }
});

test('retrieval excludes expired and forgotten memories, isolates owners, and never provisions on an empty search', async t => {
  const f = await fixture(t), other = randomUUID();
  assert.deepEqual(await f.store.search(other, 'tea'), []);
  assert.equal(await f.store.exists(other), false);
  const active = randomUUID(), expired = randomUUID();
  await f.store.apply(f.userId, [
    { key: 'active', event: 'ADD', id: active, content: 'Prefers green tea', categories: ['food'], sourceIds: ['chat:a'], expiresAt: null },
    { key: 'expired', event: 'ADD', id: expired, content: 'Prefers green tea', categories: ['food'], sourceIds: ['chat:b'], expiresAt: '2020-01-01T00:00:00Z' },
  ]);
  assert.deepEqual((await f.store.search(f.userId, 'green tea')).map(m => m.id), [active]);
  assert.deepEqual(await f.store.search(other, 'green tea'), []);
  await f.store.forget(f.userId, active);
  assert.deepEqual(await f.store.search(f.userId, 'green tea'), []);
});
