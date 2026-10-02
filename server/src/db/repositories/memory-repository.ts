import { personalTranscript, echoSourceId } from '../../listening/speakers.js';
import { echoLocationContext } from '../../listening/location.js';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNotNull, lte, or, sql, type SQL, lt } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Database } from '../client.js';
import { listeningBatches, listeningSegments, memoryRuns, memoryState, messages, runtimeSubmissions, todaySettings } from '../schema.js';
import { hydrateTranscripts, type TranscriptArchive } from '../../listening/transcript-archive.js';
import { hydrateMessages, type HistoryReader } from './conversation-history.js';
import { memoryConfigVersion, memoryLimits, type MemoryCursor, type MemoryEvidence, type MemoryWindow } from '../../memory/contract.js';

export type MemoryRunRow = typeof memoryRuns.$inferSelect;
export interface PendingEvidence { count: number; oldestAt: Date | null; newestAt: Date | null }
const leaseMs = 120_000;
/**
 * Items become evidence a minute after completion. Cursors move by completion time, so this
 * margin lets transactions that committed slightly out of order land before a cursor passes.
 */
const settleMs = 60_000;

/** (at, id) strictly after the cursor, and at or before `through` when given. */
function range(at: PgColumn, id: PgColumn, after: MemoryCursor | null, through?: MemoryCursor): SQL | undefined {
  const gtCursor = after ? or(gt(at, new Date(after.at)), and(eq(at, new Date(after.at)), gt(id, after.id))) : undefined;
  const lteCursor = through ? or(lt(at, new Date(through.at)), and(eq(at, new Date(through.at)), lte(id, through.id))) : undefined;
  return and(gtCursor, lteCursor);
}
const cursor = (at: Date | null, id: string | null): MemoryCursor | null => at && id ? { at: at.toISOString(), id } : null;
const later = (a: MemoryCursor, b: MemoryCursor) => a.at > b.at || (a.at === b.at && a.id > b.id);
const clip = (text: string, max: number) => (text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false });

/**
 * Evidence sources and run bookkeeping for memory consolidation. Chat reads completed Turns
 * (text from Rebyte history); Echo reads transcribed recordings (text from the S3 archive).
 * Echo advances by speaker review time so a late confirmation or correction is processed anew.
 */
export class MemoryRepository {
  constructor(private readonly db: Database, private readonly archive?: TranscriptArchive, private readonly history?: HistoryReader) {}

  async state(userId: string) {
    await this.db.insert(memoryState).values({ userId }).onConflictDoNothing();
    const [state] = await this.db.select().from(memoryState).where(eq(memoryState.userId, userId));
    return state!;
  }

  async openRun(userId: string): Promise<MemoryRunRow | undefined> {
    const [row] = await this.db.select().from(memoryRuns).where(and(eq(memoryRuns.userId, userId), inArray(memoryRuns.status, ['pending', 'running'])));
    return row;
  }

  private chatQuery(userId: string, after: MemoryCursor | null, through?: MemoryCursor, now = new Date()) {
    return and(eq(runtimeSubmissions.userId, userId), eq(runtimeSubmissions.status, 'completed'), isNotNull(runtimeSubmissions.completedAt),
      lte(runtimeSubmissions.completedAt, new Date(now.getTime() - settleMs)),
      range(runtimeSubmissions.completedAt, runtimeSubmissions.id, after, through));
  }
  private echoQueries(userId: string, after: MemoryCursor | null, through?: MemoryCursor, now = new Date()) {
    const settled = new Date(now.getTime() - settleMs);
    return [
      and(eq(listeningBatches.userId, userId), eq(listeningBatches.status, 'transcribed'), isNotNull(listeningBatches.speakerReviewedAt),
        lte(listeningBatches.speakerReviewedAt, settled), range(listeningBatches.speakerReviewedAt, listeningBatches.id, after, through)),
      and(eq(listeningSegments.userId, userId), eq(listeningSegments.status, 'transcribed'), isNotNull(listeningSegments.speakerReviewedAt),
        lte(listeningSegments.speakerReviewedAt, settled), range(listeningSegments.speakerReviewedAt, listeningSegments.id, after, through)),
    ] as const;
  }

