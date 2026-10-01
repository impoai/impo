import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { notificationSettings, users } from '../schema.js';
import { ServiceError } from '../../errors.js';
import { defaultNotificationSettings } from '../../notifications/contract.js';
import { defaultEchoSchedule, echoLocalDate, echoReminderLifetimeMs, nextEchoOccurrence, parseEchoSchedule, type EchoSchedule } from '../../echo/schedule.js';
import { enqueueNotification } from './notification-repository.js';

export function storedEchoSchedule(value: unknown): EchoSchedule {
  try { return parseEchoSchedule(value); } catch { return defaultEchoSchedule(); }
}

export class EchoScheduleRepository {
  constructor(private readonly db: Database, private readonly now = () => new Date()) {}
  async get(userId: string): Promise<EchoSchedule> {
    const [row] = await this.db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId));
    return storedEchoSchedule(row?.preferences.echoSchedule);
  }
  async save(userId: string, input: unknown): Promise<EchoSchedule> {
    const requested = parseEchoSchedule(input);
    return this.db.transaction(async tx => {
      const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      if (!user) throw new ServiceError(410, 'account_deleted', 'This account has been deleted.');
      const [row] = await tx.select().from(notificationSettings).where(eq(notificationSettings.userId, userId)).for('update');
      const current = storedEchoSchedule(row?.preferences.echoSchedule);
      // A lost response may be retried without replacing the saved revision.
      if (current.revision && JSON.stringify({ ...requested, revision: null }) === JSON.stringify({ ...current, revision: null })) return current;
      if (requested.revision !== current.revision) throw new ServiceError(409, 'echo_schedule_changed', 'Your Echo schedule changed on another device. Reload it before saving.');
      const echoSchedule = { ...requested, revision: randomUUID() };
      await tx.insert(notificationSettings).values({ userId, preferences: { ...defaultNotificationSettings, echoSchedule } })
        .onConflictDoUpdate({ target: notificationSettings.userId, set: {
          preferences: sql`${notificationSettings.preferences} || ${JSON.stringify({ echoSchedule })}::jsonb`, updatedAt: this.now(),
        } });
      return echoSchedule;
    });
  }
  async list(after?: string) {
    return this.db.select({ userId: notificationSettings.userId, preferences: notificationSettings.preferences }).from(notificationSettings)
      .where(and(sql`${notificationSettings.preferences} ? 'echoSchedule'`, ...(after ? [gt(notificationSettings.userId, after)] : [])))
      .orderBy(asc(notificationSettings.userId)).limit(100);
  }
  async plan(userId: string) {
    const schedule = await this.get(userId);
    return { revision: schedule.revision, nextAt: nextEchoOccurrence(schedule, 'reminderTime', this.now())?.getTime() ?? null };
  }
  async remind(userId: string, revision: string, scheduledAt: number): Promise<void> {
    const now = this.now();
    if (!Number.isSafeInteger(scheduledAt) || now.getTime() < scheduledAt || now.getTime() >= scheduledAt + echoReminderLifetimeMs) return;
    await this.db.transaction(async tx => {
      const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      if (!user) return;
      const [row] = await tx.select().from(notificationSettings).where(eq(notificationSettings.userId, userId)).for('update');
      const schedule = storedEchoSchedule(row?.preferences.echoSchedule);
      if (!schedule.enabled || schedule.revision !== revision || nextEchoOccurrence(schedule, 'reminderTime', new Date(scheduledAt - 1))?.getTime() !== scheduledAt) return;
      await enqueueNotification(tx, { userId, category: 'echo', targetId: revision,
        sourceKey: `echo/${revision}/${echoLocalDate(new Date(scheduledAt), schedule.timeZone)}`,
        expiresAt: new Date(scheduledAt + echoReminderLifetimeMs) });
    });
  }
}
