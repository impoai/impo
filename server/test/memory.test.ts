import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryCategories, parseFacts, parseOperations } from '../src/memory/contract.js';
import { defaultMemoryPolicy, planMemoryTick } from '../src/memory/planner.js';
import { memoryId } from '../src/memory/store.js';

const now = new Date('2026-09-29T12:00:00Z');
const minutes = (n: number) => new Date(now.getTime() - n * 60_000);
const plan = (pending: { count: number; oldestAt: Date | null; newestAt: Date | null }, extra: Partial<Parameters<typeof planMemoryTick>[0]> = {}) =>
  planMemoryTick({ now, openRun: false, storeExists: false, sweptAt: null, pending, ...extra });

test('planner: waits for a settled conversation, bounds delay, drains backlog, resumes first and sweeps daily', () => {
  const none = { count: 0, oldestAt: null, newestAt: null };
  assert.deepEqual(plan(none), []);
  assert.deepEqual(plan({ count: 3, oldestAt: minutes(30), newestAt: minutes(5) }), [], 'the user is still talking');
  assert.deepEqual(plan({ count: 3, oldestAt: minutes(40), newestAt: minutes(25) }), [{ kind: 'consolidate', reason: 'quiet' }]);
  assert.deepEqual(plan({ count: 3, oldestAt: minutes(7 * 60), newestAt: minutes(1) }), [{ kind: 'consolidate', reason: 'overdue' }]);
  assert.deepEqual(plan({ count: defaultMemoryPolicy.backlogItems, oldestAt: minutes(2), newestAt: minutes(1) }), [{ kind: 'consolidate', reason: 'backlog' }]);
  assert.deepEqual(plan(none, { openRun: true }), [{ kind: 'consolidate', reason: 'resume' }]);
  assert.deepEqual(plan(none, { storeExists: true }), [{ kind: 'sweep' }]);
  assert.deepEqual(plan(none, { storeExists: true, sweptAt: minutes(60) }), []);
  assert.deepEqual(plan(none, { storeExists: true, sweptAt: minutes(25 * 60) }), [{ kind: 'sweep' }]);
});

test('Mem0 platform category list', () => {
  assert.equal(memoryCategories.length, 15);
  assert.ok(memoryCategories.includes('user_preferences') && memoryCategories.includes('misc'));
});

test('extract output: every fact cites supplied evidence; categories, lengths and expiry are validated', () => {
  const ids = new Set(['chat:a', 'echo:b']);
  const facts = parseFacts('```json\n{"facts":[{"text":"Prefers aisle seats","categories":["user_preferences"],"sourceIds":["chat:a","chat:a"]},{"text":"Dentist on Oct 3","categories":["health","health"],"sourceIds":["echo:b"],"expiresAt":"2026-10-03T23:59:59+08:00"}]}\n```', ids);
  assert.deepEqual(facts[0], { text: 'Prefers aisle seats', categories: ['user_preferences'], sourceIds: ['chat:a'], expiresAt: null });
  assert.deepEqual(facts[1]!.categories, ['health']);
  assert.equal(facts[1]!.expiresAt, '2026-10-03T15:59:59.000Z');
  assert.deepEqual(parseFacts('{"facts":[]}', ids), []);
  for (const bad of ['not json', '{"facts":[{"text":"x","categories":["user_preferences"],"sourceIds":[]}]}', '{"facts":[{"text":"x","categories":["secret"],"sourceIds":["chat:a"]}]}',
    '{"facts":[{"text":"x","categories":[],"sourceIds":["chat:a"]}]}', '{"facts":[{"text":"x","category":"misc","sourceIds":["chat:a"]}]}',
    '{"facts":[{"text":"x","categories":["food","travel","music","sports"],"sourceIds":["chat:a"]}]}',
    '{"facts":[{"text":"x","categories":["misc"],"sourceIds":["chat:zzz"]}]}', `{"facts":[{"text":"${'x'.repeat(501)}","categories":["misc"],"sourceIds":["chat:a"]}]}`,
  ]) assert.throws(() => parseFacts(bad, ids), bad);
  // Expiry never rejects a batch: no offset reads as UTC, a bare date is the end of that day, garbage drops it.
  const expiries = parseFacts(JSON.stringify({ facts: ['2026-10-15T23:59:59', '2026-10-15', 'soon', 42].map(expiresAt => ({ text: 'x', categories: ['travel'], sourceIds: ['chat:a'], expiresAt })) }), ids);
  assert.deepEqual(expiries.map(f => f.expiresAt), ['2026-10-15T23:59:59.000Z', '2026-10-15T23:59:59.000Z', null, null]);
});

test('decide output: only shown refs, each changed once; NONE is dropped', () => {
  const refs = new Set(['m1', 'm2']); const ids = new Set(['chat:a']);
  const ops = parseOperations(JSON.stringify({ operations: [
    { op: 'ADD', text: 'Has a sister named Lily', categories: ['family'], sourceIds: ['chat:a'] },
    { op: 'update', ref: 'm1', text: 'Lives in Seattle since 2026', categories: ['misc'], sourceIds: ['chat:a'], expiresAt: null },
    { op: 'delete', ref: 'm2', reason: 'The user cancelled the trip' }, { op: 'none', ref: 'm2' },
  ] }), refs, ids);
  assert.deepEqual(ops.map(op => op.op), ['add', 'update', 'delete']);
  assert.throws(() => parseOperations('{"operations":[{"op":"delete","ref":"m9","reason":"x"}]}', refs, ids), 'an unseen ref');
  assert.throws(() => parseOperations('{"operations":[{"op":"delete","ref":"m1","reason":"x"},{"op":"update","ref":"m1","text":"y","categories":["misc"],"sourceIds":["chat:a"]}]}', refs, ids), 'a ref changed twice');
  assert.throws(() => parseOperations('{"operations":[{"op":"merge","ref":"m1"}]}', refs, ids));
});

test('ADD memory IDs are deterministic UUIDs per operation key', () => {
  assert.equal(memoryId('run/0'), memoryId('run/0'));
  assert.notEqual(memoryId('run/0'), memoryId('run/1'));
  assert.match(memoryId('run/0'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
