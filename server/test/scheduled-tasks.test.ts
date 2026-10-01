import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTaskOccurrence, parseTaskSchedule } from '../src/scheduling/contract.js';
import { scheduledTaskToolRegistry } from '../src/tools/scheduled-task-tools.js';

const weekly = { frequency: 'weekly', timeZone: 'Asia/Shanghai', runAt: null, time: '09:00', weekdays: [1, 2, 3, 4, 5] };
test('scheduled tasks validate once, daily and weekly without ambiguous clocks', () => {
  for (const patch of [{ weekdays: [] }, { weekdays: [1, 1] }, { time: '9:00' }, { timeZone: 'bad' }, { runAt: '2027-01-01' }, { frequency: 'hourly' }, { weekdays: [0] }, { unknown: true }])
    assert.throws(() => parseTaskSchedule({ ...weekly, ...patch }));
  const once = { frequency: 'once', timeZone: 'UTC', runAt: '2027-01-01T09:00:00+08:00', time: null, weekdays: [] };
  assert.equal(parseTaskSchedule(once).runAt, '2027-01-01T01:00:00.000Z');
  assert.throws(() => parseTaskSchedule({ ...once, runAt: '2027-02-30T09:00:00Z' }));
  assert.equal(nextTaskOccurrence(parseTaskSchedule(once), new Date('2027-01-02')), null);
});
test('repeat calendar preserves selected zone, weekends and DST policy', () => {
  assert.equal(nextTaskOccurrence(parseTaskSchedule(weekly), new Date('2026-10-02T02:00Z'))?.toISOString(), '2026-10-05T01:00:00.000Z');
  const dst = parseTaskSchedule({ ...weekly, timeZone: 'America/New_York', weekdays: [7], time: '02:30' });
  assert.equal(nextTaskOccurrence(dst, new Date('2026-03-08T05:00Z'))?.toISOString(), '2026-03-08T07:30:00.000Z');
  dst.time = '01:30';
  assert.equal(nextTaskOccurrence(dst, new Date('2026-11-01T05:45Z'))?.toISOString(), '2026-11-08T06:30:00.000Z');
});
test('chat scheduling validates the full goal and carries the stable invocation identity', async () => {
  const tool = scheduledTaskToolRegistry(async (user, invocation, input) => { assert.equal(user, 'owner'); assert.equal(invocation, 'stable'); return input; }).get('instant_schedule_task', 1);
  assert.equal(tool.retry, 'transactional');
  assert.throws(() => tool.validate({ title: 'News', goal: 'News', schedule: weekly, userId: 'other' }));
  const result = await tool.execute(tool.validate({ title: ' News ', goal: 'Find current news', schedule: weekly }), { userId: 'owner', invocationId: 'stable', signal: new AbortController().signal });
  assert.equal(result.ok, true);
});
