import { createHash } from 'node:crypto';
import { ServiceError } from '../errors.js';
import { uuid } from '../http/request.js';
import { maxBatchAudioBytes, maxBatchItems, type AcceptedBatch, type BatchItem } from './batch-contract.js';
import { parseEchoLocations } from './location.js';

export function parseListeningBatch(input: unknown, userId: string): AcceptedBatch {
  const invalid = (): never => { throw new ServiceError(400, 'invalid_batch', 'Invalid listening batch. Audio remains on this iPhone.'); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const b = input as Record<string, unknown>;
  if (Object.keys(b).some(k => !['batchId','streamId','sequence','sessionId','items'].includes(k))) return invalid();
  const batchId = uuid(String(b.batchId)); const streamId = uuid(String(b.streamId)); const sessionId = uuid(String(b.sessionId));
  if (!Number.isSafeInteger(b.sequence) || (Number(b.sequence) < 1 || Number(b.sequence) > 2_147_483_647) || !Array.isArray(b.items) || b.items.length < 1 || b.items.length > maxBatchItems) return invalid();
  let bytes = 0; let duration = 0; let previous = -Infinity;
  const ids = new Set<string>();
  const items: BatchItem[] = b.items.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const v = value as Record<string, unknown>;
    if(Object.keys(v).some(k=>!['segmentId','startedAt','endedAt','mimeType','audio','locations'].includes(k))) return invalid();
    const segmentId = uuid(String(v.segmentId));
    if(ids.has(segmentId)) return invalid(); ids.add(segmentId);
    const timestamp = (x: unknown) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(x) ? Date.parse(x) : NaN;
    const start = timestamp(v.startedAt); const end = timestamp(v.endedAt);
    if(!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end-start > 301_000 || end > Date.now()+300_000 || start < previous) return invalid();
    previous = start; duration += end-start;
    if(!['audio/mp4','audio/m4a','audio/wav','audio/mpeg','audio/aac'].includes(String(v.mimeType))) return invalid();
    if(typeof v.audio !== 'string' || !v.audio.length || v.audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v.audio) || Buffer.from(v.audio,'base64').toString('base64') !== v.audio) return invalid();
    bytes += Buffer.byteLength(v.audio, 'base64');
    const locations = parseEchoLocations(v.locations, start, end);
    return {segmentId, startedAt:new Date(start).toISOString(), endedAt:new Date(end).toISOString(), mimeType:String(v.mimeType), audio:v.audio,
      ...(locations !== undefined ? {locations} : {})};
  });
  if(bytes > maxBatchAudioBytes || duration > 301_000) throw new ServiceError(413, 'batch_too_large', 'Listening batch exceeds its audio limit.');
  const canonical = {batchId,streamId,sequence:Number(b.sequence),sessionId,items};
  return {...canonical,userId,contentHash:createHash('sha256').update(JSON.stringify(canonical)).digest('hex')};
}
