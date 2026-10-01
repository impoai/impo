import { ListeningBatchRepository, batchPublicFields } from './listening-batch-repository.js';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, gt, gte, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { listeningSegments as segments, listeningBatches as batches } from '../schema.js';
import { ServiceError } from '../../errors.js';
import type { TranscriptionResult } from '../../listening/transcriber.js';
import { hydrateTranscripts, type TranscriptArchive } from '../../listening/transcript-archive.js';
import { parseLocationLabel, withEchoLocation } from '../../listening/location.js';

export const maxAudioBytes = 8 * 1024 * 1024;
export type Segment = typeof segments.$inferSelect;
export type ClaimedSegment = Segment & { leaseToken: string; audio: Buffer };
const publicFields = {
  id: segments.id, clientSegmentId: segments.clientSegmentId,
  startedAt: segments.startedAt, endedAt: segments.endedAt,
  status: segments.status, transcript: segments.transcript, model: segments.model, error: segments.error, locationLabel: segments.locationLabel,
};

export class ListeningRepository {
  constructor(private readonly db: Database, private readonly archive?: TranscriptArchive) {}

  async upload(userId: string, input: { clientSegmentId: string; startedAt: Date; endedAt: Date; mimeType: string; audio: Buffer }) {
    const audioHash = createHash('sha256').update(input.audio).digest('hex');
    const [inserted] = await this.db.insert(segments).values({ userId, ...input, audioBytes: input.audio.length, audioHash })
      .onConflictDoNothing({ target: [segments.userId, segments.clientSegmentId] }).returning(publicFields);
    if (inserted) return withEchoLocation(inserted);
    const [existing] = await this.db.select({ ...publicFields, audioHash: segments.audioHash, mimeType: segments.mimeType })
      .from(segments).where(and(eq(segments.userId, userId), eq(segments.clientSegmentId, input.clientSegmentId)));
    if (!existing) throw new Error('Missing upload receipt');
    if (existing.status === 'deleted') throw new ServiceError(410, 'segment_deleted', 'This recording has been deleted');
    if (existing.audioHash !== audioHash || existing.mimeType !== input.mimeType
      || existing.startedAt.getTime() !== input.startedAt.getTime() || existing.endedAt.getTime() !== input.endedAt.getTime()) {
      throw new ServiceError(409, 'segment_conflict', 'This recording ID was already used for different audio');
    }
    const { audioHash: _, mimeType: __, ...receipt } = existing;
    return withEchoLocation(receipt);
  }

  async list(userId: string, from: Date, to: Date) {
    // A day contains at most 1440 non-overlapping minute segments. Bound malformed clients too.
    const legacy = await this.db.select(publicFields).from(segments).where(and(eq(segments.userId, userId),
      gte(segments.startedAt, from), lt(segments.startedAt, to), ne(segments.status, 'deleted')))
      .orderBy(asc(segments.startedAt), asc(segments.id)).limit(2000);
    const batches = await new ListeningBatchRepository(this.db).list(userId, from, to);
    return (await hydrateTranscripts(this.archive, userId, [...legacy, ...batches].sort((a,b) => a.startedAt.getTime()-b.startedAt.getTime() || a.id.localeCompare(b.id)).slice(0,2000))).map(withEchoLocation);
  }

  async calendar(userId: string, timeZone: string) {
    // Only day/count metadata crosses the wire; never load transcript bodies to build the rail.
    const recordings = this.recordingMetadata(userId);
    const date = sql<string>`to_char(${recordings.startedAt} AT TIME ZONE ${timeZone}, 'YYYY-MM-DD')`.as('date');
    const days = await this.db.select({ date, count: count() }).from(recordings).groupBy(({ date }) => date).orderBy(({ date }) => desc(date));
    return { timeZone, days };
  }

  async timeline(userId: string, timeZone: string) {
    // Stable identities reserve the entire scroll range without reading S3 or
    // transferring transcript text. Hydration uses the owned records endpoint;
    // insertions/deletions cannot shift an offset page onto different recordings.
    const recordings = this.recordingMetadata(userId);
    const date = sql<string>`to_char(${recordings.startedAt} AT TIME ZONE ${timeZone}, 'YYYY-MM-DD')`.as('date');
    const days = await this.db.select({ date, ids: sql<string[]>`array_agg(${recordings.id} ORDER BY ${recordings.startedAt} DESC, ${recordings.id} DESC)` })
      .from(recordings).groupBy(({ date }) => date).orderBy(({ date }) => desc(date));
    return { timeZone, days };
  }

