import { and, asc, eq, gt, inArray, isNotNull, ne, notExists, or, sql, TransactionRollbackError } from 'drizzle-orm';
import type { Database } from '../client.js';
import { actions, conversations, listeningBatches, listeningSegments, messages, productEvents, runtimeSubmissions, sessionBindings, toolInvocations } from '../schema.js';

/** Administrative operations across users, used only by explicit maintenance entry points. */
export class MaintenanceRepository {
  constructor(private readonly db: Database) {}

  async transcribedBatches(after: string, limit: number, withText = false) {
    const table = listeningBatches;
    return this.db.select().from(table).where(and(eq(table.status, 'transcribed'), gt(table.id, after), withText ? ne(table.transcript, '') : undefined))
      .orderBy(asc(table.id)).limit(limit);
  }

  async transcribedSegments(after: string, limit: number, withText = false) {
    const table = listeningSegments;
    return this.db.select().from(table).where(and(eq(table.status, 'transcribed'), gt(table.id, after), withText ? ne(table.transcript, '') : undefined))
      .orderBy(asc(table.id)).limit(limit);
  }

  async clearBatchTranscript(row: { id: string; userId: string; transcript: string }): Promise<boolean> {
    const table = listeningBatches;
    const result = await this.db.update(table).set({ transcript: '', updatedAt: new Date() })
      .where(and(eq(table.id, row.id), eq(table.userId, row.userId), eq(table.status, 'transcribed'), eq(table.transcript, row.transcript)));
    return result.rowCount === 1;
  }

  async clearSegmentTranscript(row: { id: string; userId: string; transcript: string }): Promise<boolean> {
    const table = listeningSegments;
    const result = await this.db.update(table).set({ transcript: '', utterances: [], updatedAt: new Date() })
      .where(and(eq(table.id, row.id), eq(table.userId, row.userId), eq(table.status, 'transcribed'), eq(table.transcript, row.transcript)));
    return result.rowCount === 1;
  }

  async purgeChatText(dryRun: boolean): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    await this.db.transaction(async tx => {
      const active = inArray(runtimeSubmissions.status, ['queued', 'running', 'waiting_device']);
      const finished = tx.select({ id: runtimeSubmissions.id }).from(runtimeSubmissions).where(inArray(runtimeSubmissions.status, ['completed', 'failed', 'cancelled']));
      const activeMessage = tx.select({ id: runtimeSubmissions.id }).from(runtimeSubmissions)
        .where(and(active, or(eq(runtimeSubmissions.userMessageId, messages.id), eq(runtimeSubmissions.assistantMessageId, messages.id))));
      counts.messages = (await tx.update(messages).set({ text: '', parts: [], updatedAt: new Date() })
        .where(and(or(ne(messages.text, ''), sql`${messages.parts} <> '[]'::jsonb`), notExists(activeMessage)))).rowCount ?? 0;
      counts.streamEvents = (await tx.delete(productEvents).where(inArray(productEvents.submissionId, finished))).rowCount ?? 0;
      // PostgreSQL JSON expressions retain only the receipt outcome, never its content.
      const result = toolInvocations.result;
      counts.toolInvocations = (await tx.update(toolInvocations).set({ arguments: {}, updatedAt: new Date(),
        result: sql`CASE WHEN ${result} IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object('ok', ${result}->'ok', 'error',
          CASE WHEN ${result} ? 'error' THEN jsonb_build_object('code', ${result}->'error'->'code') END)) END` })
        .where(and(inArray(toolInvocations.submissionId, finished), sql`(${toolInvocations.arguments} <> '{}'::jsonb
          OR (${result} IS NOT NULL AND ${result} - 'ok'::text - 'error'::text <> '{}'::jsonb)
          OR (jsonb_typeof(${result}->'error') = 'object' AND (${result}->'error') - 'code'::text <> '{}'::jsonb))`))).rowCount ?? 0;
      counts.historyContexts = (await tx.update(sessionBindings).set({ historyContext: null, updatedAt: new Date() })
        .where(and(isNotNull(sessionBindings.historyContext), isNotNull(sessionBindings.providerSessionId)))).rowCount ?? 0;
      const activeConversation = tx.select({ id: runtimeSubmissions.id }).from(runtimeSubmissions).where(and(active, eq(runtimeSubmissions.conversationId, conversations.id)));
      const finishedTasks = tx.select({ id: conversations.actionId }).from(conversations).where(and(eq(conversations.kind, 'task'), notExists(activeConversation)));
      counts.taskGoals = (await tx.update(actions).set({ goal: '…', updatedAt: new Date() }).where(and(ne(actions.goal, '…'), inArray(actions.id, finishedTasks)))).rowCount ?? 0;
      if (dryRun) tx.rollback();
    }).catch(error => { if (!(dryRun && error instanceof TransactionRollbackError)) throw error; });
    return counts;
  }
}
