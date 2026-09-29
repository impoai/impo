import type { UIMessageChunk } from 'ai';
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './chat.js';
import { runtimeSubmissions, sessionBindings, type StoredError } from './runtime.js';
import { devices } from './devices.js';

export const toolInvocations = pgTable('tool_invocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  submissionId: uuid('submission_id').notNull(),
  bindingId: uuid('binding_id').notNull(),
  turnId: text('turn_id').notNull(),
  callId: text('call_id').notNull(),
  toolName: text('tool_name').notNull(),
  toolVersion: integer('tool_version').notNull().default(1),
  arguments: jsonb('arguments').$type<Record<string, unknown>>().notNull(),
  argumentsHash: text('arguments_hash').notNull(),
  executionLocation: text('execution_location', { enum: ['server', 'device'] }).notNull(),
  status: text('status', { enum: ['received', 'running', 'result_saved', 'submitted', 'failed', 'cancelled'] }).notNull().default('received'),
  result: jsonb('result').$type<Record<string, unknown>>(),
  resultProjected: boolean('result_projected').notNull().default(false),
  error: jsonb('error').$type<StoredError>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('tool_invocations_user_id_id_unique').on(table.userId, table.id),
  unique('tool_invocations_user_submission_id_unique').on(table.userId, table.submissionId, table.id),
  unique('tool_invocations_call_unique').on(table.bindingId, table.turnId, table.callId),
  foreignKey({ name: 'tool_invocations_submission_binding_fk', columns: [table.userId, table.submissionId, table.bindingId], foreignColumns: [runtimeSubmissions.userId, runtimeSubmissions.id, runtimeSubmissions.bindingId] }),
  foreignKey({ name: 'tool_invocations_owned_binding_fk', columns: [table.userId, table.bindingId], foreignColumns: [sessionBindings.userId, sessionBindings.id] }),
  index('tool_invocations_submission_index').on(table.submissionId),
  check('tool_invocations_status_check', sql`${table.status} IN ('received', 'running', 'result_saved', 'submitted', 'failed', 'cancelled')`),
  check('tool_invocations_location_check', sql`${table.executionLocation} IN ('server', 'device')`),
  check('tool_invocations_version_check', sql`${table.toolVersion} > 0`),
  check('tool_invocations_arguments_check', sql`jsonb_typeof(${table.arguments}) = 'object'`),
  check('tool_invocations_result_check', sql`${table.result} IS NULL OR jsonb_typeof(${table.result}) = 'object'`),
  check('tool_invocations_saved_result_check', sql`${table.status} NOT IN ('result_saved', 'submitted') OR (${table.result} IS NOT NULL OR ${table.error} IS NOT NULL)`),
]);

export const deviceDispatches = pgTable('device_dispatches', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  submissionId: uuid('submission_id').notNull(),
  invocationId: uuid('invocation_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  status: text('status', { enum: ['pending', 'claimed', 'result_saved', 'expired', 'revoked', 'cancelled'] }).notNull().default('pending'),
  executionId: uuid('execution_id'),
  resultHash: text('result_hash'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('device_dispatches_invocation_unique').on(table.invocationId),
  unique('device_dispatches_execution_unique').on(table.executionId),
  foreignKey({ name: 'device_dispatches_owned_device_fk', columns: [table.userId, table.deviceId], foreignColumns: [devices.userId, devices.id] }),
  foreignKey({ name: 'device_dispatches_submission_device_fk', columns: [table.userId, table.submissionId, table.deviceId], foreignColumns: [runtimeSubmissions.userId, runtimeSubmissions.id, runtimeSubmissions.deviceId] }),
  foreignKey({ name: 'device_dispatches_submission_invocation_fk', columns: [table.userId, table.submissionId, table.invocationId], foreignColumns: [toolInvocations.userId, toolInvocations.submissionId, toolInvocations.id] }),
  index('device_dispatches_pending_index').on(table.deviceId, table.createdAt),
  check('device_dispatches_status_check', sql`${table.status} IN ('pending', 'claimed', 'result_saved', 'expired', 'revoked', 'cancelled')`),
  check('device_dispatches_claim_check', sql`${table.status} NOT IN ('claimed', 'result_saved') OR (${table.executionId} IS NOT NULL AND ${table.claimedAt} IS NOT NULL)`),
  check('device_dispatches_receipt_check', sql`${table.status} <> 'result_saved' OR (${table.resultHash} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`),
]);

export const outboxJobs = pgTable('outbox_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  submissionId: uuid('submission_id').notNull(),
  invocationId: uuid('invocation_id'),
  type: text('type').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  status: text('status', { enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] }).notNull().default('pending'),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  error: jsonb('error').$type<StoredError>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  unique('outbox_jobs_user_id_id_unique').on(table.userId, table.id),
  unique('outbox_jobs_user_dedupe_unique').on(table.userId, table.dedupeKey),
  foreignKey({ name: 'outbox_jobs_owned_submission_fk', columns: [table.userId, table.submissionId], foreignColumns: [runtimeSubmissions.userId, runtimeSubmissions.id] }),
  foreignKey({ name: 'outbox_jobs_submission_invocation_fk', columns: [table.userId, table.submissionId, table.invocationId], foreignColumns: [toolInvocations.userId, toolInvocations.submissionId, toolInvocations.id] }),
  index('outbox_jobs_ready_index').on(table.availableAt, table.createdAt).where(sql`${table.status} = 'pending'`),
  index('outbox_jobs_expired_lease_index').on(table.leaseUntil).where(sql`${table.status} = 'running'`),
  index('outbox_jobs_submission_index').on(table.submissionId),
  check('outbox_jobs_status_check', sql`${table.status} IN ('pending', 'running', 'completed', 'failed', 'cancelled')`),
  check('outbox_jobs_attempts_check', sql`${table.attempts} >= 0`),
  check('outbox_jobs_payload_check', sql`jsonb_typeof(${table.payload}) = 'object'`),
  check('outbox_jobs_lease_check', sql`(${table.status} = 'running' AND ${table.leaseToken} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.leaseToken} IS NULL AND ${table.leaseUntil} IS NULL)`),
]);

export const productEvents = pgTable('product_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  submissionId: uuid('submission_id').notNull(),
  sequence: bigint('sequence', { mode: 'number' }).notNull(),
  chunk: jsonb('chunk').$type<UIMessageChunk>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('product_events_user_id_id_unique').on(table.userId, table.id),
  unique('product_events_submission_sequence_unique').on(table.submissionId, table.sequence),
  foreignKey({ name: 'product_events_owned_submission_fk', columns: [table.userId, table.submissionId], foreignColumns: [runtimeSubmissions.userId, runtimeSubmissions.id] }),
  check('product_events_sequence_check', sql`${table.sequence} BETWEEN 1 AND 9007199254740991`),
  check('product_events_chunk_check', sql`jsonb_typeof(${table.chunk}) = 'object' AND ${table.chunk} ? 'type' AND jsonb_typeof(${table.chunk}->'type') = 'string'`),
]);
