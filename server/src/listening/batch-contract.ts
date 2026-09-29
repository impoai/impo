/** Shared, deterministic data types; this module is safe inside a Workflow. */
import { temporalTaskQueue } from '../temporal/config.js';
import type { EchoLocationSpan } from './location.js';
export const listeningTaskQueue = temporalTaskQueue;
export const maxBatchBytes = 1_500_000;
export const maxBatchAudioBytes = 1_048_576;
export const maxBatchItems = 16;
export interface BatchItem {
  segmentId: string; startedAt: string; endedAt: string; mimeType: string; audio: string;
  locations?: EchoLocationSpan[];
}
export interface ListeningBatch {
  batchId: string; streamId: string; sequence: number; sessionId: string; items: BatchItem[];
}
export interface BatchAudioSource { key: string; sha256: string; byteLength: number }
export interface AcceptedBatch extends ListeningBatch { userId: string; contentHash: string; audioSource?: BatchAudioSource }
export interface BatchReceipt { batchId: string; streamId: string; sequence: number; status: 'accepted' }
export interface BatchDecision { receipt?: BatchReceipt; error?: 'batch_busy' | 'sequence_gap' | 'batch_conflict'; expectedSequence?: number }
export interface StreamProgress { next: number; lastBatchId?: string; lastHash?: string }
export interface ListeningWorkflowState { userId: string; streams?: Record<string, StreamProgress> }
export const listeningWorkflowId = (userId: string) => `impo/listening/${userId}`;
export const batchWorkflowId = (userId: string, batchId: string) => `impo/listening-batch/${userId}/${batchId}`;
export const batchReceipt = (batch: ListeningBatch): BatchReceipt => ({batchId: batch.batchId, streamId: batch.streamId, sequence: batch.sequence, status: 'accepted'});
