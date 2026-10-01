import { createHash, timingSafeEqual } from 'node:crypto';
import { ServiceError } from '../errors.js';

// 15-minute signed upload admission plus up to 60 minutes of an in-flight transfer.
export const deletionGraceMs = 2 * 60 * 60 * 1000;
export const deletionChallengeMs = 5 * 60 * 1000;
export const identityHash = (provider: string, subject: string) => createHash('sha256').update(JSON.stringify([provider, subject])).digest('hex');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function tokenMatches(token: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(expected, 'hex'));
}
export interface DeletionManifest {
  authProvider: string; authSubject: string;
  conversationIds: string[]; sessionIds: string[]; agentIds: string[];
  objectKeys: string[]; memoryDatabaseName: string;
  workflows: string[];
  connections: Array<{ entityId: string; authConfigId: string; accountId: string | null; routerId: string | null }>;
}
export interface DeletionChallenge { challengeId: string; token: string; expiresAt: string; appleAuthorizationAvailable?: boolean }
export interface DeletionReceipt { requestId: string; status: 'deleting' | 'deleted'; requestedAt: string; receiptToken?: string; appleManualRevocationRequired: boolean }
export interface DeletionConfirmation { challengeId: string; token: string; confirmation: 'DELETE'; appleAuthorizationCode?: string }
export function parseConfirmation(input: unknown): DeletionConfirmation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const v = input as Record<string, unknown>;
  if (Object.keys(v).some(k => !['challengeId', 'token', 'confirmation', 'appleAuthorizationCode'].includes(k)) ||
      typeof v.challengeId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v.challengeId) ||
      typeof v.token !== 'string' || !/^[0-9a-f]{64}$/.test(v.token) || v.confirmation !== 'DELETE' ||
      (v.appleAuthorizationCode !== undefined && (typeof v.appleAuthorizationCode !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(v.appleAuthorizationCode)))) throw invalid();
  return v as unknown as DeletionConfirmation;
}
const invalid = () => new ServiceError(400, 'deletion_confirmation_required', 'Confirm the deletion warning, then type DELETE to continue.');
