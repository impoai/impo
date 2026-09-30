import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './chat.js';

/** Account-level app profile, so onboarding and the assistant's look survive sign-out and new devices. */
export const userProfiles = pgTable('user_profiles', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  assistantName: text('assistant_name'),
  avatarIndex: integer('avatar_index'),
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('user_profiles_assistant_name_check', sql`${table.assistantName} IS NULL OR length(${table.assistantName}) BETWEEN 1 AND 30`),
  check('user_profiles_avatar_check', sql`${table.avatarIndex} IS NULL OR ${table.avatarIndex} BETWEEN 0 AND 6`),
]);
