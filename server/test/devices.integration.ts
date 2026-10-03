import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { FakeRebyte, type JSONRecord, type PlannedTool } from './helpers/fake-rebyte.js';

const directory = fileURLToPath(new URL('../', import.meta.url));
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL || new URL(databaseURL).pathname !== '/instant_test') throw new Error('Run the isolated test-db.mjs --devices harness.');
const pool = new pg.Pool({ connectionString: databaseURL, max: 4 });
const calendarTool: PlannedTool = {
  name: 'ios_list_calendar_events',
  arguments: { start: '2026-09-22T00:00:00+08:00', end: '2026-09-23T00:00:00+08:00', time_zone: 'Asia/Shanghai', limit: 10 },
};
const healthTool: PlannedTool = {
  name: 'ios_get_health_summary',
  arguments: { start: '2026-09-22T00:00:00+08:00', end: '2026-09-23T00:00:00+08:00', time_zone: 'Asia/Shanghai', metrics: ['steps', 'active_energy', 'heart_rate', 'sleep'] },
};
const tools = [calendarTool.name, healthTool.name];
// The full Main Agent tool set also includes the (non-device) task delegation tool.
const agentTools = [...tools, 'instant_create_task', 'impo_search_memory', 'web_search'];
const syntheticCalendar = {
  test_data: true, source: 'explicit protocol test data; not EventKit', observed_at: '2026-09-22T12:00:00+08:00', truncated: false,
  events: [{ id: 'test-calendar-event', title: 'SYNTHETIC_CALENDAR_MARKER', start: '2026-09-22T10:00:00+08:00', end: '2026-09-22T11:00:00+08:00', all_day: false }],
};
type Managed = { child: ChildProcess; output: string; exited: Promise<number | null> };
type Pending = { invocationId: string; toolCallId: string; deviceId: string; toolName: string; input: JSONRecord; expiresAt: string };

