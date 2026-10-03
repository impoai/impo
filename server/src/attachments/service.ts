import { AttachmentRepository } from '../db/repositories/attachment-repository.js';
import { S3AudioObjectStore, type AudioObjectStore } from '../listening/audio-upload.js';
import { attachmentManifest, attachmentSource, maxAttachmentBytes } from './contract.js';
import { ServiceError } from '../errors.js';

export class AttachmentService {
  constructor(readonly repository: AttachmentRepository, private readonly objects: AudioObjectStore) {}
  async prepare(userId: string, value: unknown) {
    const file = await this.repository.reserve(userId, attachmentManifest(value));
    if (file.status === 'ready') return { status: 'ready' as const, file };
    const ticket = await this.objects.prepare(attachmentSource(userId, file));
    return ticket ? { status: 'upload' as const, ...ticket } : { status: 'uploaded' as const };
  }
  async complete(userId: string, id: string) {
    const file = await this.repository.get(userId, id);
    await this.objects.commit(attachmentSource(userId, file));
    try { return await this.repository.ready(userId, id); }
    catch (error) {
      if (error instanceof ServiceError && error.status === 404) await this.objects.delete(attachmentSource(userId, file));
      throw error;
    }
  }
  async load(userId: string, id: string, signal?: AbortSignal) {
    const file = await this.repository.get(userId, id);
    if (file.status !== 'ready') throw new ServiceError(409, 'upload_incomplete', 'Finish uploading this file before reading it.');
    return { file, bytes: await this.objects.load(attachmentSource(userId, file), signal) };
  }
}

export function attachmentObjects(bucket: string, region: string) { return new S3AudioObjectStore(bucket, region, undefined, 'application/octet-stream', maxAttachmentBytes); }
