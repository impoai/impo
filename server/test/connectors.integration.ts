import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { FakeRebyte, type JSONRecord, type PlannedTool } from './helpers/fake-rebyte.js';
import { FakeComposio } from './helpers/fake-composio.js';
import { deviceHash } from '../src/tools/device-tools.js';

const directory = fileURLToPath(new URL('../', import.meta.url));
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL || new URL(databaseURL).pathname !== '/instant_test') throw new Error('Run the isolated test-db.mjs --connectors harness.');
const pool = new pg.Pool({ connectionString: databaseURL, max: 4 });
const aliceID = '00000000-0000-4000-8000-000000000001';
const bobID = '00000000-0000-4000-8000-000000000002';
const list: PlannedTool = { name: 'instant_list_connectors', arguments: {} };
const search: PlannedTool = { name: 'instant_search_connector_tools', arguments: { connector: 'gmail', queries: [{ use_case: 'Find Gmail tools for synthetic protocol acceptance' }] } };
const schema: PlannedTool = { name: 'instant_get_connector_tool_schemas', arguments: { connector: 'gmail', tool_slugs: ['GMAIL_FETCH_EMAILS'] } };
const execute = (tool_slug: string, args: JSONRecord, connector = 'gmail', extra: JSONRecord = {}): PlannedTool => ({ name: 'instant_execute_connector_tools', arguments: { connector, tools: [{ tool_slug, arguments: args, ...extra }] } });
const read = execute('GMAIL_FETCH_EMAILS', { user_id: 'me', max_results: 2, query: 'subject:synthetic-protocol-test' });
const draft = execute('GMAIL_CREATE_EMAIL_DRAFT', { user_id: 'me', subject: 'SYNTHETIC TEST DRAFT - LOCAL FIXTURE ONLY', body: 'No real mailbox has been accessed.' });
type Managed = { child: ChildProcess; output: string; exited: Promise<number | null> };

