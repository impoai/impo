import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { eq, sql } from 'drizzle-orm';
import { createMemoryDatabase } from '../src/db/memory-client.js';
import { MemoryRecordRepository } from '../src/db/repositories/memory-record-repository.js';
import type { MemoryChange } from '../src/memory/contract.js';

async function fixture(t: TestContext, legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), 'impo-drizzle-memory-'));
  const url = pathToFileURL(join(directory, 'memory.db')).href;
  if (legacy) {
    // Exact deployed v1 layout, independently specified so compatibility is tested.
    const client = createClient({ url });
    try {
      await client.batch([
        'CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
        `CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, categories TEXT NOT NULL DEFAULT '[]', source_ids TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER, embedding F32_BLOB(3) NOT NULL)`,
        "CREATE INDEX memories_embedding_idx ON memories(libsql_vector_idx(embedding, 'metric=cosine'))",
        'CREATE INDEX memories_updated_idx ON memories(updated_at)',
        'CREATE INDEX memories_expires_idx ON memories(expires_at) WHERE expires_at IS NOT NULL',
        'CREATE TABLE memory_history (op_key TEXT PRIMARY KEY, memory_id TEXT NOT NULL, event TEXT NOT NULL, previous TEXT, content TEXT, reason TEXT, at INTEGER NOT NULL)',
        'CREATE INDEX memory_history_memory_idx ON memory_history(memory_id, at)',
        "INSERT INTO memory_meta VALUES ('embedding_model', 'test'), ('embedding_dimensions', '3')",
        `INSERT INTO memories (id, content, categories, source_ids, created_at, updated_at, embedding) VALUES ('legacy', 'Existing memory', '["food"]', '["chat:old"]', 1000, 1000, vector32('[1,0,0]'))`,
      ], 'write');
    } finally { client.close(); }
  }
  const database = createMemoryDatabase(url, 3);
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  await database.initialize('test');
  return { database, records: new MemoryRecordRepository(database) };
}

const add = (id: string, overrides: Partial<Extract<MemoryChange, { event: 'ADD' }>> = {}): MemoryChange => ({
  key: `add/${id}`, event: 'ADD', id, content: `Memory ${id}`, categories: ['food'], sourceIds: ['chat:1'], expiresAt: null, ...overrides,
});

test('Drizzle memory entities read and update deployed v1 rows without a rewrite', async t => {
  const { database, records } = await fixture(t, true);
  await database.initialize('test');
  const [previous] = (await records.get(['legacy'])).values();
  assert.equal(previous!.createdAt, '1970-01-01T00:00:01.000Z');
  assert.deepEqual(previous!.categories, ['food']);
  assert.deepEqual((await records.similar([1, 0, 0], 8, 0.01)).map(row => row.id), ['legacy']);
  await records.apply({ key: 'update/legacy', event: 'UPDATE', id: 'legacy', content: 'Updated memory', categories: ['health'], sourceIds: ['echo:new'], expiresAt: null }, [0, 1, 0]);
  const [updated] = (await records.get(['legacy'])).values();
  assert.equal(updated!.createdAt, previous!.createdAt);
  assert.deepEqual(updated!.sourceIds, ['chat:old', 'echo:new']);
  assert.deepEqual(await records.similar([1, 0, 0], 8, 0.01), []);
  assert.deepEqual((await records.similar([0, 1, 0], 8, 0.01)).map(row => row.id), ['legacy']);
  const [raw] = await database.db.select().from(database.schema.memories);
  assert.deepEqual(raw!.embedding, [0, 1, 0]);
});

test('a failed history insert rolls back the memory and vector index; retry applies once', async t => {
  const { database, records } = await fixture(t);
  await records.apply(add('one'), [1, 0, 0]);
  await database.db.run(sql`CREATE TRIGGER reject_update BEFORE INSERT ON memory_history WHEN NEW.event = 'UPDATE' BEGIN SELECT RAISE(ABORT, 'test history failure'); END`);
  const change: MemoryChange = { key: 'update/one', event: 'UPDATE', id: 'one', content: 'Replacement', categories: ['health'], sourceIds: [], expiresAt: null };
  await assert.rejects(records.apply(change, [0, 1, 0]));
  assert.equal((await records.get(['one'])).get('one')!.content, 'Memory one');
  assert.deepEqual((await records.similar([1, 0, 0], 8, 0.01)).map(row => row.id), ['one']);
  assert.deepEqual((await records.history('one')).map(row => row.event), ['ADD']);
  await database.db.run(sql`DROP TRIGGER reject_update`);
  assert.equal(await records.apply(change, [0, 1, 0]), 'updated');
  assert.equal(await records.apply(change, [0, 1, 0]), undefined);
  assert.deepEqual((await records.history('one')).map(row => row.event), ['ADD', 'UPDATE']);
});

test('memory paging handles tied timestamps and parameterizes category and identity values', async t => {
  const { database, records } = await fixture(t);
  for (const id of ['c', "a' OR 1=1 --", 'b']) await records.apply(add(id), [1, 0, 0]);
  await records.apply(add('other', { categories: ['health'] }), [0, 1, 0]);
  await database.db.update(database.schema.memories).set({ updatedAt: new Date(1000) });
  const first = await records.page({ category: 'food', limit: 2 });
  assert.deepEqual(first.map(row => row.id), ["a' OR 1=1 --", 'b']);
  const next = await records.page({ category: 'food', limit: 2, before: { at: 1000, id: 'b' } });
  assert.deepEqual(next.map(row => row.id), ['c']);
  assert.deepEqual(await records.summary(), { total: 4, categories: { food: 3, health: 1 } });
  assert.equal((await records.get(["a' OR 1=1 --"])).size, 1);
  assert.equal(await records.forget("a' OR 1=1 --"), true);
  assert.equal(await records.forget("a' OR 1=1 --"), false);
  assert.equal(await records.count(), 3);
  assert.equal((await records.history("a' OR 1=1 --")).at(-1)!.event, 'FORGET');
  // The history and memory share a transaction even when the delete fails.
  await database.db.run(sql`CREATE TRIGGER reject_delete BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT, 'test delete failure'); END`);
  await assert.rejects(records.forget('b'));
  assert.deepEqual((await records.history('b')).map(row => row.event), ['ADD']);
});

test('expiration and malformed vectors cannot leave an unindexed or partial memory', async t => {
  const { database, records } = await fixture(t);
  await assert.rejects(records.apply(add('invalid'), [1, 0]));
  assert.equal(await records.count(), 0);
  assert.deepEqual(await records.history('invalid'), []);
  await records.apply(add('expired', { expiresAt: '2000-01-01T00:00:00.000Z' }), [1, 0, 0]);
  assert.deepEqual(await records.similar([1, 0, 0], 8, 2), []);
  assert.equal(await records.sweep(new Date()), 1);
  assert.equal(await records.sweep(new Date()), 0);
  assert.deepEqual((await records.history('expired')).map(row => row.event), ['ADD', 'EXPIRE']);
  const meta = await database.db.select().from(database.schema.memoryMeta).where(eq(database.schema.memoryMeta.key, 'embedding_dimensions'));
  assert.equal(meta[0]!.value, '3');
});
