import { createHash } from 'node:crypto';
import type { BriefCard, BriefContent, BriefInput } from './contract.js';

export const briefTypes = ['suggestion', 'recap', 'connect', 'feature', 'occasion'] as const;
export type BriefType = typeof briefTypes[number];
export interface BriefPreferences {
  categories: Record<BriefType, boolean>;
  occasionCalendar: 'none' | 'gregorian' | 'chinese';
}
export const defaultBriefPreferences: BriefPreferences = {
  categories: { suggestion: true, recap: true, connect: true, feature: true, occasion: true }, occasionCalendar: 'none',
};
export interface BriefTopic { shownAt?: string; dismissed?: boolean; snoozedUntil?: string }
export type BriefTopics = Record<string, BriefTopic>;
export interface BriefContext {
  id: string; kind: 'connection' | 'feature' | 'occasion'; topicKey: string;
  title: string; detail: string; capturedAt: string; expiresAt: string;
  target: string; state?: string; url?: string;
}
export interface BriefAction {
  id: string; kind: 'chat_draft' | 'connect' | 'open_feature' | 'open_resource'; target: string;
  contextIds: string[];
}
export interface BriefResolvedAction extends BriefAction { label: string; prompt: string | null }
export interface BriefGuidance {
  version: 2; editionId: string; preferences: BriefPreferences;
  contexts: BriefContext[]; actions: BriefAction[]; blockedTopics: string[];
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (): never => { throw new Error('invalid_brief_output'); };
const str = (v: unknown, max: number): string => typeof v === 'string' && v.trim() && Array.from(v).length <= max ? v.trim() : fail();
const strings = (v: unknown, max: number, length: number): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) return fail();
  return [...new Set(v.map(s => str(s, length)))];
};
export function parseBriefPreferences(raw: unknown): BriefPreferences {
  if (!object(raw) || Object.keys(raw).some(k => !['categories', 'occasionCalendar'].includes(k))
    || !object(raw.categories) || Object.keys(raw.categories).length !== briefTypes.length
    || briefTypes.some(k => typeof (raw.categories as Record<string, unknown>)[k] !== 'boolean')
    || !['none', 'gregorian', 'chinese'].includes(String(raw.occasionCalendar))) throw new Error('invalid_brief_preferences');
  return { categories: Object.fromEntries(briefTypes.map(k => [k, (raw.categories as Record<string, boolean>)[k]])) as BriefPreferences['categories'], occasionCalendar: raw.occasionCalendar as BriefPreferences['occasionCalendar'] };
}
export function topicBlocked(topic: BriefTopic | undefined, now: Date, cooldownMs: number): boolean {
  return Boolean(topic && (topic.dismissed || Date.parse(topic.snoozedUntil ?? '') > now.getTime()
    || Date.parse(topic.shownAt ?? '') + cooldownMs > now.getTime()));
}
export function topicCooldown(key: string): number { return /^(connection|feature):/.test(key) ? 7 * 86400_000 : key.startsWith('occasion:') ? 3 * 86400_000 : 86400_000; }
export function cardTopic(card: Pick<BriefCard, 'sourceIds'> & { contextIds?: string[] }, contexts: BriefContext[]): string {
  const context = contexts.find(c => card.contextIds?.includes(c.id));
  return context?.topicKey ?? `source:${[...card.sourceIds].sort()[0] ?? 'unknown'}`;
}

export function briefCardVisible(card: BriefCard, preferences: BriefPreferences, topics: BriefTopics, now = new Date()): boolean {
  return (!card.type || preferences.categories[card.type]) && !topicBlocked(topics[card.topicKey ?? ''], now, 0);
}

