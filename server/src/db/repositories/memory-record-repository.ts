import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { MemoryDatabase } from '../memory-client.js';
import type { MemorySchema } from '../memory-schema.js';
import type { Memory, MemoryCategory, MemoryChange, MemoryMatch } from '../../memory/contract.js';

type MemoryRow = Omit<MemorySchema['memories']['$inferSelect'], 'embedding' | 'metadata'>;
function view(row: MemoryRow): Memory {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), expiresAt: row.expiresAt?.toISOString() ?? null };
}

/** CRUD for one user's already resolved Turso database; no cross-user query surface. */
export class MemoryRecordRepository {
  private readonly db;
  private readonly memories;
  private readonly historyTable;
  private readonly fields;

  constructor(database: MemoryDatabase) {
    this.db = database.db;
    this.memories = database.schema.memories;
    this.historyTable = database.schema.memoryHistory;
    const { id, content, categories, sourceIds, createdAt, updatedAt, expiresAt } = this.memories;
    this.fields = { id, content, categories, sourceIds, createdAt, updatedAt, expiresAt };
  }

  async count(): Promise<number> {
    return (await this.db.select({ value: count() }).from(this.memories))[0]!.value;
  }

  async list(limit: number): Promise<Memory[]> {
    const rows = await this.db.select(this.fields).from(this.memories).orderBy(desc(this.memories.updatedAt), asc(this.memories.id)).limit(limit);
    return rows.map(view);
  }

  async get(ids: string[]): Promise<Map<string, Memory>> {
    if (!ids.length) return new Map();
    const rows = await this.db.select(this.fields).from(this.memories).where(inArray(this.memories.id, ids));
    return new Map(rows.map(row => [row.id, view(row)]));
  }

  async similar(vector: number[], limit: number, maxDistance: number): Promise<MemoryMatch[]> {
    const m = this.memories;
    // Turso's vector table-valued function and implicit rowid have no query-builder equivalent.
    const encoded = JSON.stringify(vector);
    const distance = sql<number>`vector_distance_cos(${m.embedding}, vector32(${encoded}))`.mapWith(Number);
    const rows = await this.db.select({ ...this.fields, distance }).from(m)
      .innerJoin(sql`vector_top_k('memories_embedding_idx', vector32(${encoded}), ${limit}) AS nearest`, sql`${m}.rowid = nearest.id`)
      .where(and(lte(distance, maxDistance), or(isNull(m.expiresAt), gt(m.expiresAt, new Date())))).orderBy(distance);
    return rows.map(({ distance, ...row }) => ({ ...view(row), distance }));
  }

  /** Check the idempotency receipt, mutate the memory and write history in one transaction. */
  async apply(change: MemoryChange, vector?: number[]): Promise<'added' | 'updated' | 'deleted' | undefined> {
    const m = this.memories, h = this.historyTable;
    return this.db.transaction(async tx => {
      if ((await tx.select({ key: h.opKey }).from(h).where(eq(h.opKey, change.key))).length) return undefined;
      const [previous] = await tx.select(this.fields).from(m).where(eq(m.id, change.id));
      if (change.event === 'ADD' ? previous : !previous) return undefined;
      const now = new Date();
      if (change.event !== 'ADD') await tx.delete(m).where(eq(m.id, change.id));
      if (change.event !== 'DELETE') {
        if (!vector) throw new Error('Memory change requires an embedding');
        // Reinsert updates so the vector index cannot retain the previous embedding.
        await tx.insert(m).values({ id: change.id, content: change.content, categories: change.categories,
          sourceIds: previous ? [...new Set([...previous.sourceIds, ...change.sourceIds])].slice(-20) : change.sourceIds,
          createdAt: previous?.createdAt ?? now, updatedAt: now,
          expiresAt: change.expiresAt ? new Date(change.expiresAt) : null, embedding: vector });
      }
      await tx.insert(h).values({ opKey: change.key, memoryId: change.id, event: change.event, previous: previous?.content ?? null,
        content: change.event === 'DELETE' ? null : change.content, reason: change.event === 'DELETE' ? change.reason : null, at: now });
      return change.event === 'ADD' ? 'added' : change.event === 'UPDATE' ? 'updated' : 'deleted';
    });
  }

  async summary(): Promise<{ total: number; categories: Partial<Record<MemoryCategory, number>> }> {
    const category = sql<string>`category.value`;
    const [total, rows] = await Promise.all([this.count(),
      this.db.select({ category, count: count() }).from(this.memories)
        .innerJoin(sql`json_each(${this.memories.categories}) AS category`, sql`true`).groupBy(category)]);
    return { total, categories: Object.fromEntries(rows.map(row => [row.category, row.count])) };
  }

  async page(query: { category?: MemoryCategory; limit: number; before?: { at: number; id: string } }): Promise<Memory[]> {
    const m = this.memories, before = query.before;
    const rows = await this.db.select(this.fields).from(m).where(and(
      query.category ? sql`EXISTS (SELECT 1 FROM json_each(${m.categories}) AS category WHERE category.value = ${query.category})` : undefined,
      before ? or(lt(m.updatedAt, new Date(before.at)), and(eq(m.updatedAt, new Date(before.at)), gt(m.id, before.id))) : undefined,
    )).orderBy(desc(m.updatedAt), asc(m.id)).limit(query.limit);
    return rows.map(view);
  }

  async forget(id: string): Promise<boolean> {
    const m = this.memories, h = this.historyTable;
    return this.db.transaction(async tx => {
      const [previous] = await tx.select({ content: m.content }).from(m).where(eq(m.id, id));
      if (!previous) return false;
      await tx.delete(m).where(eq(m.id, id));
      await tx.insert(h).values({ opKey: `forget/${id}`, memoryId: id, event: 'FORGET', previous: previous.content,
        reason: 'Removed by the user', at: new Date() }).onConflictDoNothing();
      return true;
    });
  }

  async sweep(now: Date): Promise<number> {
    const m = this.memories, h = this.historyTable;
    return this.db.transaction(async tx => {
      const candidates = tx.select({ id: m.id }).from(m).where(and(isNotNull(m.expiresAt), lte(m.expiresAt, now))).limit(500);
      const expired = await tx.delete(m).where(inArray(m.id, candidates)).returning({ id: m.id, content: m.content });
      if (expired.length) await tx.insert(h).values(expired.map(previous => ({
        opKey: `expire/${previous.id}`, memoryId: previous.id, event: 'EXPIRE' as const, previous: previous.content, at: now,
      }))).onConflictDoNothing();
      return expired.length;
    });
  }

  async history(memoryId: string) {
    const h = this.historyTable;
    const rows = await this.db.select({ event: h.event, previous: h.previous, content: h.content, reason: h.reason, at: h.at }).from(h)
      .where(eq(h.memoryId, memoryId)).orderBy(asc(h.at), asc(h.opKey));
    return rows.map(row => ({ ...row, at: row.at.toISOString() }));
  }
}
