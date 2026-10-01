import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { Database } from '../client.js';
import { conversations, runtimeSubmissions, scheduledTaskRuns, scheduledTasks, users } from '../schema.js';
import { RuntimeRepository, type RuntimeOptions, type Transaction } from './runtime-repository.js';
import { ServiceError } from '../../errors.js';
import { deviceHash } from '../../tools/device-tools.js';
import { composePrompt } from '../../prompts/index.js';
import { nextTaskOccurrence, parseScheduledTask, type ScheduledTaskInput } from '../../scheduling/contract.js';

type Row = typeof scheduledTasks.$inferSelect;
const owned = (userId: string, id: string) => and(eq(scheduledTasks.userId, userId), eq(scheduledTasks.id, id));
const missing = () => new ServiceError(404, 'not_found', 'Scheduled task not found.');
const conflict = () => new ServiceError(409, 'schedule_changed', 'This schedule changed. Reload it before saving.');
const content = (row: ScheduledTaskInput) => ({ title: row.title, goal: row.goal, schedule: row.schedule, enabled: row.enabled });
const view = (row: Row) => ({ id: row.id, ...content(row), revision: row.revision, nextRunAt: row.nextRunAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });

export class ScheduledTaskRepository extends RuntimeRepository {
  constructor(db: Database, runtime: RuntimeOptions = { provider: 'development' }, private readonly now = () => new Date()) {
    super(db, { ...runtime, ...(runtime.taskAgentConfig ? { taskAgentConfig: { ...runtime.taskAgentConfig,
      instructions: composePrompt('scheduled-task'), promptVersion: 'impo.scheduled.v1' } } : {}) });
  }
  private async owner(tx: Transaction, userId: string) {
    return (await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update'))[0];
  }
  async list(userId: string) {
    const rows = await this.db.select().from(scheduledTasks).where(and(eq(scheduledTasks.userId, userId), isNull(scheduledTasks.deletedAt)))
      .orderBy(desc(scheduledTasks.createdAt), desc(scheduledTasks.id));
    return { schedules: rows.map(view) };
  }
  async get(userId: string, id: string) {
    const [row] = await this.db.select().from(scheduledTasks).where(and(owned(userId, id), isNull(scheduledTasks.deletedAt)));
    if (!row) throw missing();
    return view(row);
  }
  private next(input: ScheduledTaskInput) {
    if (!input.enabled) return null;
    const next = nextTaskOccurrence(input.schedule, this.now());
    if (!next) throw new ServiceError(400, 'schedule_in_past', 'Choose a future time for this task.');
    return next;
  }
  async create(userId: string, clientRequestId: string, input: ScheduledTaskInput) {
    const normalized = parseScheduledTask(input as unknown as Record<string, unknown>);
    const requestHash = deviceHash(normalized);
    return this.db.transaction(async tx => {
      if (!await this.owner(tx, userId)) throw missing();
      const [existing] = await tx.select().from(scheduledTasks).where(and(eq(scheduledTasks.userId, userId), eq(scheduledTasks.clientRequestId, clientRequestId)));
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ServiceError(409, 'idempotency_conflict', 'This request already created a different schedule.');
        if (existing.deletedAt) throw new ServiceError(410, 'schedule_deleted', 'This scheduled task was deleted.');
        return view(existing);
      }
      const current = await tx.select({ id: scheduledTasks.id }).from(scheduledTasks).where(and(eq(scheduledTasks.userId, userId), isNull(scheduledTasks.deletedAt))).limit(50);
      if (current.length >= 50) throw new ServiceError(409, 'schedule_limit', 'You can keep up to 50 scheduled tasks.');
      const [row] = await tx.insert(scheduledTasks).values({ userId, clientRequestId, requestHash, ...normalized, nextRunAt: this.next(normalized) }).returning();
      return view(row!);
    });
  }
  async update(userId: string, id: string, revision: string, input: ScheduledTaskInput) {
    const normalized = parseScheduledTask(input as unknown as Record<string, unknown>);
    return this.db.transaction(async tx => {
      if (!await this.owner(tx, userId)) throw missing();
      const [old] = await tx.select().from(scheduledTasks).where(and(owned(userId, id), isNull(scheduledTasks.deletedAt))).for('update');
      if (!old) throw missing();
      if (deviceHash(content(old)) === deviceHash(normalized)) return view(old);
      if (old.revision !== revision) throw conflict();
      const [row] = await tx.update(scheduledTasks).set({ ...normalized, revision: randomUUID(), nextRunAt: this.next(normalized), updatedAt: this.now() })
        .where(owned(userId, id)).returning();
      return view(row!);
    });
  }
  async remove(userId: string, id: string, revision: string) {
    return this.db.transaction(async tx => {
      if (!await this.owner(tx, userId)) throw missing();
      const [old] = await tx.select().from(scheduledTasks).where(owned(userId, id)).for('update');
      if (!old) throw missing();
      if (!old.deletedAt) {
        if (old.revision !== revision) throw conflict();
        await tx.update(scheduledTasks).set({ enabled: false, nextRunAt: null, deletedAt: this.now(), updatedAt: this.now(), revision: randomUUID() }).where(owned(userId, id));
      }
      return { deleted: true };
    });
  }
  async runs(userId: string, id: string, before?: string) {
    await this.get(userId, id);
    let cursor: { at: string; id: string } | undefined;
    if (before) {
      try {
        cursor = JSON.parse(Buffer.from(before, 'base64url').toString());
        if (!cursor || !Number.isFinite(Date.parse(cursor.at)) || !/^[0-9a-f-]{36}$/i.test(cursor.id)) throw new Error();
      } catch { throw new ServiceError(400, 'invalid_cursor', 'Invalid schedule history cursor'); }
    }
    const rows = await this.db.select().from(scheduledTaskRuns).where(and(eq(scheduledTaskRuns.userId, userId), eq(scheduledTaskRuns.scheduleId, id),
      ...(cursor ? [or(lt(scheduledTaskRuns.scheduledAt, new Date(cursor.at)), and(eq(scheduledTaskRuns.scheduledAt, new Date(cursor.at)), lt(scheduledTaskRuns.id, cursor.id)))] : []))).orderBy(desc(scheduledTaskRuns.scheduledAt), desc(scheduledTaskRuns.id)).limit(31);
    const results = [];
    for (const row of rows.slice(0, 30)) {
      const [run] = row.taskId ? await this.db.select({ status: runtimeSubmissions.status }).from(runtimeSubmissions)
        .innerJoin(conversations, eq(conversations.id, runtimeSubmissions.conversationId))
        .where(and(eq(conversations.userId, userId), eq(conversations.actionId, row.taskId))).orderBy(desc(runtimeSubmissions.createdAt)).limit(1) : [];
      results.push({ id: row.id, taskId: row.taskId, scheduledAt: row.scheduledAt.toISOString(), createdAt: row.createdAt.toISOString(),
        status: row.status === 'skipped_overlap' ? row.status : run?.status ?? 'queued' });
    }
    return { runs: results, nextCursor: rows.length > 30 ? Buffer.from(JSON.stringify({ at: rows[29]!.scheduledAt.toISOString(), id: rows[29]!.id })).toString('base64url') : null };
  }
  /** Discovery includes tombstones so a deletion also wakes and closes its existing timer. */
  async discover(after?: string) {
    return this.db.select({ id: scheduledTasks.id, userId: scheduledTasks.userId, revision: scheduledTasks.revision }).from(scheduledTasks)
      .where(after ? lt(scheduledTasks.id, after) : undefined).orderBy(desc(scheduledTasks.id)).limit(100);
  }
  async plan(userId: string, id: string) {
    const [row] = await this.db.select().from(scheduledTasks).where(owned(userId, id));
    return { revision: row?.revision ?? null, nextAt: row?.enabled && !row.deletedAt ? row.nextRunAt?.getTime() ?? null : null };
  }
  /** A stale timer cannot create a task; acceptance and occurrence advancement share one transaction. */
  async fire(userId: string, id: string, revision: string, scheduledAt: number) {
    return this.db.transaction(async tx => {
      if (!await this.owner(tx, userId)) return;
      const [row] = await tx.select().from(scheduledTasks).where(owned(userId, id)).for('update');
      const now = this.now();
      if (!row || !row.enabled || row.deletedAt || row.revision !== revision || row.nextRunAt?.getTime() !== scheduledAt || scheduledAt > now.getTime()) return;
      const [active] = await tx.select({ id: runtimeSubmissions.id }).from(scheduledTaskRuns)
        .innerJoin(conversations, and(eq(conversations.actionId, scheduledTaskRuns.taskId), eq(conversations.userId, userId)))
        .innerJoin(runtimeSubmissions, eq(runtimeSubmissions.conversationId, conversations.id))
        .where(and(eq(scheduledTaskRuns.scheduleId, id), eq(scheduledTaskRuns.userId, userId), inArray(runtimeSubmissions.status, ['queued', 'running', 'waiting_device']))).limit(1);
      const receipt = active ? undefined : await this.createUserTaskInTransaction(tx, userId, {
        clientMessageId: `schedule/${id}/${revision}/${scheduledAt}`, text: row.goal,
        clientContext: { timeZone: row.schedule.timeZone, currentDate: now.toISOString() },
      });
      await tx.insert(scheduledTaskRuns).values({ userId, scheduleId: id, revision, scheduledAt: new Date(scheduledAt),
        taskId: receipt?.taskId, status: active ? 'skipped_overlap' : 'started' });
      await tx.update(scheduledTasks).set({ nextRunAt: nextTaskOccurrence(row.schedule, now), updatedAt: now }).where(owned(userId, id));
      return receipt;
    });
  }
}
