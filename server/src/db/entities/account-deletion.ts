import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { DeletionManifest } from '../../accounts/contract.js';

/** Retains no conversation content. Must survive removal of the owned user row. */
export const accountDeletions = pgTable('account_deletions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().unique(),
  identityHash: text('identity_hash').notNull().unique(),
  challengeHash: text('challenge_hash').notNull(),
  challengeExpiresAt: timestamp('challenge_expires_at', { withTimezone: true }).notNull(),
  status: text('status', { enum: ['challenge', 'pending', 'completed'] }).notNull().default('challenge'),
  manifest: jsonb('manifest').$type<DeletionManifest>(),
  requestedAt: timestamp('requested_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  lastError: text('last_error'),
  appleManualRevocationRequired: boolean('apple_manual_revocation_required').notNull().default(false),
}, t => [
  check('account_deletions_status', sql`${t.status} IN ('challenge','pending','completed')`),
  check('account_deletions_manifest', sql`(${t.status} = 'pending' AND ${t.manifest} IS NOT NULL AND ${t.requestedAt} IS NOT NULL) OR (${t.status} <> 'pending' AND ${t.manifest} IS NULL)`),
  index('account_deletions_pending').on(t.requestedAt).where(sql`${t.status} = 'pending'`),
]);
