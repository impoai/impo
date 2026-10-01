import { sql } from 'drizzle-orm';
import { check, foreignKey, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './chat.js';

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  installationId: text('installation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('devices_user_id_id_unique').on(table.userId, table.id),
  unique('devices_user_installation_unique').on(table.userId, table.installationId),
  check('devices_installation_check', sql`length(${table.installationId}) BETWEEN 1 AND 256`),
]);

export const deviceCapabilities = pgTable('device_capabilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  toolName: text('tool_name').notNull(),
}, table => [
  unique('device_capabilities_device_tool_unique').on(table.deviceId, table.toolName),
  foreignKey({ name: 'device_capabilities_owned_device_fk', columns: [table.userId, table.deviceId], foreignColumns: [devices.userId, devices.id] }),
  // A new name lets Drizzle push replace the previous list; same-name checks keep old expressions.
  check('device_capabilities_tool_v3_check', sql`${table.toolName} IN ('impo_list_calendar_events', 'impo_get_health_summary', 'ios_list_calendar_events', 'ios_get_health_summary', 'impo_list_reminders', 'impo_create_reminder', 'impo_search_contacts', 'impo_get_current_location')`),
]);
