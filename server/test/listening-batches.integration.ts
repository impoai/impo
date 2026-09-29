import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { listeningBatches } from '../src/db/schema.js';
import { createRuntimeRepository } from '../src/runtime.js';
import { loadConfig } from '../src/config.js';
import { ListeningBatchRepository } from '../src/listening/batch-repository.js';
import { ListeningRepository } from '../src/listening/repository.js';
import { parseListeningBatch } from '../src/listening/batch-input.js';
import { createListeningBatchService } from '../src/listening/temporal/client.js';
import { createListeningTemporalWorker } from '../src/listening/temporal/worker.js';
import { MemoryTranscriptArchive, transcriptKey } from '../src/listening/transcript-archive.js';
import { listeningWorkflowId } from '../src/listening/batch-contract.js';
import { createApiServer } from '../src/http/api-server.js';
import { TodayRepository } from '../src/today/repository.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { TranscriptionError } from '../src/listening/transcriber.js';

async function until(check:()=>Promise<boolean>,timeout=40000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(100);}throw new Error('Timed out');}
test('real Temporal: global admission, duplicate delivery, sequence, retry, deletion, worker restart and HTTP receipts', {timeout:120000}, async()=>{
 const portServer=createServer();portServer.listen(0,'127.0.0.1');await once(portServer,'listening');const port=(portServer.address() as {port:number}).port;await new Promise<void>(r=>portServer.close(()=>r()));
 const temporal=spawn('temporal',['server','start-dev','--ip','127.0.0.1','--port',String(port),'--headless'],{stdio:'ignore'});
 const database=createDatabase(process.env.DATABASE_URL!);const repo=new ListeningBatchRepository(database.db);
 const config={address:`127.0.0.1:${port}`,namespace:'default',taskQueue:`test-${randomUUID()}`};
 let first:Awaited<ReturnType<typeof createListeningBatchService>>|undefined;
 let second:typeof first;
 const workers:Array<Awaited<ReturnType<typeof createListeningTemporalWorker>>>=[];const running:Promise<void>[]=[];
 const apis:ReturnType<typeof createApiServer>[]=[];
 let blocked=true;let failing=false;let calls=0;let concurrent=0;let maximum=0;const sizes:number[]=[];
 const transcriber={model:'test',async transcribe(){return {transcript:'unused',utterances:[],model:'test'};},async transcribeMany(items:unknown[],signal:AbortSignal){
  calls++;sizes.push(items.length);concurrent++;maximum=Math.max(maximum,concurrent);
  try {while(blocked)await delay(30,undefined,{signal});if(failing)throw new TranscriptionError('synthetic permanent failure',false,'synthetic_failure');return {transcript:'batch transcript',utterances:[],model:'test'};}finally{concurrent--;}
 }};
 // Per-user S3 archive stand-in; counts writes and deletions to observe in-flight races.
 const archive=new MemoryTranscriptArchive();let archiveDeletes=0;const baseDelete=archive.delete.bind(archive);archive.delete=async(...a)=>{archiveDeletes++;return baseDelete(...a);};
 const archived=async(userId:string,batchId:string)=>{const row=await repo.receipt(userId,batchId);return row?archive.objects.get(transcriptKey(userId,batchId,row.startedAt)):undefined;};
 async function worker(){const w=await createListeningTemporalWorker(config,repo,transcriber,archive);workers.push(w);running.push(w.worker.run());return w;}
 try {
  await until(async()=>{try{first=await createListeningBatchService(config,repo);return true;}catch{return false;}},20000);
  second=await createListeningBatchService(config,repo);
  const runtime=createRuntimeRepository(database.db,loadConfig('api'));const user=await runtime.findUser('alice');
  for(const service of [first!,second!]){const api=createApiServer(runtime,{batches:repo,batchService:service,listening:new ListeningRepository(database.db,archive),listeningEnabled:true});api.listen(0,'127.0.0.1');await once(api,'listening');apis.push(api);}
  const post=async(batch:any,index=0)=>fetch(`http://127.0.0.1:${(apis[index]!.address() as {port:number}).port}/api/v1/listening/batches`,{method:'POST',headers:{Authorization:'Bearer instant-dev-alice','Content-Type':'application/json'},body:JSON.stringify(batch)});
  await worker();await worker();
  const streamId=randomUUID();const sessionId=randomUUID();
  const input=(sequence:number)=>({batchId:randomUUID(),streamId,sequence,sessionId,items:[0,1].map(i=>({segmentId:randomUUID(),startedAt:new Date(Date.now()-10000+i*2000).toISOString(),endedAt:new Date(Date.now()-9000+i*2000).toISOString(),mimeType:'audio/mp4',audio:Buffer.from('synthetic').toString('base64')}))});
  const one=input(1);const two=input(2);
  const locations=one.items.map((item,i)=>[{from:item.startedAt,to:item.endedAt,capturedAt:item.startedAt,accuracyMeters:80,source:'device' as const,granularity:'district' as const,city:'Shanghai',country:'China',district:i===0?"Jing’an":'Huangpu'}]);
  one.items.forEach((item,i)=>Object.assign(item,{locations:locations[i]}));
  const receipts=await Promise.all([post(one),post(one,1)]);assert.deepEqual(receipts.map(r=>r.status),[202,202]);
  await until(async()=>calls===1);
  assert.equal((await post(two,1)).status,429);
  assert.equal((await post({...one,items:[{...one.items[0],audio:'YWJj'}]})).status,409);
  assert.equal((await repo.receipt(user.id,one.batchId))?.status,'transcribing');
  blocked=false;await until(async()=>(await repo.receipt(user.id,one.batchId))?.status==='transcribed');
  assert.equal((await post(one)).status,202);assert.equal(calls,1);
  assert.equal((await post({...one,items:one.items.map(item=>({...item,locations:[]}))})).status,409,'changing recording location cannot mutate a sealed batch');
  // The raw transcript is archived per user, keyed by the recording's start time and batch ID.
  const archivedOne=await archived(user.id,one.batchId);assert.equal(archivedOne?.transcript,'batch transcript');assert.equal(archivedOne?.segments?.length,2);
  assert.deepEqual(archivedOne?.segments?.map(s=>s.locations),locations,'archive retains each recording interval and place');
  assert.ok([...archive.objects.keys()].every(key=>key.startsWith(`users/${user.id}/echo/`)));
  // PostgreSQL keeps no transcript text; Echo reads it back from the archive.
  assert.equal((await repo.receipt(user.id,one.batchId))?.transcript,'');
  const echo=await new ListeningRepository(database.db,archive).history(user.id,20);
  assert.equal(echo.segments.find(x=>x.clientSegmentId===one.batchId)?.transcript,'batch transcript');
  const rowOne=(await repo.receipt(user.id,one.batchId))!;
  await assert.rejects(()=>database.db.update(listeningBatches).set({locationLabel:'x'.repeat(81)}).where(eq(listeningBatches.id,rowOne.id)));
  await assert.rejects(()=>database.db.update(listeningBatches).set({segments:{} as any}).where(eq(listeningBatches.id,rowOne.id)));
  const recording=echo.segments.find(x=>x.id===rowOne.id)!;
  assert.deepEqual(recording.location?.spans,locations.flat());
  assert.equal('segments' in recording,false); assert.equal('locationLabel' in recording,false);
  const today=new TodayRepository(database.db,archive);
  const originalSource=await today.currentSource(user.id,{kind:'batch',recordId:rowOne.id});
  assert.deepEqual(originalSource?.location?.spans,locations.flat());
  const patch=(label:unknown,token='alice')=>fetch(`http://127.0.0.1:${(apis[0]!.address() as {port:number}).port}/api/v1/listening/segments/${rowOne.id}/location`,{method:'PATCH',headers:{Authorization:`Bearer instant-dev-${token}`,'Content-Type':'application/json'},body:JSON.stringify({label})});
  assert.equal((await patch('Home','bob')).status,404);
  assert.equal((await patch('x'.repeat(81))).status,400);
  const labeled=await patch('Office');assert.equal(labeled.status,200);
  assert.equal((await labeled.json()).segment.location.label,'Office');
  const changedSource=await today.currentSource(user.id,{kind:'batch',recordId:rowOne.id});
  assert.notEqual(changedSource?.version,originalSource?.version,'edited annotations invalidate generated Brief sources');
  assert.equal(changedSource?.location?.source,'manual');
  const far={at:'9999-12-31T00:00:00.000Z',id:'ffffffff-ffff-ffff-ffff-ffffffffffff'};
  const evidence=await new MemoryRepository(database.db,archive).evidence(user.id,{echo:{after:null,through:far}},10,new Date(Date.now()+3600000));
  assert.equal(evidence.find(e=>e.id===`echo:${rowOne.id}`)?.location?.label,'Office');
  assert.deepEqual(evidence.find(e=>e.id===`echo:${rowOne.id}`)?.location?.spans,locations.flat());
  assert.equal((await patch(null)).status,200);
  assert.equal((await today.currentSource(user.id,{kind:'batch',recordId:rowOne.id}))?.version,originalSource?.version);
  assert.equal((await post(input(4))).status,409);
  assert.equal((await post(two,1)).status,202);await until(async()=>(await repo.receipt(user.id,two.batchId))?.status==='transcribed');
  assert.equal(maximum,1);assert.deepEqual(sizes,[2,2]);
  // Deleting a transcribed recording over HTTP deletes its archived transcript.
  const twoRow=await repo.receipt(user.id,two.batchId);assert.ok(await archived(user.id,two.batchId));
  const removed=await fetch(`http://127.0.0.1:${(apis[0]!.address() as {port:number}).port}/api/v1/listening/segments/${twoRow!.id}`,{method:'DELETE',headers:{Authorization:'Bearer instant-dev-alice'}});
  assert.equal(removed.status,200);assert.equal(archive.objects.has(transcriptKey(user.id,two.batchId,twoRow!.startedAt)),false);
  const history=await new ListeningRepository(database.db).history(user.id,20);assert.equal(history.segments.filter(x=>x.clientSegmentId===one.batchId).length,1);
  assert.equal('audio' in (await repo.receipt(user.id,one.batchId))!,false);
  // A failed batch retains its place and can be retried without resending audio.
  failing=true;const three=input(3);assert.equal((await post(three)).status,202);
  await until(async()=>(await repo.receipt(user.id,three.batchId))?.status==='failed');
  failing=false;await first!.retry(user.id,three.batchId);
  await until(async()=>(await repo.receipt(user.id,three.batchId))?.status==='transcribed');
  // Deletion wakes a failed workflow and does not resurrect content.
  failing=true;const four=input(4);assert.equal((await post(four)).status,202);
  await until(async()=>(await repo.receipt(user.id,four.batchId))?.status==='failed');
  const row=await repo.receipt(user.id,four.batchId);await repo.delete(user.id,row!.id);await first!.retry(user.id,four.batchId);
  await until(async()=>{const state=await first!.client.workflow.getHandle(listeningWorkflowId(user.id)).query<{status:string}>('listeningState');return state.status==='idle';});
  assert.equal((await post(four)).status,410);failing=false;
  // Stop every poller, accept work while absent, then resume on a fresh Worker.
  for(const w of workers)w.worker.shutdown();await Promise.all(running);
  const five=input(5);const accepting=post(five);await delay(500);await worker();assert.equal((await accepting).status,202);
  await until(async()=>(await repo.receipt(user.id,five.batchId))?.status==='transcribed');
  assert.equal((await repo.receipt(user.id,four.batchId))?.transcript,'');
  assert.equal(await archived(user.id,four.batchId),undefined,'a deleted failed batch is never archived');
  // Interrupt an in-progress activity; the next Worker retries its durable input.
  blocked=true;const six=input(6);const before=calls;assert.equal((await post(six)).status,202);
  await until(async()=>calls>before);
  for(const w of workers)if(w.worker.getState()==='RUNNING')w.worker.shutdown();await Promise.all(running);
  blocked=false;await worker();
  await until(async()=>(await repo.receipt(user.id,six.batchId))?.status==='transcribed');
  assert.ok((await repo.receipt(user.id,six.batchId))!.attempts>=2);
  assert.equal((await archived(user.id,six.batchId))?.transcript,'batch transcript','a retried attempt archives under the same key');
  // Deleted while transcribing: the late result is archived then withdrawn, never kept.
  blocked=true;const eight=input(7);const beforeEight=calls;const deletesBefore=archiveDeletes;assert.equal((await post(eight)).status,202);
  await until(async()=>calls>beforeEight);
  const eightRow=await repo.receipt(user.id,eight.batchId);await new ListeningRepository(database.db,archive).delete(user.id,eightRow!.id);blocked=false;
  await until(async()=>archiveDeletes>=deletesBefore+2);
  assert.equal(archive.objects.has(transcriptKey(user.id,eight.batchId,eightRow!.startedAt)),false);assert.equal((await repo.receipt(user.id,eight.batchId))?.transcript,'');
  // A timed-out attempt cannot overwrite a newer attempt's committed result.
  const seven=parseListeningBatch(input(8),user.id);const old=await repo.begin(seven);const current=await repo.begin(seven);
  assert.equal(old.done,false);assert.equal(current.done,false);
  if(!old.done && !current.done){
   assert.equal(await repo.complete(old.id,old.token,{transcript:'stale',utterances:[],model:'test'}),false);
   assert.equal(await repo.complete(current.id,current.token,{transcript:'current',utterances:[],model:'test'}),true);
  }

  // Query the canonical ID after multiple continue-as-new runs.
  assert.equal((await first!.client.workflow.getHandle(listeningWorkflowId(user.id)).describe()).status.name,'RUNNING');
  await patch('Home');
  await new ListeningRepository(database.db,archive).delete(user.id,rowOne.id);
  const [tombstone]=await database.db.select().from(listeningBatches).where(eq(listeningBatches.id,rowOne.id));
  assert.equal(tombstone?.locationLabel,null);
  assert.ok(tombstone?.segments.every(s=>s.locations===undefined));
  assert.equal(await archived(user.id,one.batchId),undefined);
  assert.equal((await patch('Office')).status,404,'deleted recordings cannot regain annotations');
 } finally {
  for(const api of apis){api.closeAllConnections();await new Promise<void>(r=>api.close(()=>r()));}
  for(const w of workers)if(w.worker.getState()==='RUNNING')w.worker.shutdown();await Promise.allSettled(running);
  for(const w of workers)await w.close();await first?.close();await second?.close();await database.close();temporal.kill('SIGTERM');await once(temporal,'exit');
 }
});
