import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { messages, users } from './chat.js';

export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey(), userId: uuid('user_id').notNull().references(() => users.id),
  name: text('name').notNull(), mediaType: text('media_type').notNull(), sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(), status: text('status', { enum: ['uploading', 'ready'] }).notNull().default('uploading'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('attachments_owned_id_unique').on(table.userId, table.id),
  check('attachments_size_check', sql`${table.sizeBytes} BETWEEN 1 AND 10485760`),
  check('attachments_status_check', sql`${table.status} IN ('uploading', 'ready')`)]);

export const messageAttachments = pgTable('message_attachments', {
  userId: uuid('user_id').notNull(), messageId: uuid('message_id').notNull(), attachmentId: uuid('attachment_id').notNull(),
  position: integer('position').notNull(),
}, table => [primaryKey({ columns: [table.messageId, table.attachmentId] }),
  foreignKey({ columns: [table.userId, table.messageId], foreignColumns: [messages.userId, messages.id] }),
  foreignKey({ columns: [table.userId, table.attachmentId], foreignColumns: [attachments.userId, attachments.id] })]);
