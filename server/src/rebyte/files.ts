import { posix } from 'node:path';
import { ServiceError } from '../errors.js';
import type { RebyteGateway, SessionArtifact } from './gateway.js';

/**
 * Files an Agent delivers: artifacts that a completed Turn published from /workspace/outputs/.
 * Rebyte keeps the bytes after the Sandbox expires; Instant stores neither bytes nor names.
 */
export const outputDirectory = '/workspace/outputs/';
/** Downloads stream through the API; larger artifacts are refused. */
export const maxFileBytes = 100 * 1024 * 1024;
const deliveredPath = (path: string) => path.startsWith(outputDirectory) && path.length > outputDirectory.length && posix.normalize(path) === path && !path.endsWith('/') && !/[\x00-\x1f\x7f]/.test(path);
const validSize = (size: number) => Number.isSafeInteger(size) && size >= 0;

export interface FileData {
  schemaVersion: 1;
  fileId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
}
export type FilePart = { type: 'data-instant-file'; id: string; data: FileData };

const mediaTypes: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', htm: 'text/html',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
};

/** Rebyte serves every artifact as application/octet-stream, so the type comes from the name. */
export function mediaType(name: string): string {
  const extension = posix.extname(name).slice(1).toLowerCase();
  return mediaTypes[extension] ?? 'application/octet-stream';
}

/** An opaque, URL-path-safe ID naming the owned Session binding, so a download checks ownership first. */
export function fileId(bindingId: string, artifactId: string): string {
  return `${bindingId}_${artifactId}`;
}

export function parseFileId(value: string): { bindingId: string; artifactId: string } {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(artifact_[A-Za-z0-9_-]{1,128})$/i.exec(value);
  if (!match) throw new ServiceError(404, 'not_found', 'File not found');
  return { bindingId: match[1]!.toLowerCase(), artifactId: match[2]! };
}

/** Delivered files of one Turn, in publication order. */
export function turnFiles(artifacts: SessionArtifact[], turnId: string, bindingId: string): FilePart[] {
  return artifacts
    .filter(artifact => artifact.turn_id === turnId && deliveredPath(artifact.path) && validSize(artifact.size_bytes))
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
    .map(artifact => {
      const name = posix.basename(artifact.path);
      const id = fileId(bindingId, artifact.id);
      return { type: 'data-instant-file', id, data: { schemaVersion: 1, fileId: id, name, mediaType: mediaType(name), sizeBytes: artifact.size_bytes } };
    });
}

/** RFC 6266/5987: an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7E]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export interface DeliveredFile { name: string; mediaType: string; sizeBytes: number; body: ReadableStream<Uint8Array> }

/** Owned downloads: the binding must belong to the user, and Rebyte checks the artifact's Session. */
export class FileDownloads {
  constructor(private readonly sessions: { ownedProviderSession(userId: string, bindingId: string): Promise<string | undefined> },
    private readonly gateway: Pick<RebyteGateway, 'artifact' | 'artifactContent'>) {}

  async open(userId: string, id: string, signal: AbortSignal): Promise<DeliveredFile> {
    const { bindingId, artifactId } = parseFileId(id);
    const sessionId = await this.sessions.ownedProviderSession(userId, bindingId);
    if (!sessionId) throw new ServiceError(404, 'not_found', 'File not found');
    const artifact = await this.provider(signal, () => this.gateway.artifact(sessionId, artifactId, signal));
    // Only delivered files are downloadable, never other Sandbox artifacts.
    if (artifact.id !== artifactId || artifact.session_id !== sessionId || !deliveredPath(artifact.path)) throw new ServiceError(404, 'not_found', 'File not found');
    if (!validSize(artifact.size_bytes)) throw new ServiceError(503, 'file_unavailable', 'This file is temporarily unavailable', true);
    if (artifact.size_bytes > maxFileBytes) throw new ServiceError(413, 'file_too_large', 'This file is too large to download');
    const content = await this.provider(signal, () => this.gateway.artifactContent(sessionId, artifactId, signal));
    if (!content.ok || !content.body) {
      await content.body?.cancel();
      throw new ServiceError(503, 'file_unavailable', 'This file is temporarily unavailable', true);
    }
    const name = posix.basename(artifact.path);
    return { name, mediaType: mediaType(name), sizeBytes: artifact.size_bytes, body: content.body };
  }

  /** Provider errors can carry request details; only a missing artifact is distinguished. */
  private async provider<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    try { return await call(); }
    catch (error) {
      if (signal.aborted) throw error;
      if ((error as { status?: unknown }).status === 404) throw new ServiceError(404, 'not_found', 'File not found');
      throw new ServiceError(503, 'file_unavailable', 'This file is temporarily unavailable', true);
    }
  }
}

/** Enforce the immutable metadata size even when an upstream stream has no Content-Length. */
export async function* boundedFileBytes(body: ReadableStream<Uint8Array>, expected: number): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > expected || bytes > maxFileBytes) throw new Error('File size exceeded its metadata');
      yield part.value;
    }
    if (bytes !== expected) throw new Error('File download was incomplete');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
