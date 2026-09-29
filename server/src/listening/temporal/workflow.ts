import { allHandlersFinished, condition, continueAsNew, defineQuery, defineSignal, defineUpdate, proxyActivities, setHandler } from '@temporalio/workflow';
import { batchReceipt, type AcceptedBatch, type BatchDecision, type ListeningWorkflowState, type StreamProgress } from '../batch-contract.js';
import type { ListeningActivities } from './activities.js';

export const submitListeningBatch = defineUpdate<BatchDecision,[AcceptedBatch]>('submitListeningBatch');
export const retryListeningBatch = defineSignal<[string]>('retryListeningBatch');
export const listeningState = defineQuery<{batchId?:string;status:string;sequence?:number}>('listeningState');
const operations = proxyActivities<ListeningActivities>({
 startToCloseTimeout:'6 minutes', heartbeatTimeout:'30 seconds',
 retry:{initialInterval:'10 seconds',maximumInterval:'5 minutes',maximumAttempts:8},
});
const metadata = proxyActivities<Pick<ListeningActivities,'loadProgress'|'markFailed'>>({
 startToCloseTimeout:'30 seconds',retry:{initialInterval:'1 second',maximumInterval:'30 seconds'},
});

/** Exactly one logical coordinator per authenticated user in the production Namespace. */
export async function userListeningWorkflow(state:ListeningWorkflowState):Promise<void> {
 let streams:Record<string,StreamProgress> = state.streams ?? {};
 let ready = state.streams !== undefined;
 let active:AcceptedBatch|undefined;
 let status='idle'; let retry=false;
 setHandler(listeningState,()=>({batchId:active?.batchId,status,sequence:active?.sequence}));
 setHandler(retryListeningBatch,batchId=>{if(active?.batchId===batchId)retry=true;});
 setHandler(submitListeningBatch,async batch=>{
  await condition(()=>ready);
  if(batch.userId!==state.userId) return {error:'batch_conflict'};
  if(active) return active.batchId===batch.batchId && active.contentHash===batch.contentHash ? {receipt:batchReceipt(batch)} : {error:'batch_busy'};
  const progress=streams[batch.streamId]??{next:1};
  if(batch.sequence<progress.next) return progress.lastBatchId===batch.batchId && progress.lastHash===batch.contentHash ? {receipt:batchReceipt(batch)} : {error:'batch_conflict'};
  if(batch.sequence!==progress.next) return {error:'sequence_gap',expectedSequence:progress.next};
  // No awaits after the admission check: concurrent handlers cannot both admit.
  active=batch; status='pending';
  return {receipt:batchReceipt(batch)};
 });
 if(!ready){streams=await metadata.loadProgress(state.userId);ready=true;}
 while(true){
  await condition(()=>active!==undefined);
  const batch=active!;
  status='transcribing';retry=false;
  try {await operations.transcribeBatch(batch);}
  catch {
   status='failed';
   await metadata.markFailed(state.userId,batch.batchId);
   // Preserve accepted audio in Workflow state for explicit retry/deletion.
   await condition(()=>retry);
   continue;
  }
  streams[batch.streamId]={next:batch.sequence+1,lastBatchId:batch.batchId,lastHash:batch.contentHash};
  active=undefined;status='idle';
  // Handler completion and the empty check execute without yielding before CAN.
  await condition(allHandlersFinished);
  if(!active) return continueAsNew<typeof userListeningWorkflow>({userId:state.userId,streams});
 }
}
