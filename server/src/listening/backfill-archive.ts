/**
 * One-off: copy every already-transcribed Echo recording from PostgreSQL into the per-user
 * transcript archive. Idempotent (stable keys); reads only, never changes the database.
 * Run inside the VPC: node --import tsx src/listening/backfill-archive.ts
 */
import { and, asc, eq, gt } from 'drizzle-orm';
import { databaseRequiresSsl } from '../config.js';
import { createDatabase } from '../db/client.js';
import { listeningBatches as batches, listeningSegments as segments } from '../db/schema.js';
import { S3TranscriptArchive } from './transcript-archive.js';

const url = process.env.DATABASE_URL, bucket = process.env.TRANSCRIPT_BUCKET;
if (!url || !bucket) throw new Error('DATABASE_URL and TRANSCRIPT_BUCKET are required');
const database = createDatabase(url, { ssl: databaseRequiresSsl(url) });
const archive = new S3TranscriptArchive(bucket, process.env.AWS_REGION ?? 'us-east-1');
const users = new Set<string>();
const counts = { batches: 0, segments: 0, characters: 0 };
const page = 200;

try {
  for (let after = '00000000-0000-0000-0000-000000000000'; ;) {
    const rows = await database.db.select().from(batches).where(and(eq(batches.status, 'transcribed'), gt(batches.id, after))).orderBy(asc(batches.id)).limit(page);
    for (const row of rows) {
      await archive.put({ userId: row.userId, recordId: row.clientBatchId, kind: 'echo-batch', startedAt: row.startedAt, endedAt: row.endedAt,
        transcript: row.transcript, utterances: [], model: row.model ?? 'unknown', segments: row.segments, streamId: row.streamId, sequence: row.sequence });
      users.add(row.userId); counts.batches++; counts.characters += row.transcript.length;
    }
    if (rows.length < page) break;
    after = rows.at(-1)!.id;
  }
  for (let after = '00000000-0000-0000-0000-000000000000'; ;) {
    const rows = await database.db.select().from(segments).where(and(eq(segments.status, 'transcribed'), gt(segments.id, after))).orderBy(asc(segments.id)).limit(page);
    for (const row of rows) {
      await archive.put({ userId: row.userId, recordId: row.clientSegmentId, kind: 'echo-segment', startedAt: row.startedAt, endedAt: row.endedAt,
        transcript: row.transcript, utterances: row.utterances, model: row.model ?? 'unknown' });
      users.add(row.userId); counts.segments++; counts.characters += row.transcript.length;
    }
    if (rows.length < page) break;
    after = rows.at(-1)!.id;
  }
  console.log(JSON.stringify({ event: 'transcript_backfill_done', users: users.size, ...counts }));
} finally { await database.close(); }
