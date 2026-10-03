import { scheduledTaskWorkflowId } from '../../scheduling/contract.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import * as s from '../schema.js';
import { ServiceError } from '../../errors.js';
import { deletionChallengeMs, deletionGraceMs, identityHash, parseConfirmation, tokenHash, tokenMatches, type DeletionChallenge, type DeletionManifest, type DeletionReceipt } from '../../accounts/contract.js';
import { transcriptKey } from '../../listening/transcript-archive.js';
import { batchWorkflowId, listeningWorkflowId } from '../../listening/batch-contract.js';
import { backgroundWorkflowId } from '../../background/contract.js';
import { echoScheduleWorkflowId } from '../../echo/schedule.js';

export class AccountDeletionRepository {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}
  async closedIdentity(provider: string, subject: string) {
    const [row] = await this.db.select({ userId: s.accountDeletions.userId }).from(s.accountDeletions)
      .where(and(eq(s.accountDeletions.identityHash, identityHash(provider, subject)), ne(s.accountDeletions.status, 'challenge')));
    return row;
  }
  async prepare(userId: string): Promise<DeletionChallenge> {
    const token = randomBytes(32).toString('hex'), id = randomUUID(), expiresAt = new Date(this.now().getTime() + deletionChallengeMs);
    await this.db.transaction(async tx => {
      const [user] = await tx.select().from(s.users).where(eq(s.users.id, userId)).for('update');
      if (!user) throw new ServiceError(410, 'account_deleted', 'This account has been deleted.');
      const [previous] = await tx.select().from(s.accountDeletions).where(eq(s.accountDeletions.userId, userId));
      if (previous && previous.status !== 'challenge') throw new ServiceError(410, 'account_deleted', 'Account deletion has already been requested.');
      await tx.insert(s.accountDeletions).values({ id, userId, identityHash: identityHash(user.authProvider, user.authSubject), challengeHash: tokenHash(token), challengeExpiresAt: expiresAt })
        .onConflictDoUpdate({ target: s.accountDeletions.userId, set: { id, challengeHash: tokenHash(token), challengeExpiresAt: expiresAt } });
    });
    return { challengeId: id, token, expiresAt: expiresAt.toISOString() };
  }
  async identity(userId: string) {
    const [user] = await this.db.select({ provider: s.users.authProvider, subject: s.users.authSubject }).from(s.users).where(eq(s.users.id, userId));
    return user;
  }
  async validateConfirmation(userId: string, input: unknown): Promise<boolean> {
    const confirmation = parseConfirmation(input);
    const [row] = await this.db.select().from(s.accountDeletions).where(eq(s.accountDeletions.userId, userId));
    if (!row || row.id !== confirmation.challengeId || !tokenMatches(confirmation.token, row.challengeHash)) throw new ServiceError(400, 'deletion_confirmation_required', 'Start again from Delete account in Settings.');
    if (row.status !== 'challenge') return false;
    if (row.challengeExpiresAt <= this.now()) throw new ServiceError(409, 'deletion_confirmation_expired', 'The confirmation expired. Start again from Delete account in Settings.');
    return true;
  }
  async confirm(userId: string, input: unknown, appleManualRevocationRequired = false): Promise<DeletionReceipt> {
    const confirmation = parseConfirmation(input);
    const [prepared] = await this.db.select({ identityHash: s.accountDeletions.identityHash }).from(s.accountDeletions).where(eq(s.accountDeletions.userId, userId));
    if (!prepared) throw new ServiceError(400, 'deletion_confirmation_required', 'Start again from Delete account in Settings.');
    return this.db.transaction(async tx => {
      // Serialize with identity provisioning, including a request already in flight at deletion.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${prepared.identityHash}, 0))`);
      // Same lock order as challenge creation and command acceptance.
      const [user] = await tx.select().from(s.users).where(eq(s.users.id, userId)).for('update');
      const [request] = await tx.select().from(s.accountDeletions).where(eq(s.accountDeletions.userId, userId)).for('update');
      if (!request || request.id !== confirmation.challengeId || !tokenMatches(confirmation.token, request.challengeHash))
        throw new ServiceError(400, 'deletion_confirmation_required', 'Start again from Delete account in Settings.');
      if (request.status !== 'challenge') return this.receipt(request, confirmation.token);
      if (!user || request.challengeExpiresAt <= this.now()) throw new ServiceError(409, 'deletion_confirmation_expired', 'The confirmation expired. Start again from Delete account in Settings.');
      const [conversations, sessions, attempts, agents, agentAttempts, briefs, memoryRuns, batches, segments, connections, notificationEvents, schedules] = await Promise.all([
        tx.select({ id: s.conversations.id }).from(s.conversations).where(eq(s.conversations.userId, userId)),
        tx.select({ id: s.sessionBindings.providerSessionId }).from(s.sessionBindings).where(eq(s.sessionBindings.userId, userId)),
        tx.select({ id: s.sessionCreationAttempts.providerSessionId }).from(s.sessionCreationAttempts).where(eq(s.sessionCreationAttempts.userId, userId)),
        tx.select({ id: s.userAgents.providerAgentId }).from(s.userAgents).where(eq(s.userAgents.userId, userId)),
        tx.select({ id: s.agentCreationAttempts.providerAgentId }).from(s.agentCreationAttempts).where(eq(s.agentCreationAttempts.userId, userId)),
        tx.select({ id: s.todayBriefs.providerSessionId }).from(s.todayBriefs).where(eq(s.todayBriefs.userId, userId)),
        tx.select({ id: s.memoryRuns.providerSessionId }).from(s.memoryRuns).where(eq(s.memoryRuns.userId, userId)),
        tx.select().from(s.listeningBatches).where(eq(s.listeningBatches.userId, userId)),
        tx.select({ id: s.listeningSegments.clientSegmentId, startedAt: s.listeningSegments.startedAt }).from(s.listeningSegments).where(eq(s.listeningSegments.userId, userId)),
        tx.select({ entityId: s.connectorConnections.entityId, authConfigId: s.connectorConnections.authConfigId, accountId: s.connectorConnections.connectedAccountId, routerId: s.connectorConnections.routerSessionId }).from(s.connectorConnections).where(eq(s.connectorConnections.userId, userId)),
        tx.select({ id: s.notificationEvents.id }).from(s.notificationEvents).where(eq(s.notificationEvents.userId, userId)),
        tx.select({ id: s.scheduledTasks.id }).from(s.scheduledTasks).where(eq(s.scheduledTasks.userId, userId)),
      ]);
      const ids = (rows: Array<{ id: string | null }>) => [...new Set(rows.flatMap(r => r.id ? [r.id] : []))];
      const objectKeys = [...segments.map(r => transcriptKey(userId, r.id, r.startedAt)), ...batches.flatMap(r => {
        const key = r.uploadInput?.audioSource?.key;
        if (key && !key.startsWith(`users/${userId}/`)) throw new Error('Audio ownership mismatch');
        return [transcriptKey(userId, r.clientBatchId, r.startedAt), ...(key ? [key, key.replace(/^users\//, 'users/_uploads/')] : [])];
      })];
      const manifest: DeletionManifest = {
        authProvider: user.authProvider, authSubject: user.authSubject, conversationIds: conversations.map(r => r.id),
        sessionIds: ids([...sessions, ...attempts, ...briefs, ...memoryRuns]), agentIds: ids([...agents, ...agentAttempts]),
        objectKeys: [...new Set(objectKeys)], memoryDatabaseName: `impo-mem-${userId}`, connections,
        workflows: [...schedules.map(r => scheduledTaskWorkflowId(userId, r.id)), backgroundWorkflowId(userId), listeningWorkflowId(userId), echoScheduleWorkflowId(userId), ...batches.map(r => batchWorkflowId(userId, r.clientBatchId)), ...notificationEvents.map(r => `impo/notification/${r.id}`)],
      };
      const requestedAt = this.now();
      const [accepted] = await tx.update(s.accountDeletions).set({ status: 'pending', manifest, requestedAt, appleManualRevocationRequired }).where(eq(s.accountDeletions.id, request.id)).returning();
      // Foreign-key order is explicit. Every deletion includes ownership; no global purge.
      for (const table of [s.scheduledTaskRuns, s.scheduledTasks, s.deviceDispatches, s.outboxJobs, s.toolInvocations, s.productEvents, s.messageItemBindings,
        s.runtimeSubmissions, s.sessionCreationAttempts, s.sessionBindings, s.agentCreationAttempts, s.userAgents,
        s.messageAttachments, s.attachments, s.messages, s.conversations, s.actions, s.deviceCapabilities, s.devices, s.connectorConnections,
        s.listeningSegments, s.listeningBatches, s.todayBriefs, s.todaySettings, s.memoryRuns, s.memoryState,
        s.memoryDatabases, s.userProfiles, s.notificationEvents, s.pushInstallations, s.notificationSettings]) {
        await tx.delete(table).where(eq(table.userId, userId));
      }
      await tx.delete(s.users).where(eq(s.users.id, userId));
      return this.receipt(accepted!, confirmation.token);
    });
  }
  private receipt(row: typeof s.accountDeletions.$inferSelect, token?: string): DeletionReceipt {
    return { requestId: row.id, status: row.status === 'completed' ? 'deleted' : 'deleting', requestedAt: row.requestedAt!.toISOString(), appleManualRevocationRequired: row.appleManualRevocationRequired, ...(token ? { receiptToken: token } : {}) };
  }
  async status(id: string, token: string): Promise<DeletionReceipt> {
    const [row] = await this.db.select().from(s.accountDeletions).where(eq(s.accountDeletions.id, id));
    if (!row || row.status === 'challenge' || !tokenMatches(token, row.challengeHash)) throw new ServiceError(404, 'not_found', 'Deletion receipt not found.');
    return this.receipt(row, token);
  }
  async pending() { return this.db.select({ id: s.accountDeletions.id }).from(s.accountDeletions).where(eq(s.accountDeletions.status, 'pending')).limit(100); }
  async work(id: string) {
    const [row] = await this.db.select().from(s.accountDeletions).where(eq(s.accountDeletions.id, id));
    return row?.status === 'pending' ? row : undefined;
  }
  async failure(id: string, code: string) {
    await this.db.update(s.accountDeletions).set({ lastError: code }).where(and(eq(s.accountDeletions.id, id), eq(s.accountDeletions.status, 'pending')));
  }
  async complete(id: string) {
    const row = await this.work(id);
    if (!row) return;
    if (this.now().getTime() < row.requestedAt!.getTime() + deletionGraceMs) throw new Error('Deletion cleanup grace period has not elapsed');
    await this.db.update(s.accountDeletions).set({ status: 'completed', manifest: null, lastError: null, completedAt: this.now() }).where(and(eq(s.accountDeletions.id, id), eq(s.accountDeletions.status, 'pending')));
  }
}
