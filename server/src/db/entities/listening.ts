import { sql } from 'drizzle-orm';
import { check, customType, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './chat.js';
import type { StoredError } from './runtime.js';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/** One speaker's run of words, sliced from the transcript text so CJK spacing survives. */
export interface Utterance { speaker: string | null; startMs: number; endMs: number; text: string }

/**
 * A recorded stretch of audio from Listening. The audio is only kept until it is
 * transcribed; after that only the text remains. Transcription is claimed with a
 * lease by the Worker, independent of chat submissions and their outbox.
 */
export const listeningSegments = pgTable('listening_segments', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  clientSegmentId: text('client_segment_id').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
  mimeType: text('mime_type').notNull(),
  audio: bytea('audio'),
  audioHash: text('audio_hash').notNull(),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  audioBytes: integer('audio_bytes').notNull(),
  status: text('status', { enum: ['pending', 'transcribing', 'transcribed', 'failed', 'deleted'] }).notNull().default('pending'),
  transcript: text('transcript').notNull().default(''),
  locationLabel: text('location_label'),
  utterances: jsonb('utterances').$type<Utterance[]>().notNull().default(sql`'[]'::jsonb`),
  model: text('model'),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  error: jsonb('error').$type<StoredError>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  transcribedAt: timestamp('transcribed_at', { withTimezone: true }),
}, (table) => [
  unique('listening_segments_client_unique').on(table.userId, table.clientSegmentId),
  index('listening_segments_user_time_index').on(table.userId, table.startedAt),
  index('listening_segments_pending_index').on(table.createdAt).where(sql`${table.status} IN ('pending', 'transcribing')`),
  check('listening_segments_status_check', sql`${table.status} IN ('pending', 'transcribing', 'transcribed', 'failed', 'deleted')`),
  check('listening_segments_time_check', sql`${table.endedAt} >= ${table.startedAt}`),
  check('listening_segments_location_label_check', sql`${table.locationLabel} IS NULL OR char_length(${table.locationLabel}) BETWEEN 1 AND 80`),
  check('listening_segments_audio_check', sql`(${table.status} IN ('pending', 'transcribing') AND ${table.audio} IS NOT NULL) OR (${table.status} IN ('transcribed', 'failed', 'deleted') AND ${table.audio} IS NULL)`),
  check('listening_segments_bytes_check', sql`${table.audioBytes} > 0`),
  check('listening_segments_utterances_check', sql`jsonb_typeof(${table.utterances}) = 'array'`),
  check('listening_segments_lease_check', sql`(${table.status} = 'transcribing' AND ${table.leaseToken} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL) OR (${table.status} <> 'transcribing' AND ${table.leaseToken} IS NULL AND ${table.leaseUntil} IS NULL)`),
]);
