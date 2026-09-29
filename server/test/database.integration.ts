import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDatabase } from '../src/db/client.js';
import { LeaseLostError } from '../src/errors.js';
import { RuntimeRepository, type ClaimedJob } from '../src/persistence/runtime-repository.js';

const serverDirectory = fileURLToPath(new URL('../', import.meta.url));
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error('DATABASE_URL is required; run npm run test:db for an isolated PostgreSQL cluster.');
const pool = new pg.Pool({ connectionString: databaseURL, max: 4 });
const env = {
  ...process.env, PORT: '0', INSTANT_AUTH_MODE: 'local-dev', INSTANT_RUNTIME: 'development',
  NODE_ENV: 'test', INSTANT_WORKER_POLL_MS: '25', WORKER_LEASE_MS: '2000',
};
const processes = new Set<ManagedProcess>();
const token = { alice: 'instant-dev-alice', bob: 'instant-dev-bob' };
type Identity = keyof typeof token;
type ManagedProcess = {
  child: ChildProcess;
  output: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};
let baseURL = '';
let api: ManagedProcess;

function start(entry: string, args: string[] = []): ManagedProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
    cwd: serverDirectory, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const managed: ManagedProcess = {
    child, output: '',
    exited: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
  };
  child.stdout!.on('data', chunk => { managed.output += String(chunk); });
  child.stderr!.on('data', chunk => { managed.output += String(chunk); });
  processes.add(managed);
  return managed;
}

async function stop(process: ManagedProcess | undefined, signal: NodeJS.Signals = 'SIGTERM') {
  if (!process) return;
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill(signal);
  const force = setTimeout(() => process.child.kill('SIGKILL'), 3000);
  force.unref();
  try { await process.exited; }
  finally { clearTimeout(force); processes.delete(process); }
}

async function waitFor<T>(description: string, read: () => Promise<T | undefined>, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(25);
  }
  throw new Error(`Timed out: ${description}\n${[...processes].map(proc => proc.output).join('\n')}`);
}

async function startAPI() {
  api = start('src/api-main.ts');
  baseURL = await waitFor('API listening', async () => {
    if (api.child.exitCode !== null) throw new Error(`API exited: ${api.output}`);
    for (const line of api.output.split('\n')) {
      try {
        const value = JSON.parse(line);
        if (typeof value.url === 'string') return new URL(value.url).origin;
      } catch { /* Non-JSON startup logs are not readiness signals. */ }
    }
    return undefined;
  });
}

async function request(path: string, options: { user?: Identity; method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseURL}/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token[options.user ?? 'alice']}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function submit(text: string, clientMessageId: string = randomUUID(), user: Identity = 'alice') {
  const result = await request('/conversation/messages', { method: 'POST', body: { clientMessageId, text }, user });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(typeof result.body.submissionId, 'string');
  assert.equal(typeof result.body.messageId, 'string');
  return { ...result.body, text, clientMessageId } as {
    submissionId: string; messageId: string; conversationId: string; text: string; clientMessageId: string;
  };
}

async function runWorkerOnce() {
  const worker = start('src/worker-main.ts', ['--once']);
  const result = await worker.exited;
  processes.delete(worker);
  assert.equal(result.code, 0, `Worker --once failed: ${worker.output}`);
}

async function claimInIndependentProcess(): Promise<{ claimant: ManagedProcess; job: ClaimedJob }> {
  // Exercise the same claim transaction as a Worker, then hold precisely at its
  // crash boundary. This does not require a timing/pause hook in production code.
  const claimant = start('--input-type=module', ['--eval', `
    import { createDatabase } from './src/db/client.ts';
    import { RuntimeRepository } from './src/persistence/runtime-repository.ts';
    const connection = createDatabase(process.env.DATABASE_URL);
    const job = await new RuntimeRepository(connection.db).claimJob('integration-claimant', 60000);
    if (!job) throw new Error('No job to claim');
    process.stdout.write(JSON.stringify({ event: 'test_claimed', job }) + '\\n');
    setInterval(() => {}, 1000);
  `]);
  const job = await waitFor('independent job claim', async () => {
    if (claimant.child.exitCode !== null) throw new Error(`Claim process exited: ${claimant.output}`);
    for (const line of claimant.output.split('\n')) {
      try {
        const value = JSON.parse(line);
        if (value.event === 'test_claimed') return value.job as ClaimedJob;
      } catch { /* Only the explicit claim receipt is a readiness signal. */ }
    }
    return undefined;
  });
  return { claimant, job };
}

