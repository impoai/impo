import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rebyte = process.argv.includes('--rebyte');
const devices = process.argv.includes('--devices');
const connectors = process.argv.includes('--connectors');
const batches = process.argv.includes('--listening-batches');
const background = process.argv.includes('--background');
const today = process.argv.includes('--today');
const listening = process.argv.includes('--listening');
const live = process.argv.includes('--live');
const memory = process.argv.includes('--memory');
if (live && !process.env.REBYTE_API_KEY) throw new Error('REBYTE_API_KEY is required for live acceptance');
const children = new Set();
let cluster;
let pgBin;
let started = false;
let interrupted = false;

async function run(command, args, options = {}) {
  const { expectOutput, ...spawnOptions } = options;
  let output = '';
  const proc = spawn(command, args, {
    cwd: join(root, 'server'), stdio: expectOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit', detached: true, ...spawnOptions,
  });
  if (expectOutput) {
    for (const [source, destination] of [[proc.stdout, process.stdout], [proc.stderr, process.stderr]]) {
      source.on('data', chunk => { output += chunk.toString(); destination.write(chunk); });
    }
  }
  children.add(proc);
  try {
    const [code, signal] = await once(proc, 'exit');
    if (code !== 0) throw new Error(`${command} failed (${signal ?? code})`);
    if (expectOutput && !expectOutput.test(output)) throw new Error(`${command} did not report the expected schema result`);
  } finally {
    children.delete(proc);
  }
}

async function stopChildren() {
  await Promise.all([...children].map(async proc => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = once(proc, 'exit');
    const kill = signal => {
      try { process.kill(-proc.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    kill('SIGTERM');
    const timeout = setTimeout(() => kill('SIGKILL'), 5000);
    timeout.unref();
    try { await exited; } finally { clearTimeout(timeout); }
  }));
}

async function findPostgres() {
  const candidates = process.env.PG_BIN ? [process.env.PG_BIN] : [
    ...(process.env.PATH ?? '').split(delimiter),
    '/opt/homebrew/opt/postgresql@18/bin', '/opt/homebrew/opt/postgresql@17/bin',
    '/usr/local/opt/postgresql@18/bin', '/usr/local/opt/postgresql@17/bin',
    '/usr/lib/postgresql/18/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin',
  ];
  for (const candidate of candidates) {
    try {
      await Promise.all(['postgres', 'initdb', 'pg_ctl', 'createdb'].map(name => access(join(candidate, name), 1)));
      return candidate;
    } catch { /* A PostgreSQL client installation alone cannot run these tests. */ }
  }
  throw new Error('PostgreSQL server binaries are required. Install postgresql@18 or set PG_BIN; database tests never skip.');
}

async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function cleanup() {
  await stopChildren();
  if (started) {
    let hasPostmaster = false;
    try { await access(join(cluster, 'data', 'postmaster.pid')); hasPostmaster = true; } catch { /* Startup may have failed. */ }
    if (hasPostmaster) {
      await run(join(pgBin, 'pg_ctl'), ['-D', join(cluster, 'data'), '-m', 'immediate', '-w', '-t', '15', 'stop']);
    }
    started = false;
  }
  if (cluster) {
    await rm(cluster, { recursive: true, force: true });
    cluster = undefined;
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    interrupted = true;
    try { await cleanup(); }
    catch (error) { console.error(error.message); }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

try {
  pgBin = await findPostgres();
  // This harness always owns its database, even if the caller has DATABASE_URL set.
  cluster = await mkdtemp(join(tmpdir(), 'instant-pg-'));
  await chmod(cluster, 0o700);
  const port = await freePort();
  await run(join(pgBin, 'initdb'), ['-D', join(cluster, 'data'), '-U', 'instant', '-A', 'trust', '--encoding=UTF8', '--no-locale']);
  // Mark before startup so failure/interruption also attempts to stop a started server.
  started = true;
  await run(join(pgBin, 'pg_ctl'), [
    '-D', join(cluster, 'data'), '-l', join(cluster, 'postgres.log'), '-w', '-t', '15',
    '-o', `-h 127.0.0.1 -p ${port} -k '${cluster.replaceAll("'", "'\\''")}'`, 'start',
  ]);
  await run(join(pgBin, 'createdb'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'instant', 'instant_test']);
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://instant@127.0.0.1:${port}/instant_test`,
    INSTANT_AUTH_MODE: 'local-dev', INSTANT_RUNTIME: 'development', NODE_ENV: 'test',
  };
  console.log('\nDatabase acceptance → isolated PostgreSQL cluster, real API and Worker processes');
  await run('npm', ['run', 'db:push'], { env, expectOutput: /Changes applied/i });
  await run(process.execPath, ['--import', 'tsx', 'src/db/seed.ts'], { env });
  // Re-running setup must leave an existing database usable, without duplicate seeds.
  await run('npm', ['run', 'db:push'], { env, expectOutput: /No changes detected/i });
  await run(process.execPath, ['--import', 'tsx', 'src/db/seed.ts'], { env });
  await run(process.execPath, ['--import', 'tsx', '--test', memory ? 'test/memory.integration.ts' : today ? 'test/today.integration.ts' : background ? 'test/background.integration.ts' : batches ? 'test/listening-batches.integration.ts' : listening ? 'test/listening.integration.ts' : live ? 'test/rebyte.live.ts' : connectors ? 'test/connectors.integration.ts' : devices ? 'test/devices.integration.ts' : rebyte ? 'test/rebyte.integration.ts' : 'test/database.integration.ts'], { env });
  console.log(memory ? '\nPASS: Memory consolidation over chat and Echo evidence: planner deferral, bounded windows, idempotent add/update/delete, failure skip and expiry sweep.' : today ? '\nPASS: Today scheduling, append-only editions, ownership, source invalidation and real SDK recovery against a protocol double.' : background
    ? '\nPASS: per-user hourly Temporal lifecycle, empty ticks, Continue-As-New, Worker recovery and extension isolation.'
    : batches
    ? '\nPASS: real Temporal, two API clients/two Workers, independent admission, direct upload confirmation, retry, deletion and restart.'
    : listening
    ? '\nPASS: durable Listening uploads, ownership, transcription leases/retries and deletion against isolated PostgreSQL.'
    : live
    ? '\nPASS: Swift ↔ persistent API/Worker/PostgreSQL ↔ remote Rebyte (real development organization).'
    : connectors
    ? '\nPASS: durable connector tools ↔ real API/Worker/PostgreSQL ↔ local Composio/Rebyte doubles (no real account changes).'
    : devices
    ? '\nPASS: durable device grants/receipts ↔ real API/Worker/PostgreSQL ↔ Rebyte SDK (explicit synthetic device data; no native access).'
    : rebyte
    ? '\nPASS: PostgreSQL ↔ persistent API/Worker ↔ Rebyte SDK (local protocol double; no remote model call).'
    : '\nPASS: PostgreSQL ↔ persistent API ↔ independent Worker (development runtime).');
} catch (error) {
  console.error(error.message);
  if (cluster) {
    try { console.error(await readFile(join(cluster, 'postgres.log'), 'utf8')); } catch { /* initdb may not have run. */ }
  }
  process.exitCode = 1;
} finally {
  if (!interrupted) await cleanup();
}
