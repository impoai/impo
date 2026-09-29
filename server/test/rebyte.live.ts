import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Rebyte } from '@rebyteai/agent-sdk';
import { loadDatabaseUrl } from '../src/config.js';
import { RebyteGateway } from '../src/rebyte/gateway.js';

const serverDirectory = fileURLToPath(new URL('../', import.meta.url));
const rootDirectory = fileURLToPath(new URL('../../', import.meta.url));
const aliceId = '00000000-0000-4000-8000-000000000001';
const bobId = '00000000-0000-4000-8000-000000000002';
type ManagedProcess = {
  child: ChildProcess;
  output: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};
type Receipt = { messageId: string; submissionId: string };
type Binding = { id: string; user_id: string; provider_session_id: string | null };

/** Every resource comes from this test's isolated database; no organization-wide deletion. */
test('real Rebyte preserves history and completes explicit test-device Calendar/Health functions', { timeout: 300_000 }, async t => {
  const databaseURL = loadDatabaseUrl('local-dev');
  if (new URL(databaseURL).pathname !== '/instant_test') throw new Error('Live acceptance requires the isolated instant_test database; run npm run test:live.');
  const apiKey = process.env.REBYTE_API_KEY;
  if (!apiKey) throw new Error('REBYTE_API_KEY is required; live acceptance never skips.');
  const config = {
    apiKey, baseURL: process.env.REBYTE_BASE_URL ?? 'https://api.rebyte.ai/v1',
    model: process.env.REBYTE_MODEL ?? 'gpt-5.6-luna', timeoutMs: 15_000,
  };
  const gateway = new RebyteGateway(config);
  const client = new Rebyte({ apiKey, baseURL: config.baseURL, maxRetries: 0, timeout: 15_000, logLevel: 'off' });
  const pool = new pg.Pool({ connectionString: databaseURL, max: 4, statement_timeout: 5000 });
  const processes = new Set<ManagedProcess>();
  // Leave a bounded cleanup window inside the test's hard deadline.
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(260_000)]);
  const env = {
    ...process.env, DATABASE_URL: databaseURL, PORT: '0', NODE_ENV: 'test',
    INSTANT_AUTH_MODE: 'local-dev', INSTANT_RUNTIME: 'rebyte',
    INSTANT_WORKER_POLL_MS: '25', WORKER_LEASE_MS: '3000', REBYTE_POLL_MS: '200',
    REBYTE_BASE_URL: config.baseURL, REBYTE_MODEL: config.model,
  };
  let baseURL = '';
  let api: ManagedProcess | undefined;
  let worker: ManagedProcess | undefined;
  let phase = 'startup';
  let successful = false;

  function start(command: string, args: string[], childEnv: NodeJS.ProcessEnv = env, cwd = serverDirectory) {
    const child = spawn(command, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const managed: ManagedProcess = {
      child, output: '', exited: new Promise((resolve, reject) => {
        child.once('error', () => reject(new Error('Test child could not start')));
        child.once('exit', (code, childSignal) => resolve({ code, signal: childSignal }));
      }),
    };
    // Inspect readiness/test counts only. Never print child/provider output on error.
    child.stdout!.on('data', chunk => { managed.output = (managed.output + String(chunk)).slice(-65_536); });
    child.stderr!.on('data', chunk => { managed.output = (managed.output + String(chunk)).slice(-65_536); });
    processes.add(managed);
    return managed;
  }

  async function stop(managed: ManagedProcess | undefined, childSignal: NodeJS.Signals = 'SIGTERM') {
    if (!managed) return;
    if (managed.child.exitCode === null && managed.child.signalCode === null) managed.child.kill(childSignal);
    const force = setTimeout(() => managed.child.kill('SIGKILL'), 2000);
    force.unref();
    try { await managed.exited; }
    finally { clearTimeout(force); processes.delete(managed); }
  }

  async function waitFor<T>(read: () => Promise<T | undefined>, intervalMs = 100): Promise<T> {
    while (true) {
      signal.throwIfAborted();
      const result = await read();
      if (result !== undefined) return result;
      await delay(intervalMs, undefined, { signal });
    }
  }

  async function startAPI() {
    api = start(process.execPath, ['--import', 'tsx', 'src/api-main.ts']);
    baseURL = await waitFor(async () => {
      if (api!.child.exitCode !== null) throw new Error('API process exited before readiness');
      for (const line of api!.output.split('\n')) {
        try {
          const value = JSON.parse(line);
          if (value.event === 'listening' && typeof value.url === 'string') return new URL(value.url).origin;
        } catch { /* Only the explicit JSON readiness event counts. */ }
      }
      return undefined;
    }, 20);
  }

  async function request(path: string, method = 'GET', body?: unknown, user: 'alice' | 'bob' = 'alice') {
    const response = await fetch(`${baseURL}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer instant-dev-${user}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  async function submit(text: string, deviceId?: string): Promise<Receipt> {
    const response = await request('/conversation/messages', 'POST', {
      clientMessageId: randomUUID(), text,
      ...(deviceId ? { deviceId, clientContext: { timeZone: 'Asia/Shanghai', currentDate: '2026-09-22T12:00:00+08:00' } } : {}),
    });
    assert.equal(response.status, 202);
    assert.equal(typeof response.body.submissionId, 'string');
    assert.equal(typeof response.body.messageId, 'string');
    return response.body as Receipt;
  }

  async function completed(receipt: Receipt) {
    return waitFor(async () => {
      const response = await request(`/submissions/${receipt.submissionId}`);
      assert.equal(response.status, 200);
      assert.notEqual(response.body.status, 'failed');
      assert.notEqual(response.body.status, 'cancelled');
      return response.body.status === 'completed' ? response.body : undefined;
    });
  }

  /** A finished reply keeps no text in PostgreSQL; the conversation API reads it from Rebyte. */
  async function answerFromRebyte(submissionId: string): Promise<string> {
    const row = (await pool.query<{ id: string; text: string }>('SELECT m.id, m.text FROM messages m JOIN runtime_submissions s ON s.assistant_message_id=m.id WHERE s.id=$1', [submissionId])).rows[0]!;
    assert.equal(row.text, '', 'a finished reply keeps no text in PostgreSQL');
    const view = await request('/conversation?limit=100');
    assert.equal(view.status, 200);
    return (view.body.messages as Array<{ id: string; text: string }>).find(message => message.id === row.id)?.text ?? '';
  }
  async function bindings() {
    return (await pool.query<Binding>("SELECT id, user_id, provider_session_id FROM session_bindings WHERE provider = 'rebyte'")).rows;
  }

  async function waitChild(managed: ManagedProcess) {
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        managed.exited,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error('Live acceptance exceeded its deadline'));
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally { if (abort) signal.removeEventListener('abort', abort); }
  }

  try {
    await startAPI();
    const marker = `INSTANT_CONTEXT_${randomUUID().replaceAll('-', '')}`;
    phase = 'first message admission';
    const first = await submit(`本次对话的校验码是 ${marker}。下一轮我会问这个码。现在只回复“已收到”。`);

    // The subscriber disconnects while the durable run is still queued.
    const subscriptionAbort = new AbortController();
    const subscription = await fetch(`${baseURL}/api/v1/submissions/${first.submissionId}/stream`, {
      headers: { Authorization: 'Bearer instant-dev-alice' }, signal: AbortSignal.any([signal, subscriptionAbort.signal]),
    });
    assert.equal(subscription.status, 200);
    subscriptionAbort.abort();
    await subscription.body?.cancel().catch(() => {});

    phase = 'worker crash before first local reply projection';
    worker = start(process.execPath, ['--import', 'tsx', 'src/worker-main.ts']);
    const binding = await waitFor(async () => {
      if (worker!.child.exitCode !== null) throw new Error('Worker exited before remote admission');
      const row = (await bindings()).find(value => value.user_id === aliceId && value.provider_session_id !== null);
      if (!row) return undefined;
      // Stop immediately when the binding commits; inspect the actual boundary below.
      worker!.child.kill('SIGSTOP');
      return row;
    }, 10);
    const atCrash = (await pool.query<{ text: string; status: string }>(
      'SELECT m.text, s.status FROM runtime_submissions s JOIN messages m ON m.id = s.assistant_message_id WHERE s.id = $1', [first.submissionId],
    )).rows[0];
    // If scheduling missed this boundary, fail explicitly; never claim an unobserved crash test.
    assert.equal(atCrash.text, '', 'Could not capture the Worker before first reply projection');
    assert.notEqual(atCrash.status, 'completed');
    const sessionId = binding.provider_session_id!;
    const admittedTurns = await gateway.turns(sessionId, signal);
    assert.equal(admittedTurns.length, 1, 'Remote first Turn must already be durable at the crash boundary');
    await stop(worker, 'SIGKILL');
    worker = undefined;
    await stop(api, 'SIGKILL');
    api = undefined;

    phase = 'remote execution while API and Worker are offline';
    await waitFor(async () => {
      const turns = await gateway.turns(sessionId, signal);
      assert.equal(turns.length, 1);
      assert.notEqual(turns[0].status, 'failed');
      assert.notEqual(turns[0].status, 'cancelled');
      return turns[0].status === 'completed' ? true : undefined;
    }, 300);
    const unprojected = (await pool.query<{ text: string }>(
      'SELECT m.text FROM runtime_submissions s JOIN messages m ON m.id = s.assistant_message_id WHERE s.id = $1', [first.submissionId],
    )).rows[0];
    assert.equal(unprojected.text, '', 'Offline local processes cannot project the remote reply');

    phase = 'restart and recover first reply';
    await startAPI();
    worker = start(process.execPath, ['--import', 'tsx', 'src/worker-main.ts']);
    await completed(first);
    assert.equal((await bindings()).filter(value => value.user_id === aliceId).length, 1);
    assert.equal((await gateway.turns(sessionId, signal)).length, 1, 'Recovery must not resubmit first input');

    phase = 'second turn recalls first-turn context';
    const second = await submit('上一条用户消息给出的校验码是什么？只输出该校验码，不要其他文字。');
    await completed(second);
    const history = await request('/conversation');
    assert.equal(history.status, 200);
    const historyMessages = history.body.messages as Array<{ id: string; role: string; text: string; status: string }>;
    assert.equal(historyMessages.length, 4);
    const replies = historyMessages.filter(message => message.role === 'assistant');
    assert.equal(replies.length, 2);
    assert.ok(replies.every(message => message.status === 'completed'));
    assert.ok(replies[1].text.includes(marker), 'Second answer must recall the marker without receiving it again');
    const mapped = await pool.query<{ binding_id: string; provider_turn_id: string }>(
      'SELECT binding_id, provider_turn_id FROM runtime_submissions WHERE id = ANY($1::uuid[])', [[first.submissionId, second.submissionId]],
    );
    assert.equal(mapped.rowCount, 2);
    assert.equal(new Set(mapped.rows.map(row => row.binding_id)).size, 1);
    assert.equal(new Set(mapped.rows.map(row => row.provider_turn_id)).size, 2);
    const itemMappings = await pool.query<{ message_id: string }>(
      'SELECT DISTINCT message_id FROM message_item_bindings WHERE binding_id = $1', [binding.id],
    );
    assert.equal(itemMappings.rowCount, 4, 'Both user/assistant message pairs must map to remote Items');
    const remoteTurns = await gateway.turns(sessionId, signal);
    assert.equal(remoteTurns.length, 2, 'Two inputs and recovery must create exactly two remote Turns');
    assert.ok(remoteTurns.every(turn => turn.status === 'completed'));
    assert.equal((await request(`/submissions/${first.submissionId}`, 'GET', undefined, 'bob')).status, 404);
    const remoteMatches = await gateway.findSessions({ instant_app: 'instant', instant_binding: binding.id }, signal);
    assert.equal(remoteMatches.length, 1, 'Recovery must not duplicate the main remote Session');

    phase = 'Swift client live protocol and history';
    const swiftEnv: NodeJS.ProcessEnv = {
      ...process.env, INSTANT_LIVE_BASE_URL: baseURL,
    };
    for (const key of Object.keys(swiftEnv)) {
      if (/REBYTE|COMPOSIO|DATABASE_URL|OPENAI_API_KEY/.test(key)) delete swiftEnv[key];
    }
    const swift = start('swift', ['test', '--package-path', 'ios/Packages/InstantClient', '--filter', 'RebyteLiveTests'], swiftEnv, rootDirectory);
    const swiftResult = await waitChild(swift);
    processes.delete(swift);
    phase = `Swift process verification (exit ${swiftResult.code ?? 'signal'})`;
    assert.equal(swiftResult.code, 0, 'Swift live acceptance failed');
    assert.match(swift.output, /Executed [1-9]\d* tests?.*with 0 failures/, 'Swift live acceptance must execute a test');
    assert.doesNotMatch(swift.output, /\b[1-9]\d* skipped\b|\b[1-9]\d* tests? skipped\b/, 'Swift live acceptance must not skip');
    phase = 'Swift independent Session and replay turn count';
    const allBindings = await bindings();
    const bobBinding = allBindings.find(value => value.user_id === bobId);
    assert.ok(bobBinding?.provider_session_id, 'Swift should create Bob’s independent Session');
    assert.notEqual(bobBinding.provider_session_id, sessionId);
    assert.equal((await gateway.turns(sessionId, signal)).length, 2, 'Swift Bob traffic must not alter Alice’s Session');
    assert.equal((await gateway.turns(bobBinding.provider_session_id, signal)).length, 1, 'Swift stream replay must not create another Turn');

    phase = 'real function calls with explicitly synthetic Calendar/Health receipts';
    const device = await request('/devices/register', 'POST', { installationId: `live-protocol-test-${randomUUID()}`, tools: ['ios_list_calendar_events', 'ios_get_health_summary'] });
    assert.ok([200, 201].includes(device.status));
    const deviceId = device.body.deviceId as string;
    assert.equal(typeof deviceId, 'string');
    const calendarMarker = `SYNTHETIC_CALENDAR_${randomUUID().replaceAll('-', '')}`;
    const healthMarker = `SYNTHETIC_HEALTH_${randomUUID().replaceAll('-', '')}`;
    const toolReceipt = await submit(
      '这是明确使用测试设备数据的 function 接口验收，不要读取或推断真实个人信息。请分别调用 ios_list_calendar_events 和 ios_get_health_summary。两者 start="2026-09-22T00:00:00+08:00"、end="2026-09-23T00:00:00+08:00"、time_zone="Asia/Shanghai"；日历 limit=5；健康 metrics=["steps"]。收到两个工具的结果后，只输出各自结果中的 test_marker 字段，不要使用历史消息代替调用。', deviceId,
    );
    const handled = new Set<string>();
    const names = new Set<string>();
    await waitFor(async () => {
      const pending = await request(`/devices/${deviceId}/tool-invocations?status=pending`);
      assert.equal(pending.status, 200);
      for (const invocation of pending.body.invocations as Array<{ invocationId: string; toolName: string }>) {
        if (handled.has(invocation.invocationId)) continue;
        assert.ok(['ios_list_calendar_events', 'ios_get_health_summary'].includes(invocation.toolName));
        const claim = await request(`/device-tool-invocations/${invocation.invocationId}/claim`, 'POST', { deviceId });
        assert.equal(claim.status, 200);
        const calendar = invocation.toolName === 'ios_list_calendar_events';
        const output = {
          test_data: true, test_marker: calendar ? calendarMarker : healthMarker,
          source: 'explicitly synthetic live API acceptance; no EventKit or HealthKit data read',
          observed_at: '2026-09-22T12:00:00+08:00',
          ...(calendar ? { events: [], truncated: false } : { metrics: { steps: { value: 1234, unit: 'count', test_data: true } } }),
        };
        const result = await request(`/device-tool-invocations/${invocation.invocationId}/result`, 'POST', {
          deviceId, executionId: claim.body.executionId, success: true, output,
        });
        assert.equal(result.status, 200); assert.equal(result.body.accepted, true);
        handled.add(invocation.invocationId); names.add(invocation.toolName);
      }
      const view = await request(`/submissions/${toolReceipt.submissionId}`);
      assert.equal(view.status, 200); assert.notEqual(view.body.status, 'failed'); assert.notEqual(view.body.status, 'cancelled');
      return view.body.status === 'completed' ? true : undefined;
    }, 100);
    assert.deepEqual([...names].sort(), ['ios_get_health_summary', 'ios_list_calendar_events']);
    // Enabling device tools changes this user's tool set, so the next message moves to a new
    // Session that carries the history; the previous Session keeps its two Turns.
    assert.equal((await gateway.turns(sessionId, signal)).length, 2, 'the retired Session receives no new Turn');
    const toolBinding = (await bindings()).find(value => value.user_id === aliceId && value.provider_session_id !== null && value.provider_session_id !== sessionId);
    assert.ok(toolBinding?.provider_session_id, 'a device tool change starts a new Session');
    const toolSessionId = toolBinding.provider_session_id;
    assert.deepEqual((await gateway.retrieve(toolSessionId, signal)).environment.type, 'openai_hosted', 'chat Sessions run in a Rebyte Sandbox');
    const toolRows = await pool.query<{ tool_name: string; status: string }>('SELECT tool_name, status FROM tool_invocations WHERE submission_id=$1', [toolReceipt.submissionId]);
    assert.equal(toolRows.rowCount, 2); assert.ok(toolRows.rows.every(row => row.status === 'submitted'));
    const toolAnswer = await answerFromRebyte(toolReceipt.submissionId);
    assert.ok(toolAnswer.includes(calendarMarker)); assert.ok(toolAnswer.includes(healthMarker));
    assert.equal((await gateway.turns(toolSessionId, signal)).length, 1);

    phase = 'real function error receipt from the explicit test device';
    const errorMarker = `SYNTHETIC_PERMISSION_ERROR_${randomUUID().replaceAll('-', '')}`;
    const failureReceipt = await submit(
      '再次进行明确使用测试设备的 function 接口验收。只调用一次 ios_get_health_summary，start="2026-09-22T00:00:00+08:00"、end="2026-09-23T00:00:00+08:00"、time_zone="Asia/Shanghai"、metrics=["steps"]。这是一次预期错误路径：若工具失败，只原样回复它返回的错误字符串，不要重试、调用别的工具或推断真实健康数据。', deviceId,
    );
    let failedInvocation: string | undefined;
    await waitFor(async () => {
      const pending = await request(`/devices/${deviceId}/tool-invocations?status=pending`);
      assert.equal(pending.status, 200);
      for (const invocation of pending.body.invocations as Array<{ invocationId: string; toolName: string }>) {
        if (invocation.invocationId === failedInvocation) continue;
        assert.equal(failedInvocation, undefined, 'The error path should make one requested Function call');
        assert.equal(invocation.toolName, 'ios_get_health_summary');
        const claim = await request(`/device-tool-invocations/${invocation.invocationId}/claim`, 'POST', { deviceId });
        assert.equal(claim.status, 200);
        const receipt = await request(`/device-tool-invocations/${invocation.invocationId}/result`, 'POST', {
          deviceId, executionId: claim.body.executionId, success: false, error: errorMarker,
        });
        assert.equal(receipt.status, 200); assert.equal(receipt.body.accepted, true);
        failedInvocation = invocation.invocationId;
      }
      const view = await request(`/submissions/${failureReceipt.submissionId}`);
      assert.equal(view.status, 200); assert.notEqual(view.body.status, 'failed'); assert.notEqual(view.body.status, 'cancelled');
      return view.body.status === 'completed' ? true : undefined;
    }, 100);
    assert.ok(failedInvocation);
    const failedTool = (await pool.query<{ status: string; result: { ok: boolean } }>('SELECT status, result FROM tool_invocations WHERE id=$1', [failedInvocation])).rows[0];
    assert.equal(failedTool.status, 'submitted'); assert.equal(failedTool.result.ok, false);
    const errorAnswer = await answerFromRebyte(failureReceipt.submissionId);
    assert.ok(errorAnswer.includes(errorMarker), 'The response must use the error returned by this Function call');
    assert.equal((await gateway.turns(toolSessionId, signal)).length, 2);
    successful = true;
    console.log(JSON.stringify({ event: 'rebyte_live_verified', sessions: 3, turns: 5, aliceMessages: 8, swiftTests: 1, workerCrashBeforeProjection: true, apiRestart: true, deviceFunctions: 3, deviceErrorReceipts: 1, deviceData: 'explicitly-synthetic-not-native' }));
  } catch (error) {
    const status = error instanceof Rebyte.APIError ? error.status : undefined;
    throw new Error(`Live acceptance failed during ${phase}${status ? ` (upstream HTTP ${status})` : ''}; provider payloads omitted.`);
  } finally {
    await Promise.all([...processes].map(managed => stop(managed)));
    const cleanupSignal = AbortSignal.timeout(20_000);
    let cleaned = 0;
    let cleanupFailed = false;
    try {
      for (const binding of await bindings()) {
        // Metadata recovery covers a creation that committed remotely but never bound locally.
        const matches = await gateway.findSessions({ instant_app: 'instant', instant_binding: binding.id }, cleanupSignal);
        const ids = new Set(matches.map(value => value.id));
        if (binding.provider_session_id) ids.add(binding.provider_session_id);
        for (const id of ids) {
          try {
            const remote = await gateway.retrieve(id, cleanupSignal);
            if (remote.metadata.instant_app !== 'instant' || remote.metadata.instant_binding !== binding.id) {
              cleanupFailed = true;
              continue;
            }
            await client.beta.agents.sessions.delete(id, { signal: cleanupSignal });
            cleaned++;
          } catch (error) {
            if (!(error instanceof Rebyte.APIError && error.status === 404)) cleanupFailed = true;
          }
        }
      }
    } catch { cleanupFailed = true; }
    finally { await pool.end(); }
    console.log(JSON.stringify({ event: 'rebyte_live_cleanup', deletedSessions: cleaned, verified: !cleanupFailed }));
    if (cleanupFailed || (successful && cleaned !== 3)) throw new Error('Could not verify cleanup of all test-owned Rebyte Sessions; provider payloads omitted.');
  }
});
