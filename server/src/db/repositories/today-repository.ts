import { personalTranscript } from '../../listening/speakers.js';
import type { ModelModes } from '../../model-modes.js';
import { userProfiles } from '../schema.js';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, lt, or, sql, ne, isNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import { actions, conversations, listeningBatches, listeningSegments, messages, todayBriefs, todaySettings, scheduledTasks, notificationSettings } from '../schema.js';
import { parseBriefPreferences, briefCardVisible, defaultBriefPreferences, topicBlocked, topicCooldown, type BriefTopics } from '../../today/content.js';
import { buildBriefGuidance, type BriefContextProvider } from '../../today/context.js';
import { ServiceError } from '../../errors.js';
import { hydrateTranscripts, type TranscriptArchive } from '../../listening/transcript-archive.js';
import { echoLocationContext, type EchoLocationContext } from '../../listening/location.js';
import { hydrateMessages, taskTitles, type HistoryReader } from './conversation-history.js';
import { briefConfigVersion, currentBriefLocation, defaultBriefSlots, dueSlot, localClock, type BriefContent, type BriefInput, type BriefSlot, type BriefSource, type BriefLocation } from '../../today/contract.js';

import { enqueueNotification } from './notification-repository.js';
export type BriefRow = typeof todayBriefs.$inferSelect;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const leaseMs = 120_000;
const validZone = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
};
export function validateTodaySettings(raw: Record<string, unknown>) {
  if (Object.keys(raw).some(k => !['timeZone', 'locale', 'slots', 'displayName', 'location', 'contentPreferences', 'briefClientVersion'].includes(k)) || !validZone(raw.timeZone)
    || typeof raw.locale !== 'string' || !/^[A-Za-z0-9_-]{2,40}$/.test(raw.locale)) throw new ServiceError(400, 'invalid_request', 'A valid time zone and locale are required');
  let slots: BriefSlot[] | undefined;
  if (raw.slots !== undefined) {
    if (!Array.isArray(raw.slots) || raw.slots.length < 1 || raw.slots.length > 6) throw new ServiceError(400, 'invalid_request', 'Choose between one and six brief times');
    slots = raw.slots.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError(400, 'invalid_request', 'Invalid brief time');
      const s = value as Record<string, unknown>;
      if (Object.keys(s).some(k => !['id', 'label', 'hour', 'enabled'].includes(k)) || typeof s.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(s.id)
        || typeof s.label !== 'string' || !s.label.trim() || s.label.length > 60 || !Number.isInteger(s.hour) || Number(s.hour) < 0 || Number(s.hour) > 23 || typeof s.enabled !== 'boolean') throw new ServiceError(400, 'invalid_request', 'Invalid brief time');
      return { id: s.id, label: s.label.trim(), hour: s.hour as number, enabled: s.enabled };
    });
    if (new Set(slots.map(s => s.id)).size !== slots.length) throw new ServiceError(400, 'invalid_request', 'Brief identifiers must be unique');
    const enabled = slots.filter(s => s.enabled);
    if (new Set(enabled.map(s => s.hour)).size !== enabled.length) throw new ServiceError(400, 'invalid_request', 'Choose a different hour for each enabled brief');
  }
  if (raw.displayName !== undefined && (typeof raw.displayName !== 'string' || raw.displayName.length > 100)) throw new ServiceError(400, 'invalid_request', 'Invalid display name');
  let location: BriefLocation | null | undefined;
  if (raw.location === null) location = null;
  else if (raw.location !== undefined) {
    const v = raw.location as Record<string, unknown>;
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['city', 'country', 'capturedAt', 'source'].includes(k))
      || (v.source !== undefined && v.source !== 'device' && v.source !== 'manual')
      || typeof v.city !== 'string' || !v.city.trim() || v.city.length > 100 || typeof v.country !== 'string' || v.country.length > 100
      || typeof v.capturedAt !== 'string' || !Number.isFinite(Date.parse(v.capturedAt)) || Date.parse(v.capturedAt) > Date.now() + 300000) throw new ServiceError(400, 'invalid_request', 'Invalid city snapshot');
    location = { city: v.city.trim(), country: v.country, capturedAt: v.capturedAt, ...(v.source !== undefined ? { source: v.source as 'device' | 'manual' } : {}) };
  }
  let contentPreferences;
  if (raw.contentPreferences !== undefined) {
    try { contentPreferences = parseBriefPreferences(raw.contentPreferences); }
    catch { throw new ServiceError(400, 'invalid_request', 'Choose valid Brief content preferences'); }
  }
  if (raw.briefClientVersion !== undefined && raw.briefClientVersion !== 2) throw new ServiceError(400, 'invalid_request', 'Invalid Brief client version');
  return { timeZone: raw.timeZone, locale: raw.locale, slots, ...(raw.displayName !== undefined ? { displayName: raw.displayName as string } : {}), ...(location !== undefined ? { location } : {}),
    ...(contentPreferences ? { contentPreferences } : {}), ...(raw.briefClientVersion === 2 ? { briefClientVersion: 2 } : {}) };
}

