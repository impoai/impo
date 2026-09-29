import { ApplicationFailure } from '@temporalio/common';
import { Context, heartbeat } from '@temporalio/activity';
import type { AcceptedBatch } from '../batch-contract.js';
import { ListeningBatchRepository } from '../batch-repository.js';
import { TranscriptionError, type BatchTranscriber } from '../transcriber.js';
import type { TranscriptArchive } from '../transcript-archive.js';
import { loadUploadedBatch, type AudioObjectStore } from '../audio-upload.js';
import { ServiceError } from '../../errors.js';

export const listeningLog = (event:string,fields:Record<string,unknown>={}) => console.log(JSON.stringify({event:`listening.${event}`,at:new Date().toISOString(),...fields}));
export function createListeningActivities(repository:ListeningBatchRepository, transcriber:BatchTranscriber, archive?:TranscriptArchive, objects?:AudioObjectStore) {
 return {
  loadProgress:(userId:string)=>repository.progress(userId),
  markFailed:(userId:string,batchId:string)=>repository.fail(userId,batchId,'transcription_failed'),
  async transcribeBatch(batch:AcceptedBatch):Promise<void> {
   const claim=await repository.begin(batch);
   if(claim.done){if(batch.audioSource)await objects?.delete(batch.audioSource);listeningLog('already_terminal',{batchId:batch.batchId,status:claim.status});return;}
   const context=Context.current();const start=Date.now();
   const timer=setInterval(()=>heartbeat({batchId:batch.batchId}),5000);timer.unref();
   listeningLog('transcription_started',{batchId:batch.batchId,sequence:batch.sequence,segments:batch.items.length,attempt:claim.attempts,workerAttempt:context.info.attempt});
   try {
    if(batch.audioSource && !objects)throw new Error('Audio object storage is not configured');
    const source=batch.audioSource ? await loadUploadedBatch(batch,objects!,context.cancellationSignal) : batch;
    const audio=source.items.map(i=>({audio:Buffer.from(i.audio,'base64'),mimeType:i.mimeType}));
    const result=await transcriber.transcribeMany(audio,context.cancellationSignal);
    context.cancellationSignal.throwIfAborted();
    // Archive first under a stable key, so a crash before commit is repaired by the retry.
    const row=archive?await repository.receipt(batch.userId,batch.batchId):undefined;
    const record=row?{userId:batch.userId,recordId:batch.batchId,kind:'echo-batch' as const,startedAt:row.startedAt,endedAt:row.endedAt,
     transcript:result.transcript,utterances:result.utterances,model:result.model,segments:row.segments,streamId:row.streamId,sequence:row.sequence}:undefined;
    if(record)await archive!.put(record,context.cancellationSignal);
    // With an archive, the text lives only there; PostgreSQL keeps metadata and status.
    const committed=await repository.complete(claim.id,claim.token,archive?{...result,transcript:''}:result);
    // Deleted while transcribing: withdraw it. A lost claim is not a deletion; the winning
    // execution owns the same key.
    if(record&&!committed&&(await repository.receipt(batch.userId,batch.batchId))?.status==='deleted')await archive!.delete(record.userId,record.recordId,record.startedAt);
    if(batch.audioSource && (committed || (await repository.receipt(batch.userId,batch.batchId))?.status==='deleted'))await objects!.delete(batch.audioSource);
    listeningLog('transcription_completed',{batchId:batch.batchId,ms:Date.now()-start,committed,characters:result.transcript.length});
   }catch(error){
    const code=error instanceof TranscriptionError?error.code:'transcription_interrupted';
    await repository.retry(claim.id,claim.token,code);
    listeningLog('transcription_retry',{batchId:batch.batchId,ms:Date.now()-start,code,attempt:claim.attempts});
    if(error instanceof TranscriptionError && !error.retryable) throw ApplicationFailure.nonRetryable(error.message,code);
    if(error instanceof ServiceError && !error.retryable)throw ApplicationFailure.nonRetryable('Invalid stored audio',error.code);
    throw ApplicationFailure.retryable('Transcription attempt failed',code);
   }finally{clearInterval(timer);}
  },
 };
}
export type ListeningActivities=ReturnType<typeof createListeningActivities>;
