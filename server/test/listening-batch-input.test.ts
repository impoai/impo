import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parseListeningBatch } from '../src/listening/batch-input.js';
import { maxBatchAudioBytes } from '../src/listening/batch-contract.js';
const input=()=>({batchId:randomUUID(),streamId:randomUUID(),sequence:1,sessionId:randomUUID(),items:[{segmentId:randomUUID(),startedAt:'2026-09-26T00:00:00Z',endedAt:'2026-09-26T00:00:10Z',mimeType:'audio/mp4',audio:'YWJj'}]});
test('batch payload validation enforces size, identity, chronological input and canonical retries',()=>{
 const maximum=input();maximum.items[0]!.audio=Buffer.alloc(maxBatchAudioBytes).toString('base64');assert.equal(parseListeningBatch(maximum,'user').items[0]!.audio.length,maximum.items[0]!.audio.length);
 const a=input();const b=parseListeningBatch(a,'user');assert.equal(b.contentHash,parseListeningBatch(JSON.parse(JSON.stringify(a)),'user').contentHash);
 for(const modify of [(v:any)=>v.sequence=0,(v:any)=>v.sequence=2**40,(v:any)=>v.items=[],(v:any)=>v.items.push(v.items[0]),(v:any)=>v.items[0].audio='!',(v:any)=>v.userId='spoof',(v:any)=>v.items[0].audio=Buffer.alloc(maxBatchAudioBytes+1).toString('base64')]){
  const value=input();modify(value);assert.throws(()=>parseListeningBatch(value,'user'));
 }
 const outOfOrder=input();outOfOrder.items.push({...outOfOrder.items[0]!,segmentId:randomUUID(),startedAt:'2026-09-25T00:00:00Z',endedAt:'2026-09-25T00:00:10Z'});assert.throws(()=>parseListeningBatch(outOfOrder,'user'));
});