export class TodayRepository {
  constructor(private readonly db: Database, private readonly archive?: TranscriptArchive, private readonly history?: HistoryReader, private readonly contextProvider: BriefContextProvider = {}) {}

  private async guidance(userId: string, input: BriefInput, editionId: string, ignoreCooldown = false) {
    const settings = (await this.settings(userId))!;
    const [schedules, reviews, notifications] = await Promise.all([
      this.db.select({ id: scheduledTasks.id }).from(scheduledTasks).where(and(eq(scheduledTasks.userId, userId), isNull(scheduledTasks.deletedAt))).limit(1),
      this.db.select({ id: listeningBatches.id }).from(listeningBatches).where(and(eq(listeningBatches.userId, userId), sql`${listeningBatches.speakerReview}->>'status' = 'confirmed'`)).limit(1),
      this.db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId)),
    ]);
    const echoSchedule = notifications[0]?.preferences.echoSchedule as { enabled?: boolean } | undefined;
    return buildBriefGuidance(userId, input, editionId, settings.contentPreferences, ignoreCooldown ? {} : settings.topics, settings.briefClientVersion,
      { scheduledTasks: schedules.length > 0, echoSchedule: echoSchedule?.enabled === true, echoSpeakers: reviews.length > 0 }, this.contextProvider);
  }

  async selectedModel(userId: string, models: ModelModes): Promise<string> {
    const [profile] = await this.db.select({ mode: userProfiles.mode }).from(userProfiles).where(eq(userProfiles.userId, userId));
    return models[profile?.mode ?? 'Balanced'];
  }
  async settings(userId: string) {
    const [settings] = await this.db.select().from(todaySettings).where(eq(todaySettings.userId, userId));
    return settings ?? null;
  }
  async registerClient(userId: string, raw: Record<string, unknown>) {
    if (Object.keys(raw).length !== 1 || raw.version !== 2) throw new ServiceError(400, 'invalid_request', 'Invalid Brief client version');
    await this.db.update(todaySettings).set({ briefClientVersion: 2 }).where(eq(todaySettings.userId, userId));
    return { status: 'saved' };
  }
  async configure(userId: string, raw: Record<string, unknown>) {
    const settings = validateTodaySettings(raw);
    const [saved] = await this.db.insert(todaySettings).values({ userId, ...settings, slots: settings.slots ?? defaultBriefSlots })
      .onConflictDoUpdate({ target: todaySettings.userId, set: { ...settings,
        ...(settings.slots ? { slots: settings.slots } : {}), updatedAt: new Date() } }).returning();
    return saved!;
  }
  async ensureDue(userId: string, now = new Date(), manual = false): Promise<BriefRow | undefined> {
    const settings = await this.settings(userId);
    if (!settings) { if (manual) throw new ServiceError(409, 'today_setup_required', 'Set your time zone first'); return; }
    const local = localClock(now, settings.timeZone);
    const slot = dueSlot(settings.slots, local.hour) ?? (manual ? (settings.slots.find(s => s.id === 'early') ?? { id: 'early', label: 'Early Brief', hour: local.hour, enabled: false }) : undefined);
    if (!slot) return;
    // No historical backfill storm: only the most recent due edition today.
    await this.db.insert(todayBriefs).values({ userId, localDate: local.date, timeZone: settings.timeZone,
      slotId: slot.id, slotLabel: slot.label, scheduledAt: now, configVersion: briefConfigVersion }).onConflictDoNothing();
    const [brief] = await this.db.select().from(todayBriefs).where(and(eq(todayBriefs.userId, userId), eq(todayBriefs.localDate, local.date), eq(todayBriefs.slotId, slot.id)));
    return brief;
  }
  async claim(userId: string): Promise<BriefRow | undefined> {
    return this.db.transaction(async tx => {
      // Fences all Activity attempts and multiple Workers for this user.
      const [settings] = await tx.select().from(todaySettings).where(eq(todaySettings.userId, userId)).for('update');
      if (!settings) return;
      const now = new Date();
      const [active] = await tx.select({ id: todayBriefs.id }).from(todayBriefs).where(and(eq(todayBriefs.userId, userId), gt(todayBriefs.leaseUntil, now)));
      if (active) return;
      const [row] = await tx.select().from(todayBriefs).where(and(eq(todayBriefs.userId, userId), inArray(todayBriefs.status, ['pending', 'generating'])))
        .orderBy(asc(todayBriefs.createdAt)).limit(1).for('update');
      if (!row) return;
      const [claimed] = await tx.update(todayBriefs).set({ status: 'generating', leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + leaseMs), attempts: row.attempts + 1, errorCode: null })
        .where(eq(todayBriefs.id, row.id)).returning();
      return claimed;
    });
  }
  private fence(row: BriefRow) { return and(eq(todayBriefs.id, row.id), eq(todayBriefs.userId, row.userId), eq(todayBriefs.status, 'generating'), eq(todayBriefs.leaseToken, row.leaseToken!), gt(todayBriefs.leaseUntil, new Date())); }
  async patch(row: BriefRow, values: Partial<typeof todayBriefs.$inferInsert>) {
    const [saved] = await this.db.update(todayBriefs).set(values).where(this.fence(row)).returning();
    if (!saved) throw new Error('today_lease_lost');
    return saved;
  }
  async renew(row: BriefRow) { await this.patch(row, { leaseUntil: new Date(Date.now() + leaseMs) }); }
  async release(row: BriefRow) {
    await this.db.update(todayBriefs).set({ leaseToken: null, leaseUntil: null }).where(and(eq(todayBriefs.id, row.id), eq(todayBriefs.leaseToken, row.leaseToken!)));
  }
  private source(kind: BriefSource['kind'], recordId: string, title: string, occurredAt: Date, text: string, versionText = text, location?: EchoLocationContext): BriefSource {
    return { id: `${kind}:${recordId}`, kind, recordId, title, occurredAt: occurredAt.toISOString(), text, version: hash(versionText + (location ? JSON.stringify(location) : '')), ...(location ? {location} : {}) };
  }
  /** Task goals are chat text kept in Rebyte; fill each from its task's first message. */
  private async withTaskTitles<T extends { id: string; goal: string }>(userId: string, rows: T[]): Promise<T[]> {
    if (!rows.length) return rows;
    const owners = await this.db.select({ id: conversations.id, actionId: conversations.actionId }).from(conversations)
      .where(and(eq(conversations.userId, userId), inArray(conversations.actionId, rows.map(row => row.id))));
    const titles = await taskTitles(this.db, this.history, userId, owners.map(owner => owner.id));
    const byAction = new Map(owners.map(owner => [owner.actionId, titles.get(owner.id)]));
    return rows.map(row => ({ ...row, goal: byAction.get(row.id) ?? row.goal }));
  }
  async input(row: BriefRow): Promise<BriefInput> {
    if (row.input) return row.input;
    const settings = (await this.settings(row.userId))!;
    const cutoff = new Date(); const since = new Date(cutoff.getTime() - 7 * 86400_000);
    const [chat, batches, segments, tasks] = await Promise.all([
      this.db.select().from(messages).where(and(eq(messages.userId, row.userId), eq(messages.role, 'user'), gte(messages.createdAt, since), lt(messages.createdAt, cutoff))).orderBy(desc(messages.createdAt)).limit(24)
        .then(rows => hydrateMessages(this.db, this.history, row.userId, rows)),
      this.db.select({ id: listeningBatches.id, clientSegmentId: listeningBatches.clientBatchId, status: listeningBatches.status, startedAt: listeningBatches.startedAt, transcript: listeningBatches.transcript, segments: listeningBatches.segments, locationLabel: listeningBatches.locationLabel, utterances: listeningBatches.utterances, speakerReview: listeningBatches.speakerReview }).from(listeningBatches)
        .where(and(eq(listeningBatches.userId, row.userId), eq(listeningBatches.status, 'transcribed'), sql`${listeningBatches.speakerReview}->>'status' = 'confirmed'`, gte(listeningBatches.speakerReviewedAt, since), lt(listeningBatches.speakerReviewedAt, cutoff))).orderBy(desc(listeningBatches.speakerReviewedAt)).limit(24)
        .then(rows => hydrateTranscripts(this.archive, row.userId, rows)),
      this.db.select({ id: listeningSegments.id, clientSegmentId: listeningSegments.clientSegmentId, status: listeningSegments.status, startedAt: listeningSegments.startedAt, transcript: listeningSegments.transcript, locationLabel: listeningSegments.locationLabel, utterances: listeningSegments.utterances, speakerReview: listeningSegments.speakerReview }).from(listeningSegments)
        .where(and(eq(listeningSegments.userId, row.userId), eq(listeningSegments.status, 'transcribed'), sql`${listeningSegments.speakerReview}->>'status' = 'confirmed'`, gte(listeningSegments.speakerReviewedAt, since), lt(listeningSegments.speakerReviewedAt, cutoff))).orderBy(desc(listeningSegments.speakerReviewedAt)).limit(24)
        .then(rows => hydrateTranscripts(this.archive, row.userId, rows)),
      this.db.select().from(actions).where(and(eq(actions.userId, row.userId), gte(actions.updatedAt, since), lt(actions.createdAt, cutoff))).orderBy(desc(actions.updatedAt)).limit(12)
        .then(rows => this.withTaskTitles(row.userId, rows)),
    ]);
    const candidates = [
      ...chat.map(v => this.source('message', v.id, 'Your message', v.createdAt, v.text)),
      ...batches.map(v => this.source('batch', v.id, 'Your Echo speech', v.startedAt, personalTranscript(v), JSON.stringify([personalTranscript(v), v.speakerReview]), echoLocationContext(v, 8))),
      ...segments.map(v => this.source('transcript', v.id, 'Your Echo speech', v.startedAt, personalTranscript(v), JSON.stringify([personalTranscript(v), v.speakerReview]), echoLocationContext(v, 8))),
      ...tasks.map(v => this.source('task', v.id, 'Task', v.createdAt, `${v.goal}\nStatus at ${cutoff.toISOString()}: ${v.status}`, v.goal)),
    ].filter(s => s.text.trim()).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    const sources: BriefSource[] = []; let remaining = 24000; let truncated = candidates.length >= 24;
    for (const source of candidates) {
      if (remaining <= 0 || sources.length >= 30) { truncated = true; break; }
      const locationSize = source.location ? JSON.stringify(source.location).length : 0;
      if (remaining <= locationSize) { truncated = true; break; }
      const text = source.text.slice(0, Math.min(2400, remaining - locationSize));
      truncated ||= text.length !== source.text.length;
      sources.push({ ...source, occurredLocalDate: localClock(new Date(source.occurredAt), row.timeZone).date, text }); remaining -= text.length + locationSize;
    }
    const location = currentBriefLocation(settings.location, cutoff);
    const input: BriefInput = { localDate: row.localDate, timeZone: row.timeZone, locale: settings.locale, kind: row.slotId, label: row.slotLabel, cutoff: cutoff.toISOString(), sources, truncated, profile: { displayName: settings.displayName, location } };
    input.guidance = await this.guidance(row.userId, input, row.id);
    input.sources = input.sources.filter(s => !input.guidance!.blockedTopics.includes(`source:${s.id}`));
    await this.patch(row, { input });
    return input;
  }
  async currentSource(userId: string, source: Pick<BriefSource, 'kind' | 'recordId'>): Promise<BriefSource | undefined> {
    const { kind, recordId: id } = source;
    if (kind === 'message') {
      const [v] = await hydrateMessages(this.db, this.history, userId, await this.db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.id, id), eq(messages.role, 'user'))));
      if (v?.text) return this.source(kind, id, 'Your message', v.createdAt, v.text);
    } else if (kind === 'batch') {
      const [v] = await hydrateTranscripts(this.archive, userId, await this.db.select({ clientSegmentId: listeningBatches.clientBatchId, status: listeningBatches.status, startedAt: listeningBatches.startedAt, transcript: listeningBatches.transcript, segments: listeningBatches.segments, locationLabel: listeningBatches.locationLabel, utterances: listeningBatches.utterances, speakerReview: listeningBatches.speakerReview })
        .from(listeningBatches).where(and(eq(listeningBatches.userId, userId), eq(listeningBatches.id, id), eq(listeningBatches.status, 'transcribed'))));
      if (v && personalTranscript(v)) return this.source(kind, id, 'Your Echo speech', v.startedAt, personalTranscript(v), JSON.stringify([personalTranscript(v), v.speakerReview]), echoLocationContext(v, 8));
    } else if (kind === 'transcript') {
      const [v] = await hydrateTranscripts(this.archive, userId, await this.db.select({ clientSegmentId: listeningSegments.clientSegmentId, status: listeningSegments.status, startedAt: listeningSegments.startedAt, transcript: listeningSegments.transcript, locationLabel: listeningSegments.locationLabel, utterances: listeningSegments.utterances, speakerReview: listeningSegments.speakerReview }).from(listeningSegments)
        .where(and(eq(listeningSegments.userId, userId), eq(listeningSegments.id, id), eq(listeningSegments.status, 'transcribed'))));
      if (v && personalTranscript(v)) return this.source(kind, id, 'Your Echo speech', v.startedAt, personalTranscript(v), JSON.stringify([personalTranscript(v), v.speakerReview]), echoLocationContext(v, 8));
    } else if (kind === 'task') {
      const [v] = await this.withTaskTitles(userId, await this.db.select().from(actions).where(and(eq(actions.userId, userId), eq(actions.id, id))));
      if (v) return this.source(kind, id, 'Task', v.createdAt, `${v.goal}\nCurrent status: ${v.status}`, v.goal);
    }
  }
  async sourcesValid(row: BriefRow) {
    for (const source of row.input?.sources ?? []) {
      const current = await this.currentSource(row.userId, source);
      if (!current || current.version !== source.version) return false;
    }
    return true;
  }
  async complete(row: BriefRow, content: BriefContent, provenance: { providerAgentId: string | null; providerTurnId: string; providerItemId: string }) {
    if (!await this.sourcesValid(row)) { await this.patch(row, { status: 'withdrawn', input: null, content: null }); return; }
    if (content.schemaVersion === 2 && !await this.contextValid(row, content.cards)) {
      await this.patch(row, { status: 'withdrawn', input: null, content: null }); return;
    }
    await this.db.transaction(async tx => {
      const [settings] = await tx.select().from(todaySettings).where(eq(todaySettings.userId, row.userId)).for('update');
      if (!settings) throw new Error('today_settings_missing');
      const now = new Date();
      if (content.schemaVersion === 2 && content.cards.some(c => !settings.contentPreferences.categories[c.type!]
        || topicBlocked(settings.topics[c.topicKey!], now, topicCooldown(c.topicKey!)))) {
        await tx.update(todayBriefs).set({ status: 'withdrawn', input: null, content: null }).where(this.fence(row)); return;
      }
      const [saved] = await tx.update(todayBriefs).set({ status: 'completed', content: content.schemaVersion === 2 ? { ...content, generatedAt: now.toISOString() } : content, ...provenance, completedAt: new Date(), errorCode: null,
        input: row.input ? { ...row.input, sources: row.input.sources.map(s => ({ ...s, text: '' })) } : null }).where(this.fence(row)).returning();
      if (!saved) throw new Error('today_lease_lost');
      if (content.schemaVersion === 2) {
        const topics: BriefTopics = Object.fromEntries(Object.entries(settings.topics).filter(([, t]) => t.dismissed || Date.parse(t.snoozedUntil ?? '') > now.getTime() || Date.parse(t.shownAt ?? '') > now.getTime() - 30 * 86400_000));
        for (const card of content.cards) topics[card.topicKey!] = { ...topics[card.topicKey!], shownAt: now.toISOString() };
        await tx.update(todaySettings).set({ topics }).where(eq(todaySettings.userId, row.userId));
      }
      if (content.cards.length) await enqueueNotification(tx, { userId: row.userId, sourceKey: `brief/${row.id}`, category: 'brief', targetId: row.id });
    });
  }

  private async contextValid(row: BriefRow, cards: BriefContent['cards']): Promise<boolean> {
    if (!row.input?.guidance) return false;
    const now = new Date();
    const fresh = await this.guidance(row.userId, { ...row.input, cutoff: now.toISOString(), localDate: localClock(now, row.timeZone).date }, row.id, true);
    return cards.every(c => (!c.expiresAt || Date.parse(c.expiresAt) > now.getTime())
      && fresh.preferences.categories[c.type!]
      && (c.contextIds ?? []).every(id => fresh.contexts.some(v => v.id === id))
      && (!c.action || fresh.actions.some(a => a.id === c.action!.id && a.kind === c.action!.kind && a.target === c.action!.target)));
  }
  async cardAction(userId: string, id: string, cardId: string) {
    const row = await this.owned(userId, id);
    const visible = await this.view(row);
    const card = visible.content?.cards.find(c => c.id === cardId);
    if (!card?.action) throw new ServiceError(404, 'not_found', 'This suggestion is no longer available');
    if (!await this.contextValid(row, [card])) throw new ServiceError(409, 'brief_action_expired', 'This suggestion has changed. Refresh your Brief.');
    return { action: card.action };
  }
  async feedback(userId: string, id: string, cardId: string, raw: Record<string, unknown>) {
    if (Object.keys(raw).length !== 1 || !['dismiss', 'snooze'].includes(String(raw.action))) throw new ServiceError(400, 'invalid_request', 'Choose dismiss or snooze');
    const row = await this.owned(userId, id);
    if (row.status !== 'completed' || !await this.sourcesValid(row)) throw new ServiceError(404, 'not_found', 'Suggestion not found');
    const card = row.content?.cards.find(c => c.id === cardId);
    if (!card?.topicKey) throw new ServiceError(404, 'not_found', 'Suggestion not found');
    await this.db.transaction(async tx => {
      const [settings] = await tx.select().from(todaySettings).where(eq(todaySettings.userId, userId)).for('update');
      if (!settings) throw new ServiceError(404, 'not_found', 'Brief preferences not found');
      if (Object.keys(settings.topics).length >= 1000 && !settings.topics[card.topicKey!]) throw new ServiceError(409, 'brief_topic_limit', 'Restore hidden suggestions in Brief preferences first');
      const topics = { ...settings.topics, [card.topicKey!]: { ...settings.topics[card.topicKey!],
        ...(raw.action === 'dismiss' ? { dismissed: true } : { snoozedUntil: new Date(Date.now() + 7 * 86400_000).toISOString() }) } };
      await tx.update(todaySettings).set({ topics }).where(eq(todaySettings.userId, userId));
    });
    return { status: 'saved' };
  }
  async resetTopics(userId: string) {
    await this.db.transaction(async tx => {
      const [settings] = await tx.select().from(todaySettings).where(eq(todaySettings.userId, userId)).for('update');
      if (!settings) throw new ServiceError(404, 'not_found', 'Brief preferences not found');
      const topics = Object.fromEntries(Object.entries(settings.topics).map(([key, t]) => [key, t.shownAt ? { shownAt: t.shownAt } : {}]));
      await tx.update(todaySettings).set({ topics }).where(eq(todaySettings.userId, userId));
    });
    return { status: 'saved' };
  }
  async fail(row: BriefRow, code: string) { await this.patch(row, { status: 'failed', errorCode: code, input: row.input ? { ...row.input, sources: row.input.sources.map(s => ({ ...s, text: '' })) } : null }); }
  async owned(userId: string, id: string) {
    const [row] = await this.db.select().from(todayBriefs).where(and(eq(todayBriefs.userId, userId), eq(todayBriefs.id, id), ne(todayBriefs.status, 'deleted')));
    if (!row) throw new ServiceError(404, 'not_found', 'Brief not found');
    return row;
  }
  async view(row: BriefRow) {
    if (row.status === 'completed' && !await this.sourcesValid(row)) {
      await this.db.update(todayBriefs).set({ status: 'withdrawn', input: null, content: null }).where(and(eq(todayBriefs.id, row.id), eq(todayBriefs.status, 'completed')));
      row = { ...row, status: 'withdrawn', input: null, content: null };
    }
    if (row.content?.schemaVersion === 2) {
      const settings = await this.settings(row.userId);
      row = { ...row, content: { ...row.content, cards: row.content.cards.filter(c => briefCardVisible(c, settings?.contentPreferences ?? defaultBriefPreferences, settings?.topics ?? {})) } };
    }
    return { id: row.id, localDate: row.localDate, timeZone: row.timeZone, kind: row.slotId, label: row.slotLabel,
      scheduledAt: row.scheduledAt.toISOString(), createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
      status: row.status, content: row.status === 'completed' ? row.content : null, errorCode: row.errorCode,
      inputCutoff: row.input?.cutoff ?? null, inputTruncated: row.input?.truncated ?? false,
      sources: row.status === 'completed' ? (row.input?.sources ?? []).map(({ text: _, ...source }) => source) : [] };
  }
  async list(userId: string, limit: number, cursor?: string, date?: string) {
    let before: { at: string; id: string } | undefined;
    if (cursor) {
      try { before = JSON.parse(Buffer.from(cursor, 'base64url').toString()); }
      catch { throw new ServiceError(400, 'invalid_cursor', 'Invalid page cursor'); }
      if (!before || !Number.isFinite(Date.parse(before.at)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(before.id)) throw new ServiceError(400, 'invalid_cursor', 'Invalid page cursor');
    }
    const rows = await this.db.select().from(todayBriefs).where(and(eq(todayBriefs.userId, userId), ne(todayBriefs.status, 'deleted'),
      date ? eq(todayBriefs.localDate, date) : undefined,
      before ? or(lt(todayBriefs.scheduledAt, new Date(before.at)), and(eq(todayBriefs.scheduledAt, new Date(before.at)), lt(todayBriefs.id, before.id))) : undefined))
      .orderBy(desc(todayBriefs.scheduledAt), desc(todayBriefs.id)).limit(limit + 1);
    const selected = rows.slice(0, limit); const last = selected.at(-1);
    return { briefs: await Promise.all(selected.map(row => this.view(row))), nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ at: last.scheduledAt.toISOString(), id: last.id })).toString('base64url') : null };
  }
  async delete(userId: string, id: string) {
    await this.owned(userId, id);
    await this.db.update(todayBriefs).set({ status: 'deleted', content: null, input: null, leaseToken: null, leaseUntil: null }).where(and(eq(todayBriefs.id, id), eq(todayBriefs.userId, userId)));
  }
}
