import { createHash } from 'node:crypto';
import type { MemoryDatabaseRepository } from '../db/repositories/memory-database-repository.js';
import { ServiceError } from '../errors.js';
import type { Memory, MemoryCategory, MemoryChange, MemoryMatch } from './contract.js';
import type { Embedder } from './embedder.js';

/** Deterministic memory ID for an ADD, so a retried run inserts the same row. */
export function memoryId(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 | (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Memory application service: embedding and validation; repositories own all database access. */
export class MemoryStore {
  constructor(private readonly databases: MemoryDatabaseRepository, readonly embedder: Embedder,
    private readonly validEchoSources?: (userId: string, sourceIds: string[]) => Promise<Set<string>>) {}

  private async records(userId: string, signal?: AbortSignal) {
    const records = await this.databases.open(userId, signal);
    if (this.validEchoSources) {
      const sources = await records.echoSources();
      const valid = await this.validEchoSources(userId, sources);
      await records.retractEchoSources(sources.filter(source => !valid.has(source)));
    }
    return records;
  }

  async reconcileSources(userId: string, signal?: AbortSignal): Promise<void> {
    if (await this.exists(userId)) await this.records(userId, signal);
  }

  exists(userId: string): Promise<boolean> { return this.databases.exists(userId); }

  async count(userId: string, signal?: AbortSignal): Promise<number> {
    return (await this.records(userId, signal)).count();
  }

  async list(userId: string, limit = 50, signal?: AbortSignal): Promise<Memory[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ServiceError(400, 'invalid_request', 'Limit must be between 1 and 500');
    return (await this.records(userId, signal)).list(limit);
  }

  async get(userId: string, ids: string[], signal?: AbortSignal): Promise<Map<string, Memory>> {
    if (!ids.length) return new Map();
    return (await this.records(userId, signal)).get(ids);
  }

  /** Nearest memories for each text, merged by best distance. */
  async similar(userId: string, texts: string[], perText: number, maxDistance: number, signal?: AbortSignal): Promise<MemoryMatch[]> {
    if (!texts.length) return [];
    const records = await this.records(userId, signal);
    const vectors = await this.embedder.embed(texts, 'query', signal);
    const best = new Map<string, MemoryMatch>();
    for (const vector of vectors) {
      signal?.throwIfAborted();
      for (const match of await records.similar(vector, perText, maxDistance)) {
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

  async apply(userId: string, changes: MemoryChange[], signal?: AbortSignal): Promise<{ added: number; updated: number; deleted: number }> {
    const counts = { added: 0, updated: 0, deleted: 0 };
    if (!changes.length) return counts;
    const records = await this.records(userId, signal);
    const written = changes.filter(change => change.event !== 'DELETE');
    if (this.validEchoSources) {
      const sources = [...new Set(written.flatMap(change => change.sourceIds).filter(source => source.startsWith('echo:')))];
      const valid = await this.validEchoSources(userId, sources);
      if (sources.some(source => !valid.has(source))) throw new Error('echo_evidence_changed');
    }
    const vectors = await this.embedder.embed(written.map(change => change.content), 'document', signal);
    const vectorOf = new Map(written.map((change, index) => [change.key, vectors[index]]));
    for (const change of changes) {
      signal?.throwIfAborted();
      const outcome = await records.apply(change, vectorOf.get(change.key));
      if (outcome) counts[outcome]++;
    }
    await this.reconcileSources(userId, signal);
    return counts;
  }

  async summary(userId: string, signal?: AbortSignal): Promise<{ total: number; categories: Partial<Record<MemoryCategory, number>> }> {
    if (!await this.exists(userId)) return { total: 0, categories: {} };
    return (await this.records(userId, signal)).summary();
  }

  async page(userId: string, query: { category?: MemoryCategory; limit: number; cursor?: string }, signal?: AbortSignal): Promise<{ memories: Memory[]; nextCursor: string | null }> {
    let before: { at: number; id: string } | undefined;
    if (query.cursor) {
      try { before = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()); } catch { /* validated below */ }
      if (!before || !Number.isSafeInteger(before.at) || typeof before.id !== 'string') throw new ServiceError(400, 'invalid_cursor', 'Invalid page cursor');
    }
    if (!await this.exists(userId)) return { memories: [], nextCursor: null };
    const rows = await (await this.records(userId, signal)).page({ ...query, before, limit: query.limit + 1 });
    const memories = rows.slice(0, query.limit), last = memories.at(-1);
    return { memories, nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({ at: Date.parse(last.updatedAt), id: last.id })).toString('base64url') : null };
  }

  async forget(userId: string, id: string, signal?: AbortSignal): Promise<boolean> {
    if (!await this.exists(userId)) return false;
    return (await this.databases.open(userId, signal)).forget(id);
  }

  async sweep(userId: string, now = new Date(), signal?: AbortSignal): Promise<number> {
    return (await this.databases.open(userId, signal)).sweep(now);
  }

  async history(userId: string, memoryId: string, signal?: AbortSignal) {
    return (await this.databases.open(userId, signal)).history(memoryId);
  }

  close(): void { this.databases.close(); }
}
