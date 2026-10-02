import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { users, runtimeSubmissions, sessionBindings, agentConfigVersions } from '../src/db/schema.js';
import { ProfileRepository } from '../src/db/repositories/profile-repository.js';
import { RuntimeRepository } from '../src/db/repositories/runtime-repository.js';
import { ScheduledTaskRepository } from '../src/db/repositories/scheduled-task-repository.js';
import { TodayRepository } from '../src/db/repositories/today-repository.js';
import { createApiServer } from '../src/http/api-server.js';
import { modelModes } from '../src/model-modes.js';

const database = createDatabase(process.env.DATABASE_URL!);
after(() => database.close());
const profiles = new ProfileRepository(database.db);
const options = { provider: 'rebyte' as const, modelModes, agentConfig: { provider: 'rebyte', model: 'legacy-model', tools: [], useSavedAgent: true }, taskAgentConfig: { provider: 'rebyte', model: 'legacy-model', tools: [], useSavedAgent: false } };
const runtime = new RuntimeRepository(database.db, options);
async function owner() {
  const [user] = await database.db.insert(users).values({ authProvider: 'mode-test', authSubject: randomUUID(), name: 'Model mode test' }).returning();
  return user!.id;
}
async function config(submissionId: string) {
  const [row] = await database.db.select({ binding: sessionBindings.id, config: agentConfigVersions.config }).from(runtimeSubmissions)
    .innerJoin(sessionBindings, eq(sessionBindings.id, runtimeSubmissions.bindingId))
    .innerJoin(agentConfigVersions, eq(agentConfigVersions.id, sessionBindings.agentConfigVersionId)).where(eq(runtimeSubmissions.id, submissionId));
  return row!;
}
test('profile mode is authenticated, account-owned, validated and preserved by legacy patches', async () => {
  const server = createApiServer(runtime, { profiles });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/profile`;
  const request = (token: string, body?: unknown) => fetch(url, { method: body ? 'PATCH' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Impo-Model-Catalog': '2' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await request('wrong', { mode: 'Power' })).status, 401);
    assert.equal((await (await request('instant-dev-alice')).json()).mode, 'Balanced');
    const legacy = await fetch(url, { headers: { Authorization: 'Bearer instant-dev-alice' } });
    assert.equal((await legacy.json()).mode, undefined, 'older clients must not label the new GPT route as Sol');
    for (const mode of ['power', 'gpt-6-sol', '', null, 1]) assert.equal((await request('instant-dev-alice', { mode })).status, 400);
    assert.equal((await request('instant-dev-alice', { mode: 'Power', userId: randomUUID() })).status, 400);
    assert.equal((await (await request('instant-dev-alice', { mode: 'Power' })).json()).mode, 'Power');
    assert.equal((await (await request('instant-dev-alice', { assistantName: 'Robin' })).json()).mode, 'Power');
    assert.equal((await (await request('instant-dev-bob')).json()).mode, 'Balanced');
    assert.equal((await (await request('instant-dev-alice')).json()).mode, 'Power');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('mode switches preserve active work and rotate only the next idle chat session', async () => {
  const user = await owner();
  const command = { clientMessageId: randomUUID(), text: 'Hello' };
  const first = await runtime.acceptMessage(user, command);
  const before = await config(first.submissionId);
  assert.equal(before.config.model, modelModes.Balanced);
  await profiles.update(user, { mode: 'Power' });
  assert.deepEqual(await runtime.acceptMessage(user, command), first, 'accepted retries keep their original model');
  assert.equal((await config(first.submissionId)).config.model, modelModes.Balanced);
  await assert.rejects(runtime.acceptMessage(user, { clientMessageId: randomUUID(), text: 'Next' }), { code: 'config_upgrade_pending' });
  await database.db.update(runtimeSubmissions).set({ status: 'cancelled' }).where(eq(runtimeSubmissions.id, first.submissionId));
  const second = await runtime.acceptMessage(user, { clientMessageId: randomUUID(), text: 'Next' });
  const after = await config(second.submissionId);
  assert.equal(after.config.model, modelModes.Power); assert.notEqual(after.binding, before.binding);
  assert.equal((await config(first.submissionId)).config.model, modelModes.Balanced);
});
test('direct tasks, scheduled occurrences and new briefs share the account mode', async () => {
  const user = await owner();
  await profiles.update(user, { mode: 'Power' });
  const task = await runtime.createUserTask(user, { clientMessageId: randomUUID(), text: 'Research' });
  assert.equal((await config(task.submissionId)).config.model, modelModes.Power);
  let now = new Date('2027-01-01T08:00Z');
  const schedules = new ScheduledTaskRepository(database.db, options, () => now);
  const plan = await schedules.create(user, randomUUID(), { title: 'Research', goal: 'Research', enabled: true, schedule: { frequency: 'daily', timeZone: 'UTC', runAt: null, time: '09:00', weekdays: [] } });
  await profiles.update(user, { mode: 'Balanced' });
  now = new Date('2027-01-01T09:00Z');
  const receipt = await schedules.fire(user, plan.id, plan.revision, Date.parse(plan.nextRunAt!));
  assert.equal((await config(receipt!.submissionId)).config.model, modelModes.Balanced);
  assert.equal((await config(task.submissionId)).config.model, modelModes.Power);
  const briefs = new TodayRepository(database.db);
  assert.equal(await briefs.selectedModel(user, modelModes), modelModes.Balanced);
  await profiles.update(user, { mode: 'Power' });
  assert.equal(await briefs.selectedModel(user, modelModes), modelModes.Power);
  assert.equal(await briefs.selectedModel(await owner(), modelModes), modelModes.Balanced);
});
