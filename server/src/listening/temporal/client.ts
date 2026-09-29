import { randomUUID } from 'node:crypto';
import { Client, Connection, WithStartWorkflowOperation, WorkflowIdConflictPolicy, WorkflowNotFoundError } from '@temporalio/client';
import { ServiceError } from '../../errors.js';
import { ListeningBatchRepository } from '../batch-repository.js';
import { batchReceipt, listeningTaskQueue, listeningWorkflowId, type AcceptedBatch, type BatchDecision, type BatchReceipt } from '../batch-contract.js';
import type { TemporalOptions } from '../../temporal/config.js';
export type { TemporalOptions } from '../../temporal/config.js';
export interface ListeningBatchService {submit(batch:AcceptedBatch):Promise<BatchReceipt>;retry(userId:string,batchId:string):Promise<void>}
export async function createListeningBatchService(config:TemporalOptions,repository:ListeningBatchRepository) {
 const connection=await Connection.connect({address:config.address,...(config.apiKey?{tls:true,apiKey:config.apiKey}:{}),connectTimeout:'10 seconds'});
 const client=new Client({connection,namespace:config.namespace});
 return {
  client,close:()=>connection.close(),
  async submit(batch:AcceptedBatch):Promise<BatchReceipt>{
   const previous=await repository.receipt(batch.userId,batch.batchId);
   if(previous){
    if(previous.contentHash!==batch.contentHash)throw new ServiceError(409,'batch_conflict','This batch ID was already used for different audio.');
    if(previous.status==='deleted')throw new ServiceError(410,'batch_deleted','This batch was deleted.');
    return batchReceipt(batch);
   }
   // Do not append rejected audio updates while another batch is running.
   // The Workflow handler still arbitrates simultaneous callers atomically.
   try {
    const state=await connection.withDeadline(Date.now()+5000,()=>client.workflow.getHandle(listeningWorkflowId(batch.userId)).query<{batchId?:string;status:string}>('listeningState'));
    if(state.batchId && state.batchId!==batch.batchId) throw new ServiceError(429,'batch_busy','Your previous batch is still processing. Audio remains on this iPhone.',true);
   }catch(error){if(!(error instanceof WorkflowNotFoundError))throw error;}
   const startWorkflowOperation=new WithStartWorkflowOperation('userListeningWorkflow',{
    workflowId:listeningWorkflowId(batch.userId),taskQueue:config.taskQueue??listeningTaskQueue,
    workflowIdConflictPolicy:WorkflowIdConflictPolicy.USE_EXISTING,args:[{userId:batch.userId}],
    priority:{fairnessKey:batch.userId,fairnessWeight:1},
   });
   const decision=await connection.withDeadline(Date.now()+20_000,()=>client.workflow.executeUpdateWithStart<() => Promise<void>,BatchDecision,[AcceptedBatch]>('submitListeningBatch',{
    startWorkflowOperation,args:[batch],updateId:randomUUID(),
   }));
   if(!decision.receipt)throw new ServiceError(decision.error==='batch_busy'?429:409,decision.error??'batch_conflict',
    decision.error==='batch_busy'?'Your previous batch is still processing. Audio remains on this iPhone.':`Batch sequence conflict. Expected ${decision.expectedSequence??'the original batch'}.`,decision.error==='batch_busy');
   return decision.receipt;
  },
  async retry(userId:string,batchId:string){
   const row=await repository.receipt(userId,batchId);
   if(!row)throw new ServiceError(404,'not_found','Batch not found.');
   await client.workflow.getHandle(listeningWorkflowId(userId)).signal('retryListeningBatch',batchId);
  },
 };
}
