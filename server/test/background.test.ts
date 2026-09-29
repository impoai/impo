import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundProvisioner } from '../src/background/provisioner.js';
import { createBackgroundActivities } from '../src/background/activities.js';
import { backgroundSteps } from '../src/background/registry.js';

test('provisioning discovers paginated and late users, retries uncertain starts and does not keep rescanning Temporal', async () => {
  const ids = Array.from({ length: 205 }, (_, i) => String(i).padStart(4, '0'));
  const calls: string[] = []; let failOnce = true;
  const users = { async exists() { return true; }, async list(after?: string, limit = 100) { return ids.filter(id => !after || id > after).slice(0, limit).map(id => ({ id })); } };
  const p = new BackgroundProvisioner(users, { async ensure(id) { calls.push(id); if (id === '0001' && failOnce) { failOnce = false; throw new Error('Unknown start result'); } } });
  const signal = new AbortController().signal;
  await p.scan(signal); assert.equal(calls.length, 205);
  await p.scan(signal); assert.equal(calls.length, 206); assert.equal(calls.at(-1), '0001');
  ids.unshift('-new'); await p.scan(signal); assert.equal(calls.at(-1), '-new'); assert.equal(calls.length, 207);
  const c = new AbortController(); c.abort(); await p.scan(c.signal); assert.equal(calls.length, 207);
});

test('the shipping registry is empty and never invokes an Agent or business function', async () => {
  assert.deepEqual(backgroundSteps, []);
  const activities = createBackgroundActivities({ async exists() { return true; }, async list() { return []; } });
  assert.deepEqual(await activities.planBackgroundTick({ userId: 'synthetic', tickId: 'synthetic/1', scheduledAt: 1 }), { userExists: true, steps: [] });
});
