import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ServiceError } from '../errors.js';
import { parseListeningBatch } from './batch-input.js';
import { maxBatchAudioBytes, maxBatchBytes, batchReceipt, type AcceptedBatch, type BatchAudioSource } from './batch-contract.js';
import type { ListeningBatchRepository } from './batch-repository.js';
import type { ListeningBatchService } from './temporal/client.js';

export interface AudioUploadTicket { url: string; headers: Record<string,string>; expiresAt: string }
export interface AudioObjectStore {
  prepare(source: BatchAudioSource): Promise<AudioUploadTicket | null>;
  commit(source: BatchAudioSource): Promise<void>;
  load(source: BatchAudioSource, signal?: AbortSignal): Promise<Buffer>;
  delete(source: BatchAudioSource): Promise<void>;
}
const invalid = () => new ServiceError(400,'invalid_upload','Provide valid batch metadata, payload size and SHA-256 checksum.');
const conflict = () => new ServiceError(409,'batch_conflict','This batch ID was already used for different audio.');
const metadata = (batch: AcceptedBatch) => ({batchId:batch.batchId,streamId:batch.streamId,sequence:batch.sequence,sessionId:batch.sessionId,
  items:batch.items.map(({audio:_,...item})=>item)});

/** Only metadata crosses the API. The signed checksum binds the immutable file. */
export function parseUploadManifest(input: unknown, userId: string): AcceptedBatch {
  if(!input || typeof input!=='object' || Array.isArray(input))throw invalid();
  const value=input as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['batch','sha256','byteLength'].includes(key)) ||
    typeof value.sha256!=='string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) || Number(value.byteLength)<1 || Number(value.byteLength)>maxBatchBytes)throw invalid();
  const batch=value.batch as Record<string,unknown> | undefined;
  if(!batch || !Array.isArray(batch.items))throw invalid();
  let bytes=0;
  const items=batch.items.map((raw:unknown)=>{
    if(!raw || typeof raw!=='object' || Array.isArray(raw))throw invalid();
    const {audioBytes,...item}=raw as Record<string,unknown>;
    if('audio' in item || !Number.isSafeInteger(audioBytes) || Number(audioBytes)<1)throw invalid();
    bytes+=Number(audioBytes);
    return {...item,audio:'AA=='};
  });
  if(bytes>maxBatchAudioBytes || bytes>Number(value.byteLength))throw invalid();
  const parsed=parseListeningBatch({...batch,items},userId);
  return {...parsed,contentHash:value.sha256,items:parsed.items.map(item=>({...item,audio:''})),
    audioSource:{key:`users/${userId}/echo-audio/${parsed.batchId}/${value.sha256}.json`,sha256:value.sha256,byteLength:Number(value.byteLength)}};
}

/** Stage URLs cannot write the durable object consumed by the Worker. */
export class S3AudioObjectStore implements AudioObjectStore {
  private readonly client:S3Client;
  constructor(private readonly bucket:string,region:string,client?:S3Client){this.client=client??new S3Client({region});}
  private staging(source:BatchAudioSource){return source.key.replace(/^users\//,'users/_uploads/');}
  private checksum(source:BatchAudioSource){return Buffer.from(source.sha256,'hex').toString('base64');}
  private async head(source:BatchAudioSource,key:string){
    try {
      const object=await this.client.send(new HeadObjectCommand({Bucket:this.bucket,Key:key,ChecksumMode:'ENABLED'}));
      if(object.ContentLength!==source.byteLength || object.ChecksumSHA256!==this.checksum(source))throw new ServiceError(422,'upload_checksum_mismatch','Uploaded file does not match its declared checksum and size.');
      return object;
    }catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404)return undefined;throw error;}
  }
  async prepare(source:BatchAudioSource):Promise<AudioUploadTicket|null>{
    if(await this.head(source,source.key) || await this.head(source,this.staging(source)))return null;
    const checksum=this.checksum(source);
    const command=new PutObjectCommand({Bucket:this.bucket,Key:this.staging(source),ContentType:'application/json',
      ContentLength:source.byteLength,ChecksumSHA256:checksum});
    const url=await getSignedUrl(this.client,command,{expiresIn:900,signableHeaders:new Set(['content-type','content-length']),unhoistableHeaders:new Set(['x-amz-checksum-sha256'])});
    return {url,headers:{'Content-Type':'application/json','Content-Length':String(source.byteLength),'x-amz-checksum-sha256':checksum},expiresAt:new Date(Date.now()+900000).toISOString()};
  }
  async commit(source:BatchAudioSource){
    if(await this.head(source,source.key))return;
    const staged=await this.head(source,this.staging(source));
    if(!staged)throw new ServiceError(409,'upload_incomplete','The file has not finished uploading. Keep the local recording and retry.',true);
    await this.client.send(new CopyObjectCommand({Bucket:this.bucket,Key:source.key,
      CopySource:encodeURIComponent(`${this.bucket}/${this.staging(source)}`),CopySourceIfMatch:staged.ETag,ChecksumAlgorithm:'SHA256'}));
    if(!await this.head(source,source.key))throw new ServiceError(502,'upload_commit_failed','The file is not durably available yet.',true);
    await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:this.staging(source)}));
  }
  async load(source:BatchAudioSource,signal?:AbortSignal){
    const result=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:source.key,ChecksumMode:'ENABLED'}),{abortSignal:signal});
    if(result.ContentLength!==source.byteLength || source.byteLength>maxBatchBytes)throw invalid();
    const bytes=Buffer.from(await result.Body!.transformToByteArray());
    if(bytes.length!==source.byteLength || createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw new ServiceError(422,'upload_checksum_mismatch','Stored audio failed its integrity check.');
    return bytes;
  }
  async delete(source:BatchAudioSource){
    await Promise.all([source.key,this.staging(source)].map(Key=>this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key}))));
  }
}

