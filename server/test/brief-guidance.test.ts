import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBriefGuidance, occasionContexts } from '../src/today/context.js';
import { defaultBriefPreferences, briefCardVisible, parseBriefContentV2, parseBriefPreferences, topicBlocked, topicCooldown } from '../src/today/content.js';
import type { BriefInput } from '../src/today/contract.js';

const input: BriefInput = { localDate: '2026-09-24', timeZone: 'Asia/Shanghai', locale: 'en', kind: 'evening', label: 'Evening', cutoff: '2026-09-24T12:00:00Z', sources: [
  { id: 'message:one', kind: 'message', recordId: 'one', title: 'Your message', occurredAt: '2026-09-24T10:00:00Z', version: 'v1', text: 'I need an outline for a talk about post-training tomorrow.' },
], truncated: false, profile: { displayName: 'Test', location: null } };
const usage = { scheduledTasks: false, echoSchedule: false, echoSpeakers: false };
const card = { type: 'suggestion', eyebrow: 'Tomorrow', title: 'Outline your talk', body: 'Choose three points to help prepare your post-training talk.', bullets: [], sourceIds: ['message:one'], contextIds: [], links: [], action: { id: 'chat', label: 'Draft an outline', prompt: 'Help me outline my talk about post-training tomorrow.' } };
const serialize = (cards: unknown[]) => JSON.stringify({ title: 'Make tomorrow easier', summary: 'One small step to prepare.', cards });

test('Brief v2 resolves only known actions and evidence, derives style and stable identity', async () => {
  const guidance = await buildBriefGuidance('alice', input, 'edition', defaultBriefPreferences, {}, 2, usage, {});
  const context = { ...input, guidance };
  const parsed = parseBriefContentV2(serialize([card]), context);
  assert.equal(briefCardVisible(parsed.cards[0]!, defaultBriefPreferences, {}), true);
  assert.equal(briefCardVisible(parsed.cards[0]!, { ...defaultBriefPreferences, categories: { ...defaultBriefPreferences.categories, suggestion: false } }, {}), false);
  assert.equal(briefCardVisible(parsed.cards[0]!, defaultBriefPreferences, { [parsed.cards[0]!.topicKey!]: { dismissed: true } }), false);
  assert.equal(parsed.schemaVersion, 2); assert.equal(parsed.cards[0]!.style, 'plan');
  assert.equal(parsed.cards[0]!.action?.kind, 'chat_draft');
  assert.equal(parsed.cards[0]!.id, parseBriefContentV2(serialize([card]), context).cards[0]!.id);
  assert.throws(() => parseBriefContentV2(serialize([{ ...card, sourceIds: ['message:bob'] }]), context));
  assert.throws(() => parseBriefContentV2(serialize([{ ...card, action: { ...card.action, id: 'send-email' } }]), context));
  assert.throws(() => parseBriefContentV2(serialize([{ ...card, action: { ...card.action, target: 'https://evil.example' } }]), context));
  assert.throws(() => parseBriefContentV2(serialize([{ ...card, links: [{ title: 'Invented', url: 'https://example.org' }] }]), context));
  assert.throws(() => parseBriefContentV2(serialize([card, { ...card, title: 'Reworded' }]), context));
  assert.throws(() => parseBriefContentV2(serialize([{ ...card, type: 'connect' }]), context));
  assert.throws(() => parseBriefContentV2(serialize([{ ...card, type: 'feature' }]), context));
  assert.throws(() => parseBriefContentV2(serialize([{ ...card, type: 'occasion', action: null }]), context));
});