  private recordingMetadata(userId: string) {
    return this.db.select({ id: segments.id, startedAt: segments.startedAt }).from(segments)
      .where(and(eq(segments.userId, userId), ne(segments.status, 'deleted')))
      .unionAll(this.db.select({ id: batches.id, startedAt: batches.startedAt }).from(batches)
        .where(and(eq(batches.userId, userId), ne(batches.status, 'deleted')))).as('recordings');
  }

  async records(userId: string, ids: string[]) {
    const legacy = await this.db.select(publicFields).from(segments).where(and(eq(segments.userId, userId), inArray(segments.id, ids), ne(segments.status, 'deleted')));
    const current = await this.db.select(batchPublicFields).from(batches).where(and(eq(batches.userId, userId), inArray(batches.id, ids), ne(batches.status, 'deleted')));
    return { segments: (await hydrateTranscripts(this.archive, userId, [...legacy, ...current])).map(row => ({ ...withEchoLocation(row), cursor: this.cursor(row) })) };
  }

  private cursor(row: { startedAt: Date; id: string }) {
    return Buffer.from(JSON.stringify([row.startedAt.toISOString(), row.id])).toString('base64url');
  }

  async history(userId: string, limit: number, cursor?: string, beforeDate?: Date, direction: 'older' | 'newer' = 'older') {
    let before: { startedAt: Date; id: string } | undefined;
    if (cursor !== undefined) {
      try {
        if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== 'string'
          || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(decoded[0]) || !Number.isFinite(Date.parse(decoded[0]))
          || typeof decoded[1] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded[1])) throw new Error();
        before = { startedAt: new Date(decoded[0]), id: decoded[1] };
      } catch { throw new ServiceError(400, 'invalid_cursor', 'This Echo page is invalid. Refresh the list.'); }
    }
    const ascending = direction === 'newer';
    const order = ascending ? asc : desc;
    const bound = (date: typeof segments.startedAt | typeof batches.startedAt, id: typeof segments.id | typeof batches.id) =>
      before ? (ascending
        ? or(gt(date, before.startedAt), and(eq(date, before.startedAt), gt(id, before.id)))
        : or(lt(date, before.startedAt), and(eq(date, before.startedAt), lt(id, before.id))))
        : beforeDate ? lt(date, beforeDate) : undefined;
    const legacy = await this.db.select(publicFields).from(segments).where(and(eq(segments.userId, userId),
      ne(segments.status, 'deleted'), bound(segments.startedAt, segments.id)))
      .orderBy(order(segments.startedAt), order(segments.id)).limit(limit + 1);
    const current = await this.db.select(batchPublicFields).from(batches).where(and(eq(batches.userId, userId),
      ne(batches.status, 'deleted'), bound(batches.startedAt, batches.id)))
      .orderBy(order(batches.startedAt), order(batches.id)).limit(limit + 1);
    const rows = [...legacy, ...current].sort((a,b) => (ascending ? -1 : 1) * (b.startedAt.getTime()-a.startedAt.getTime() || b.id.localeCompare(a.id)));
    const page = rows.slice(0, limit); if (ascending) page.reverse();
    const first = page[0], last = page.at(-1), hasMore = rows.length > limit;
    return { segments: (await hydrateTranscripts(this.archive, userId, page)).map(row => ({ ...withEchoLocation(row), cursor: this.cursor(row) })),
      nextCursor: last && (ascending || hasMore) ? this.cursor(last) : null,
      previousCursor: first && (ascending ? hasMore : !!before || !!beforeDate) ? this.cursor(first) : null };
  }

  async labelLocation(userId: string, id: string, value: unknown) {
    const locationLabel = parseLocationLabel(value);
    await this.db.transaction(async tx => {
      const changed = await tx.update(batches).set({locationLabel,updatedAt:new Date()})
        .where(and(eq(batches.userId,userId),eq(batches.id,id),ne(batches.status, 'deleted'))).returning({id:batches.id});
      if (changed.length) return;
      const legacy = await tx.update(segments).set({locationLabel,updatedAt:new Date()})
        .where(and(eq(segments.userId,userId),eq(segments.id,id),ne(segments.status, 'deleted'))).returning({id:segments.id});
      if (!legacy.length) throw new ServiceError(404,'not_found','Recording not found');
    });
    const recording = (await this.records(userId,[id])).segments[0];
    if (!recording) throw new ServiceError(404,'not_found','Recording not found');
    return {segment:recording};
  }

  async delete(userId: string, id: string) {
    const batch = await new ListeningBatchRepository(this.db).delete(userId, id);
    // The database tombstone commits first; a failed archive delete surfaces as an error
    // and repeating the request deletes the same object again.
    if (batch) { await this.archive?.delete(userId, batch.batchId, batch.startedAt); return batch.batchId; }
    // A small tombstone makes deletion win against late uploads and in-flight transcription.
    const [row] = await this.db.update(segments).set({ status: 'deleted', audio: null, transcript: '', utterances: [],
      model: null, error: null, leaseToken: null, leaseUntil: null, locationLabel: null, updatedAt: new Date() })
      .where(and(eq(segments.userId, userId), eq(segments.id, id))).returning({ id: segments.id, clientSegmentId: segments.clientSegmentId, startedAt: segments.startedAt });
    if (!row) throw new ServiceError(404, 'not_found', 'Recording not found');
    await this.archive?.delete(userId, row.clientSegmentId, row.startedAt);
  }

  async claim(leaseMs: number): Promise<ClaimedSegment | undefined> {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(segments).where(or(
        and(eq(segments.status, 'pending'), lte(segments.availableAt, sql`now()`)),
        and(eq(segments.status, 'transcribing'), lte(segments.leaseUntil, sql`now()`)),
      )).orderBy(asc(segments.createdAt)).limit(1).for('update', { skipLocked: true });
      if (!row) return undefined;
      const [claimed] = await tx.update(segments).set({ status: 'transcribing', leaseToken: randomUUID(),
        leaseUntil: new Date(Date.now() + leaseMs), attempts: row.attempts + 1, updatedAt: new Date() })
        .where(eq(segments.id, row.id)).returning();
      return claimed as ClaimedSegment;
    });
  }

  private owned(job: ClaimedSegment) {
    return and(eq(segments.id, job.id), eq(segments.status, 'transcribing'), eq(segments.leaseToken, job.leaseToken), sql`${segments.leaseUntil} > now()`);
  }

  async renew(job: ClaimedSegment, leaseMs: number): Promise<boolean> {
    return (await this.db.update(segments).set({ leaseUntil: new Date(Date.now() + leaseMs) })
      .where(this.owned(job)).returning({ id: segments.id })).length > 0;
  }

  async complete(job: ClaimedSegment, result: TranscriptionResult): Promise<void> {
    const record = { userId: job.userId, recordId: job.clientSegmentId, kind: 'echo-segment' as const, startedAt: job.startedAt, endedAt: job.endedAt, ...result };
    // Archive before commit under a stable key, so a crash before commit is repaired by the retry.
    await this.archive?.put(record);
    // With an archive, the text lives only there; PostgreSQL keeps metadata and status.
    const stored = this.archive ? { ...result, transcript: '', utterances: [] } : result;
    const committed = await this.db.update(segments).set({ ...stored, status: 'transcribed', audio: null, error: null,
      leaseToken: null, leaseUntil: null, transcribedAt: new Date(), updatedAt: new Date() }).where(this.owned(job)).returning({ id: segments.id });
    if (!committed.length && this.archive) {
      // Only a deletion withdraws the object; a lost lease means another execution owns the key.
      const [current] = await this.db.select({ status: segments.status }).from(segments).where(eq(segments.id, job.id));
      if (current?.status === 'deleted') await this.archive.delete(record.userId, record.recordId, record.startedAt);
    }
  }

  async fail(job: ClaimedSegment, retryable: boolean): Promise<void> {
    const retry = retryable && job.attempts < 5;
    await this.db.update(segments).set({ status: retry ? 'pending' : 'failed',
      ...(retry ? {} : { audio: null }), leaseToken: null, leaseUntil: null,
      availableAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** job.attempts)),
      error: { code: 'transcription_failed', message: retry ? 'Transcription will retry shortly.' : 'This recording could not be transcribed.', retryable: retry },
      updatedAt: new Date() }).where(this.owned(job));
  }
}
