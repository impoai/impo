import { Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy, WorkflowNotFoundError } from '@temporalio/client';
import { ServiceError } from '../../errors.js';
import { ListeningBatchRepository } from '../batch-repository.js';
import { batchReceipt, batchWorkflowId, listeningTaskQueue, listeningWorkflowId, type AcceptedBatch, type BatchDecision, type BatchReceipt } from '../batch-contract.js';
import type { TemporalOptions } from '../../temporal/config.js';
export type { TemporalOptions } from '../../temporal/config.js';
export interface ListeningBatchService {submit(batch:AcceptedBatch):Promise<BatchReceipt>;retry(userId:string,batchId:string):Promise<void>;hasDurableBatch(userId:string,batchId:string):Promise<boolean>}

export async function createListeningBatchService(config:TemporalOptions,repository:ListeningBatchRepository) {
 const connection=await Connection.connect({address:config.address,...(config.apiKey?{tls:true,apiKey:config.apiKey}:{}),connectTimeout:'10 seconds'});
 const client=new Client({connection,namespace:config.namespace});
 const deadline=<T>(operation:()=>Promise<T>)=>connection.withDeadline(Date.now()+20_000,operation);
 return {
  client,close:()=>connection.close(),
  async hasDurableBatch(userId:string,batchId:string){
   try{await deadline(()=>client.workflow.getHandle(batchWorkflowId(userId,batchId)).describe());return true;}
   catch(error){if(error instanceof WorkflowNotFoundError)return false;throw error;}
  },
  async submit(batch:AcceptedBatch):Promise<BatchReceipt>{
   const previous=await repository.receipt(batch.userId,batch.batchId);
   if(previous){
    if(previous.contentHash!==batch.contentHash)throw new ServiceError(409,'batch_conflict','This batch ID was already used for different audio.');
    if(previous.status==='deleted')throw new ServiceError(410,'batch_deleted','This batch was deleted.');
    if(previous.workflowVersion===1 || previous.status==='transcribed')return batchReceipt(batch);
   } else {
    // Preserve a legacy coordinator's accepted audio during rollout, including an
    // acknowledgement lost before its first Activity inserted metadata.
    try {
     const legacy=client.workflow.getHandle(listeningWorkflowId(batch.userId));
     const state=await connection.withDeadline(Date.now()+5000,()=>legacy.query<{batchId?:string}>('listeningState'));
     if(state.batchId===batch.batchId){
      const result=await deadline(()=>legacy.executeUpdate<BatchDecision,[AcceptedBatch]>('submitListeningBatch',{args:[batch]}));
      if(!result.receipt)throw new ServiceError(409,'batch_conflict','This batch ID was already used for different audio.');
      return result.receipt;
     }
    }catch(error){if(!(error instanceof WorkflowNotFoundError))throw error;}
   }
   // Metadata reservation fences conflicting IDs/sequences; it never acknowledges audio.
   // A failed/ambiguous start leaves the local payload intact and retries this exact ID.
   const row=await repository.reserve(batch,2);
   if(row.status==='deleted')throw new ServiceError(410,'batch_deleted','This batch was deleted.');
   try {
    await deadline(()=>client.workflow.start('batchListeningWorkflow',{
     workflowId:batchWorkflowId(batch.userId,batch.batchId),taskQueue:config.taskQueue??listeningTaskQueue,
     workflowIdReusePolicy:WorkflowIdReusePolicy.REJECT_DUPLICATE,args:[batch],
     priority:{fairnessKey:batch.userId,fairnessWeight:1},
    }));
   }catch(error){if(!(error instanceof WorkflowExecutionAlreadyStartedError))throw error;}
   // Start acknowledgement means Temporal durably owns the audio, even with no Worker.
   // Worker concurrency bounds model calls; uploads do not wait for transcription.
   return batchReceipt(batch);
  },
  async retry(userId:string,batchId:string){
   const row=await repository.receipt(userId,batchId);
   if(!row)throw new ServiceError(404,'not_found','Batch not found.');
   if(row.status==='transcribed')return;
   try {
    await deadline(()=>client.workflow.getHandle(row.workflowVersion>=2 ? batchWorkflowId(userId,batchId) : listeningWorkflowId(userId)).signal('retryListeningBatch',batchId));
   }catch(error){if(!(error instanceof WorkflowNotFoundError) || row.status!=='deleted')throw error;}
  },
 };
}
