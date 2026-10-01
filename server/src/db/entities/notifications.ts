import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './chat.js';
import type { NotificationCategory, NotificationSettings } from '../../notifications/contract.js';

export const notificationSettings = pgTable('notification_settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  preferences: jsonb('preferences').$type<NotificationSettings & Record<string, unknown>>().notNull().default(sql`'{"chat":true,"tasks":true,"brief":true,"echo":true}'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [check('notification_settings_object', sql`jsonb_typeof(${t.preferences}) = 'object'`)]);
export const pushInstallations = pgTable('push_installations', {
  id: uuid('id').primaryKey(), userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  secretHash: text('secret_hash').notNull(), revision: bigint('revision', { mode: 'number' }).notNull(),
  registrationId: uuid('registration_id').notNull(), platform: text('platform', { enum: ['ios', 'android'] }).notNull(),
  token: text('token'), tokenHash: text('token_hash'), enabled: boolean('enabled').notNull(), revoked: boolean('revoked').notNull().default(false),
  foreground: boolean('foreground').notNull(), presenceAt: timestamp('presence_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('push_installations_user').on(t.userId),
  uniqueIndex('push_installations_token').on(t.tokenHash).where(sql`${t.tokenHash} IS NOT NULL`),
  check('push_installations_platform', sql`${t.platform} IN ('ios','android')`),
  check('push_installations_revision', sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
]);
export const notificationEvents = pgTable('notification_events', {
  id: uuid('id').primaryKey().defaultRandom(), userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sourceKey: text('source_key').notNull(), category: text('category').$type<NotificationCategory>().notNull(), targetId: uuid('target_id').notNull(),
  failed: boolean('failed').notNull().default(false),
  status: text('status', { enum: ['pending', 'ready', 'done', 'suppressed'] }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
}, t => [unique('notification_events_source').on(t.userId, t.sourceKey), index('notification_events_pending').on(t.status, t.scheduledAt),
  check('notification_events_category_v2', sql`${t.category} IN ('chat','tasks','brief','echo')`),
  check('notification_events_status', sql`${t.status} IN ('pending','ready','done','suppressed')`)]);
export const notificationDeliveries = pgTable('notification_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(), eventId: uuid('event_id').notNull().references(() => notificationEvents.id, { onDelete: 'cascade' }),
  installationId: uuid('installation_id').notNull().references(() => pushInstallations.id, { onDelete: 'cascade' }), registrationId: uuid('registration_id').notNull(), tokenHash: text('token_hash').notNull(),
  status: text('status', { enum: ['pending', 'sending', 'sent', 'suppressed', 'failed'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0), leaseToken: uuid('lease_token'), leaseUntil: timestamp('lease_until', { withTimezone: true }),
  providerMessageId: text('provider_message_id'), errorCode: text('error_code'), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [unique('notification_deliveries_target').on(t.eventId, t.installationId),
  check('notification_deliveries_status', sql`${t.status} IN ('pending','sending','sent','suppressed','failed')`)]);