async function assertFenced(job: ClaimedJob, phase: 'tool' | 'continuation') {
  const connection = createDatabase(databaseURL!);
  try {
    const repository = new RuntimeRepository(connection.db);
    await assert.rejects(
      phase === 'tool'
        ? repository.saveToolResult(job, { ok: true, data: { echo: 'late result must be rejected' } })
        : repository.completeSubmission(job),
      LeaseLostError,
    );
  } finally { await connection.close(); }
}

async function completed(submissionId: string) {
  return waitFor('submission completion', async () => {
    const response = await request(`/submissions/${submissionId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.notEqual(response.body.status, 'failed', JSON.stringify(response.body));
    return response.body.status === 'completed' ? response.body : undefined;
  });
}

test('persistent server and independent Worker survive real process boundaries', { timeout: 120000 }, async t => {
  try {
    await startAPI();

    await t.test('acceptance is atomic, idempotent and isolated between users', async () => {
      const unauthenticated = await fetch(`${baseURL}/api/v1/conversation`);
      assert.equal(unauthenticated.status, 401);
      const clientMessageId = randomUUID();
      const text = `idempotent-${randomUUID()}`;
      const concurrent = await Promise.all(Array.from({ length: 5 }, () => submit(text, clientMessageId)));
      const accepted = concurrent[0];
      for (const result of concurrent) {
        assert.equal(result.messageId, accepted.messageId);
        assert.equal(result.submissionId, accepted.submissionId);
      }
      const duplicate = await request('/conversation/messages', {
        method: 'POST', body: { clientMessageId: accepted.clientMessageId, text: accepted.text },
      });
      assert.equal(duplicate.status, 202);
      assert.equal(duplicate.body.submissionId, accepted.submissionId);
      assert.equal(duplicate.body.messageId, accepted.messageId);
      const conflict = await request('/conversation/messages', {
        method: 'POST', body: { clientMessageId: accepted.clientMessageId, text: 'different payload' },
      });
      assert.equal(conflict.status, 409);
      assert.equal((await request(`/submissions/${accepted.submissionId}`, { user: 'bob' })).status, 404);
      assert.equal((await request(`/submissions/${accepted.submissionId}/cancel`, { user: 'bob', method: 'POST', body: {} })).status, 404);
      const persisted = await pool.query('SELECT * FROM runtime_submissions WHERE id = $1', [accepted.submissionId]);
      assert.equal(persisted.rowCount, 1);
      const worker = start('src/worker-main.ts');
      try { await completed(accepted.submissionId); }
      finally { await stop(worker); }
    });

    await t.test('user-started tasks run in their own conversation and never replace the main one', async () => {
      const mainBefore = await request('/conversation');
      assert.equal(mainBefore.status, 200, JSON.stringify(mainBefore.body));
      const goal = `task-goal-${randomUUID()}`;
      const clientMessageId = randomUUID();
      const created = await request('/tasks', { method: 'POST', body: { clientMessageId, text: goal } });
      assert.equal(created.status, 202, JSON.stringify(created.body));
      const { taskId, conversationId, submissionId } = created.body;
      assert.notEqual(conversationId, mainBefore.body.conversationId);
      const retried = await request('/tasks', { method: 'POST', body: { clientMessageId, text: goal } });
      assert.equal(retried.status, 202);
      assert.deepEqual([retried.body.taskId, retried.body.submissionId], [taskId, submissionId], 'a retried create is the same task');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM actions WHERE goal=$1', [goal])).rows[0].count, 1);

      const listed = await request('/tasks');
      const row = listed.body.tasks.find((task: any) => task.taskId === taskId);
      assert.ok(row, JSON.stringify(listed.body));
      assert.equal(row.title, goal);
      assert.ok(['queued', 'in_progress'].includes(row.status));
      assert.equal((await request('/tasks', { user: 'bob' })).body.tasks.some((task: any) => task.taskId === taskId), false);
      assert.equal((await request(`/tasks/${taskId}/conversation`, { user: 'bob' })).status, 404);

      const worker = start('src/worker-main.ts');
      try {
        await completed(submissionId);
        const followUp = await request(`/tasks/${taskId}/messages`, { method: 'POST', body: { clientMessageId: randomUUID(), text: 'follow up' } });
        assert.equal(followUp.status, 202, JSON.stringify(followUp.body));
        await completed(followUp.body.submissionId);
      } finally { await stop(worker); }

      const detail = await request(`/tasks/${taskId}/conversation`);
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      assert.equal(detail.body.title, goal);
      assert.deepEqual(detail.body.messages.map((message: any) => message.role), ['user', 'assistant', 'user', 'assistant']);
      assert.equal(detail.body.messages[0].text, goal);
      assert.equal((await request('/tasks')).body.tasks.find((task: any) => task.taskId === taskId).status, 'completed');

      // The main conversation must still be the main one after a task conversation exists.
      const mainAfter = await request('/conversation');
      assert.equal(mainAfter.body.conversationId, mainBefore.body.conversationId);
      const chat = await submit(`main-after-task-${randomUUID()}`);
      const owner = await pool.query('SELECT c.kind FROM runtime_submissions s JOIN conversations c ON c.id = s.conversation_id WHERE s.id=$1', [chat.submissionId]);
      assert.equal(owner.rows[0].kind, 'main');
      const reuse = await request('/conversation/messages', { method: 'POST', body: { clientMessageId, text: goal } });
      assert.equal(reuse.status, 409, 'a task message ID cannot be replayed into the main conversation');
      const drain = start('src/worker-main.ts');
      try { await completed(chat.submissionId); } finally { await stop(drain); }
    });

    await t.test('API restart retains accepted work; disconnecting SSE does not cancel execution', async () => {
      const accepted = await submit(`after-restart-${randomUUID()}`);
      const beforeRestart = await request(`/submissions/${accepted.submissionId}`);
      await stop(api, 'SIGKILL');
      await startAPI();
      const persisted = await request(`/submissions/${accepted.submissionId}`);
      assert.equal(persisted.status, 200);
      assert.equal(persisted.body.messageId, beforeRestart.body.messageId);
      const abort = new AbortController();
      const stream = await fetch(`${baseURL}/api/v1/submissions/${accepted.submissionId}/stream`, {
        headers: { Authorization: `Bearer ${token.alice}` }, signal: abort.signal,
      });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
      assert.equal(stream.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
      abort.abort();
      await stream.body?.cancel().catch(() => {});
      await waitFor('SSE disconnect releases subscription', async () => {
        const view = await request(`/submissions/${accepted.submissionId}`);
        return view.body.subscriberCount === 0 ? true : undefined;
      });
      const worker = start('src/worker-main.ts');
      try { await completed(accepted.submissionId); }
      finally { await stop(worker); }
      await stop(api, 'SIGKILL');
      await startAPI();
      assert.equal((await request(`/submissions/${accepted.submissionId}`)).body.status, 'completed');
      const replay = await fetch(`${baseURL}/api/v1/submissions/${accepted.submissionId}/stream`, {
        headers: { Authorization: `Bearer ${token.alice}` }, signal: AbortSignal.timeout(10000),
      });
      const replayText = await replay.text();
      assert.equal(replay.status, 200);
      assert.ok(replayText.includes(accepted.text), 'replayed SSE includes the persisted answer');
      assert.match(replayText, /data: \[DONE\]/);
      const history = await request('/conversation');
      assert.equal(history.status, 200);
      assert.ok(JSON.stringify(history.body).includes(accepted.text), 'restarted API must restore persisted messages');
      const bobHistory = await request('/conversation', { user: 'bob' });
      assert.ok(!JSON.stringify(bobHistory.body).includes(accepted.text), 'history must not cross users');
      assert.equal((await request(`/submissions/${accepted.submissionId}/stream`, { user: 'bob' })).status, 404);
    });

    await t.test('saved tool results survive Worker replacement without running the tool again', async () => {
      const accepted = await submit(`stored-result-${randomUUID()}`);
      await runWorkerOnce();
      await runWorkerOnce();
      const before = await pool.query('SELECT * FROM tool_invocations WHERE submission_id = $1', [accepted.submissionId]);
      assert.equal(before.rowCount, 1);
      assert.equal(before.rows[0].status, 'result_saved');
      assert.ok(JSON.stringify(before.rows[0]).includes(accepted.text));
      const executionBefore = await pool.query(
        "SELECT id, attempts, completed_at FROM outbox_jobs WHERE submission_id = $1 AND type = 'tool.execute'", [accepted.submissionId],
      );
      assert.equal(executionBefore.rowCount, 1);
      assert.equal(executionBefore.rows[0].attempts, 1);
      assert.ok(executionBefore.rows[0].completed_at);
      const worker = start('src/worker-main.ts');
      try { await completed(accepted.submissionId); }
      finally { await stop(worker); }
      const after = await pool.query('SELECT * FROM tool_invocations WHERE submission_id = $1', [accepted.submissionId]);
      assert.equal(after.rowCount, 1);
      assert.equal(after.rows[0].status, 'submitted');
      assert.deepEqual(after.rows[0].result, before.rows[0].result);
      const executionAfter = await pool.query(
        "SELECT id, attempts, completed_at FROM outbox_jobs WHERE submission_id = $1 AND type = 'tool.execute'", [accepted.submissionId],
      );
      assert.deepEqual(executionAfter.rows, executionBefore.rows, 'completion must reuse the frozen result, without a new execution attempt');
    });

    await t.test('an expired Worker lease is reclaimed; a live lease cannot be stolen', async () => {
      const accepted = await submit(`lease-recovery-${randomUUID()}`);
      const following = await submit(`serialized-behind-lease-${randomUUID()}`);
      await runWorkerOnce();
      const { claimant, job } = await claimInIndependentProcess();
      assert.equal(job.submissionId, accepted.submissionId);
      assert.equal(job.type, 'tool.execute');
      await runWorkerOnce();
      const stillClaimed = await pool.query('SELECT status, attempts FROM outbox_jobs WHERE id = $1', [job.id]);
      assert.deepEqual(stillClaimed.rows[0], { status: 'running', attempts: 1 });
      assert.equal((await request(`/submissions/${following.submissionId}`)).body.status, 'queued');
      const followingCalls = await pool.query('SELECT id FROM tool_invocations WHERE submission_id = $1', [following.submissionId]);
      assert.equal(followingCalls.rowCount, 0, 'later main-session work must wait behind the leased submission');
      await stop(claimant, 'SIGKILL');
      // Advance only the persisted lease clock instead of waiting one minute.
      await pool.query("UPDATE outbox_jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [job.id]);
      await assertFenced(job, 'tool');
      const replacement = start('src/worker-main.ts');
      try { await Promise.all([completed(accepted.submissionId), completed(following.submissionId)]); }
      finally { await stop(replacement); }
      const recovered = await pool.query('SELECT status, attempts FROM outbox_jobs WHERE id = $1', [job.id]);
      assert.deepEqual(recovered.rows[0], { status: 'completed', attempts: 2 });
      await assertFenced(job, 'tool');
    });

    await t.test('two Workers finish queued messages without duplicate main-session work', async () => {
      const first = await submit(`parallel-first-${randomUUID()}`);
      const second = await submit(`parallel-second-${randomUUID()}`);
      const workers = [start('src/worker-main.ts'), start('src/worker-main.ts')];
      try { await Promise.all([completed(first.submissionId), completed(second.submissionId)]); }
      finally { await Promise.all(workers.map(worker => stop(worker))); }
      for (const accepted of [first, second]) {
        const calls = await pool.query('SELECT * FROM tool_invocations WHERE submission_id = $1', [accepted.submissionId]);
        assert.equal(calls.rowCount, 1);
        assert.ok(JSON.stringify(calls.rows[0].result).includes(accepted.text));
      }
    });

    await t.test('cancellation persists across restart and a late completion cannot revive it', async () => {
      const queued = await submit(`cancel-queued-${randomUUID()}`);
      assert.equal((await request(`/submissions/${queued.submissionId}/cancel`, { method: 'POST', body: {} })).status, 200);
      const running = await submit(`cancel-result-saved-${randomUUID()}`);
      await runWorkerOnce();
      await runWorkerOnce();
      const { claimant, job } = await claimInIndependentProcess();
      assert.equal(job.submissionId, running.submissionId);
      assert.equal(job.type, 'submission.complete');
      assert.equal((await request(`/submissions/${running.submissionId}/cancel`, { method: 'POST', body: {} })).status, 200);
      await assertFenced(job, 'continuation');
      await stop(claimant, 'SIGKILL');
      await stop(api, 'SIGKILL');
      await startAPI();
      for (let index = 0; index < 3; index++) await runWorkerOnce();
      for (const accepted of [queued, running]) {
        assert.equal((await request(`/submissions/${accepted.submissionId}`)).body.status, 'cancelled');
      }
    });

    await t.test('database constraints reject cross-user references and duplicate main conversations', async () => {
      const alice = '00000000-0000-4000-8000-000000000001';
      const bob = '00000000-0000-4000-8000-000000000002';
      const conversation = await pool.query("SELECT id FROM conversations WHERE user_id = $1 AND kind = 'main'", [alice]);
      assert.equal(conversation.rowCount, 1);
      await assert.rejects(
        pool.query("INSERT INTO conversations (user_id) VALUES ($1)", [alice]),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === '23505',
      );
      await assert.rejects(
        pool.query(
          "INSERT INTO messages (user_id, conversation_id, sequence, role, text) VALUES ($1, $2, 999999, 'user', 'foreign owner')",
          [bob, conversation.rows[0].id],
        ),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === '23503',
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO session_bindings (user_id, conversation_id, agent_config_version_id)
           SELECT user_id, conversation_id, agent_config_version_id FROM session_bindings WHERE user_id = $1 AND is_current`,
          [alice],
        ),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === '23505',
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO tool_invocations
           (user_id, submission_id, binding_id, turn_id, call_id, tool_name, arguments, arguments_hash, execution_location)
           SELECT $1, submission_id, binding_id, turn_id, $2, tool_name, arguments, arguments_hash, execution_location
           FROM tool_invocations WHERE user_id = $3 LIMIT 1`,
          [bob, randomUUID(), alice],
        ),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === '23503',
      );
    });

    await t.test('findOrCreateUser provisions a real-provider identity exactly once, even under a concurrent first sight', async () => {
      const connection = createDatabase(databaseURL!);
      try {
        const repository = new RuntimeRepository(connection.db);
        const subject = `user_${randomUUID()}`;
        const concurrent = await Promise.all(Array.from({ length: 5 }, () => repository.findOrCreateUser('clerk', subject, 'Instant user')));
        const id = concurrent[0]!.id;
        assert.ok(concurrent.every(user => user.id === id), 'concurrent first sight of the same identity must resolve to one user row');
        const rows = await pool.query('SELECT id FROM users WHERE auth_provider=$1 AND auth_subject=$2', ['clerk', subject]);
        assert.equal(rows.rowCount, 1);
        assert.equal(rows.rows[0].id, id);
        const other = await repository.findOrCreateUser('clerk', `user_${randomUUID()}`, 'Instant user');
        assert.notEqual(other.id, id, 'a different subject must never resolve to the same user');
      } finally { await connection.close(); }
    });
  } finally {
    await Promise.all([...processes].map(process => stop(process)));
    await pool.end();
  }
});
