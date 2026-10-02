import type { EchoLocationContext } from '../listening/location.js';
import type { BriefGuidance, BriefResolvedAction, BriefType } from './content.js';
export interface BriefSlot { id: string; label: string; hour: number; enabled: boolean }
export const defaultBriefSlots: BriefSlot[] = [
  { id: 'early', label: 'Early Brief', hour: 6, enabled: false },
  { id: 'morning', label: 'Morning Brief', hour: 8, enabled: true },
  { id: 'midday', label: 'Midday Brief', hour: 13, enabled: true },
  { id: 'evening', label: 'Evening Brief', hour: 20, enabled: true },
];
export interface BriefSource {
  id: string; kind: 'message' | 'transcript' | 'batch' | 'task'; recordId: string;
  title: string; occurredAt: string; occurredLocalDate?: string; version: string; text: string;
  location?: EchoLocationContext;
}
export interface BriefInput {
  localDate: string; timeZone: string; locale: string; kind: string; label: string;
  cutoff: string; sources: BriefSource[]; truncated: boolean;
  profile: { displayName: string; location: BriefLocation | null };
  guidance?: BriefGuidance;
}
export interface BriefLocation { city: string; country: string; capturedAt: string; source?: 'device' | 'manual' }
export function currentBriefLocation(location: BriefLocation | null, now: Date): BriefLocation | null {
  if (!location) return null;
  return location.source === 'manual' || now.getTime() - Date.parse(location.capturedAt) <= 24 * 3600000 ? location : null;
}
export interface BriefLink { title: string; url: string }
export interface BriefCard {
  id?: string; type?: BriefType; contextIds?: string[]; topicKey?: string; expiresAt?: string;
  action?: BriefResolvedAction | null;
  eyebrow: string; title: string; body: string; bullets: string[]; sourceIds: string[];
  style: 'focus' | 'plan' | 'reflection' | 'discovery'; links: BriefLink[];
}
export interface BriefContent { schemaVersion?: number; generatedAt?: string; title: string; summary: string; cards: BriefCard[] }
export const briefConfigVersion = 'today.v5';

export function localClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}
export function dueSlot(slots: BriefSlot[], hour: number): BriefSlot | undefined {
  return slots.filter(s => s.enabled && s.hour <= hour).sort((a, b) => b.hour - a.hour || a.id.localeCompare(b.id))[0];
}

export { todayInstructions as briefInstructions } from '../prompts/today.js';

export function parseBriefContent(text: string, sources: BriefSource[], searched = false): BriefContent {
  const raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const str = (v: unknown, max: number, empty = false): string => {
    if (typeof v !== 'string' || (!empty && !v.trim()) || Array.from(v).length > max) throw new Error('invalid_brief_output');
    return v.trim();
  };
  if (!object(raw) || !Array.isArray(raw.cards) || raw.cards.length > 5) throw new Error('invalid_brief_output');
  const ids = new Set(sources.map(s => s.id));
  return { title: str(raw.title, 100), summary: str(raw.summary, 600), cards: raw.cards.map((card: unknown) => {
    if (!object(card)) throw new Error('invalid_brief_output');
    // Agents may omit empty lists. Normalize absence; malformed values and evidence
    // still fail validation, and the persisted/client shape always contains arrays.
    const bullets = card.bullets === undefined ? [] : card.bullets;
    const sourceIds = card.sourceIds === undefined ? [] : card.sourceIds;
    const rawLinks = card.links === undefined ? [] : card.links;
    if (!Array.isArray(bullets) || bullets.length > 5 || !Array.isArray(sourceIds)
      || sourceIds.length > 10 || sourceIds.some(id => typeof id !== 'string' || !ids.has(id))
      || !['focus', 'plan', 'reflection', 'discovery'].includes(String(card.style)) || !Array.isArray(rawLinks) || rawLinks.length > 5) throw new Error('invalid_brief_output');
    const links = rawLinks.map((link: unknown) => {
      if (!searched || !object(link)) throw new Error('invalid_brief_output');
      const url = str(link.url, 2000); const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid_brief_output');
      return { title: str(link.title, 120), url };
    });
    if (!sourceIds.length && !links.length) throw new Error('invalid_brief_output');
    return { eyebrow: str(card.eyebrow, 60), title: str(card.title, 100), body: str(card.body, 1200),
      style: card.style as BriefCard['style'], links, bullets: bullets.map(v => str(v, 240)), sourceIds: [...new Set(sourceIds as string[])] };
  }) };
}
