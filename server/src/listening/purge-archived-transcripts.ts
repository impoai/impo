/**
 * One-off: clear transcript text from PostgreSQL for recordings whose S3 archive copy holds
 * exactly the same text. Rows, timestamps and statuses stay; nothing unverified is cleared.
 * Run inside the VPC: node --import tsx src/listening/purge-archived-transcripts.ts
 */
import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { databaseRequiresSsl } from '../config.js';
import { createDatabase } from '../db/client.js';
import { MaintenanceRepository } from '../db/repositories/maintenance-repository.js';
import { transcriptKey } from './transcript-archive.js';

const url = process.env.DATABASE_URL, bucket = process.env.TRANSCRIPT_BUCKET;
if (!url || !bucket) throw new Error('DATABASE_URL and TRANSCRIPT_BUCKET are required');
const database = createDatabase(url, { ssl: databaseRequiresSsl(url) });
const repository = new MaintenanceRepository(database.db);
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const counts = { batchesCleared: 0, segmentsCleared: 0, missingInArchive: 0, mismatched: 0, changedMeanwhile: 0 };
const page = 200;
// DRY_RUN=1 verifies and counts without writing.
const dryRun = process.env.DRY_RUN === '1';

async function archived(userId: string, recordId: string, startedAt: Date): Promise<string | undefined> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: transcriptKey(userId, recordId, startedAt) }));
    return (JSON.parse(await object.Body!.transformToString()) as { transcript?: string }).transcript;
  } catch (error) { if (error instanceof NoSuchKey) return undefined; throw error; }
}
function check(copy: string | undefined, text: string): boolean {
  if (copy === undefined) { counts.missingInArchive++; return false; }
  if (copy !== text) { counts.mismatched++; return false; }
  return true;
}

try {
  for (let after = '00000000-0000-0000-0000-000000000000'; ;) {
    const rows = await repository.transcribedBatches(after, page, true);
    for (const row of rows) {
      if (!check(await archived(row.userId, row.clientBatchId, row.startedAt), row.transcript)) continue;
      if (dryRun) { counts.batchesCleared++; continue; }
      // Clear only if the text is still what was verified.
      const done = await repository.clearBatchTranscript(row);
      if (done) counts.batchesCleared++; else counts.changedMeanwhile++;
    }
    if (rows.length < page) break;
    after = rows.at(-1)!.id;
  }
  for (let after = '00000000-0000-0000-0000-000000000000'; ;) {
    const rows = await repository.transcribedSegments(after, page, true);
    for (const row of rows) {
      if (!check(await archived(row.userId, row.clientSegmentId, row.startedAt), row.transcript)) continue;
      if (dryRun) { counts.segmentsCleared++; continue; }
      const done = await repository.clearSegmentTranscript(row);
      if (done) counts.segmentsCleared++; else counts.changedMeanwhile++;
    }
    if (rows.length < page) break;
    after = rows.at(-1)!.id;
  }
  console.log(JSON.stringify({ event: 'transcript_purge_done', dryRun, ...counts }));
} finally { await database.close(); }
