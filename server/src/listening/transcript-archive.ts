import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Utterance } from '../db/entities/listening.js';
import type { BatchSegmentMetadata } from '../db/entities/listening-batches.js';

/**
 * Durable per-user transcript archive and the only home of transcript text when configured:
 * PostgreSQL keeps recording metadata and status. One object per Echo recording, written
 * before the database marks it transcribed; deleting the recording deletes the object.
 */
export interface TranscriptRecord {
  userId: string;
  /** The client batch ID (or legacy client segment ID); stable across retries. */
  recordId: string;
  kind: 'echo-batch' | 'echo-segment';
  startedAt: Date; endedAt: Date;
  transcript: string; utterances: Utterance[]; model: string;
  segments?: BatchSegmentMetadata[];
  streamId?: string; sequence?: number;
}
export interface TranscriptArchive {
  put(record: TranscriptRecord, signal?: AbortSignal): Promise<void>;
  delete(userId: string, recordId: string, startedAt: Date, signal?: AbortSignal): Promise<void>;
  /** The archived transcript text, or undefined when no object exists. */
  get(userId: string, recordId: string, startedAt: Date, signal?: AbortSignal): Promise<string | undefined>;
}

/** Fill `transcript` from the archive for transcribed rows; PostgreSQL keeps only metadata. */
export async function hydrateTranscripts<T extends { status: string; transcript: string; clientSegmentId: string; startedAt: Date }>(
  archive: TranscriptArchive | undefined, userId: string, rows: T[]): Promise<T[]> {
  if (!archive) return rows;
  const result = [...rows];
  // Bounded fan-out: a day view can hold many recordings.
  for (let start = 0; start < result.length; start += 32) {
    await Promise.all(result.slice(start, start + 32).map(async (row, offset) => {
      if (row.status !== 'transcribed' || row.transcript) return;
      const text = await archive.get(userId, row.clientSegmentId, row.startedAt);
      if (text !== undefined) result[start + offset] = { ...row, transcript: text };
    }));
  }
  return result;
}

/** users/{userId}/echo/{UTC day}/{UTC start time}_{recordId}.json — chronological per user. */
export function transcriptKey(userId: string, recordId: string, startedAt: Date): string {
  const iso = startedAt.toISOString();
  return `users/${userId}/echo/${iso.slice(0, 10)}/${iso.slice(11, 19).replaceAll(':', '')}Z_${recordId}.json`;
}

export class S3TranscriptArchive implements TranscriptArchive {
  private readonly client: S3Client;
  constructor(private readonly bucket: string, region: string) {
    // Credentials come from the ECS task role through the SDK default chain.
    this.client = new S3Client({ region });
  }

  async put(record: TranscriptRecord, signal?: AbortSignal): Promise<void> {
    const body = JSON.stringify({
      schemaVersion: 1, kind: record.kind, userId: record.userId, recordId: record.recordId,
      startedAt: record.startedAt.toISOString(), endedAt: record.endedAt.toISOString(),
      ...(record.streamId ? { streamId: record.streamId, sequence: record.sequence } : {}),
      ...(record.segments ? { segments: record.segments } : {}),
      model: record.model, transcript: record.transcript, utterances: record.utterances,
      archivedAt: new Date().toISOString(),
    });
    // Same key on retry: a repeated write replaces the object with identical content.
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: transcriptKey(record.userId, record.recordId, record.startedAt),
      Body: body, ContentType: 'application/json' }), { abortSignal: signal });
  }

  async delete(userId: string, recordId: string, startedAt: Date, signal?: AbortSignal): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: transcriptKey(userId, recordId, startedAt) }), { abortSignal: signal });
  }

  async get(userId: string, recordId: string, startedAt: Date, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: transcriptKey(userId, recordId, startedAt) }), { abortSignal: signal });
      const transcript = (JSON.parse(await object.Body!.transformToString()) as { transcript?: unknown }).transcript;
      return typeof transcript === 'string' ? transcript : undefined;
    } catch (error) { if (error instanceof NoSuchKey) return undefined; throw error; }
  }
}

/** Local development and tests: keeps objects in memory. */
export class MemoryTranscriptArchive implements TranscriptArchive {
  readonly objects = new Map<string, TranscriptRecord>();
  async put(record: TranscriptRecord): Promise<void> { this.objects.set(transcriptKey(record.userId, record.recordId, record.startedAt), record); }
  async delete(userId: string, recordId: string, startedAt: Date): Promise<void> { this.objects.delete(transcriptKey(userId, recordId, startedAt)); }
  async get(userId: string, recordId: string, startedAt: Date): Promise<string | undefined> { return this.objects.get(transcriptKey(userId, recordId, startedAt))?.transcript; }
}