  /** Unread evidence counts and times across both sources, for the planner. */
  async pending(userId: string, now = new Date()): Promise<PendingEvidence> {
    const state = await this.state(userId);
    const [chatWhere, [batchWhere, segmentWhere]] = [this.chatQuery(userId, cursor(state.chatAt, state.chatId), undefined, now),
      this.echoQueries(userId, cursor(state.echoAt, state.echoId), undefined, now)];
    const stats = await Promise.all([
      this.db.select({ n: sql<number>`count(*)::int`, min: sql<Date | null>`min(${runtimeSubmissions.completedAt})`, max: sql<Date | null>`max(${runtimeSubmissions.completedAt})` }).from(runtimeSubmissions).where(chatWhere),
      this.db.select({ n: sql<number>`count(*)::int`, min: sql<Date | null>`min(${listeningBatches.speakerReviewedAt})`, max: sql<Date | null>`max(${listeningBatches.speakerReviewedAt})` }).from(listeningBatches).where(batchWhere),
      this.db.select({ n: sql<number>`count(*)::int`, min: sql<Date | null>`min(${listeningSegments.speakerReviewedAt})`, max: sql<Date | null>`max(${listeningSegments.speakerReviewedAt})` }).from(listeningSegments).where(segmentWhere),
    ]);
    const rows = stats.map(([s]) => s!);
    const times = (key: 'min' | 'max') => rows.map(r => r[key]).filter((v): v is Date => !!v).map(v => new Date(v));
    const mins = times('min'), maxes = times('max');
    return { count: rows.reduce((n, r) => n + Number(r.n), 0),
      oldestAt: mins.length ? new Date(Math.min(...mins.map(Number))) : null, newestAt: maxes.length ? new Date(Math.max(...maxes.map(Number))) : null };
  }

  /** Evidence in a window, oldest first. Deleted or empty items are simply absent. */
  async evidence(userId: string, window: MemoryWindow, limitPerSource = memoryLimits.runItems, now = new Date()): Promise<Array<MemoryEvidence & { cursor: MemoryCursor }>> {
    const result: Array<MemoryEvidence & { cursor: MemoryCursor }> = [];
    if (window.chat) {
      const turns = await this.db.select({ id: runtimeSubmissions.id, at: runtimeSubmissions.completedAt, userMessageId: runtimeSubmissions.userMessageId, assistantMessageId: runtimeSubmissions.assistantMessageId })
        .from(runtimeSubmissions).where(this.chatQuery(userId, window.chat.after, window.chat.through, now))
        .orderBy(asc(runtimeSubmissions.completedAt), asc(runtimeSubmissions.id)).limit(limitPerSource);
      const rows = turns.length ? await this.db.select().from(messages).where(and(eq(messages.userId, userId),
        inArray(messages.id, turns.flatMap(t => [t.userMessageId, t.assistantMessageId])))) : [];
      const text = new Map((await hydrateMessages(this.db, this.history, userId, rows)).map(m => [m.id, m.text]));
      for (const turn of turns) {
        const user = clip(text.get(turn.userMessageId) ?? '', memoryLimits.chatCharacters);
        const reply = clip(text.get(turn.assistantMessageId) ?? '', memoryLimits.replyCharacters);
        result.push({ id: `chat:${turn.id}`, kind: 'chat', occurredAt: turn.at!.toISOString(), text: user.text,
          ...(reply.text ? { reply: reply.text } : {}), ...(user.truncated || reply.truncated ? { truncated: true } : {}),
          cursor: { at: turn.at!.toISOString(), id: turn.id } });
      }
    }
    if (window.echo) {
      const [batchWhere, segmentWhere] = this.echoQueries(userId, window.echo.after, window.echo.through, now);
      const [batches, segments] = await Promise.all([
        this.db.select({ id: listeningBatches.id, at: listeningBatches.speakerReviewedAt, clientSegmentId: listeningBatches.clientBatchId, status: listeningBatches.status, startedAt: listeningBatches.startedAt, transcript: listeningBatches.transcript, segments: listeningBatches.segments, locationLabel: listeningBatches.locationLabel, utterances: listeningBatches.utterances, speakerReview: listeningBatches.speakerReview })
          .from(listeningBatches).where(batchWhere).orderBy(asc(listeningBatches.speakerReviewedAt), asc(listeningBatches.id)).limit(limitPerSource),
        this.db.select({ id: listeningSegments.id, at: listeningSegments.speakerReviewedAt, clientSegmentId: listeningSegments.clientSegmentId, status: listeningSegments.status, startedAt: listeningSegments.startedAt, transcript: listeningSegments.transcript, locationLabel: listeningSegments.locationLabel, utterances: listeningSegments.utterances, speakerReview: listeningSegments.speakerReview })
          .from(listeningSegments).where(segmentWhere).orderBy(asc(listeningSegments.speakerReviewedAt), asc(listeningSegments.id)).limit(limitPerSource),
      ]);
      const recordings = [...batches, ...segments].sort((a, b) => a.at!.getTime() - b.at!.getTime() || a.id.localeCompare(b.id)).slice(0, limitPerSource);
      for (const recording of await hydrateTranscripts(this.archive, userId, recordings)) {
        const body = clip(personalTranscript(recording), memoryLimits.echoCharacters);
        result.push({ id: echoSourceId(recording.id, recording.speakerReview), kind: 'echo', occurredAt: recording.startedAt.toISOString(), text: body.text, location: echoLocationContext(recording, 8),
          ...(body.truncated ? { truncated: true } : {}), cursor: { at: recording.at!.toISOString(), id: recording.id } });
      }
    }
    return result;
  }

