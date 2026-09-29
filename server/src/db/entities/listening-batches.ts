import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './chat.js';
import type { StoredError } from './runtime.js';
import type { EchoLocationSpan } from '../../listening/location.js';
import type { AcceptedBatch } from '../../listening/batch-contract.js';
export interface BatchSegmentMetadata { segmentId: string; startedAt: string; endedAt: string; locations?: EchoLocationSpan[] }
/** Metadata only. New uploads keep raw audio in S3; legacy inputs remain in Temporal. */
export const listeningBatches = pgTable('listening_batches', {
 id: uuid('id').primaryKey().defaultRandom(), userId: uuid('user_id').notNull().references(()=>users.id),
 clientBatchId: uuid('client_batch_id').notNull(), streamId: uuid('stream_id').notNull(), sequence: integer('sequence').notNull(),
 sessionId: uuid('session_id').notNull(), contentHash:text('content_hash').notNull(),
 workflowVersion:integer('workflow_version').notNull().default(1),
 uploadInput:jsonb('upload_input').$type<AcceptedBatch>(),
 startedAt:timestamp('started_at',{withTimezone:true}).notNull(), endedAt:timestamp('ended_at',{withTimezone:true}).notNull(),
 audioMilliseconds:integer('audio_milliseconds').notNull(), segments:jsonb('segments').$type<BatchSegmentMetadata[]>().notNull(),
 status:text('status',{enum:['pending','transcribing','transcribed','failed','deleted']}).notNull().default('pending'),
 transcript:text('transcript').notNull().default(''), model:text('model'), error:jsonb('error').$type<StoredError>(),
 locationLabel:text('location_label'),
 attempts:integer('attempts').notNull().default(0), executionToken:uuid('execution_token'),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(), updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
 transcribedAt:timestamp('transcribed_at',{withTimezone:true}),
}, t=>[
 unique('listening_batches_client_unique').on(t.userId,t.clientBatchId), unique('listening_batches_sequence_unique').on(t.userId,t.streamId,t.sequence),
 index('listening_batches_user_time').on(t.userId,t.startedAt),
 check('listening_batches_status_check',sql`${t.status} IN ('pending','transcribing','transcribed','failed','deleted')`),
 check('listening_batches_sequence_check',sql`${t.sequence} > 0`),
 check('listening_batches_location_label_check',sql`${t.locationLabel} IS NULL OR char_length(${t.locationLabel}) BETWEEN 1 AND 80`),
 check('listening_batches_segments_check',sql`jsonb_typeof(${t.segments}) = 'array'`),
 check('listening_batches_time_check',sql`${t.endedAt} > ${t.startedAt} AND ${t.audioMilliseconds} > 0`),
]);
