import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { memoryDatabases } from '../schema.js';
import { createMemoryDatabase, type MemoryDatabase } from '../memory-client.js';
import { MEMORY_SCHEMA_VERSION } from '../memory-schema.js';
import { MemoryRecordRepository } from './memory-record-repository.js';
import { ServiceError } from '../../errors.js';
import type { MemoryDatabaseProvider } from '../../memory/provider.js';

/** Resolves owned PostgreSQL locations and manages the per-user Turso connections. */
export class MemoryDatabaseRepository {
  private readonly clients = new Map<string, { database: MemoryDatabase; records: MemoryRecordRepository }>();
  constructor(private readonly db: Database, private readonly provider: MemoryDatabaseProvider,
    private readonly embedding: { model: string; dimensions: number }, private readonly options: { maxOpenClients?: number } = {}) {}

  async exists(userId: string): Promise<boolean> {
    return (await this.db.select({ userId: memoryDatabases.userId }).from(memoryDatabases).where(eq(memoryDatabases.userId, userId))).length > 0;
  }

  async open(userId: string, signal?: AbortSignal): Promise<MemoryRecordRepository> {
    signal?.throwIfAborted();
    const cached = this.clients.get(userId);
    if (cached) { this.clients.delete(userId); this.clients.set(userId, cached); return cached.records; }
    let [location] = await this.db.select().from(memoryDatabases).where(eq(memoryDatabases.userId, userId));
    if (!location) {
      const databaseName = `impo-mem-${userId}`;
      const { url } = await this.provider.ensure(databaseName, signal);
      await this.db.insert(memoryDatabases).values({ userId, databaseName, url }).onConflictDoNothing({ target: memoryDatabases.userId });
      [location] = await this.db.select().from(memoryDatabases).where(eq(memoryDatabases.userId, userId));
      if (!location) throw new Error('Memory database row missing after insert');
    }
    const database = createMemoryDatabase(location.url, this.embedding.dimensions, this.provider.authToken);
    try {
      if (location.schemaVersion < MEMORY_SCHEMA_VERSION) {
        await database.initialize(this.embedding.model);
        await this.db.update(memoryDatabases).set({ schemaVersion: MEMORY_SCHEMA_VERSION, updatedAt: new Date() }).where(eq(memoryDatabases.userId, userId));
      }
      const meta = new Map((await database.db.select().from(database.schema.memoryMeta)).map(row => [row.key, row.value]));
      if (meta.get('embedding_model') !== this.embedding.model || meta.get('embedding_dimensions') !== String(this.embedding.dimensions)) {
        throw new ServiceError(503, 'memory_reindex_required', 'Memories were indexed with another embedding model', false);
      }
    } catch (error) { database.close(); throw error; }
    // A concurrent first open may have populated the cache while this one initialized.
    const existing = this.clients.get(userId);
    if (existing) { database.close(); return existing.records; }
    const records = new MemoryRecordRepository(database);
    this.clients.set(userId, { database, records });
    const limit = this.options.maxOpenClients ?? 200;
    while (this.clients.size > limit) {
      const [oldest, stale] = this.clients.entries().next().value!;
      this.clients.delete(oldest); stale.database.close();
    }
    return records;
  }

  close(): void { for (const client of this.clients.values()) client.database.close(); this.clients.clear(); }
}
