import { sql } from 'drizzle-orm';
import { customType, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { MemoryCategory } from '../memory/contract.js';

/** Turso tables live in a separate database for each user, not in PostgreSQL. */
export function memorySchema(dimensions: number) {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) throw new Error('Invalid embedding dimensions');
  const vector = customType<{ data: number[]; driverData: Uint8Array | ArrayBuffer }>({
    dataType: () => `F32_BLOB(${dimensions})`,
    toDriver: values => {
      if (values.length !== dimensions || values.some(value => !Number.isFinite(value))) throw new Error('Invalid embedding vector');
      const buffer = Buffer.alloc(dimensions * 4);
      values.forEach((value, i) => buffer.writeFloatLE(value, i * 4));
      return buffer;
    },
    fromDriver: value => {
      const buffer = value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value);
      return Array.from({ length: dimensions }, (_, i) => buffer.readFloatLE(i * 4));
    },
  });
  const memories = sqliteTable('memories', {
    id: text('id').primaryKey(),
    content: text('content').notNull(),
    categories: text('categories', { mode: 'json' }).$type<MemoryCategory[]>().notNull().default([]),
    sourceIds: text('source_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    embedding: vector('embedding').notNull(),
  }, table => [
    index('memories_embedding_idx').on(sql`libsql_vector_idx(${sql.identifier(table.embedding.name)}, 'metric=cosine')`),
    index('memories_updated_idx').on(table.updatedAt),
    index('memories_expires_idx').on(table.expiresAt).where(sql`${sql.identifier(table.expiresAt.name)} IS NOT NULL`),
  ]);
  const memoryHistory = sqliteTable('memory_history', {
    opKey: text('op_key').primaryKey(),
    memoryId: text('memory_id').notNull(),
    event: text('event', { enum: ['ADD', 'UPDATE', 'DELETE', 'FORGET', 'EXPIRE'] }).notNull(),
    previous: text('previous'),
    content: text('content'),
    reason: text('reason'),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
  }, table => [index('memory_history_memory_idx').on(table.memoryId, table.at)]);
  const memoryMeta = sqliteTable('memory_meta', {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
  });
  return { memories, memoryHistory, memoryMeta };
}

export type MemorySchema = ReturnType<typeof memorySchema>;
// Existing per-user databases already use this layout. No data rewrite is required.
export const MEMORY_SCHEMA_VERSION = 1;
