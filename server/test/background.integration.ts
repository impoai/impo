import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { createDatabase } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { BackgroundUserRepository } from '../src/background/repository.js';
import { createBackgroundClient } from '../src/background/client.js';
import { createBackgroundActivities } from '../src/background/activities.js';
import { BackgroundProvisioner } from '../src/background/provisioner.js';
import { backgroundIntervalMs, backgroundWorkflowId, type BackgroundStatus, type BackgroundTick } from '../src/background/contract.js';
import type { BackgroundStep } from '../src/background/registry.js';
import { createTemporalWorker } from '../src/temporal/worker.js';

async function until(check: () => Promise<boolean>, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(40); }
  throw new Error('Background assertion timed out');
}

test('hourly per-user framework: global singleton, empty ticks, Continue-As-New and plug-in retries', { timeout: 120000 }, async () => {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const db = createDatabase(process.env.DATABASE_URL!);
  const repository = new BackgroundUserRepository(db.db);
  const config = { address: env.address, namespace: 'default', taskQueue: `background-test-${randomUUID()}` };
  const client = await createBackgroundClient(config);
  const otherClient = await createBackgroundClient(config);
  const workers: Array<Awaited<ReturnType<typeof createTemporalWorker>>> = [];
  const running: Promise<void>[] = [];
  const a = '00000000-0000-4000-8000-000000000001';
  const b = '00000000-0000-4000-8000-000000000002';
  const handle = (id: string) => client.client.workflow.getHandle(backgroundWorkflowId(id));
  const state = (id: string) => handle(id).query<BackgroundStatus>('backgroundState');
  let installed: readonly BackgroundStep[] = [];
  async function startWorker() {
    // Replace the activity registry during the test without relying on the Java
    // time-skipping server's worker restart behavior (covered against the full server below).
    const w = await createTemporalWorker(config, {
      ...createBackgroundActivities(repository),
      planBackgroundTick: (tick: BackgroundTick) => createBackgroundActivities(repository, installed).planBackgroundTick(tick),
      executeBackgroundStep: (tick: BackgroundTick, key: string) => createBackgroundActivities(repository, installed).executeBackgroundStep(tick, key),
    });
    workers.push(w); running.push(w.worker.run());
  }
  async function stopWorkers() {
    for (const w of workers) if (w.worker.getState() === 'RUNNING') w.worker.shutdown();
    await Promise.all(running);
  }
  try {
    await startWorker(); await startWorker();
    const signal = new AbortController().signal;
    const firstProvisioner = new BackgroundProvisioner(repository, client);
    const secondProvisioner = new BackgroundProvisioner(repository, otherClient);
    await Promise.all([firstProvisioner.scan(signal), secondProvisioner.scan(signal), ...Array.from({ length: 6 }, () => client.ensure(a))]);
    const original = await handle(a).describe();
    const first = await state(a);
    assert.equal(first.ticks, 0); assert.equal(first.phase, 'waiting');
    assert.ok(Math.abs(first.nextTickAt - (await env.currentTimeMs()) - backgroundIntervalMs) < 10000);
    assert.equal((await state(b)).ticks, 0);
    await env.sleep('59 minutes');
    assert.equal((await state(a)).ticks, 0);
    await env.sleep('1 minute');
    await until(async () => (await state(a)).ticks === 1 && (await state(b)).ticks === 1);
    assert.equal((await state(a)).lastTick?.status, 'empty');
    assert.equal((await state(a)).lastTick?.steps, 0);
    assert.equal((await state(a)).nextTickAt, first.nextTickAt + backgroundIntervalMs);
    // Advance through a full production-sized run; each tick remains an actual one-hour Temporal timer.
    for (let tick = 2; tick <= 24; tick++) {
      await env.sleep('1 hour');
      await until(async () => (await state(a)).ticks === tick && (await state(b)).ticks === tick);
    }
    await until(async () => (await handle(a).describe()).runId !== original.runId);
    const continued = await state(a);
    assert.equal(continued.ticks, 24); assert.equal(continued.nextTickAt, first.nextTickAt + 24 * backgroundIntervalMs);
    await client.ensure(a);
    assert.equal((await state(a)).ticks, 24, 'ensuring an existing workflow must not reset its timer or checkpoint');
    const oldRun = await client.client.workflow.getHandle(backgroundWorkflowId(a), original.runId).describe();
    assert.equal(oldRun.status.name, 'CONTINUED_AS_NEW');
    assert.ok(oldRun.historyLength < 1000);

    // A new user gets discovered without changing the existing users' schedules.
    const newcomer = randomUUID();
    await db.db.insert(users).values({ id: newcomer, authProvider: 'test', authSubject: newcomer, name: 'Synthetic framework test' });
    await firstProvisioner.scan(signal);
    assert.equal((await state(newcomer)).ticks, 0);
    await db.db.delete(users).where(eq(users.id, newcomer));

    const calls: Array<{ userId: string; key: string; tickId: string }> = [];
    const attempts = new Map<string, number>();
    const plugins: BackgroundStep[] = [
      { key: 'retry.v1', async run(ctx) {
        calls.push({ userId: ctx.userId, key: ctx.idempotencyKey, tickId: ctx.tickId });
        const n = (attempts.get(ctx.idempotencyKey) ?? 0) + 1; attempts.set(ctx.idempotencyKey, n);
        if (n === 1) throw new Error('Synthetic temporary failure');
      } },
      { key: 'fails.v1', async run() { throw new Error('Synthetic exhausted failure'); } },
      { key: 'after.v1', async run(ctx) { calls.push({ userId: ctx.userId, key: ctx.idempotencyKey, tickId: ctx.tickId }); } },
    ];
    installed = plugins;
    await env.sleep('1 hour');
    await until(async () => calls.length > 0);
    await env.sleep('3 minutes');
    await until(async () => (await state(a)).ticks === 25 && (await state(b)).ticks === 25);
    const recovered = await state(a);
    assert.equal(recovered.lastTick?.status, 'failed'); assert.equal(recovered.lastTick?.failedSteps, 1);
    assert.equal(recovered.lastTick?.steps, 3);
    assert.ok(recovered.nextTickAt > await env.currentTimeMs());
    assert.equal((recovered.nextTickAt - first.nextTickAt) % backgroundIntervalMs, 0);
    const alice = calls.filter(c => c.userId === a);
    assert.equal(alice.filter(c => c.key.endsWith('/retry.v1')).length, 2);
    assert.equal(alice.filter(c => c.key.endsWith('/after.v1')).length, 1, 'an exhausted plug-in must not block later plug-ins');
    assert.equal(new Set(alice.filter(c => c.key.endsWith('/retry.v1')).map(c => c.key)).size, 1, 'retry idempotency key is stable');
    await until(async () => (await handle(newcomer).describe()).status.name === 'COMPLETED');
    // The next regular hour still runs after a failed plug-in and a Continue-As-New.
    await env.sleep(recovered.nextTickAt - await env.currentTimeMs() + 1000);
    await env.sleep('3 minutes');
    await until(async () => (await state(a)).ticks === 26);

    // Restore a checkpoint whose timer is three hours overdue: run once and retain the cadence.
    const overdue = randomUUID();
    await db.db.insert(users).values({ id: overdue, authProvider: 'test', authSubject: overdue, name: 'Synthetic overdue checkpoint' });
    const due = await env.currentTimeMs() - 3 * backgroundIntervalMs;
    await client.client.workflow.start('userBackgroundWorkflow', {
      workflowId: backgroundWorkflowId(overdue), taskQueue: config.taskQueue, args: [{ userId: overdue, nextTickAt: due }],
    });
    await until(async () => calls.some(c => c.userId === overdue));
    await env.sleep('3 minutes');
    await until(async () => (await state(overdue)).ticks === 1);
    assert.ok((await state(overdue)).nextTickAt > await env.currentTimeMs());
    assert.equal(((await state(overdue)).nextTickAt - due) % backgroundIntervalMs, 0);
  } finally {
    await stopWorkers();
    await Promise.all(workers.map(w => w.close()));
    await client.close(); await otherClient.close(); await db.close(); await env.teardown();
  }
});

