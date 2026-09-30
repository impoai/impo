import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceTools, selectDeviceTools, validateDeviceInput } from '../src/tools/device-tools.js';

const rejects = (name: string, input: unknown) => assert.throws(() => validateDeviceInput(name, input), /./);

test('reminder and contact tools validate their inputs strictly', () => {
  assert.deepEqual(validateDeviceInput('impo_list_reminders', { status: 'incomplete', limit: 20 }), { status: 'incomplete', limit: 20 });
  validateDeviceInput('impo_list_reminders', { status: 'all', limit: 5, due_start: '2026-10-01T00:00:00-07:00', due_end: '2026-10-08T00:00:00-07:00', time_zone: 'America/Los_Angeles' });
  rejects('impo_list_reminders', { status: 'open', limit: 5 });
  rejects('impo_list_reminders', { status: 'all', limit: 0 });
  rejects('impo_list_reminders', { status: 'all', limit: 5, due_start: '2026-10-01T00:00:00Z' });
  rejects('impo_list_reminders', { status: 'all', limit: 5, due_start: '2026-10-01T00:00:00Z', due_end: '2027-12-01T00:00:00Z', time_zone: 'UTC' });

  validateDeviceInput('impo_create_reminder', { title: 'Call Mom' });
  validateDeviceInput('impo_create_reminder', { title: 'Pay rent', notes: 'Transfer', due: '2026-10-01T09:00:00+08:00', time_zone: 'Asia/Shanghai', list: 'Home' });
  rejects('impo_create_reminder', { title: '  ' });
  rejects('impo_create_reminder', { title: 'x'.repeat(301) });
  rejects('impo_create_reminder', { title: 'Due without zone', due: '2026-10-01T09:00:00Z' });
  rejects('impo_create_reminder', { title: 'Extra', priority: 1 });

  validateDeviceInput('impo_search_contacts', { query: 'Taylor', limit: 5 });
  rejects('impo_search_contacts', { query: '', limit: 5 });
  rejects('impo_search_contacts', { query: 'Taylor', limit: 26 });
  rejects('impo_search_contacts', { query: 'Taylor' });
});

test('new device tools are advertised only when the attached device enabled them', () => {
  const names = deviceTools.map(tool => tool.name);
  for (const name of ['impo_list_reminders', 'impo_create_reminder', 'impo_search_contacts']) assert.ok(names.includes(name));
  const selected = selectDeviceTools(deviceTools, ['impo_search_contacts']).map(tool => tool.name);
  assert.deepEqual(selected, ['impo_search_contacts']);
});
