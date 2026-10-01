import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users, actions } from './chat.js';
import type { TaskSchedule } from '../../scheduling/contract.js';

export const scheduledTasks = pgTable('scheduled_tasks', {
  id: uuid('id').primaryKey().defaultRandom(), userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clientRequestId: text('client_request_id').notNull(), requestHash: text('request_hash').notNull(),
  title: text('title').notNull(), goal: text('goal').notNull(), schedule: jsonb('schedule').$type<TaskSchedule>().notNull(),
  enabled: boolean('enabled').notNull().default(true), revision: uuid('revision').notNull().defaultRandom(),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [unique('scheduled_tasks_owned_id').on(t.userId, t.id), unique('scheduled_tasks_command').on(t.userId, t.clientRequestId),
  index('scheduled_tasks_owner').on(t.userId, t.createdAt),
  check('scheduled_tasks_title', sql`char_length(${t.title}) BETWEEN 1 AND 120`),
  check('scheduled_tasks_goal', sql`char_length(${t.goal}) BETWEEN 1 AND 4000`),
  check('scheduled_tasks_schedule', sql`jsonb_typeof(${t.schedule}) = 'object'`)]);

export const scheduledTaskRuns = pgTable('scheduled_task_runs', {
  id: uuid('id').primaryKey().defaultRandom(), userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  scheduleId: uuid('schedule_id').notNull(), revision: uuid('revision').notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  taskId: uuid('task_id'), status: text('status', { enum: ['started', 'skipped_overlap'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [unique('scheduled_task_runs_occurrence').on(t.scheduleId, t.revision, t.scheduledAt),
  foreignKey({ columns: [t.userId, t.scheduleId], foreignColumns: [scheduledTasks.userId, scheduledTasks.id] }).onDelete('cascade'),
  foreignKey({ columns: [t.userId, t.taskId], foreignColumns: [actions.userId, actions.id] }),
  index('scheduled_task_runs_history').on(t.userId, t.scheduleId, t.scheduledAt),
  check('scheduled_task_runs_status', sql`${t.status} IN ('started','skipped_overlap')`)]);