test('Brief connection opportunities respect authoritative state and omit provider failures', async () => {
  const provider = { connectors: {
    list: async () => ['gmail', 'googlecalendar', 'outlook'].map(toolkit => ({ toolkit, name: toolkit, status: (toolkit === 'gmail' ? 'connected' : 'disconnected') as 'connected' | 'disconnected', featured: true })),
    getStatus: async (_: string, toolkit: string) => { if (toolkit === 'outlook') throw new Error('timeout'); return { status: 'disconnected' as const }; },
    refresh: async () => ({ status: 'connected' as const }),
  } };
  const guidance = await buildBriefGuidance('alice', input, 'edition', defaultBriefPreferences, {}, 2, usage, provider);
  assert.deepEqual(guidance.contexts.map(c => c.id), ['connection:gmail:connected', 'connection:googlecalendar:disconnected']);
  assert.ok(!guidance.actions.some(a => a.id === 'connect:gmail'));
  assert.ok(guidance.actions.some(a => a.id === 'review:gmail'));
  assert.throws(() => parseBriefContentV2(serialize([{ ...card, type: 'connect', sourceIds: [], contextIds: ['connection:gmail:connected'] }]), { ...input, guidance }));
  const valid = { ...card, type: 'connect', sourceIds: [], contextIds: ['connection:googlecalendar:disconnected'], action: { id: 'connect:googlecalendar', label: 'Connect Calendar', prompt: null } };
  assert.equal(parseBriefContentV2(serialize([valid]), { ...input, guidance }).cards[0]!.action?.target, 'googlecalendar');
  assert.equal((await buildBriefGuidance('alice', input, 'edition', defaultBriefPreferences, {}, 1, usage, provider)).contexts.length, 0);
});

test('Brief preferences, adoption and account cooldowns suppress candidates across card types', async () => {
  assert.throws(() => parseBriefPreferences({ ...defaultBriefPreferences, categories: { suggestion: true } }));
  assert.throws(() => parseBriefPreferences({ ...defaultBriefPreferences, occasionCalendar: 'inferred' }));
  const topics = { 'feature:scheduled-tasks': { dismissed: true }, 'source:message:one': { snoozedUntil: '2026-10-01T00:00:00Z' } };
  const guidance = await buildBriefGuidance('alice', input, 'edition', defaultBriefPreferences, topics, 2, { ...usage, echoSpeakers: true }, { schedulingEnabled: true });
  assert.deepEqual(guidance.contexts.map(c => c.id), ['feature:echo-schedule']);
  assert.throws(() => parseBriefContentV2(serialize([card]), { ...input, guidance }));
  assert.throws(() => parseBriefContentV2(serialize([card]), { ...input, guidance: { ...guidance, blockedTopics: [], preferences: { ...defaultBriefPreferences, categories: { ...defaultBriefPreferences.categories, suggestion: false } } } }));
  assert.equal(topicBlocked({ shownAt: input.cutoff }, new Date('2026-09-25T12:00:00Z'), topicCooldown('feature:echo-schedule')), true);
  assert.equal(topicBlocked({ dismissed: true }, new Date('2030-01-01'), 0), true);
});

test('Occasions require an explicit calendar and verified dates, without inferring them from locale', () => {
  assert.deepEqual(occasionContexts(input, defaultBriefPreferences), []);
  const preferences = { ...defaultBriefPreferences, occasionCalendar: 'chinese' as const };
  const [occasion] = occasionContexts(input, preferences);
  assert.equal(occasionContexts({ ...input, timeZone: 'Asia/Kolkata' }, preferences)[0]!.expiresAt, '2026-09-25T18:30:00.000Z');
  assert.equal(occasion!.id, 'occasion:mid-autumn:2026-09-25'); assert.match(occasion!.detail, /tomorrow/);
  assert.deepEqual(occasionContexts({ ...input, localDate: '2026-09-26', cutoff: '2026-09-26T00:00:00Z' }, preferences), []);
  assert.equal(occasionContexts({ ...input, localDate: '2027-09-15', cutoff: '2027-09-15T00:00:00Z' }, preferences)[0]!.id, 'occasion:mid-autumn:2027-09-15');
  assert.deepEqual(occasionContexts({ ...input, localDate: '2028-09-15', cutoff: '2028-09-15T00:00:00Z' }, preferences), []);
});
