import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './chat.js';
import type { BriefContent, BriefInput, BriefSlot, BriefLocation } from '../../today/contract.js';
import { defaultBriefPreferences, type BriefPreferences, type BriefTopics } from '../../today/content.js';

export const todaySettings = pgTable('today_settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  timeZone: text('time_zone').notNull(), locale: text('locale').notNull(),
  displayName: text('display_name').notNull().default(''), location: jsonb('location').$type<BriefLocation>(),
  slots: jsonb('slots').$type<BriefSlot[]>().notNull(),
  contentPreferences: jsonb('content_preferences').$type<BriefPreferences>().notNull().default(defaultBriefPreferences),
  topics: jsonb('topics').$type<BriefTopics>().notNull().default({}),
  briefClientVersion: integer('brief_client_version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [check('today_settings_slots_array', sql`jsonb_typeof(${t.slots}) = 'array'`)]);

/** Append-only editions. Deleting an edition keeps its unique slot tombstone. */
export const todayBriefs = pgTable('today_briefs', {
  id: uuid('id').primaryKey().defaultRandom(), userId: uuid('user_id').notNull().references(() => users.id),
  localDate: text('local_date').notNull(), timeZone: text('time_zone').notNull(),
  slotId: text('slot_id').notNull(), slotLabel: text('slot_label').notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  status: text('status', { enum: ['pending', 'generating', 'completed', 'failed', 'deleted', 'withdrawn'] }).notNull().default('pending'),
  input: jsonb('input').$type<BriefInput>(), content: jsonb('content').$type<BriefContent>(),
  configVersion: text('config_version').notNull(), model: text('model'),
  creationStartedAt: timestamp('creation_started_at', { withTimezone: true }),
  providerSessionId: text('provider_session_id'), providerAgentId: text('provider_agent_id'),
  providerTurnId: text('provider_turn_id'), providerItemId: text('provider_item_id'),
  attempts: integer('attempts').notNull().default(0), errorCode: text('error_code'),
  repairCount: integer('repair_count').notNull().default(0),
  leaseToken: uuid('lease_token'), leaseUntil: timestamp('lease_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, t => [
  unique('today_briefs_slot_unique').on(t.userId, t.localDate, t.slotId),
  index('today_briefs_history').on(t.userId, t.scheduledAt, t.id),
  check('today_briefs_status_check', sql`${t.status} IN ('pending','generating','completed','failed','deleted','withdrawn')`),
  check('today_briefs_completed_check', sql`${t.status} <> 'completed' OR (${t.content} IS NOT NULL AND ${t.providerSessionId} IS NOT NULL AND ${t.providerTurnId} IS NOT NULL AND ${t.providerItemId} IS NOT NULL)`),
]);
