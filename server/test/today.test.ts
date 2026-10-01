import assert from 'node:assert/strict';
import test from 'node:test';
import { currentBriefLocation, defaultBriefSlots, dueSlot, localClock, parseBriefContent, type BriefSource } from '../src/today/contract.js';
import { validateTodaySettings } from '../src/db/repositories/today-repository.js';

test('brief schedule uses the stored local date across midnight, DST and non-hour offsets', () => {
  assert.deepEqual(localClock(new Date('2026-09-27T17:00:00Z'), 'Asia/Shanghai'), { date: '2026-09-28', hour: 1 });
  assert.deepEqual(localClock(new Date('2026-09-28T03:00:00Z'), 'Asia/Kolkata'), { date: '2026-09-28', hour: 8 });
  assert.equal(dueSlot(defaultBriefSlots, 7), undefined);
  assert.equal(dueSlot(defaultBriefSlots, 8)?.id, 'morning');
  assert.equal(dueSlot(defaultBriefSlots, 13)?.id, 'midday');
  assert.equal(dueSlot(defaultBriefSlots, 23)?.id, 'evening');
  assert.deepEqual(localClock(new Date('2026-11-01T05:30:00Z'), 'America/New_York'), localClock(new Date('2026-11-01T06:30:00Z'), 'America/New_York'));
});
test('settings reject invalid zones, duplicate slots and excessive location data', () => {
  const base = { timeZone: 'Asia/Shanghai', locale: 'zh-Hans', displayName: 'CJ' };
  assert.deepEqual(validateTodaySettings(base), { ...base, slots: undefined });
  assert.throws(() => validateTodaySettings({ ...base, timeZone: 'Moon/Base' }));
  assert.throws(() => validateTodaySettings({ ...base, slots: [defaultBriefSlots[0], defaultBriefSlots[0]] }));
  assert.throws(() => validateTodaySettings({ ...base, slots: [defaultBriefSlots[1], { ...defaultBriefSlots[2], hour: 8 }] }));
  assert.throws(() => validateTodaySettings({ ...base, location: { city: 'Shanghai', country: 'China', capturedAt: new Date().toISOString(), latitude: 31 } }));
  assert.equal(validateTodaySettings({ ...base, location: null }).location, null);
});
test('brief output accepts real evidence and safe style choices, rejects invented references and unsearched links', () => {
  const source: BriefSource = { id: 'message:abc', kind: 'message', recordId: 'abc', title: 'Message', occurredAt: new Date().toISOString(), version: 'v1', text: 'Meet tomorrow' };
  const card = { style: 'plan', eyebrow: 'Follow-up', title: 'Prepare the meeting', body: 'Review the note.', bullets: [], sourceIds: [source.id], links: [] };
  const content = { title: 'Your morning', summary: 'One thing to consider.', cards: [card] };
  assert.deepEqual(parseBriefContent(JSON.stringify(content), [source]), content);
  assert.deepEqual(parseBriefContent(JSON.stringify({ ...content, cards: [{ ...card, bullets: undefined, links: undefined }] }), [source]), content);
  assert.throws(() => parseBriefContent(JSON.stringify({ ...content, cards: [{ ...card, bullets: null }] }), [source]));
  assert.throws(() => parseBriefContent(JSON.stringify({ ...content, cards: [{ ...card, sourceIds: ['message:other-user'] }] }), [source]));
  assert.throws(() => parseBriefContent(JSON.stringify({ ...content, cards: [{ ...card, style: '<html>' }] }), [source]));
  const web = { ...card, sourceIds: [], links: [{ title: 'Source', url: 'https://example.org/news' }] };
  assert.throws(() => parseBriefContent(JSON.stringify({ ...content, cards: [web] }), [], false));
  assert.equal(parseBriefContent(JSON.stringify({ ...content, cards: [web] }), [], true).cards[0]?.links.length, 1);
  assert.throws(() => parseBriefContent(JSON.stringify({ ...content, cards: [{ ...web, links: [{ title: 'Bad', url: 'javascript:alert(1)' }] }] }), [], true));
  assert.equal(parseBriefContent(JSON.stringify({ ...content, cards: [] }), []).cards.length, 0);
});


test('manual city survives expiry while device and legacy city snapshots expire', () => {
  const now = new Date('2026-09-28T04:00:00Z');
  const old = { city: 'Shanghai', country: 'China', capturedAt: '2026-09-25T04:00:00Z' };
  const manual = { ...old, source: 'manual' as const };
  assert.equal(currentBriefLocation(old, now), null);
  assert.equal(currentBriefLocation({ ...old, source: 'device' }, now), null);
  assert.deepEqual(currentBriefLocation(manual, now), manual);
  assert.deepEqual(validateTodaySettings({ timeZone: 'Asia/Shanghai', locale: 'zh-Hans-CN', location: manual }).location, manual);
  assert.throws(() => validateTodaySettings({ timeZone: 'Asia/Shanghai', locale: 'zh-Hans', location: { ...old, source: 'guessed' } }));
  const recent = { ...old, capturedAt: now.toISOString(), source: 'device' as const };
  assert.deepEqual(currentBriefLocation(recent, now), recent);
});
