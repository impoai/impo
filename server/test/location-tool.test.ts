import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceToolNames, deviceTools, selectDeviceTools, validateDeviceInput } from '../src/tools/device-tools.js';
import { appPrompt } from '../src/prompts/app.js';

test('current location is a no-argument device tool offered only by a device that registered it', () => {
  assert.ok(deviceToolNames.includes('impo_get_current_location'));
  assert.deepEqual(validateDeviceInput('impo_get_current_location', {}), {});
  assert.throws(() => validateDeviceInput('impo_get_current_location', { precise: true }), /schema/);
  const tool = deviceTools.find(candidate => candidate.name === 'impo_get_current_location')!;
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /approximate city/);
  assert.deepEqual(selectDeviceTools(deviceTools, ['impo_search_contacts']).map(t => t.name).filter(n => n === 'impo_get_current_location'), []);
  assert.deepEqual(selectDeviceTools(deviceTools, ['impo_get_current_location']).filter(t => t.name.startsWith('impo_') || t.name.startsWith('ios_')).map(t => t.name), ['impo_get_current_location']);
});

test('the main prompt treats the context city as approximate and asks for the precise location first', () => {
  assert.match(appPrompt, /approximate city and may be stale/);
  assert.match(appPrompt, /call impo_get_current_location first/);
  assert.match(appPrompt, /Never infer a city from the time zone/);
});
