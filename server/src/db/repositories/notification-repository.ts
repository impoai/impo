import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, or, sql, gt, isNotNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import { notificationSettings, notificationEvents, notificationDeliveries, pushInstallations, todayBriefs } from '../schema.js';
import type { Transaction } from './runtime-repository.js';
import { ServiceError } from '../../errors.js';
import { defaultNotificationSettings, notificationLifetimeMs, presenceWindowMs, type NotificationCategory, type NotificationSettings, type Registration, type Revocation } from '../../notifications/contract.js';

type Query = Database | Transaction;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const missing = () => new ServiceError(404, 'not_found', 'Notification installation not found');
const conflict = () => new ServiceError(409, 'registration_conflict', 'Notification registration changed; refresh this installation');
const settingsView = (row?: { preferences: NotificationSettings }): NotificationSettings => row ? { ...defaultNotificationSettings, ...row.preferences } : { ...defaultNotificationSettings };
async function allowed(db: Query, userId: string, category: NotificationCategory, now = new Date()) {
  const [preferences] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId));
  if (!settingsView(preferences)[category]) return false;
  if (category === 'brief') return true;
  const [active] = await db.select({ id: pushInstallations.id }).from(pushInstallations).where(and(eq(pushInstallations.userId, userId), eq(pushInstallations.revoked, false),
    eq(pushInstallations.foreground, true), gt(pushInstallations.presenceAt, new Date(now.getTime() - presenceWindowMs)))).limit(1);
  return !active;
}

/** Called inside the source completion transaction. No historical scan or provider call. */
export async function enqueueNotification(tx: Transaction, input: { userId: string; sourceKey: string; category: NotificationCategory; targetId: string; failed?: boolean }) {
  const now = new Date();
  const eligible = await allowed(tx, input.userId, input.category, now);
  const targets = eligible ? await tx.select().from(pushInstallations).where(and(eq(pushInstallations.userId, input.userId), eq(pushInstallations.enabled, true),
    eq(pushInstallations.revoked, false), isNotNull(pushInstallations.token), gt(pushInstallations.updatedAt, new Date(now.getTime() - 30 * 86400_000)))) : [];
  const [event] = await tx.insert(notificationEvents).values({ ...input, createdAt: now, expiresAt: new Date(now.getTime() + notificationLifetimeMs), status: targets.length ? 'pending' : 'suppressed' })
    .onConflictDoNothing({ target: [notificationEvents.userId, notificationEvents.sourceKey] }).returning();
  if (event && targets.length) await tx.insert(notificationDeliveries).values(targets.map(t => ({ eventId: event.id, installationId: t.id, registrationId: t.registrationId, tokenHash: t.tokenHash! })));
}