/** V2 never treats arbitrary web URLs or model-written destinations as authority. */
export function parseBriefContentV2(text: string, input: BriefInput): BriefContent {
  const guidance = input.guidance;
  if (!guidance) return fail();
  const raw: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!object(raw) || !Array.isArray(raw.cards) || raw.cards.length > 5) return fail();
  const sourceIds = new Set(input.sources.map(s => s.id));
  const styles = { suggestion: 'plan', recap: 'reflection', connect: 'discovery', feature: 'discovery', occasion: 'focus' } as const;
  const cards = raw.cards.map((value: unknown, index): BriefCard => {
    if (!object(value) || !briefTypes.includes(value.type as BriefType)) return fail();
    const type = value.type as BriefType;
    if (!guidance.preferences.categories[type]) return fail();
    const refs = strings(value.sourceIds, 10, 200); const contextIds = strings(value.contextIds, 10, 200);
    if (refs.length + contextIds.length > 10 || refs.some(id => !sourceIds.has(id))) return fail();
    const contexts = contextIds.map(id => guidance.contexts.find(c => c.id === id) ?? fail());
    if (contexts.some(c => Date.parse(c.expiresAt) <= Date.parse(input.cutoff))) return fail();
    if (!refs.length && !contexts.length) return fail();
    if (['connect', 'feature', 'occasion'].includes(type) && contexts.length !== 1) return fail();
    if (type === 'recap' && !refs.length) return fail();
    if (type === 'connect' && (!contexts.length || contexts.some(c => c.kind !== 'connection' || !['disconnected', 'expired'].includes(c.state ?? '')))) return fail();
    if (type === 'feature' && (!contexts.length || contexts.some(c => c.kind !== 'feature'))) return fail();
    if (type === 'occasion' && (!contexts.length || contexts.some(c => c.kind !== 'occasion'))) return fail();
    if (type === 'suggestion' && contexts.some(c => c.kind !== 'connection' || c.state !== 'connected')) return fail();
    const topicKey = cardTopic({ sourceIds: refs, contextIds }, guidance.contexts);
    if (guidance.blockedTopics.includes(topicKey)) return fail();
    const rawLinks = value.links ?? [];
    if (!Array.isArray(rawLinks) || rawLinks.length > 5) return fail();
    const links = rawLinks.map((v: unknown) => {
      if (!object(v)) return fail();
      const url = str(v.url, 2000);
      if (!contexts.some(c => c.url === url) || new URL(url).protocol !== 'https:') return fail();
      return { title: str(v.title, 120), url };
    });
    let action: BriefResolvedAction | null = null;
    if (value.action != null) {
      if (!object(value.action) || Object.keys(value.action).some(k => !['id', 'label', 'prompt'].includes(k))) return fail();
      const actionId = value.action.id;
      const eligible = guidance.actions.find(a => a.id === actionId);
      if (!eligible || eligible.contextIds.some(id => !contextIds.includes(id))) return fail();
      if ((type === 'connect' && eligible.kind !== 'connect') || (type === 'feature' && eligible.kind !== 'open_feature')
        || type === 'occasion' || (['suggestion', 'recap'].includes(type) && !['chat_draft', 'open_resource'].includes(eligible.kind))) return fail();
      if (eligible.kind === 'open_resource' && !refs.includes(`task:${eligible.target}`)) return fail();
      if (!eligible.contextIds.length && !refs.length) return fail();
      const prompt = eligible.kind === 'chat_draft' ? str(value.action.prompt, 1000) : null;
      if (eligible.kind !== 'chat_draft' && value.action.prompt != null) return fail();
      action = { ...eligible, label: str(value.action.label, 60), prompt };
    }
    if (['connect', 'feature'].includes(type) && !action) return fail();
    return { id: createHash('sha256').update(`${guidance.editionId}/${index}/${topicKey}`).digest('hex').slice(0, 24),
      type, topicKey, contextIds, action, expiresAt: contexts.map(c => c.expiresAt).sort()[0] ?? new Date(Date.parse(input.cutoff) + 86400_000).toISOString(),
      style: styles[type], eyebrow: str(value.eyebrow, 60), title: str(value.title, 100), body: str(value.body, 1200),
      bullets: strings(value.bullets, 5, 240), sourceIds: refs, links };
  });
  if (cards.filter(c => c.type === 'recap').length > 1 || cards.filter(c => ['connect', 'feature'].includes(c.type!)).length > 1
    || new Set(cards.map(c => c.topicKey)).size !== cards.length) return fail();
  return { schemaVersion: 2, generatedAt: input.cutoff, title: str(raw.title, 100), summary: str(raw.summary, 600), cards };
}
