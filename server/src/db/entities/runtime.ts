import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { conversations, messages, users } from './chat.js';
import { devices } from './devices.js';
import type { ClientContext } from '../../tools/device-tools.js';

export type StoredError = { code: string; message: string; retryable?: boolean };

// Shared immutable configuration, without user data or credentials.
export const agentConfigVersions = pgTable('agent_config_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: integer('version').notNull(),
  hash: text('hash').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('agent_config_versions_version_unique').on(table.version),
  unique('agent_config_versions_hash_unique').on(table.hash),
  check('agent_config_versions_version_check', sql`${table.version} > 0`),
  check('agent_config_versions_config_check', sql`jsonb_typeof(${table.config}) = 'object'`),
]);

// One reusable Rebyte Saved Agent per user; shared template, independent remote identity.
export const userAgents = pgTable('user_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  kind: text('kind', { enum: ['main'] }).notNull().default('main'),
  agentConfigVersionId: uuid('agent_config_version_id').notNull(),
  provider: text('provider').notNull().default('rebyte'),
  providerAgentId: text('provider_agent_id'),
  status: text('status', { enum: ['creating', 'active', 'unknown', 'failed'] }).notNull().default('creating'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('user_agents_user_id_id_unique').on(table.userId, table.id),
  unique('user_agents_user_kind_unique').on(table.userId, table.kind),
  uniqueIndex('user_agents_provider_agent_unique').on(table.provider, table.providerAgentId).where(sql`${table.providerAgentId} IS NOT NULL`),
  foreignKey({ name: 'user_agents_config_version_fk', columns: [table.agentConfigVersionId], foreignColumns: [agentConfigVersions.id] }),
  check('user_agents_status_check', sql`${table.status} IN ('creating', 'active', 'unknown', 'failed')`),
  check('user_agents_active_check', sql`${table.status} <> 'active' OR ${table.providerAgentId} IS NOT NULL`),
]);

export const agentCreationAttempts = pgTable('agent_creation_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  userAgentId: uuid('user_agent_id').notNull(),
  status: text('status', { enum: ['pending', 'succeeded', 'unknown', 'failed'] }).notNull().default('pending'),
  requestHash: text('request_hash').notNull(),
  providerAgentId: text('provider_agent_id'),
  error: jsonb('error').$type<StoredError>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('agent_creation_attempts_user_id_id_unique').on(table.userId, table.id),
  unique('agent_creation_attempts_agent_hash_unique').on(table.userAgentId, table.requestHash),
  foreignKey({ name: 'agent_creation_attempts_owned_agent_fk', columns: [table.userId, table.userAgentId], foreignColumns: [userAgents.userId, userAgents.id] }),
  check('agent_creation_attempts_status_check', sql`${table.status} IN ('pending', 'succeeded', 'unknown', 'failed')`),
  check('agent_creation_attempts_succeeded_check', sql`${table.status} <> 'succeeded' OR ${table.providerAgentId} IS NOT NULL`),
]);

export const sessionBindings = pgTable('session_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  conversationId: uuid('conversation_id').notNull(),
  agentConfigVersionId: uuid('agent_config_version_id').notNull(),
  provider: text('provider').notNull().default('development'),
  providerSessionId: text('provider_session_id'),
  historyContext: text('history_context'),
  contextTokenEstimate: integer('context_token_estimate'),
  status: text('status', { enum: ['creating', 'active', 'unknown', 'failed', 'retired'] }).notNull().default('creating'),
  isCurrent: boolean('is_current').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('session_bindings_user_id_id_unique').on(table.userId, table.id),
  unique('session_bindings_user_conversation_id_unique').on(table.userId, table.conversationId, table.id),
  uniqueIndex('session_bindings_one_current').on(table.conversationId).where(sql`${table.isCurrent}`),
  uniqueIndex('session_bindings_provider_session_unique').on(table.provider, table.providerSessionId).where(sql`${table.providerSessionId} IS NOT NULL`),
  foreignKey({ name: 'session_bindings_config_version_fk', columns: [table.agentConfigVersionId], foreignColumns: [agentConfigVersions.id] }),
  foreignKey({ name: 'session_bindings_owned_conversation_fk', columns: [table.userId, table.conversationId], foreignColumns: [conversations.userId, conversations.id] }),
  check('session_bindings_status_check', sql`${table.status} IN ('creating', 'active', 'unknown', 'failed', 'retired')`),
  check('session_bindings_active_session_check', sql`${table.status} <> 'active' OR ${table.providerSessionId} IS NOT NULL`),
  check('session_bindings_context_token_estimate_check', sql`${table.contextTokenEstimate} IS NULL OR ${table.contextTokenEstimate} >= 0`),
]);

export const sessionCreationAttempts = pgTable('session_creation_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  bindingId: uuid('binding_id').notNull(),
  status: text('status', { enum: ['pending', 'succeeded', 'unknown', 'failed'] }).notNull().default('pending'),
  requestHash: text('request_hash').notNull(),
  providerSessionId: text('provider_session_id'),
  error: jsonb('error').$type<StoredError>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('session_creation_attempts_user_id_id_unique').on(table.userId, table.id),
  unique('session_creation_attempts_binding_hash_unique').on(table.bindingId, table.requestHash),
  foreignKey({ name: 'session_creation_attempts_owned_binding_fk', columns: [table.userId, table.bindingId], foreignColumns: [sessionBindings.userId, sessionBindings.id] }),
  check('session_creation_attempts_status_check', sql`${table.status} IN ('pending', 'succeeded', 'unknown', 'failed')`),
  check('session_creation_attempts_succeeded_check', sql`${table.status} <> 'succeeded' OR ${table.providerSessionId} IS NOT NULL`),
]);

