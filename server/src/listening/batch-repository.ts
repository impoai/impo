import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { listeningBatches as batches } from '../db/schema.js';
import type { AcceptedBatch, StreamProgress } from './batch-contract.js';
import type { TranscriptionResult } from './transcriber.js';
import { ServiceError } from '../errors.js';

export const batchPublicFields = {id:batches.id,clientSegmentId:batches.clientBatchId,startedAt:batches.startedAt,endedAt:batches.endedAt,
 status:batches.status,transcript:batches.transcript,model:batches.model,error:batches.error,segments:batches.segments,locationLabel:batches.locationLabel,
 batchId:batches.clientBatchId,segmentCount:sql<number>`jsonb_array_length(${batches.segments})`,audioMilliseconds:batches.audioMilliseconds};
export class ListeningBatchRepository {
 constructor(private readonly db:Database) {}
 async receipt(userId:string,batchId:string) {return (await this.db.select().from(batches).where(and(eq(batches.userId,userId),eq(batches.clientBatchId,batchId))))[0];}
 async progress(userId:string):Promise<Record<string,StreamProgress>> {
  const rows=await this.db.select({stream:batches.streamId,sequence:batches.sequence,batchId:batches.clientBatchId,hash:batches.contentHash,status:batches.status}).from(batches).where(eq(batches.userId,userId)).orderBy(asc(batches.sequence));
  const progress:Record<string,StreamProgress>={};
  for(const r of rows) {if(['transcribed','deleted'].includes(r.status)) progress[r.stream]={next:r.sequence+1,lastBatchId:r.batchId,lastHash:r.hash};}
  return progress;
 }
 async reserve(batch:AcceptedBatch, workflowVersion=1) {
  const metadata=batch.items.map(({segmentId,startedAt,endedAt,locations})=>({segmentId,startedAt,endedAt,...(locations !== undefined ? {locations} : {})}));
  const ended=Math.max(...metadata.map(s=>Date.parse(s.endedAt)));
  await this.db.insert(batches).values({userId:batch.userId,clientBatchId:batch.batchId,streamId:batch.streamId,sequence:batch.sequence,sessionId:batch.sessionId,
   contentHash:batch.contentHash,workflowVersion,uploadInput:batch.audioSource ? batch : null,startedAt:new Date(metadata[0]!.startedAt),endedAt:new Date(ended),segments:metadata,
   audioMilliseconds:Math.round(metadata.reduce((n,s)=>n+Date.parse(s.endedAt)-Date.parse(s.startedAt),0))}).onConflictDoNothing();
  const row=await this.receipt(batch.userId,batch.batchId);
  if(!row || row.contentHash!==batch.contentHash) throw new ServiceError(409,'batch_conflict','This batch was already used for different audio.');
  return row;
 }
 async begin(batch:AcceptedBatch) {
  const row=await this.reserve(batch);
  if(['transcribed','deleted'].includes(row.status)) return {done:true as const,status:row.status};
  const token=randomUUID();
  const [claimed]=await this.db.update(batches).set({status:'transcribing',executionToken:token,attempts:sql`${batches.attempts}+1`,error:null,updatedAt:new Date()})
   .where(and(eq(batches.id,row.id),sql`${batches.status} IN ('pending','transcribing','failed')`)).returning();
  return claimed ? {done:false as const,id:row.id,token,attempts:claimed.attempts} : {done:true as const,status:'deleted'};
 }
 async complete(id:string,token:string,result:TranscriptionResult) {
  return (await this.db.update(batches).set({status:'transcribed',transcript:result.transcript,model:result.model,error:null,executionToken:null,uploadInput:null,transcribedAt:new Date(),updatedAt:new Date()})
   .where(and(eq(batches.id,id),eq(batches.executionToken,token),eq(batches.status,'transcribing'))).returning({id:batches.id})).length>0;
 }
 async clearUploadInput(userId:string,batchId:string){
  await this.db.update(batches).set({uploadInput:null}).where(and(eq(batches.userId,userId),eq(batches.clientBatchId,batchId),eq(batches.status,'deleted')));
 }
 async retry(id:string,token:string,code:string) {
  await this.db.update(batches).set({status:'pending',executionToken:null,error:{code,message:'Transcription will retry.',retryable:true},updatedAt:new Date()})
   .where(and(eq(batches.id,id),eq(batches.executionToken,token),eq(batches.status,'transcribing')));
 }
 async fail(userId:string,batchId:string,code:string) {
  await this.db.update(batches).set({status:'failed',executionToken:null,error:{code,message:'Transcription failed. Check Debug logs for this batch.',retryable:true},updatedAt:new Date()})
   .where(and(eq(batches.userId,userId),eq(batches.clientBatchId,batchId),sql`${batches.status} IN ('pending','transcribing','failed')`));
 }
 async list(userId:string,from:Date,to:Date) {return this.db.select(batchPublicFields).from(batches).where(and(eq(batches.userId,userId),gte(batches.startedAt,from),lt(batches.startedAt,to),sql`${batches.status}<>'deleted'`)).orderBy(asc(batches.startedAt),asc(batches.id)).limit(2000);}
 async history(userId:string,limit:number,before?:{startedAt:Date;id:string}) {return this.db.select(batchPublicFields).from(batches).where(and(eq(batches.userId,userId),sql`${batches.status}<>'deleted'`,before?sql`(${batches.startedAt},${batches.id}) < (${before.startedAt.toISOString()}::timestamptz,${before.id}::uuid)`:undefined)).orderBy(desc(batches.startedAt),desc(batches.id)).limit(limit);}
 async delete(userId:string,id:string) {return (await this.db.update(batches).set({status:'deleted',transcript:'',model:null,error:null,executionToken:null,locationLabel:null,
  segments:sql`(SELECT coalesce(jsonb_agg(item - 'locations'), '[]'::jsonb) FROM jsonb_array_elements(${batches.segments}) item)`,updatedAt:new Date()}).where(and(eq(batches.userId,userId),eq(batches.id,id))).returning({batchId:batches.clientBatchId,startedAt:batches.startedAt}))[0];}
}
