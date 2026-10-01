import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultEchoSchedule, nextEchoOccurrence, parseEchoSchedule } from '../src/echo/schedule.js';

test('Echo schedules require an explicit opt-in and valid days, times and time zone', () => {
  const value = defaultEchoSchedule();
  assert.equal(value.enabled, false); assert.equal(nextEchoOccurrence(value, 'reminderTime', new Date()), null);
  assert.deepEqual(parseEchoSchedule(value), value);
  for (const patch of [{ weekdays: [] }, { weekdays: [1, 1] }, { weekdays: [0] }, { weekdays: [8] }, { reminderTime: '9:00' }, { stopTime: '08:59' }, { stopTime: '09:00' }, { timeZone: 'Invalid/Zone' }, { timeZone: '+09:00' }, { enabled: 'yes' }, { autoStart: true }]) {
    assert.throws(() => parseEchoSchedule({ ...value, ...patch }));
  }
});
test('weekday reminders and stop deadlines use the chosen time zone and skip weekends', () => {
  const value = { ...defaultEchoSchedule(), enabled: true, timeZone: 'Asia/Shanghai' };
  assert.equal(nextEchoOccurrence(value, 'reminderTime', new Date('2026-10-01T00:59:59Z'))?.toISOString(), '2026-10-01T01:00:00.000Z');
  assert.equal(nextEchoOccurrence(value, 'stopTime', new Date('2026-10-01T01:15:00Z'))?.toISOString(), '2026-10-01T10:00:00.000Z');
  assert.equal(nextEchoOccurrence(value, 'reminderTime', new Date('2026-10-02T02:00:00Z'))?.toISOString(), '2026-10-05T01:00:00.000Z');
  assert.equal(nextEchoOccurrence({ ...value, autoStop: false }, 'stopTime', new Date()), null);
});
test('DST gaps shift forward, repeated times occur once, and half-hour offsets remain exact', () => {
  const value = { ...defaultEchoSchedule(), enabled: true, weekdays: [7], reminderTime: '02:30', timeZone: 'America/New_York' };
  assert.equal(nextEchoOccurrence(value, 'reminderTime', new Date('2026-03-08T05:00:00Z'))?.toISOString(), '2026-03-08T07:30:00.000Z');
  const repeated = { ...value, reminderTime: '01:30' };
  assert.equal(nextEchoOccurrence(repeated, 'reminderTime', new Date('2026-11-01T04:00:00Z'))?.toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(nextEchoOccurrence(repeated, 'reminderTime', new Date('2026-11-01T05:45:00Z'))?.toISOString(), '2026-11-08T06:30:00.000Z');
  assert.equal(nextEchoOccurrence({ ...value, timeZone: 'Asia/Kolkata', reminderTime: '09:00' }, 'reminderTime', new Date('2026-10-04T00:00:00Z'))?.toISOString(), '2026-10-04T03:30:00.000Z');
});
