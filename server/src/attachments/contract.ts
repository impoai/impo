import { ServiceError } from '../errors.js';

export const maxAttachmentBytes = 10 * 1024 * 1024;
export const maxAttachments = 8;
export const attachmentTypes = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
} as const;
export interface AttachmentManifest { id: string; name: string; mediaType: string; sizeBytes: number; sha256: string }
export interface Attachment extends AttachmentManifest { status: 'uploading' | 'ready' }

export function attachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxAttachments || new Set(value).size !== value.length ||
    value.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new ServiceError(400, 'invalid_attachments', 'Choose up to eight uploaded files.');
  }
  return value;
}

export function attachmentManifest(value: unknown): AttachmentManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError(400, 'invalid_upload', 'Provide file metadata.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['id', 'name', 'mediaType', 'sizeBytes', 'sha256'].includes(key)) ||
    typeof input.id !== 'string' || attachmentIds([input.id]).length !== 1 ||
    typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 200 || /[\x00-\x1f/\\]/.test(input.name) ||
    !Number.isSafeInteger(input.sizeBytes) || Number(input.sizeBytes) < 1 || Number(input.sizeBytes) > maxAttachmentBytes ||
    typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new ServiceError(400, 'invalid_upload', 'Files must have a valid name, checksum and size of at most 10 MB.');
  }
  const extension = input.name.split('.').at(-1)!.toLowerCase() as keyof typeof attachmentTypes;
  const mediaType = attachmentTypes[extension];
  if (!mediaType || input.mediaType !== mediaType) throw new ServiceError(415, 'unsupported_file_type', 'Choose a PDF, Word document, text file, CSV, JSON or supported image.');
  return { id: input.id, name: input.name, mediaType, sizeBytes: Number(input.sizeBytes), sha256: input.sha256 };
}

export const attachmentSource = (userId: string, file: AttachmentManifest) => ({
  key: `users/${userId}/attachments/${file.id}/${file.sha256}`, sha256: file.sha256, byteLength: file.sizeBytes,
});
export const attachmentPart = (file: AttachmentManifest) => ({ type: 'data-instant-file' as const, id: `upload_${file.id}`,
  data: { schemaVersion: 1, fileId: `upload_${file.id}`, name: file.name, mediaType: file.mediaType, sizeBytes: file.sizeBytes } });

/** Stable destination across upload retries and Rebyte Session rotation. */
export const attachmentPath = (file: Pick<AttachmentManifest, 'id' | 'name'>) => `/workspace/attachments/${file.id}/${file.name}`;
