import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client.js';
import { attachments, messageAttachments, users } from '../schema.js';
import { attachmentPart, type AttachmentManifest } from '../../attachments/contract.js';
import { ServiceError } from '../../errors.js';

export class AttachmentRepository {
  constructor(private readonly db: Database) {}
  async reserve(userId: string, input: AttachmentManifest) {
    return this.db.transaction(async tx => {
      const [owner] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (!owner) throw new ServiceError(404, 'not_found', 'Account not found.');
      await tx.insert(attachments).values({ ...input, userId }).onConflictDoNothing();
      const [file] = await tx.select().from(attachments).where(and(eq(attachments.userId, userId), eq(attachments.id, input.id)));
      if (!file || file.name !== input.name || file.mediaType !== input.mediaType || file.sha256 !== input.sha256 || file.sizeBytes !== input.sizeBytes)
        throw new ServiceError(409, 'attachment_conflict', 'This file ID already belongs to another upload.');
      return file;
    });
  }
  async get(userId: string, id: string) {
    const [file] = await this.db.select().from(attachments).where(and(eq(attachments.userId, userId), eq(attachments.id, id)));
    if (!file) throw new ServiceError(404, 'not_found', 'File not found.');
    return file;
  }
  async ready(userId: string, id: string) {
    const [file] = await this.db.update(attachments).set({ status: 'ready' }).where(and(eq(attachments.userId, userId), eq(attachments.id, id))).returning();
    if (!file) throw new ServiceError(404, 'not_found', 'File not found.');
    return file;
  }
  async list(userId: string, offset = 0) {
    const files = await this.db.select().from(attachments).where(and(eq(attachments.userId, userId), eq(attachments.status, 'ready')))
      .orderBy(desc(attachments.createdAt), asc(attachments.id)).limit(51).offset(offset);
    return { files: files.slice(0, 50).map(({ id, name, mediaType, sizeBytes }) => ({ fileId: id, name, mediaType, sizeBytes })), nextOffset: files.length > 50 ? offset + 50 : null };
  }
}

/** Preserve owned file references independently of provider history and Session rotation. */
export async function hydrateAttachments<T extends { id: string; parts: unknown[] }>(db: Database, userId: string, rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const links = await db.select({ messageId: messageAttachments.messageId, file: attachments }).from(messageAttachments)
    .innerJoin(attachments, and(eq(attachments.id, messageAttachments.attachmentId), eq(attachments.userId, messageAttachments.userId)))
    .where(and(eq(messageAttachments.userId, userId), inArray(messageAttachments.messageId, rows.map(row => row.id))))
    .orderBy(asc(messageAttachments.position));
  return rows.map(row => ({ ...row, parts: [...row.parts, ...links.filter(link => link.messageId === row.id).map(link => attachmentPart(link.file))] }));
}
