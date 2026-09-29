import type { UIMessage } from 'ai';
import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  authProvider: text('auth_provider').notNull(),
  authSubject: text('auth_subject').notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique('users_auth_identity_unique').on(table.authProvider, table.authSubject)]);

// An Action is a delegated goal with its own isolated conversation; the main
// conversation has no Action. Tasks never build a Saved Agent (see runtime.ts):
// each task conversation is many-per-user, usually run once and discarded, so
// there is no durable identity on the Rebyte side worth keeping.
export const actions = pgTable('actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  kind: text('kind', { enum: ['task'] }).notNull().default('task'),
  goal: text('goal').notNull(),
  status: text('status', { enum: ['active', 'completed', 'failed', 'cancelled'] }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('actions_user_id_id_unique').on(table.userId, table.id),
  check('actions_kind_check', sql`${table.kind} IN ('task')`),
  check('actions_status_check', sql`${table.status} IN ('active', 'completed', 'failed', 'cancelled')`),
  check('actions_goal_check', sql`char_length(${table.goal}) BETWEEN 1 AND 4000`),
]);

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  kind: text('kind', { enum: ['main', 'task'] }).notNull().default('main'),
  actionId: uuid('action_id'),
  // Allocate messages while holding this conversation row's transaction lock.
  nextSequence: bigint('next_sequence', { mode: 'number' }).notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('conversations_user_id_id_unique').on(table.userId, table.id),
  // NULL actionId (the main conversation) is unconstrained by a plain unique index; only a real Action ID must be one-to-one.
  unique('conversations_action_unique').on(table.actionId),
  uniqueIndex('conversations_one_main_per_user').on(table.userId).where(sql`${table.kind} = 'main'`),
  foreignKey({ name: 'conversations_owned_action_fk', columns: [table.userId, table.actionId], foreignColumns: [actions.userId, actions.id] }),
  check('conversations_kind_check', sql`${table.kind} IN ('main', 'task')`),
  check('conversations_kind_action_check', sql`(${table.kind} = 'task' AND ${table.actionId} IS NOT NULL) OR (${table.kind} = 'main' AND ${table.actionId} IS NULL)`),
  check('conversations_sequence_check', sql`${table.nextSequence} BETWEEN 1 AND 9007199254740991`),
]);

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  conversationId: uuid('conversation_id').notNull(),
  sequence: bigint('sequence', { mode: 'number' }).notNull(),
  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  clientMessageId: text('client_message_id'),
  inputHash: text('input_hash'),
  text: text('text').notNull().default(''),
  parts: jsonb('parts').$type<UIMessage['parts']>().notNull().default(sql`'[]'::jsonb`),
  status: text('status', { enum: ['accepted', 'streaming', 'completed', 'failed', 'cancelled'] }).notNull().default('accepted'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('messages_user_id_id_unique').on(table.userId, table.id),
  unique('messages_user_conversation_id_unique').on(table.userId, table.conversationId, table.id),
  unique('messages_conversation_sequence_unique').on(table.conversationId, table.sequence),
  uniqueIndex('messages_user_client_id_unique').on(table.userId, table.clientMessageId).where(sql`${table.clientMessageId} IS NOT NULL`),
  foreignKey({ name: 'messages_owned_conversation_fk', columns: [table.userId, table.conversationId], foreignColumns: [conversations.userId, conversations.id] }),
  index('messages_conversation_created_index').on(table.conversationId, table.createdAt),
  check('messages_role_check', sql`${table.role} IN ('user', 'assistant', 'system')`),
  check('messages_status_check', sql`${table.status} IN ('accepted', 'streaming', 'completed', 'failed', 'cancelled')`),
  check('messages_sequence_check', sql`${table.sequence} BETWEEN 1 AND 9007199254740991`),
  check('messages_parts_array_check', sql`jsonb_typeof(${table.parts}) = 'array'`),
  check('messages_client_input_check', sql`(${table.clientMessageId} IS NULL AND ${table.inputHash} IS NULL) OR (${table.role} = 'user' AND ${table.clientMessageId} IS NOT NULL AND ${table.inputHash} IS NOT NULL)`),
]);
