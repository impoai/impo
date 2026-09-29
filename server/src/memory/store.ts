import { createHash } from 'node:crypto';
import { createClient, type Client, type InStatement } from '@libsql/client';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { memoryDatabases } from '../db/schema.js';
import { ServiceError } from '../errors.js';
import type { Memory, MemoryCategory } from './contract.js';
import type { Embedder } from './embedder.js';
import type { MemoryDatabaseProvider } from './provider.js';

export interface MemoryMatch extends Memory { distance: number }
/** A resolved change: `id` is a real memory ID; `key` makes the change apply at most once. */
export type MemoryChange =
  | { key: string; event: 'ADD'; id: string; content: string; categories: MemoryCategory[]; sourceIds: string[]; expiresAt: string | null }
  | { key: string; event: 'UPDATE'; id: string; content: string; categories: MemoryCategory[]; sourceIds: string[]; expiresAt: string | null }
  | { key: string; event: 'DELETE'; id: string; reason: string };

/**
 * Per-user schema, migrated lazily in every user's own database, so it stays small; new
 * fields go into `metadata` JSON. Every step must be idempotent: a crash can repeat it
 * before the version is saved. `memory_history` is the audit trail (as in Mem0) and its
 * `op_key` primary key is what makes a retried run apply each change once.
 */