test('device tools persist dispatch and immutable receipts through HTTP, PostgreSQL and Rebyte SDK', { timeout: 150000 }, async t => {
  const fake = new FakeRebyte();
  const remoteURL = await fake.listen();
  const env = {
    ...process.env, DATABASE_URL: databaseURL, PORT: '0', NODE_ENV: 'test', INSTANT_AUTH_MODE: 'local-dev', INSTANT_RUNTIME: 'rebyte',
    REBYTE_API_KEY: 'instant-fake-rebyte-key', REBYTE_BASE_URL: remoteURL, REBYTE_MODEL: 'gpt-5.6-luna',
    INSTANT_WORKER_POLL_MS: '25', WORKER_LEASE_MS: '1500', REBYTE_POLL_MS: '50', REBYTE_REQUEST_TIMEOUT_MS: '10000', DEVICE_TOOL_TIMEOUT_MS: '300000', STREAM_KEEPALIVE_MS: '200',
  };
  const processes = new Set<Managed>();
  let baseURL = '';
  let api: Managed;
  let aliceDevice = '';
  let otherAliceDevice = '';
  let bobDevice = '';

  function start(entry: string) {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const managed: Managed = { child, output: '', exited: new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }) };
    child.stdout!.on('data', chunk => { managed.output += String(chunk); });
    child.stderr!.on('data', chunk => { managed.output += String(chunk); });
    processes.add(managed); return managed;
  }
  async function stop(managed: Managed, signal: NodeJS.Signals = 'SIGTERM') {
    if (managed.child.exitCode === null && managed.child.signalCode === null) managed.child.kill(signal);
    const force = setTimeout(() => managed.child.kill('SIGKILL'), 2000); force.unref();
    try { await managed.exited; } finally { clearTimeout(force); processes.delete(managed); }
  }
  async function waitFor<T>(label: string, read: () => Promise<T | undefined>, timeout = 12000): Promise<T> {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const value = await read(); if (value !== undefined) return value; await delay(25); }
    throw new Error(`${label} timed out. Fake errors: ${JSON.stringify(fake.errors)}\n${[...processes].map(process => process.output).join('\n')}`);
  }
  async function startAPI() {
    api = start('src/api-main.ts');
    baseURL = await waitFor('API readiness', async () => {
      if (api.child.exitCode !== null) throw new Error(api.output);
      for (const line of api.output.split('\n')) { try { const value = JSON.parse(line); if (value.url) return new URL(value.url).origin; } catch {} }
      return undefined;
    });
  }
  async function request(path: string, body?: unknown, user = 'alice') {
    const response = await fetch(`${baseURL}/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer instant-dev-${user}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: await response.json() as JSONRecord };
  }
  async function register(installationId: string, advertised = tools, user = 'alice') {
    const response = await request('/devices/register', { installationId, tools: advertised }, user);
    assert.ok([200, 201].includes(response.status), JSON.stringify(response));
    assert.equal(typeof response.body.deviceId, 'string'); return response.body.deviceId as string;
  }
  async function submit(plan: PlannedTool[], deviceId: string | undefined = aliceDevice) {
    fake.nextTools = structuredClone(plan);
    const response = await request('/conversation/messages', {
      clientMessageId: randomUUID(), text: `Device protocol acceptance ${randomUUID()}`,
      ...(deviceId ? { deviceId } : {}), clientContext: { timeZone: 'Asia/Shanghai', currentDate: '2026-09-22T12:00:00+08:00' },
    });
    assert.equal(response.status, 202, JSON.stringify(response.body)); return response.body.submissionId as string;
  }
  async function pending(deviceId = aliceDevice) {
    const response = await request(`/devices/${deviceId}/tool-invocations?status=pending`);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.invocations as Pending[];
  }
  async function expectPending(count: number, deviceId = aliceDevice) {
    return waitFor(`${count} pending device calls`, async () => { const values = await pending(deviceId); return values.length === count ? values : undefined; });
  }
  async function claim(invocation: Pending, deviceId = aliceDevice, user = 'alice') {
    return request(`/device-tool-invocations/${invocation.invocationId}/claim`, { deviceId }, user);
  }
  async function result(invocation: Pending, executionId: string, body: JSONRecord, deviceId = aliceDevice, user = 'alice') {
    return request(`/device-tool-invocations/${invocation.invocationId}/result`, { deviceId, executionId, ...body }, user);
  }
  async function completed(id: string, expected = 'completed') {
    return waitFor(`submission ${expected}`, async () => {
      const response = await request(`/submissions/${id}`); assert.equal(response.status, 200);
      assert.notEqual(response.body.status, 'failed', JSON.stringify(response.body));
      return response.body.status === expected ? response.body : undefined;
    });
  }
  async function replayChunks(id: string) {
    const response = await fetch(`${baseURL}/api/v1/submissions/${id}/stream`, { headers: { Authorization: 'Bearer instant-dev-alice' }, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const stream = await response.text(); assert.ok(stream.includes('data: [DONE]'));
    return stream.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)) as JSONRecord);
  }
  async function expireWorker(id: string) {
    await pool.query("UPDATE outbox_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE submission_id=$1 AND status='running'", [id]);
  }
  async function expireDevice(invocation: Pending) {
    await pool.query("UPDATE device_dispatches SET expires_at=clock_timestamp()-interval '1 second' WHERE invocation_id=$1", [invocation.invocationId]);
    await pool.query("UPDATE tool_invocations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [invocation.invocationId]);
  }
  function resultsFor(turnId: string) { return [...fake.toolResults.values()].filter(result => result.turn_id === turnId); }

  try {
    await startAPI();
    await t.test('device registration is user scoped, repeatable and validates advertised tools', async () => {
      const installation = randomUUID();
      const devices = await Promise.all(Array.from({ length: 4 }, () => register(installation)));
      assert.equal(new Set(devices).size, 1); aliceDevice = devices[0];
      bobDevice = await register(installation, tools, 'bob');
      otherAliceDevice = await register(randomUUID());
      assert.notEqual(bobDevice, aliceDevice);
      assert.equal((await request(`/devices/${aliceDevice}/tool-invocations?status=pending`, undefined, 'bob')).status, 404);
      assert.equal((await request('/conversation/messages', { clientMessageId: randomUUID(), text: 'foreign device', deviceId: bobDevice })).status, 404);
      assert.equal((await request('/devices/register', { installationId: randomUUID(), tools: ['arbitrary_shell_command'] })).status, 400);
      assert.equal((await request('/conversation/messages', { clientMessageId: randomUUID(), text: 'invalid client date', clientContext: { timeZone: 'Asia/Shanghai', currentDate: '2026-02-31T12:00:00+08:00' } })).status, 400);
      assert.equal(await register(installation, []), aliceDevice);
      assert.equal(await register(installation), aliceDevice);
    });

    await t.test('two calls have one claim each and immutable success/error receipts survive API and Worker restart', async () => {
      const id = await submit([calendarTool, healthTool]);
      const admitted = (await pool.query(`SELECT m.client_message_id, m.text FROM messages m
        JOIN runtime_submissions s ON s.user_message_id=m.id WHERE s.id=$1`, [id])).rows[0];
      const identical = { clientMessageId: admitted.client_message_id, text: admitted.text, deviceId: aliceDevice, clientContext: { timeZone: 'Asia/Shanghai', currentDate: '2026-09-22T12:00:00+08:00' } };
      const replayInput = await request('/conversation/messages', identical);
      assert.equal(replayInput.status, 202); assert.equal(replayInput.body.submissionId, id);
      assert.equal((await request('/conversation/messages', { ...identical, deviceId: otherAliceDevice })).status, 409);
      assert.equal((await request('/conversation/messages', { ...identical, clientContext: { ...identical.clientContext, timeZone: 'UTC' } })).status, 409);
      let worker = start('src/worker-main.ts');
      const calls = await expectPending(2);
      const calendar = calls.find(call => call.toolName === calendarTool.name)!;
      const health = calls.find(call => call.toolName === healthTool.name)!;
      assert.deepEqual(calendar.input, calendarTool.arguments);
      assert.deepEqual(health.input, healthTool.arguments);
      assert.deepEqual(fake.sessions.at(-1)!.agent.tools.map((tool: JSONRecord) => tool.name ?? tool.type).sort(), [...agentTools].sort());
      assert.equal((await claim(calendar, bobDevice, 'bob')).status, 404);
      assert.equal((await claim(calendar, otherAliceDevice)).status, 404);
      const unclaimed = await result(calendar, randomUUID(), { success: true, output: syntheticCalendar });
      assert.equal(unclaimed.status, 409); assert.equal(unclaimed.body.error.code, 'invocation_not_claimed');
      const claims = await Promise.all(Array.from({ length: 5 }, () => claim(calendar)));
      assert.ok(claims.every(value => value.status === 200));
      assert.equal(new Set(claims.map(value => value.body.executionId)).size, 1);
      const executionId = claims[0].body.executionId;
      const badExecution = await result(calendar, randomUUID(), { success: true, output: syntheticCalendar });
      assert.equal(badExecution.status, 409); assert.equal(badExecution.body.error.code, 'execution_mismatch');
      for (const invalid of [{ success: true }, { success: true, output: {}, error: 'both' }, { success: false }, { success: false, error: 'no', output: {} }]) {
        assert.equal((await result(calendar, executionId, invalid)).status, 400);
      }
      assert.equal((await result(calendar, executionId, { success: true, output: syntheticCalendar }, otherAliceDevice)).status, 404);
      assert.equal((await result(calendar, executionId, { success: true, output: syntheticCalendar }, bobDevice, 'bob')).status, 404);
      const healthClaim = await claim(health); assert.equal(healthClaim.status, 200);
      await stop(worker, 'SIGKILL');
      const saved = await result(calendar, executionId, { success: true, output: syntheticCalendar });
      assert.equal(saved.status, 200); assert.deepEqual(saved.body, { accepted: true, duplicate: false });
      const replay = await result(calendar, executionId, { success: true, output: syntheticCalendar });
      assert.equal(replay.status, 200); assert.deepEqual(replay.body, { accepted: true, duplicate: true });
      const reordered = Object.fromEntries(Object.entries(syntheticCalendar).reverse());
      assert.equal((await result(calendar, executionId, { output: reordered, success: true })).body.duplicate, true, 'JSON key order cannot change an immutable receipt');
      const conflict = await result(calendar, executionId, { success: true, output: { test_data: true, changed: true } });
      assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'idempotency_conflict');
      const denied = await result(health, healthClaim.body.executionId, { success: false, error: 'health_permission_denied' });
      assert.equal(denied.status, 200);
      assert.equal((await pending()).length, 0, 'saved results must not request another local execution');
      await stop(api, 'SIGKILL'); await startAPI();
      await expireDevice(calendar); // A saved receipt remains replayable after its old dispatch deadline.
      assert.equal((await result(calendar, executionId, { success: true, output: syntheticCalendar })).body.duplicate, true);
      await expireWorker(id); worker = start('src/worker-main.ts');
      try {
        const final = await completed(id); assert.equal(final.resultCount, 2);
        const remote = resultsFor(fake.sessions.at(-1)!.turns[0].id); assert.equal(remote.length, 2);
        assert.ok(remote.some(value => value.success === true && value.output.includes('SYNTHETIC_CALENDAR_MARKER')));
        assert.ok(remote.some(value => value.success === false && value.error.includes('health_permission_denied')));
        const persisted = await pool.query('SELECT status, result FROM tool_invocations WHERE submission_id=$1', [id]);
        assert.equal(persisted.rowCount, 2); assert.ok(persisted.rows.every(row => row.status === 'submitted'));
        assert.equal((await pending()).length, 0);
        const replay = await replayChunks(id);
        assert.deepEqual(await replayChunks(id), replay, 'reconnecting reads persisted protocol events without new executions');
        for (const call of calls) {
          assert.equal(replay.filter(chunk => chunk.type === 'tool-input-available' && chunk.toolCallId === call.toolCallId).length, 1);
          assert.equal(replay.filter(chunk => ['tool-output-available', 'tool-output-error'].includes(chunk.type) && chunk.toolCallId === call.toolCallId).length, 1);
          assert.equal(replay.filter(chunk => chunk.type === 'data-instant-device-request' && chunk.data.invocationId === call.invocationId).length, 1);
        }
      } finally { await stop(worker); }
    });

    await t.test('a quiet run keeps its stream alive with SSE comments until output resumes', async () => {
      const id = await submit([calendarTool]);
      const worker = start('src/worker-main.ts');
      try {
        const [call] = await expectPending(1);
        // Waiting for the iPhone produces no chunks; proxies would close an idle stream.
        const response = await fetch(`${baseURL}/api/v1/submissions/${id}/stream`, { headers: { Authorization: 'Bearer instant-dev-alice' }, signal: AbortSignal.timeout(10000) });
        const reader = response.body!.getReader(); const decoder = new TextDecoder(); let wire = '';
        const until = Date.now() + 900;
        while (Date.now() < until && !wire.includes(': keepalive')) {
          const next = await Promise.race([reader.read(), new Promise<undefined>(resolve => setTimeout(resolve, 300))]);
          if (next && !next.done) wire += decoder.decode(next.value, { stream: true });
        }
        assert.ok(wire.includes(': keepalive\n\n'), 'an idle stream sends keepalive comments');
        const claimed = await claim(call); assert.equal(claimed.status, 200);
        assert.equal((await result(call, claimed.body.executionId, { success: true, output: syntheticCalendar })).status, 200);
        for (;;) { const next = await reader.read(); if (next.done) break; wire += decoder.decode(next.value, { stream: true }); }
        assert.ok(wire.includes('data: [DONE]'), 'the stream still completes normally');
      } finally { await stop(worker); }
    });

    await t.test('a lost Rebyte tool-result acknowledgement recovers the saved receipt without new device execution', async () => {
      const before = fake.toolResults.size;
      const id = await submit([calendarTool]);
      let worker = start('src/worker-main.ts');
      const [call] = await expectPending(1);
      const claimed = await claim(call); assert.equal(claimed.status, 200);
      fake.holdNextToolResult = true;
      assert.equal((await result(call, claimed.body.executionId, { success: true, output: syntheticCalendar })).status, 200);
      await waitFor('remote tool result committed before acknowledgement', async () => fake.toolResults.size === before + 1 ? true : undefined);
      await stop(worker, 'SIGKILL'); fake.releaseToolResultResponses();
      assert.equal((await pending()).length, 0);
      await expireWorker(id); worker = start('src/worker-main.ts');
      try {
        await completed(id);
        assert.equal(fake.toolResults.size, before + 1);
        assert.equal((await pending()).length, 0);
        const receipt = await result(call, claimed.body.executionId, { success: true, output: syntheticCalendar });
        assert.equal(receipt.status, 200); assert.equal(receipt.body.duplicate, true);
        assert.equal((await pool.query('SELECT status FROM tool_invocations WHERE id=$1', [call.invocationId])).rows[0].status, 'submitted');
        assert.equal((await replayChunks(id)).filter(chunk => chunk.type === 'tool-output-available' && chunk.toolCallId === call.toolCallId).length, 1);
      } finally { await stop(worker); }
    });

    await t.test('an expired dispatch returns a tool error; a late device result cannot resurrect it', async () => {
      const id = await submit([calendarTool]);
      const worker = start('src/worker-main.ts');
      try {
        const [call] = await expectPending(1);
        const claimed = await claim(call); assert.equal(claimed.status, 200);
        await expireDevice(call);
        const late = await result(call, claimed.body.executionId, { success: true, output: syntheticCalendar });
        assert.equal(late.status, 410); assert.equal(late.body.error.code, 'invocation_expired');
        await completed(id);
        const turn = fake.sessions.at(-1)!.turns.at(-1)!;
        const remote = resultsFor(turn.id); assert.equal(remote.length, 1); assert.equal(remote[0].success, false);
        assert.match(remote[0].error, /expir|timeout|deadline/);
        assert.equal((await pending()).length, 0);
      } finally { await stop(worker); }
    });

    await t.test('cancelled dispatches reject claims and late receipts across process restart', async () => {
      const id = await submit([calendarTool]);
      let worker = start('src/worker-main.ts');
      const [call] = await expectPending(1);
      const claimed = await claim(call); assert.equal(claimed.status, 200);
      const before = fake.toolResults.size;
      fake.holdCancellation = true;
      assert.equal((await request(`/submissions/${id}/cancel`, {})).status, 200);
      await waitFor('remote cancellation awaiting acknowledgement', async () => fake.pendingCancellation ? true : undefined);
      const whileCancelling = await result(call, claimed.body.executionId, { success: true, output: syntheticCalendar });
      assert.equal(whileCancelling.status, 410); assert.equal(whileCancelling.body.error.code, 'invocation_cancelled');
      assert.equal(fake.toolResults.size, before, 'a pending remote cancellation must not allow a new tool receipt');
      fake.releaseCancellation();
      await completed(id, 'cancelled');
      await stop(worker, 'SIGKILL'); await stop(api, 'SIGKILL'); await startAPI();
      const late = await result(call, claimed.body.executionId, { success: true, output: syntheticCalendar });
      assert.equal(late.status, 410); assert.equal(late.body.error.code, 'invocation_cancelled');
      const retryClaim = await claim(call); assert.equal(retryClaim.status, 410);
      assert.equal((await pending()).length, 0);
      worker = start('src/worker-main.ts');
      try { await completed(id, 'cancelled'); assert.equal(fake.toolResults.size, before); }
      finally { await stop(worker); }
    });

    await t.test('unavailable capabilities and invalid model arguments return errors without issuing a device grant', async () => {
      const limited = await register(randomUUID(), [calendarTool.name]);
      const id = await submit([healthTool,
        { ...calendarTool, arguments: { ...calendarTool.arguments, limit: -1 } },
        { ...calendarTool, arguments: { ...calendarTool.arguments, start: '2026-02-31T00:00:00+08:00', end: '2026-03-05T00:00:00+08:00' } },
      ], limited);
      const worker = start('src/worker-main.ts');
      try {
        await completed(id);
        assert.equal((await pending(limited)).length, 0);
        const remote = resultsFor(fake.sessions.at(-1)!.turns.at(-1)!.id);
        assert.equal(remote.length, 3); assert.ok(remote.every(value => value.success === false));
        const unbound = await submit([calendarTool], ''); await completed(unbound);
        assert.equal((await pending()).length, 0);
        const unboundResults = resultsFor(fake.sessions.at(-1)!.turns.at(-1)!.id);
        assert.equal(unboundResults.length, 1); assert.equal(unboundResults[0].success, false);
      } finally { await stop(worker); }
    });

    await t.test('revoking a capability after claim rejects the first result but preserves already accepted receipts', async () => {
      const installation = randomUUID();
      const device = await register(installation);
      const id = await submit([calendarTool, healthTool], device);
      let worker = start('src/worker-main.ts');
      try {
        const calls = await expectPending(2, device);
        const calendar = calls.find(call => call.toolName === calendarTool.name)!;
        const health = calls.find(call => call.toolName === healthTool.name)!;
        const calendarClaim = await claim(calendar, device), healthClaim = await claim(health, device);
        assert.equal(calendarClaim.status, 200); assert.equal(healthClaim.status, 200);
        const accepted = await result(calendar, calendarClaim.body.executionId, { success: true, output: syntheticCalendar }, device);
        assert.equal(accepted.status, 200); assert.equal(accepted.body.duplicate, false);
        await stop(worker, 'SIGKILL'); // Revocation cannot depend on the next background polling cycle.
        assert.equal(await register(installation, []), device);
        const revoked = await result(health, healthClaim.body.executionId, { success: true, output: { test_data: true, steps: 123 } }, device);
        assert.equal(revoked.status, 410); assert.equal(revoked.body.error.code, 'permission_revoked');
        const revokedClaim = await claim(health, device);
        assert.equal(revokedClaim.status, 410); assert.equal(revokedClaim.body.error.code, 'permission_revoked');
        const acceptedReplay = await result(calendar, calendarClaim.body.executionId, { success: true, output: syntheticCalendar }, device);
        assert.equal(acceptedReplay.status, 200); assert.equal(acceptedReplay.body.duplicate, true);
        assert.equal((await pending(device)).length, 0);
        await expireWorker(id); worker = start('src/worker-main.ts');
        await completed(id);
        const remote = resultsFor(fake.sessions.at(-1)!.turns.at(-1)!.id);
        assert.equal(remote.length, 2);
        assert.equal(remote.find(value => value.call_id === calendar.toolCallId)?.success, true);
        const denied = remote.find(value => value.call_id === health.toolCallId)!;
        assert.equal(denied.success, false); assert.match(denied.error, /permission_revoked/);
        assert.equal((await result(calendar, calendarClaim.body.executionId, { success: true, output: syntheticCalendar }, device)).body.duplicate, true);
      } finally { await stop(worker); }
    });

    await t.test('a legacy Session upgrades only when idle, preserves history, then reuses its new tools Session', async () => {
      fake.holdNextTurn = true;
      const runningID = await submit([]);
      const worker = start('src/worker-main.ts');
      try {
        const heldTurn = await waitFor('held legacy turn', async () => fake.sessions.at(-1)?.turns.at(-1)?.status === 'in_progress' ? fake.sessions.at(-1)!.turns.at(-1) : undefined);
        const oldSession = fake.sessions.at(-1)!;
        const sessionsBefore = fake.sessions.length;
        const binding = (await pool.query('SELECT id, agent_config_version_id FROM session_bindings WHERE provider_session_id=$1', [oldSession.id])).rows[0];
        const legacyID = randomUUID();
        await pool.query(`INSERT INTO agent_config_versions (id, version, hash, config)
          SELECT $1, (SELECT max(version)+1 FROM agent_config_versions), $2, jsonb_set(config, '{tools}', '[]'::jsonb)
          FROM agent_config_versions WHERE id=$3`, [legacyID, `legacy-test-${randomUUID()}`, binding.agent_config_version_id]);
        await pool.query('UPDATE session_bindings SET agent_config_version_id=$1 WHERE id=$2', [legacyID, binding.id]);
        oldSession.agent.tools = [];
        const busy = await request('/conversation/messages', { clientMessageId: randomUUID(), text: 'Must not upgrade an active Session', deviceId: aliceDevice });
        assert.equal(busy.status, 409); assert.equal(busy.body.error.code, 'config_upgrade_pending');
        assert.equal(fake.sessions.length, sessionsBefore);
        fake.complete(oldSession, heldTurn!); await completed(runningID);
        const before = (await pool.query('SELECT id, text FROM messages ORDER BY sequence')).rows;
        const oldInput = heldTurn!.text.split('\n\n').at(-1)!;
        const upgradedID = await submit([calendarTool]);
        const [call] = await expectPending(1);
        assert.equal(fake.sessions.length, sessionsBefore + 1);
        const newSession = fake.sessions.at(-1)!;
        assert.deepEqual(newSession.agent.tools.map((tool: JSONRecord) => tool.name ?? tool.type).sort(), [...agentTools].sort());
        assert.ok(newSession.agent.instructions.includes(oldInput), 'new Session receives the most recent persisted history');
        const retired = (await pool.query('SELECT status, is_current FROM session_bindings WHERE id=$1', [binding.id])).rows[0];
        assert.deepEqual(retired, { status: 'retired', is_current: false });
        const claimed = await claim(call); assert.equal(claimed.status, 200);
        assert.equal((await result(call, claimed.body.executionId, { success: true, output: syntheticCalendar })).status, 200);
        await completed(upgradedID);
        const after = (await pool.query('SELECT id, text FROM messages ORDER BY sequence')).rows;
        assert.deepEqual(after.slice(0, before.length), before, 'local messages survive Session replacement unchanged');
        assert.equal(after.length, before.length + 2, 'restored history is not projected as duplicate chat messages');
        const continued = await submit([]); await completed(continued);
        assert.equal(fake.sessions.length, sessionsBefore + 1); assert.equal(newSession.turns.length, 2);
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM session_bindings WHERE is_current')).rows[0].count, 1);
      } finally { await stop(worker); }
    });

    await t.test('neutral Android tools advertise only the attached device and preserve exact-name ownership and receipts', async () => {
      const neutralCalendar = { ...calendarTool, name: 'impo_list_calendar_events' };
      const neutralHealth = { ...healthTool, name: 'impo_get_health_summary' };
      const installation = randomUUID();
      const android = await register(installation, [neutralCalendar.name, neutralHealth.name]);
      const id = await submit([neutralCalendar, neutralHealth, calendarTool], android);
      const worker = start('src/worker-main.ts');
      try {
        const calls = await expectPending(2, android);
        const session = fake.sessions.at(-1)!;
        assert.deepEqual(session.agent.tools.map((tool: JSONRecord) => tool.name ?? tool.type).sort(),
          ['impo_get_health_summary', 'impo_list_calendar_events', 'impo_search_memory', 'instant_create_task', 'web_search']);
        assert.equal((await pending(aliceDevice)).length, 0, 'never route neutral calls to another owned iPhone');
        for (const call of calls) {
          assert.equal((await claim(call, aliceDevice)).status, 404);
          assert.equal((await claim(call, bobDevice, 'bob')).status, 404);
          const claimed = await claim(call, android); assert.equal(claimed.status, 200);
          const output = { source: call.toolName === neutralCalendar.name ? 'android.calendar_provider' : 'android.health_connect', test_data: true, events: [], metrics: {} };
          assert.equal((await result(call, claimed.body.executionId, { success: true, output }, android)).status, 200);
          assert.equal((await result(call, claimed.body.executionId, { success: true, output }, android)).body.duplicate, true);
        }
        await completed(id);
        const remote = resultsFor(session.turns.at(-1)!.id);
        assert.equal(remote.filter(value => value.success).length, 2);
        assert.equal(remote.filter(value => !value.success).length, 1, 'an unadvertised iOS alias is rejected, not translated');
        assert.match(remote.find(value => !value.success)!.error, /device_capability_unavailable/);
        assert.equal(await register(installation, []), android);
        const noDevice = await submit([], ''); await completed(noDevice);
        assert.ok(fake.sessions.at(-1)!.agent.tools.every((tool: JSONRecord) => !/^(impo|ios)_(list_calendar_events|get_health_summary)$/.test(tool.name ?? '')));
      } finally { await stop(worker); }
    });

    await t.test('client actions finish without a foreground dispatch and survive stream and history replay', async () => {
      const device = await register(randomUUID(), ['impo_open_link', 'impo_navigate']);
      const id = await submit([
        { name: 'impo_open_link', arguments: { url: 'https://youtu.be/example' } },
        { name: 'impo_navigate', arguments: { destination: 'Union Square, San Francisco', mode: 'walking' } },
      ], device);
      const worker = start('src/worker-main.ts');
      try {
        await completed(id);
        assert.deepEqual(await pending(device), [], 'ready cards never enter the automatic device poller');
        const chunks = await replayChunks(id);
        assert.ok(!chunks.some(chunk => chunk.type === 'data-instant-device-request'));
        const cards = chunks.filter(chunk => chunk.type === 'tool-output-available').map(chunk => chunk.output);
        assert.equal(cards.length, 2);
        assert.ok(cards.every(card => card.kind === 'client_action' && card.status === 'ready' && card.interaction === 'tap'));
        assert.deepEqual(await replayChunks(id), chunks);
        const stored = await pool.query('SELECT part FROM message_client_actions WHERE message_id=(SELECT assistant_message_id FROM runtime_submissions WHERE id=$1) ORDER BY created_at, id', [id]);
        assert.deepEqual(stored.rows.map(row => row.part.output).sort((a, b) => a.actionId.localeCompare(b.actionId)), [...cards].sort((a, b) => a.actionId.localeCompare(b.actionId)));
        const history = await request('/conversation?limit=100');
        assert.equal(history.status, 200);
        const restored = history.body.messages.flatMap((message: JSONRecord) => message.parts).filter((part: JSONRecord) => part.output?.kind === 'client_action');
        assert.equal(restored.length, 2);
        const foreign = await request('/conversation?limit=100', undefined, 'bob');
        assert.ok(foreign.body.messages.every((message: JSONRecord) => message.parts.every((part: JSONRecord) => part.output?.kind !== 'client_action')));
        const before = fake.sessions.length;
        const unsupported = await submit([{ name: 'impo_open_link', arguments: { url: 'https://example.com' } }], aliceDevice);
        await completed(unsupported);
        assert.ok(fake.sessions.length > before, 'capability changes rotate the idle Session');
        assert.ok(!fake.sessions.at(-1)!.agent.tools.some((tool: JSONRecord) => tool.name === 'impo_open_link'));
        const errors = (await replayChunks(unsupported)).filter(chunk => chunk.type === 'tool-output-error');
        assert.equal(errors.length, 1); assert.match(errors[0].errorText, /device_capability_unavailable/);
      } finally { await stop(worker); }
    });

    await t.test('database ownership constraints prevent a dispatch from targeting another user’s device', async () => {
      const invocation = await pool.query('SELECT invocation_id FROM device_dispatches LIMIT 1');
      assert.equal(invocation.rowCount, 1);
      await assert.rejects(
        pool.query('UPDATE device_dispatches SET device_id=$1 WHERE invocation_id=$2', [bobDevice, invocation.rows[0].invocation_id]),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === '23503',
      );
    });
    assert.deepEqual(fake.errors, []);
  } finally {
    await Promise.all([...processes].map(managed => stop(managed)));
    await fake.close(); await pool.end();
  }
});
