import assert from 'node:assert/strict';
import test from 'node:test';
import { clientActionToolRegistry, validateClientAction } from '../src/tools/client-actions.js';
import { describeDeviceCapabilities, selectDeviceTools } from '../src/tools/device-tools.js';

test('actions stay on the attached capable device while cloud tools remain available', () => {
  const catalog = [...clientActionToolRegistry().functionDefinitions(), { name: 'composio_execute' }];
  assert.deepEqual(selectDeviceTools(catalog, []).map(tool => tool.name), ['composio_execute']);
  assert.deepEqual(selectDeviceTools(catalog, ['impo_navigate']).map(tool => tool.name), ['impo_navigate', 'composio_execute']);
  const [action] = describeDeviceCapabilities(['impo_navigate']);
  assert.equal(action!.execution, 'device');
  assert.equal(action!.interaction, 'tap');
});

test('actions accept bounded HTTPS and typed destinations, never arbitrary native commands', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'shortcuts://run-shortcut?name=x', 'https://user:secret@example.com', 'https://example.com/\npath', 'https://example.com\\@evil.test']) {
    assert.throws(() => validateClientAction('impo_open_link', { url }));
  }
  assert.deepEqual(validateClientAction('impo_open_link', { url: 'https://youtu.be/example' }), { url: 'https://youtu.be/example' });
  assert.throws(() => validateClientAction('impo_open_link', { url: 'https://example.com', scheme: 'tel' }));
  assert.deepEqual(validateClientAction('impo_navigate', { destination: ' Main St & 2nd ', mode: 'walking' }), { destination: 'Main St & 2nd', mode: 'walking' });
  assert.throws(() => validateClientAction('impo_navigate', { destination: 'Airport', mode: 'teleport' }));
  assert.throws(() => validateClientAction('impo_start_timer', { seconds: 60 }));
});

test('preparation produces a ready card, not a claim that a native action executed', async () => {
  const tool = clientActionToolRegistry().get('impo_open_link', 1);
  const result = await tool.execute({ url: 'https://example.com' }, { userId: 'user', invocationId: 'id', signal: new AbortController().signal });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.status, 'ready'); assert.equal(result.data.actionId, 'id');
  assert.equal(result.data.interaction, 'tap'); assert.equal(result.data.execution, 'device');
  assert.equal(tool.executionLocation, 'server', 'the server prepares; only the client can perform the handoff');
});