export class NotificationRepository {
  constructor(private readonly db: Database) {}
  async settings(userId: string) {
    const [row] = await this.db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId));
    return settingsView(row);
  }
  async updateSettings(userId: string, patch: Partial<NotificationSettings>) {
    const [row] = await this.db.insert(notificationSettings).values({ userId, preferences: { ...defaultNotificationSettings, ...patch } })
      .onConflictDoUpdate({ target: notificationSettings.userId, set: { preferences: sql`${notificationSettings.preferences} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() } }).returning();
    return settingsView(row);
  }
  async register(userId: string, id: string, input: Registration) {
    return this.db.transaction(async tx => {
      // The installation capability plus revision fences requests across accounts and logins.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 971))`);
      const [old] = await tx.select().from(pushInstallations).where(eq(pushInstallations.id, id)).for('update');
      if (old && (old.secretHash !== hash(input.installationSecret) || input.revision <= old.revision)) throw conflict();
      const tokenHash = input.token ? hash(input.token) : null;
      if (tokenHash) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tokenHash}, 972))`);
        const [used] = await tx.select({ id: pushInstallations.id }).from(pushInstallations).where(eq(pushInstallations.tokenHash, tokenHash));
        if (used && used.id !== id) throw new ServiceError(409, 'push_token_conflict', 'Refresh the notification token for this installation');
      }
      const values = { userId, secretHash: hash(input.installationSecret), revision: input.revision, registrationId: input.registrationId,
        platform: input.platform, token: input.token, tokenHash, enabled: input.enabled && input.token !== null, foreground: input.foreground,
        revoked: false, presenceAt: new Date(), updatedAt: new Date() };
      await tx.insert(pushInstallations).values({ id, ...values }).onConflictDoUpdate({ target: pushInstallations.id, set: values });
      return { registrationId: input.registrationId };
    });
  }
  async revoke(userId: string, id: string, input: Revocation) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 971))`);
      const [old] = await tx.select().from(pushInstallations).where(and(eq(pushInstallations.id, id), eq(pushInstallations.userId, userId))).for('update');
      if (!old || old.secretHash !== hash(input.installationSecret)) throw missing();
      if (old.registrationId !== input.registrationId || input.revision <= old.revision) throw conflict();
      await tx.update(pushInstallations).set({ revision: input.revision, token: null, tokenHash: null, enabled: false, revoked: true, foreground: false, updatedAt: new Date() }).where(eq(pushInstallations.id, id));
      return { revoked: true };
    });
  }
  async pending() {
    return this.db.select({ id: notificationEvents.id }).from(notificationEvents).where(and(inArray(notificationEvents.status, ['pending', 'ready']),
      or(isNull(notificationEvents.scheduledAt), lt(notificationEvents.scheduledAt, new Date(Date.now() - 60_000)))))
      .orderBy(asc(notificationEvents.createdAt)).limit(100);
  }
  async scheduled(id: string) { await this.db.update(notificationEvents).set({ scheduledAt: new Date() }).where(eq(notificationEvents.id, id)); }
  async deliveries(eventId: string) {
    return this.db.select({ id: notificationDeliveries.id }).from(notificationDeliveries).where(and(eq(notificationDeliveries.eventId, eventId), inArray(notificationDeliveries.status, ['pending', 'sending']))).limit(5);
  }
  async claim(id: string) {
    return this.db.transaction(async tx => {
      const [delivery] = await tx.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)).for('update');
      if (!delivery || !['pending', 'sending'].includes(delivery.status) || (delivery.leaseUntil && delivery.leaseUntil.getTime() > Date.now())) return;
      const [event] = await tx.select().from(notificationEvents).where(eq(notificationEvents.id, delivery.eventId));
      const [installation] = await tx.select().from(pushInstallations).where(eq(pushInstallations.id, delivery.installationId));
      let valid = event && installation && event.expiresAt.getTime() > Date.now() && installation.userId === event.userId && installation.registrationId === delivery.registrationId
        && installation.tokenHash === delivery.tokenHash && installation.token && installation.enabled && !installation.revoked && await allowed(tx, event.userId, event.category);
      if (valid && event!.category === 'brief') {
        const [brief] = await tx.select({ id: todayBriefs.id }).from(todayBriefs).where(and(eq(todayBriefs.userId, event!.userId), eq(todayBriefs.id, event!.targetId), eq(todayBriefs.status, 'completed')));
        valid = !!brief;
      }
      if (!valid) { await tx.update(notificationDeliveries).set({ status: 'suppressed', leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(eq(notificationDeliveries.id, id)); return; }
      const leaseToken = randomUUID();
      await tx.update(notificationDeliveries).set({ status: 'sending', leaseToken, leaseUntil: new Date(Date.now() + 60_000), attempts: delivery.attempts + 1, updatedAt: new Date() }).where(eq(notificationDeliveries.id, id));
      return { delivery: { ...delivery, leaseToken }, event: event!, installation: installation! };
    });
  }
  async finish(id: string, lease: string, result: { status: 'sent' | 'pending' | 'failed'; messageId?: string; code?: string; invalidToken?: boolean }) {
    await this.db.transaction(async tx => {
      const [saved] = await tx.update(notificationDeliveries).set({ status: result.status, leaseToken: null, leaseUntil: null, providerMessageId: result.messageId ?? null, errorCode: result.code ?? null, updatedAt: new Date() })
        .where(and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.leaseToken, lease))).returning();
      if (saved && result.invalidToken) await tx.update(pushInstallations).set({ enabled: false, token: null, tokenHash: null }).where(and(eq(pushInstallations.id, saved.installationId), eq(pushInstallations.registrationId, saved.registrationId), eq(pushInstallations.tokenHash, saved.tokenHash)));
    });
  }
  async completeIfFinished(eventId: string) {
    if ((await this.deliveries(eventId)).length) return false;
    await this.db.update(notificationEvents).set({ status: 'done' }).where(and(eq(notificationEvents.id, eventId), inArray(notificationEvents.status, ['pending', 'ready'])));
    return true;
  }
}