const migrations: Array<(embedder: Embedder) => string[]> = [
  embedder => [
    'CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    `CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, categories TEXT NOT NULL DEFAULT '[]', source_ids TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER, embedding F32_BLOB(${embedder.dimensions}) NOT NULL)`,
    "CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories(libsql_vector_idx(embedding, 'metric=cosine'))",
    'CREATE INDEX IF NOT EXISTS memories_updated_idx ON memories(updated_at)',
    'CREATE INDEX IF NOT EXISTS memories_expires_idx ON memories(expires_at) WHERE expires_at IS NOT NULL',
    `CREATE TABLE IF NOT EXISTS memory_history (op_key TEXT PRIMARY KEY, memory_id TEXT NOT NULL, event TEXT NOT NULL,
      previous TEXT, content TEXT, reason TEXT, at INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS memory_history_memory_idx ON memory_history(memory_id, at)',
    `INSERT OR IGNORE INTO memory_meta (key, value) VALUES ('embedding_model', '${embedder.model}'), ('embedding_dimensions', '${embedder.dimensions}')`,
  ],
];
export const MEMORY_SCHEMA_VERSION = migrations.length;
const columns = 'id, content, categories, source_ids, created_at, updated_at, expires_at';

function row(value: Record<string, unknown>): Memory {
  let sourceIds: string[] = [], categories: MemoryCategory[] = [];
  try { sourceIds = JSON.parse(String(value.source_ids)); categories = JSON.parse(String(value.categories)); } catch { /* keep the memory readable */ }
  const iso = (v: unknown) => new Date(Number(v)).toISOString();
  return { id: String(value.id), content: String(value.content), categories, sourceIds,
    createdAt: iso(value.created_at), updatedAt: iso(value.updated_at), expiresAt: value.expires_at === null ? null : iso(value.expires_at) };
}

/** Deterministic memory ID for an ADD, so a retried run inserts the same row. */
export function memoryId(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 | (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** User memories: one embedding database per user, located through PostgreSQL. */
export class MemoryStore {
  private readonly clients = new Map<string, Client>();
  constructor(private readonly db: Database, private readonly provider: MemoryDatabaseProvider, readonly embedder: Embedder,
    private readonly options: { maxOpenClients?: number } = {}) {}

  /** Whether the user already has a memory database; never provisions one. */
  async exists(userId: string): Promise<boolean> {
    return (await this.db.select({ userId: memoryDatabases.userId }).from(memoryDatabases).where(eq(memoryDatabases.userId, userId))).length > 0;
  }

  async count(userId: string, signal?: AbortSignal): Promise<number> {
    const result = await (await this.open(userId, signal)).execute('SELECT count(*) AS n FROM memories');
    return Number(result.rows[0]!.n);
  }

  async list(userId: string, limit = 50, signal?: AbortSignal): Promise<Memory[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ServiceError(400, 'invalid_request', 'Limit must be between 1 and 500');
    const client = await this.open(userId, signal);
    const result = await client.execute({ sql: `SELECT ${columns} FROM memories ORDER BY updated_at DESC, id LIMIT ?`, args: [limit] });
    return result.rows.map(value => row(value as unknown as Record<string, unknown>));
  }

  async get(userId: string, ids: string[], signal?: AbortSignal): Promise<Map<string, Memory>> {
    const found = new Map<string, Memory>();
    if (!ids.length) return found;
    const client = await this.open(userId, signal);
    const result = await client.execute({ sql: `SELECT ${columns} FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`, args: ids });
    for (const value of result.rows) { const memory = row(value as unknown as Record<string, unknown>); found.set(memory.id, memory); }
    return found;
  }

  /** Nearest memories for each text, merged by best distance. Distances are recomputed from stored rows. */
  async similar(userId: string, texts: string[], perText: number, maxDistance: number, signal?: AbortSignal): Promise<MemoryMatch[]> {
    if (!texts.length) return [];
    const client = await this.open(userId, signal);
    const vectors = await this.embedder.embed(texts, 'query', signal);
    const best = new Map<string, MemoryMatch>();
    for (const vector of vectors) {
      const encoded = JSON.stringify(vector);
      const result = await client.execute({
        sql: `SELECT ${columns.split(', ').map(c => `m.${c}`).join(', ')}, vector_distance_cos(m.embedding, vector32(?)) AS distance
              FROM vector_top_k('memories_embedding_idx', vector32(?), ?) AS v JOIN memories m ON m.rowid = v.id
              WHERE distance <= ? AND (m.expires_at IS NULL OR m.expires_at > ?) ORDER BY distance`,
        args: [encoded, encoded, perText, maxDistance, Date.now()],
      });
      for (const value of result.rows) {
        const match = { ...row(value as unknown as Record<string, unknown>), distance: Number(value.distance) };
        const seen = best.get(match.id);
        if (!seen || seen.distance > match.distance) best.set(match.id, match);
      }
    }
    return [...best.values()].sort((a, b) => a.distance - b.distance);
  }

  async search(userId: string, query: string, limit = 8, signal?: AbortSignal): Promise<MemoryMatch[]> {
    const text = query.trim();
    if (!text || text.length > 1_000) throw new ServiceError(400, 'invalid_query', 'A memory search needs 1 to 1000 characters');
    if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new ServiceError(400, 'invalid_request', 'Retrieve between 1 and 12 memories');
    if (!await this.exists(userId)) return [];
    return (await this.similar(userId, [text], limit, 2, signal)).slice(0, limit);
  }

  /**
   * Apply changes in order. Each change and its history row commit together, and a change
   * whose key is already in the history is skipped, so repeating a run is harmless. UPDATE
   * and DELETE of a memory that no longer exists are skipped (it was changed elsewhere).
   */
  async apply(userId: string, changes: MemoryChange[], signal?: AbortSignal): Promise<{ added: number; updated: number; deleted: number }> {
    const counts = { added: 0, updated: 0, deleted: 0 };
    if (!changes.length) return counts;
    const client = await this.open(userId, signal);
    const written = changes.filter(change => change.event !== 'DELETE') as Array<Extract<MemoryChange, { content: string }>>;
    const vectors = await this.embedder.embed(written.map(change => change.content), 'document', signal);
    const vectorOf = new Map(written.map((change, index) => [change.key, JSON.stringify(vectors[index])]));
    for (const change of changes) {
      signal?.throwIfAborted();
      const done = await client.execute({ sql: 'SELECT 1 FROM memory_history WHERE op_key = ?', args: [change.key] });
      if (done.rows.length) continue;
      const now = Date.now();
      const [previous] = (await this.get(userId, [change.id], signal)).values();
      const statements: InStatement[] = [];
      if (change.event === 'ADD') {
        if (previous) continue;
        statements.push({ sql: `INSERT INTO memories (id, content, categories, source_ids, created_at, updated_at, expires_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, vector32(?))`,
          args: [change.id, change.content, JSON.stringify(change.categories), JSON.stringify(change.sourceIds), now, now, change.expiresAt ? Date.parse(change.expiresAt) : null, vectorOf.get(change.key)!] });
        counts.added++;
      } else if (!previous) continue;
      else if (change.event === 'UPDATE') {
        const sourceIds = [...new Set([...previous.sourceIds, ...change.sourceIds])].slice(-20);
        // Delete then insert: a row rewritten in place is not trusted to leave the vector index clean.
        statements.push({ sql: 'DELETE FROM memories WHERE id = ?', args: [change.id] },
          { sql: `INSERT INTO memories (id, content, categories, source_ids, created_at, updated_at, expires_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, vector32(?))`,
            args: [change.id, change.content, JSON.stringify(change.categories), JSON.stringify(sourceIds), Date.parse(previous.createdAt), now, change.expiresAt ? Date.parse(change.expiresAt) : null, vectorOf.get(change.key)!] });
        counts.updated++;
      } else {
        statements.push({ sql: 'DELETE FROM memories WHERE id = ?', args: [change.id] });
        counts.deleted++;
      }
      statements.push({ sql: 'INSERT INTO memory_history (op_key, memory_id, event, previous, content, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [change.key, change.id, change.event, previous?.content ?? null, change.event === 'DELETE' ? null : change.content, change.event === 'DELETE' ? change.reason : null, now] });
      await client.batch(statements, 'write');
    }
    return counts;
  }

  /** Memory counts per category; a memory with several categories counts in each. No database yet means none. */
  async summary(userId: string, signal?: AbortSignal): Promise<{ total: number; categories: Partial<Record<MemoryCategory, number>> }> {
    if (!await this.exists(userId)) return { total: 0, categories: {} };
    const client = await this.open(userId, signal);
    const [total, rows] = await Promise.all([client.execute('SELECT count(*) AS n FROM memories'),
      client.execute('SELECT c.value AS category, count(*) AS n FROM memories m, json_each(m.categories) c GROUP BY c.value')]);
    return { total: Number(total.rows[0]!.n), categories: Object.fromEntries(rows.rows.map(r => [String(r.category), Number(r.n)])) };
  }

  /** Newest first, optionally one category, paged by (updated_at, id). */
  async page(userId: string, query: { category?: MemoryCategory; limit: number; cursor?: string }, signal?: AbortSignal): Promise<{ memories: Memory[]; nextCursor: string | null }> {
    let before: { at: number; id: string } | undefined;
    if (query.cursor) {
      try { before = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()); } catch { /* validated below */ }
      if (!before || !Number.isSafeInteger(before.at) || typeof before.id !== 'string') throw new ServiceError(400, 'invalid_cursor', 'Invalid page cursor');
    }
    if (!await this.exists(userId)) return { memories: [], nextCursor: null };
    const client = await this.open(userId, signal);
    const where = [query.category ? 'EXISTS (SELECT 1 FROM json_each(memories.categories) c WHERE c.value = ?)' : null,
      before ? '(updated_at < ? OR (updated_at = ? AND id > ?))' : null].filter(Boolean);
    const args = [...(query.category ? [query.category] : []), ...(before ? [before.at, before.at, before.id] : []), query.limit + 1];
    const result = await client.execute({ sql: `SELECT ${columns} FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id LIMIT ?`, args });
    const memories = result.rows.slice(0, query.limit).map(v => row(v as unknown as Record<string, unknown>));
    const last = memories.at(-1);
    return { memories, nextCursor: result.rows.length > query.limit && last ? Buffer.from(JSON.stringify({ at: Date.parse(last.updatedAt), id: last.id })).toString('base64url') : null };
  }

  /** The user removes a memory; recorded as FORGET so it is distinguishable from an Agent DELETE. */
  async forget(userId: string, id: string, signal?: AbortSignal): Promise<boolean> {
    if (!await this.exists(userId)) return false;
    const client = await this.open(userId, signal);
    const [previous] = (await this.get(userId, [id], signal)).values();
    if (!previous) return false;
    await client.batch([
      { sql: 'DELETE FROM memories WHERE id = ?', args: [id] },
      { sql: 'INSERT OR IGNORE INTO memory_history (op_key, memory_id, event, previous, reason, at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [`forget/${id}`, id, 'FORGET', previous.content, 'Removed by the user', Date.now()] },
    ], 'write');
    return true;
  }

  /** Remove time-bound memories whose expiry has passed; recorded as EXPIRE in the history. */
  async sweep(userId: string, now = new Date(), signal?: AbortSignal): Promise<number> {
    const client = await this.open(userId, signal);
    const at = now.getTime();
    const expired = await client.execute({ sql: 'SELECT id, content FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT 500', args: [at] });
    if (!expired.rows.length) return 0;
    await client.batch(expired.rows.flatMap(value => [
      { sql: 'DELETE FROM memories WHERE id = ?', args: [String(value.id)] },
      { sql: 'INSERT OR IGNORE INTO memory_history (op_key, memory_id, event, previous, at) VALUES (?, ?, ?, ?, ?)',
        args: [`expire/${value.id}`, String(value.id), 'EXPIRE', String(value.content), at] },
    ]), 'write');
    return expired.rows.length;
  }

  async history(userId: string, memoryId: string, signal?: AbortSignal) {
    const client = await this.open(userId, signal);
    const result = await client.execute({ sql: 'SELECT event, previous, content, reason, at FROM memory_history WHERE memory_id = ? ORDER BY at, op_key', args: [memoryId] });
    return result.rows.map(v => ({ event: String(v.event), previous: v.previous === null ? null : String(v.previous), content: v.content === null ? null : String(v.content),
      reason: v.reason === null ? null : String(v.reason), at: new Date(Number(v.at)).toISOString() }));
  }

  close(): void { for (const client of this.clients.values()) client.close(); this.clients.clear(); }

  private async open(userId: string, signal?: AbortSignal): Promise<Client> {
    const cached = this.clients.get(userId);
    if (cached) { this.clients.delete(userId); this.clients.set(userId, cached); return cached; }
    let [location] = await this.db.select().from(memoryDatabases).where(eq(memoryDatabases.userId, userId));
    if (!location) {
      // Stable name: concurrent or retried provisioning converges on one database.
      const databaseName = `impo-mem-${userId}`;
      const { url } = await this.provider.ensure(databaseName, signal);
      await this.db.insert(memoryDatabases).values({ userId, databaseName, url }).onConflictDoNothing({ target: memoryDatabases.userId });
      [location] = await this.db.select().from(memoryDatabases).where(eq(memoryDatabases.userId, userId));
      if (!location) throw new Error('Memory database row missing after insert');
    }
    const client = createClient({ url: location.url, ...(this.provider.authToken ? { authToken: this.provider.authToken } : {}) });
    try {
      if (location.schemaVersion < MEMORY_SCHEMA_VERSION) {
        for (let version = location.schemaVersion; version < MEMORY_SCHEMA_VERSION; version++) await client.batch(migrations[version]!(this.embedder), 'write');
        await this.db.update(memoryDatabases).set({ schemaVersion: MEMORY_SCHEMA_VERSION, updatedAt: new Date() }).where(eq(memoryDatabases.userId, userId));
      }
      const meta = await client.execute("SELECT value FROM memory_meta WHERE key = 'embedding_model'");
      if (meta.rows[0]?.value !== this.embedder.model) throw new ServiceError(503, 'memory_reindex_required', 'Memories were indexed with another embedding model', false);
    } catch (error) { client.close(); throw error; }
    this.clients.set(userId, client);
    const limit = this.options.maxOpenClients ?? 200;
    while (this.clients.size > limit) {
      const [oldest, stale] = this.clients.entries().next().value!;
      this.clients.delete(oldest); stale.close();
    }
    return client;
  }
}