export async function loadUploadedBatch(batch:AcceptedBatch,objects:AudioObjectStore,signal?:AbortSignal):Promise<AcceptedBatch>{
  if(!batch.audioSource)return batch;
  const data=await objects.load(batch.audioSource,signal);
  let value:unknown;try{value=JSON.parse(data.toString('utf8'));}catch{throw invalid();}
  const decoded=parseListeningBatch(value,batch.userId);
  if(!isDeepStrictEqual(metadata(decoded),metadata(batch)))throw conflict();
  return {...decoded,contentHash:batch.contentHash,audioSource:batch.audioSource};
}

export class ListeningUploadService {
  constructor(private readonly repository:ListeningBatchRepository,private readonly objects:AudioObjectStore,private readonly batches:ListeningBatchService){}
  async prepare(userId:string,input:unknown){
    const batch=parseUploadManifest(input,userId);
    const existing=await this.repository.receipt(userId,batch.batchId);
    if(existing?.status==='deleted')throw new ServiceError(410,'batch_deleted','This batch was deleted.');
    // Legacy acknowledged audio is already durable in Temporal; do not upload it again.
    if(existing && existing.workflowVersion<3){
      if(existing.streamId!==batch.streamId || existing.sequence!==batch.sequence || existing.sessionId!==batch.sessionId)throw conflict();
      if(existing.workflowVersion===2 && existing.status==='pending' && existing.attempts===0 && !await this.batches.hasDurableBatch(userId,batch.batchId)){
        throw new ServiceError(503,'upload_not_accepted','The earlier upload has not been durably accepted. Keep the local recording and retry.',true);
      }
      return {status:'accepted',receipt:batchReceipt(batch)};
    }
    const row=await this.repository.reserve(batch,3);
    if(row.status==='deleted')throw new ServiceError(410,'batch_deleted','This batch was deleted.');
    if(row.uploadInput && !isDeepStrictEqual(metadata(row.uploadInput),metadata(batch)))throw conflict();
    if(row.status==='transcribed')return {status:'accepted',receipt:batchReceipt(batch)};
    const ticket=await this.objects.prepare(batch.audioSource!);
    return ticket ? {status:'upload',...ticket} : {status:'uploaded'};
  }
  async complete(userId:string,batchId:string){
    const row=await this.repository.receipt(userId,batchId);
    if(!row)throw new ServiceError(404,'not_found','Upload not found.');
    if(row.status==='deleted')throw new ServiceError(410,'batch_deleted','This batch was deleted.');
    if(row.workflowVersion===2 && row.status==='pending' && row.attempts===0 && !await this.batches.hasDurableBatch(userId,batchId)){
      throw new ServiceError(503,'upload_not_accepted','The earlier upload has not been durably accepted. Keep the local recording and retry.',true);
    }
    if(row.workflowVersion<3 || row.status==='transcribed')return {batchId,streamId:row.streamId,sequence:row.sequence,status:'accepted' as const};
    if(!row.uploadInput?.audioSource)throw new ServiceError(409,'upload_incomplete','Request an upload address first.');
    try{
      await this.objects.commit(row.uploadInput.audioSource);
      return await this.batches.submit(row.uploadInput);
    }
    catch(error){
      if((await this.repository.receipt(userId,batchId))?.status==='deleted')await this.objects.delete(row.uploadInput.audioSource);
      throw error;
    }
  }
  async cleanupDeleted(userId:string,batchId:string){
    const row=await this.repository.receipt(userId,batchId);
    if(row?.status==='deleted' && row.uploadInput?.audioSource){
      await this.objects.delete(row.uploadInput.audioSource);
      await this.repository.clearUploadInput(userId,batchId);
    }
  }
}