  /**
   * The next contiguous window: the oldest unread items from both sources, cut at the
   * character budget. Items are kept in source order so each cursor only moves forward.
   */
  async nextWindow(userId: string, now = new Date()): Promise<MemoryWindow | undefined> {
    const state = await this.state(userId);
    const chatAfter = cursor(state.chatAt, state.chatId), echoAfter = cursor(state.echoAt, state.echoId);
    const far: MemoryCursor = { at: '9999-12-31T00:00:00.000Z', id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
    const items = await this.evidence(userId, { chat: { after: chatAfter, through: far }, echo: { after: echoAfter, through: far } }, memoryLimits.runItems, now);
    items.sort((a, b) => a.cursor.at.localeCompare(b.cursor.at) || a.id.localeCompare(b.id));
    const window: MemoryWindow = {};
    let characters = 0, count = 0;
    for (const item of items) {
      const size = item.text.length + (item.reply?.length ?? 0) + JSON.stringify(item.location ?? null).length;
      if (count > 0 && (characters + size > memoryLimits.runCharacters || count >= memoryLimits.runItems)) break;
      characters += size; count++;
      const slot = item.kind === 'chat' ? { after: chatAfter, through: item.cursor } : { after: echoAfter, through: item.cursor };
      const current = window[item.kind];
      if (!current || later(item.cursor, current.through)) window[item.kind] = slot;
    }
    return count ? window : undefined;
  }

  async createRun(userId: string, window: MemoryWindow): Promise<MemoryRunRow> {
    await this.db.insert(memoryRuns).values({ userId, window, configVersion: memoryConfigVersion }).onConflictDoNothing();
    return (await this.openRun(userId))!;
  }

  async claim(userId: string): Promise<MemoryRunRow | undefined> {
    return this.db.transaction(async tx => {
      // Fences all Activity attempts and multiple Workers for this user.
      await tx.insert(memoryState).values({ userId }).onConflictDoNothing();
      await tx.select().from(memoryState).where(eq(memoryState.userId, userId)).for('update');
      const [row] = await tx.select().from(memoryRuns).where(and(eq(memoryRuns.userId, userId), inArray(memoryRuns.status, ['pending', 'running']))).for('update');
      const now = new Date();
      if (!row || (row.leaseUntil && row.leaseUntil > now)) return;
      const [claimed] = await tx.update(memoryRuns).set({ status: 'running', leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + leaseMs), attempts: row.attempts + 1, errorCode: null })
        .where(eq(memoryRuns.id, row.id)).returning();
      return claimed;
    });
  }
  private fence(row: MemoryRunRow) {
    return and(eq(memoryRuns.id, row.id), eq(memoryRuns.userId, row.userId), eq(memoryRuns.status, 'running'), eq(memoryRuns.leaseToken, row.leaseToken!), gt(memoryRuns.leaseUntil, new Date()));
  }
  async patch(row: MemoryRunRow, values: Partial<typeof memoryRuns.$inferInsert>): Promise<MemoryRunRow> {
    const [saved] = await this.db.update(memoryRuns).set(values).where(this.fence(row)).returning();
    if (!saved) throw new Error('memory_lease_lost');
    return saved;
  }
  async renew(row: MemoryRunRow) { await this.patch(row, { leaseUntil: new Date(Date.now() + leaseMs) }); }
  async release(row: MemoryRunRow) {
    await this.db.update(memoryRuns).set({ leaseToken: null, leaseUntil: null }).where(and(eq(memoryRuns.id, row.id), eq(memoryRuns.leaseToken, row.leaseToken!)));
  }

  /**
   * Finish a run and move the cursors to its window end in one transaction. A failed run
   * also advances: its evidence is skipped rather than blocking every later window.
   */
  async finish(row: MemoryRunRow, outcome: { status: 'completed'; facts: number; added: number; updated: number; deleted: number } | { status: 'failed'; errorCode: string }) {
    await this.db.transaction(async tx => {
      const [saved] = await tx.update(memoryRuns).set({ ...outcome, completedAt: new Date(), leaseToken: null, leaseUntil: null }).where(this.fence(row)).returning();
      if (!saved) throw new Error('memory_lease_lost');
      const { chat, echo } = row.window;
      await tx.update(memoryState).set({
        ...(chat ? { chatAt: new Date(chat.through.at), chatId: chat.through.id } : {}),
        ...(echo ? { echoAt: new Date(echo.through.at), echoId: echo.through.id } : {}), updatedAt: new Date(),
      }).where(eq(memoryState.userId, row.userId));
    });
  }

  async markSwept(userId: string, at = new Date()) {
    await this.db.update(memoryState).set({ sweptAt: at, updatedAt: new Date() }).where(eq(memoryState.userId, userId));
  }

  /** Locale and time zone resolve relative dates ("next Friday") into expiry times. */
  async profile(userId: string): Promise<{ timeZone: string | null; locale: string | null }> {
    const [settings] = await this.db.select({ timeZone: todaySettings.timeZone, locale: todaySettings.locale }).from(todaySettings).where(eq(todaySettings.userId, userId));
    return { timeZone: settings?.timeZone ?? null, locale: settings?.locale ?? null };
  }
}
