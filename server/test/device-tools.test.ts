import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deviceToolNames,
  deviceTools,
  isDeviceTool,
  selectDeviceTools,
  validateDeviceInput,
} from '../src/tools/device-tools.js';

const range = { start: '2026-09-29T00:00:00Z', end: '2026-09-30T00:00:00Z', time_zone: 'Asia/Shanghai' };

test('neutral device names and installed iOS aliases share strict input validation', () => {
  assert.equal(deviceToolNames.length, 7);
  const rangeTools = deviceToolNames.filter(name => name.endsWith('calendar_events') || name.endsWith('health_summary'));
  assert.equal(rangeTools.length, 4);
  for (const name of rangeTools) {
    const input = {
      ...range,
      ...(name.endsWith('calendar_events') ? { limit: 10 } : { metrics: ['steps', 'sleep'] }),
    };
    assert.equal(isDeviceTool(name), true);
    assert.deepEqual(validateDeviceInput(name, input), input);
    assert.throws(() => validateDeviceInput(name, { ...input, unexpected: true }), /fields/);
    assert.throws(() => validateDeviceInput(name, { ...input, end: range.start }), /positive/);
    assert.throws(() => validateDeviceInput(name, { ...input, time_zone: 'invalid/time_zone' }), /time zone/);
  }
  assert.throws(() => validateDeviceInput('android_shell', {}), /Unsupported/);
  assert.throws(() => validateDeviceInput('impo_list_calendar_events', { ...range, limit: 101 }), /limit/);
  assert.throws(
    () => validateDeviceInput('impo_get_health_summary', { ...range, metrics: ['steps', 'steps'] }),
    /distinct/,
  );
});

test('tool advertisement is exact to the attached device, preserving unrelated server tools', () => {
  const catalog = [...deviceTools, { name: 'instant_create_task' }, { type: 'web_search' }];
  const names = (capabilities: string[]) => selectDeviceTools(catalog, capabilities).map((tool) => tool.name);
  assert.deepEqual(names(['impo_list_calendar_events']), [
    'impo_list_calendar_events',
    'instant_create_task',
    undefined,
  ]);
  assert.deepEqual(names(['ios_get_health_summary']), [
    'ios_get_health_summary',
    'instant_create_task',
    undefined,
  ]);
  assert.deepEqual(names([]), ['instant_create_task', undefined]);
  assert.deepEqual(names(['invented_tool']), names([]));
  assert.ok(
    deviceTools
      .filter((tool) => tool.name.startsWith('impo_'))
      .every((tool) => !tool.description.includes('iPhone')),
  );
});
