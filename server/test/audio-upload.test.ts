import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {S3Client} from '@aws-sdk/client-s3';
import {parseUploadManifest,S3AudioObjectStore,loadUploadedBatch,ListeningUploadService} from '../src/listening/audio-upload.js';

const input=()=>({batch:{batchId:randomUUID(),streamId:randomUUID(),sessionId:randomUUID(),sequence:1,
 items:[{segmentId:randomUUID(),startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:00:01Z',mimeType:'audio/wav',audioBytes:5}]},
 sha256:'a'.repeat(64),byteLength:500});
test('upload metadata is bounded and cannot carry audio, credentials, or an object destination',()=>{
 const body=input();const parsed=parseUploadManifest(body,'owner');
 assert.equal(parsed.items[0]!.audio,'');assert.equal(parsed.contentHash,body.sha256);
 assert.ok(parsed.audioSource!.key.startsWith('users/owner/echo-audio/'));
 for(const wrong of [{...body,key:'another-user'}, {...body,byteLength:1500001},{...body,sha256:'bad'},
  {...body,batch:{...body.batch,items:[{...body.batch.items[0],audio:'AAAA'}]}},
  {...body,batch:{...body.batch,items:[{...body.batch.items[0],audioBytes:1048577}]}}])assert.throws(()=>parseUploadManifest(wrong,'owner'));
});
test('S3 URL binds checksum, length, method and staging destination',async()=>{
 const client=new S3Client({region:'us-east-1',credentials:{accessKeyId:'test',secretAccessKey:'test'}});
 client.send=async()=>{throw Object.assign(new Error('missing'),{$metadata:{httpStatusCode:404}});};
 const source=parseUploadManifest(input(),'owner').audioSource!;
 const ticket=await new S3AudioObjectStore('example-bucket','us-east-1',client).prepare(source);
 assert.ok(ticket);const url=new URL(ticket.url);
 assert.ok(url.pathname.startsWith('/users/_uploads/owner/'));
 for(const header of ['content-length','content-type','x-amz-checksum-sha256'])assert.ok(url.searchParams.get('X-Amz-SignedHeaders')?.includes(header));
 assert.equal(ticket.headers['Content-Length'],'500');
 assert.equal(ticket.headers['x-amz-checksum-sha256'],Buffer.from(source.sha256,'hex').toString('base64'));
 assert.equal(ticket.headers.Authorization,undefined);
});
test('worker reads exact stored bytes and rejects a mismatched manifest before transcription',async()=>{
 const raw=input();const payload={...raw.batch,items:raw.batch.items.map(({audioBytes:_,...item})=>({...item,audio:Buffer.from('hello').toString('base64')}))};
 const data=Buffer.from(JSON.stringify(payload));raw.sha256=createHash('sha256').update(data).digest('hex');raw.byteLength=data.length;
 const batch=parseUploadManifest(raw,'owner');
 const client=new S3Client({region:'us-east-1'});
 client.send=async()=>({ContentLength:data.length,Body:{transformToByteArray:async()=>data}}) as any;
 const store=new S3AudioObjectStore('example-bucket','us-east-1',client);
 const loaded=await loadUploadedBatch(batch,store);
 assert.equal(loaded.items[0]!.audio,payload.items[0]!.audio);
 await assert.rejects(()=>loadUploadedBatch({...batch,sessionId:randomUUID()},store),/already used/);
 data[0]=0;
 await assert.rejects(()=>loadUploadedBatch(batch,store),/integrity/);
});
test('deletion during an ambiguous S3 commit removes the durable object',async()=>{
 const batch=parseUploadManifest(input(),'owner');let deleted=false,cleaned=false;
 const repository={receipt:async()=>({status:deleted?'deleted':'pending',workflowVersion:3,uploadInput:batch})};
 const objects={commit:async()=>{deleted=true;throw new Error('lost copy response');},delete:async()=>{cleaned=true;}};
 const service=new ListeningUploadService(repository as any,objects as any,{submit:async()=>{assert.fail('deleted audio must not start');}} as any);
 await assert.rejects(()=>service.complete('owner',batch.batchId),/lost copy response/);assert.ok(cleaned);
});
