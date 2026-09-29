import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './chat.js';
import type { MemoryWindow } from '../../memory/contract.js';

/**
 * One libSQL (Turso) database per user holds that user's memories, embeddings and change
 * history. PostgreSQL keeps only where it lives and which per-database schema it has
 * reached; credentials stay in server configuration.
 */
export const memoryDatabases = pgTable('memory_databases', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  databaseName: text('database_name').notNull().unique(),
  url: text('url').notNull(),
  schemaVersion: integer('schema_version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-user consolidation progress: how far each source has been read and when expired
 * memories were last swept. Cursors are (time, id) pairs; nothing here is user content.
 * The row also serializes memory work for a user (SELECT ... FOR UPDATE in claims).
 */
export const memoryState = pgTable('memory_state', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  chatAt: timestamp('chat_at', { withTimezone: true }), chatId: uuid('chat_id'),
  echoAt: timestamp('echo_at', { withTimezone: true }), echoId: uuid('echo_id'),
  sweptAt: timestamp('swept_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One consolidation run over a bounded evidence window. It stores source references and
 * candidate memory IDs, never evidence or memory text: chat text stays in Rebyte, Echo text
 * in S3, memories in the user's Turso database, and the Agent's outputs in its Session.
 */
export const memoryRuns = pgTable('memory_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  status: text('status', { enum: ['pending', 'running', 'completed', 'failed'] }).notNull().default('pending'),
  phase: text('phase', { enum: ['extract', 'decide', 'apply'] }).notNull().default('extract'),
  window: jsonb('window').$type<MemoryWindow>().notNull(),
  configVersion: text('config_version').notNull(), model: text('model'),
  /** Existing memory IDs shown to the Agent as m1..mN during the decide phase. */
  candidates: jsonb('candidates').$type<string[]>(),
  creationStartedAt: timestamp('creation_started_at', { withTimezone: true }),
  providerSessionId: text('provider_session_id'),
  facts: integer('facts'), added: integer('added'), updated: integer('updated'), deleted: integer('deleted'),
  attempts: integer('attempts').notNull().default(0), errorCode: text('error_code'),
  leaseToken: uuid('lease_token'), leaseUntil: timestamp('lease_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, t => [
  index('memory_runs_user_created').on(t.userId, t.createdAt),
  // At most one unfinished run per user: windows are contiguous and applied in order.
  uniqueIndex('memory_runs_one_open').on(t.userId).where(sql`${t.status} IN ('pending', 'running')`),
  check('memory_runs_status_check', sql`${t.status} IN ('pending','running','completed','failed')`),
  check('memory_runs_phase_check', sql`${t.phase} IN ('extract','decide','apply')`),
]);