export const runtimeSubmissions = pgTable('runtime_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  conversationId: uuid('conversation_id').notNull(),
  bindingId: uuid('binding_id').notNull(),
  userMessageId: uuid('user_message_id').notNull(),
  assistantMessageId: uuid('assistant_message_id').notNull(),
  deviceId: uuid('device_id'),
  deviceTools: jsonb('device_tools').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  clientContext: jsonb('client_context').$type<ClientContext>(),
  providerTurnId: text('provider_turn_id'),
  status: text('status', { enum: ['queued', 'running', 'waiting_device', 'completed', 'failed', 'cancelled'] }).notNull().default('queued'),
  inputStartedAt: timestamp('input_started_at', { withTimezone: true }),
  inputAcknowledged: boolean('input_acknowledged').notNull().default(false),
  baselineTurnIds: jsonb('baseline_turn_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  cancelAcknowledged: boolean('cancel_acknowledged').notNull().default(false),
  // Allocate each UI projection event under this submission's transaction lock.
  nextEventSequence: bigint('next_event_sequence', { mode: 'number' }).notNull().default(1),
  error: jsonb('error').$type<StoredError>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  unique('runtime_submissions_user_id_id_unique').on(table.userId, table.id),
  unique('runtime_submissions_user_id_binding_unique').on(table.userId, table.id, table.bindingId),
  unique('runtime_submissions_user_id_device_unique').on(table.userId, table.id, table.deviceId),
  unique('runtime_submissions_user_message_unique').on(table.userMessageId),
  unique('runtime_submissions_assistant_message_unique').on(table.assistantMessageId),
  foreignKey({ name: 'runtime_submissions_owned_device_fk', columns: [table.userId, table.deviceId], foreignColumns: [devices.userId, devices.id] }),
  check('runtime_submissions_device_tools_check', sql`jsonb_typeof(${table.deviceTools}) = 'array'`),
  check('runtime_submissions_client_context_check', sql`${table.clientContext} IS NULL OR jsonb_typeof(${table.clientContext}) = 'object'`),
  uniqueIndex('runtime_submissions_provider_turn_unique').on(table.bindingId, table.providerTurnId).where(sql`${table.providerTurnId} IS NOT NULL`),
  foreignKey({ name: 'runtime_submissions_owned_conversation_fk', columns: [table.userId, table.conversationId], foreignColumns: [conversations.userId, conversations.id] }),
  foreignKey({ name: 'runtime_submissions_conversation_binding_fk', columns: [table.userId, table.conversationId, table.bindingId], foreignColumns: [sessionBindings.userId, sessionBindings.conversationId, sessionBindings.id] }),
  foreignKey({ name: 'runtime_submissions_user_message_fk', columns: [table.userId, table.conversationId, table.userMessageId], foreignColumns: [messages.userId, messages.conversationId, messages.id] }),
  foreignKey({ name: 'runtime_submissions_assistant_message_fk', columns: [table.userId, table.conversationId, table.assistantMessageId], foreignColumns: [messages.userId, messages.conversationId, messages.id] }),
  index('runtime_submissions_binding_created_index').on(table.bindingId, table.createdAt),
  check('runtime_submissions_status_check', sql`${table.status} IN ('queued', 'running', 'waiting_device', 'completed', 'failed', 'cancelled')`),
  check('runtime_submissions_event_sequence_check', sql`${table.nextEventSequence} BETWEEN 1 AND 9007199254740991`),
  check('runtime_submissions_distinct_messages_check', sql`${table.userMessageId} <> ${table.assistantMessageId}`),
  check('runtime_submissions_baseline_turns_check', sql`jsonb_typeof(${table.baselineTurnIds}) = 'array'`),
  check('runtime_submissions_input_ack_check', sql`NOT ${table.inputAcknowledged} OR ${table.inputStartedAt} IS NOT NULL`),
  check('runtime_submissions_cancel_ack_check', sql`NOT ${table.cancelAcknowledged} OR ${table.cancelRequested}`),
]);

export const messageItemBindings = pgTable('message_item_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  conversationId: uuid('conversation_id').notNull(),
  messageId: uuid('message_id').notNull(),
  bindingId: uuid('binding_id').notNull(),
  providerItemId: text('provider_item_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('message_item_bindings_user_id_id_unique').on(table.userId, table.id),
  unique('message_item_bindings_provider_item_unique').on(table.bindingId, table.providerItemId),
  foreignKey({ name: 'message_item_bindings_owned_message_fk', columns: [table.userId, table.conversationId, table.messageId], foreignColumns: [messages.userId, messages.conversationId, messages.id] }),
  foreignKey({ name: 'message_item_bindings_owned_binding_fk', columns: [table.userId, table.conversationId, table.bindingId], foreignColumns: [sessionBindings.userId, sessionBindings.conversationId, sessionBindings.id] }),
  index('message_item_bindings_message_index').on(table.messageId),
]);