test('Connector control plane and server tool receipts survive independent API/Worker failures without duplicate writes', { timeout: 150000 }, async t => {
  const fake = new FakeRebyte(), composio = new FakeComposio();
  const remoteURL = await fake.listen(), composioURL = await composio.listen();
  const env = {
    ...process.env, DATABASE_URL: databaseURL, PORT: '0', NODE_ENV: 'test', INSTANT_AUTH_MODE: 'local-dev', INSTANT_RUNTIME: 'rebyte',
    REBYTE_API_KEY: 'instant-fake-rebyte-key', REBYTE_BASE_URL: remoteURL, REBYTE_MODEL: 'gpt-5.6-luna',
    COMPOSIO_API_KEY: 'instant-fake-composio-key', COMPOSIO_BASE_URL: composioURL, COMPOSIO_REQUEST_TIMEOUT_MS: '10000',
    INSTANT_WORKER_POLL_MS: '25', WORKER_LEASE_MS: '1500', REBYTE_POLL_MS: '50', REBYTE_REQUEST_TIMEOUT_MS: '10000',
  };
  const processes = new Set<Managed>();
  let baseURL = '', aliceAccount = '';
  let api: Managed;
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
    throw new Error(`${label} timed out. Fake errors: ${JSON.stringify([...fake.errors, ...composio.errors])}\n${[...processes].map(process => process.output).join('\n')}`);
  }
  async function startAPI() {
    api = start('src/api-main.ts');
    baseURL = await waitFor('API readiness', async () => {
      if (api.child.exitCode !== null) throw new Error(api.output);
      for (const line of api.output.split('\n')) { try { const value = JSON.parse(line); if (value.url) return new URL(value.url).origin; } catch {} }
      return undefined;
    });
  }
  async function request(path: string, body?: unknown, user = 'alice', method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${baseURL}/api/v1${path}`, {
      method, headers: { Authorization: `Bearer instant-dev-${user}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000),
    });
    return { status: response.status, body: await response.json() as JSONRecord };
  }
  async function submit(plan: PlannedTool[], user = 'alice') {
    fake.nextTools = structuredClone(plan);
    const response = await request('/conversation/messages', { clientMessageId: randomUUID(), text: `Synthetic Gmail protocol acceptance ${randomUUID()}` }, user);
    assert.equal(response.status, 202, JSON.stringify(response.body)); return response.body.submissionId as string;
  }
  async function completed(id: string, user = 'alice') {
    return waitFor('Gmail submission completion', async () => {
      const response = await request(`/submissions/${id}`, undefined, user); assert.equal(response.status, 200);
      assert.notEqual(response.body.status, 'failed', JSON.stringify(response.body));
      assert.notEqual(response.body.status, 'waiting_device', 'Server tools cannot require the iPhone to execute');
      return response.body.status === 'completed' ? response.body : undefined;
    });
  }
  async function expireWorker(id: string) {
    await pool.query("UPDATE outbox_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE submission_id=$1 AND status='running'", [id]);
  }
  async function toolRows(id: string) {
    return (await pool.query('SELECT id, tool_name, execution_location, status, result FROM tool_invocations WHERE submission_id=$1 ORDER BY created_at', [id])).rows;
  }
  async function assertServerOnly(id: string) {
    assert.ok((await toolRows(id)).every(row => row.execution_location === 'server' && row.status === 'submitted'));
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM device_dispatches WHERE submission_id=$1', [id])).rows[0].count, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM product_events WHERE submission_id=$1 AND chunk->'data'->>'status'='waiting_device'", [id])).rows[0].count, 0);
  }
  try {
    await startAPI();
    await t.test('the shelf is every enabled rebyte-dev auth config, featured first', async () => {
      const listed = await request('/connectors'); assert.equal(listed.status, 200);
      const connectors = listed.body.connectors as JSONRecord[];
      assert.deepEqual(connectors.map(item => item.toolkit), ['gmail', 'googlecalendar']);
      assert.deepEqual(connectors[0], { toolkit: 'gmail', name: 'Gmail', description: 'Synthetic mail', logoURL: 'https://logos.example.test/gmail', featured: true, status: 'disconnected' });
      assert.equal(connectors[1]!.name, 'Google Calendar'); assert.equal(connectors[1]!.featured, true);
      assert.equal((await request('/connectors/notion')).status, 404);
      assert.equal((await request('/connectors/notion/connect', {})).status, 404);
      assert.ok(JSON.stringify(listed.body).indexOf('ac_fake') < 0, 'Auth config IDs stay on the server');
    });

    await t.test('OAuth link and refresh pin the exact owned Gmail account and keep provider credentials off client responses', async () => {
      assert.equal((await request('/connectors/gmail')).body.status, 'disconnected');
      const malicious = await request('/connectors/gmail/connect', { userId: bobID, connectedAccountId: 'borrowed-account' });
      assert.equal(malicious.status, 400);
      const linked = await request('/connectors/gmail/connect', {});
      assert.equal(linked.status, 200); assert.match(linked.body.redirectURL, /^https:\/\/connect\.example\.test\//);
      assert.equal(typeof linked.body.expiresAt, 'string');
      assert.deepEqual(Object.keys(linked.body).sort(), ['expiresAt', 'redirectURL']);
      const connection = (await pool.query("SELECT * FROM connector_connections WHERE user_id=$1 AND toolkit='gmail'", [aliceID])).rows[0];
      assert.ok(connection.entity_id.startsWith(`instant:development:${aliceID}:`));
      aliceAccount = composio.activate(connection.entity_id);
      const refreshed = await request('/connectors/gmail/refresh', {});
      assert.equal(refreshed.status, 200); assert.equal(refreshed.body.status, 'connected');
      assert.ok(Object.keys(refreshed.body).every(key => ['status', 'email', 'expiresAt'].includes(key)));
      const persisted = (await pool.query("SELECT * FROM connector_connections WHERE user_id=$1 AND toolkit='gmail'", [aliceID])).rows[0];
      assert.equal(persisted.connected_account_id, aliceAccount); assert.equal(composio.routers.get(persisted.router_session_id)?.account, aliceAccount);
      await stop(api, 'SIGKILL'); await startAPI();
      assert.equal((await request('/connectors/gmail')).body.status, 'connected');
    });

    await t.test('a second app gets its own pinned account and Tool Router Session', async () => {
      const linked = await request('/connectors/googlecalendar/connect', {}); assert.equal(linked.status, 200);
      const row = (await pool.query("SELECT * FROM connector_connections WHERE user_id=$1 AND toolkit='googlecalendar'", [aliceID])).rows[0];
      assert.equal(row.auth_config_id, 'ac_fake_googlecalendar');
      const account = composio.activate(row.entity_id, 'googlecalendar');
      assert.equal((await request('/connectors/googlecalendar/refresh', {})).body.status, 'connected');
      const persisted = (await pool.query("SELECT router_session_id FROM connector_connections WHERE user_id=$1 AND toolkit='googlecalendar'", [aliceID])).rows[0];
      assert.deepEqual(composio.routers.get(persisted.router_session_id), { entity: row.entity_id, account, toolkit: 'googlecalendar' });
      const statuses = Object.fromEntries(((await request('/connectors')).body.connectors as JSONRecord[]).map(item => [item.toolkit, item.status]));
      assert.deepEqual(statuses, { gmail: 'connected', googlecalendar: 'connected' });
    });

    await t.test('discovery, schema and Gmail reads execute in the Worker without device dispatch', async () => {
      const id = await submit([list, search, schema, read]);
      const worker = start('src/worker-main.ts');
      try {
        const final = await completed(id); assert.equal(final.resultCount, 4);
        await assertServerOnly(id);
        const rows = await toolRows(id); assert.equal(rows.length, 4);
        const listed = [...fake.toolResults.values()].map(event => typeof event.output === 'string' ? JSON.parse(event.output) : undefined).find(output => output?.connectors);
        assert.deepEqual(listed.connectors, [{ connector: 'gmail', name: 'Gmail' }, { connector: 'googlecalendar', name: 'Google Calendar' }]);
        assert.deepEqual(composio.executions.slice(-3).map(execution => execution.slug).sort(), ['COMPOSIO_GET_TOOL_SCHEMAS', 'COMPOSIO_MULTI_EXECUTE_TOOL', 'COMPOSIO_SEARCH_TOOLS']);
        assert.ok(composio.executions.every(execution => composio.routers.get(execution.router)?.account === aliceAccount));
        assert.ok((await toolRows(id)).every(row => row.result.ok === true));
        assert.equal(fake.sessions.length, 1);
      } finally { await stop(worker); }
    });

    await t.test('a saved draft receipt survives lost Rebyte acknowledgement without creating a second draft', async () => {
      const before = composio.drafts.length, remoteBefore = fake.toolResults.size;
      const id = await submit([draft]);
      fake.holdNextToolResult = true;
      let worker = start('src/worker-main.ts');
      await waitFor('draft accepted by Rebyte before acknowledgement', async () => fake.toolResults.size === remoteBefore + 1 ? true : undefined);
      assert.equal(composio.drafts.length, before + 1);
      assert.equal((await toolRows(id))[0].result.ok, true);
      await stop(worker, 'SIGKILL'); fake.releaseToolResultResponses();
      await stop(api, 'SIGKILL'); await startAPI();
      await expireWorker(id); worker = start('src/worker-main.ts');
      try {
        await completed(id); await assertServerOnly(id);
        assert.equal(composio.drafts.length, before + 1);
        assert.equal(fake.toolResults.size, remoteBefore + 1);
        assert.equal(fake.sessions.length, 1, 'Identical function config must reuse the existing Session after JSONB round trips');
        const outputEvents = await pool.query("SELECT count(*)::int AS count FROM product_events WHERE submission_id=$1 AND chunk->>'type'='tool-output-available'", [id]);
        assert.equal(outputEvents.rows[0].count, 1);
      } finally { await stop(worker); }
    });

    await t.test('unknown provider draft outcome is frozen after Worker death and never blindly retried', async () => {
      const before = composio.drafts.length;
      composio.holdNextDraft = true;
      const id = await submit([draft]);
      let worker = start('src/worker-main.ts');
      await waitFor('provider draft accepted before response', async () => composio.drafts.length === before + 1 ? true : undefined);
      assert.equal((await toolRows(id))[0].result, null);
      await stop(worker, 'SIGKILL'); composio.releaseHeldResponses();
      await expireWorker(id); worker = start('src/worker-main.ts');
      try {
        await completed(id); await assertServerOnly(id);
        assert.equal(composio.drafts.length, before + 1, 'An uncertain Gmail write must never be executed twice');
        const result = (await toolRows(id))[0].result;
        assert.equal(result.ok, false); assert.equal(result.error.code, 'execution_outcome_unknown');
        assert.equal(fake.sessions.length, 1);
      } finally { await stop(worker); }
    });

    await t.test('a remotely cancelled Turn cannot execute a previously persisted server tool on recovery', async () => {
      const before = composio.drafts.length;
      const session = fake.sessions[0], turnCount = session.turns.length;
      fake.holdNextInput = true;
      const id = await submit([draft]);
      let worker = start('src/worker-main.ts');
      const turn = await waitFor('remote draft request before local dispatch', async () => session.turns.length === turnCount + 1 && session.turns.at(-1)?.status === 'waiting' ? session.turns.at(-1) : undefined);
      await stop(worker, 'SIGKILL'); fake.releaseInputResponses();
      const action = session.required_actions[0];
      assert.ok(action && action.turn_id === turn!.id);
      // Reproduce a crash after the transaction records a request but before its
      // external effect. SQL creates only this test's durable boundary state.
      const invocationID = randomUUID();
      await pool.query(`INSERT INTO tool_invocations (id, user_id, submission_id, binding_id, turn_id, call_id, tool_name, arguments, arguments_hash, execution_location)
        SELECT $1, user_id, id, binding_id, $2, $3, $4, $5::jsonb, $6, 'server' FROM runtime_submissions WHERE id=$7`,
      [invocationID, turn!.id, action.call_id, action.name, JSON.stringify(action.arguments), deviceHash(action.arguments), id]);
      turn!.status = 'cancelled'; turn!.assistant.status = 'incomplete';
      session.status = 'idle'; session.required_actions = [];
      await expireWorker(id); worker = start('src/worker-main.ts');
      try {
        await waitFor('remote cancellation projected locally', async () => {
          const view = await request(`/submissions/${id}`); assert.equal(view.status, 200);
          return view.body.status === 'cancelled' ? true : undefined;
        });
        assert.equal(composio.drafts.length, before, 'A known terminal Turn must never start a Gmail mutation');
        const invocation = (await toolRows(id))[0]; assert.equal(invocation.status, 'cancelled'); assert.equal(invocation.result, null);
        assert.equal(fake.sessions.length, 1);
      } finally { await stop(worker); }
    });

    await t.test('model arguments cannot pick another account or reach unconnected apps', async () => {
      const before = composio.executions.length;
      const id = await submit([
        execute('GMAIL_FETCH_EMAILS', { user_id: 'me' }, 'gmail', { account: 'foreign' }),
        { name: 'instant_execute_connector_tools', arguments: { connector: 'gmail', tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} }], connected_accounts: { gmail: ['foreign'] } } },
        { ...search, arguments: { ...search.arguments, connector: 'notion' } },
      ]);
      const worker = start('src/worker-main.ts');
      try {
        await completed(id); await assertServerOnly(id);
        assert.equal(composio.executions.length, before);
        const rows = await toolRows(id); assert.equal(rows.length, 3); assert.ok(rows.every(row => row.result.ok === false));
        assert.equal(rows[2].result.error.code, 'connector_connection_required');
      } finally { await stop(worker); }
    });

    await t.test('every tool of the connected app runs, including sending and deleting, as in Rebyte', async () => {
      const before = composio.executions.length;
      const id = await submit([
        execute('GMAIL_SEND_EMAIL', { user_id: 'me', recipient_email: 'synthetic@example.test', body: 'synthetic' }),
        execute('GMAIL_DELETE_MESSAGE', { user_id: 'me', message_id: 'synthetic' }),
      ]);
      const worker = start('src/worker-main.ts');
      try {
        await completed(id); await assertServerOnly(id);
        assert.deepEqual(composio.executions.slice(before).map(execution => (execution.args.tools as JSONRecord[])[0]!.tool_slug), ['GMAIL_SEND_EMAIL', 'GMAIL_DELETE_MESSAGE']);
        assert.ok((await toolRows(id)).every(row => row.result.ok === true));
      } finally { await stop(worker); }
    });

    await t.test('another user cannot borrow the connected account even when provider discovery returns it', async () => {
      const linked = await request('/connectors/gmail/connect', {}, 'bob'); assert.equal(linked.status, 200);
      const routerCount = composio.routers.size;
      composio.foreignAccountInNextList = aliceAccount;
      const refreshed = await request('/connectors/gmail/refresh', {}, 'bob');
      assert.notEqual(refreshed.body.status, 'connected');
      assert.equal(composio.routers.size, routerCount);
      const row = (await pool.query('SELECT connected_account_id FROM connector_connections WHERE user_id=$1', [bobID])).rows[0];
      assert.equal(row.connected_account_id, null);
      const before = composio.executions.length;
      const id = await submit([search], 'bob');
      const worker = start('src/worker-main.ts');
      try {
        await completed(id, 'bob'); await assertServerOnly(id);
        assert.equal(composio.executions.length, before); assert.equal((await toolRows(id))[0].result.ok, false);
      } finally { await stop(worker); }
    });

    await t.test('disconnect revokes provider access and stops later tool execution', async () => {
      const disconnected = await request('/connectors/gmail', undefined, 'alice', 'DELETE');
      assert.equal(disconnected.status, 200); assert.equal(disconnected.body.status, 'disconnected');
      assert.equal(composio.accounts.has(aliceAccount), false);
      const before = composio.executions.length;
      const id = await submit([read]);
      const worker = start('src/worker-main.ts');
      try {
        await completed(id); assert.equal(composio.executions.length, before);
        assert.equal((await toolRows(id))[0].result.ok, false);
      } finally { await stop(worker); }
    });
    assert.deepEqual(fake.errors, []); assert.deepEqual(composio.errors, []);
  } finally {
    await Promise.all([...processes].map(managed => stop(managed)));
    await Promise.all([fake.close(), composio.close()]); await pool.end();
  }
});