test('full Temporal server: an hourly timer survives every Worker stopping and resumes once on a new Worker', { timeout: 60000 }, async () => {
  const env = await TestWorkflowEnvironment.createLocal({ server: { executable: { type: 'existing-path', path: execFileSync('which', ['temporal'], { encoding: 'utf8' }).trim() } } });
  const db = createDatabase(process.env.DATABASE_URL!);
  const config = { address: env.address, namespace: 'default', taskQueue: `background-restart-${randomUUID()}` };
  const client = await createBackgroundClient(config);
  const workers: Array<Awaited<ReturnType<typeof createTemporalWorker>>> = [];
  const runs: Promise<void>[] = [];
  const userId = '00000000-0000-4000-8000-000000000001';
  const h = client.client.workflow.getHandle(backgroundWorkflowId(userId));
  const state = () => h.query<BackgroundStatus>('backgroundState');
  async function start() {
    const w = await createTemporalWorker(config, createBackgroundActivities(new BackgroundUserRepository(db.db)));
    workers.push(w); runs.push(w.worker.run());
    return w;
  }
  try {
    const first = await start();
    const due = Date.now() + 2000;
    await client.client.workflow.start('userBackgroundWorkflow', {
      workflowId: backgroundWorkflowId(userId), taskQueue: config.taskQueue, args: [{ userId, nextTickAt: due }],
    });
    assert.equal((await state()).ticks, 0);
    first.worker.shutdown(); await runs[0];
    await delay(2500);
    assert.equal((await h.describe()).status.name, 'RUNNING');
    await start(); await start();
    await Promise.all([client.ensure(userId), client.ensure(userId)]);
    await until(async () => (await state()).ticks === 1);
    assert.equal((await state()).lastTick?.status, 'empty');
    assert.equal((await state()).nextTickAt, due + backgroundIntervalMs);
    await delay(300); assert.equal((await state()).ticks, 1);
  } finally {
    for (const w of workers) if (w.worker.getState() === 'RUNNING') w.worker.shutdown();
    await Promise.all(runs); await Promise.all(workers.map(w => w.close()));
    await client.close(); await db.close(); await env.teardown();
  }
});
