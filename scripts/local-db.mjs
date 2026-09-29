import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.local', 'postgres');
const data = join(directory, 'data');
const command = process.argv[2];
if (!['start', 'stop', 'status'].includes(command)) throw new Error('Use local-db.mjs start|stop|status');

async function exists(path) { try { await access(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function run(command, args, capture = false) {
  const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  let output = '';
  if (capture) for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit');
  return { code, output };
}
async function required(command, args) {
  const result = await run(command, args);
  if (result.code !== 0) throw new Error(`PostgreSQL command failed with exit ${result.code}`);
}
async function findBin() {
  const paths = process.env.PG_BIN ? [process.env.PG_BIN] : [
    ...(process.env.PATH ?? '').split(delimiter),
    '/opt/homebrew/opt/postgresql@18/bin', '/opt/homebrew/opt/postgresql@17/bin',
    '/usr/local/opt/postgresql@18/bin', '/usr/lib/postgresql/18/bin', '/usr/lib/postgresql/17/bin',
  ];
  for (const path of paths) {
    if (await exists(join(path, 'postgres')) && await exists(join(path, 'initdb'))) return path;
  }
  throw new Error('Install PostgreSQL server binaries or set PG_BIN');
}

const bin = await findBin();
const ctl = join(bin, 'pg_ctl');
const marker = join(directory, 'instant.json');
let settings;
if (await exists(marker)) {
  settings = JSON.parse(await readFile(marker, 'utf8'));
  if (settings.owner !== 'instant-local-development' || !Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) throw new Error('Invalid Instant database ownership marker');
} else {
  if (command !== 'start') { console.log('Instant local database is not initialized.'); process.exit(0); }
  if (await exists(data)) throw new Error('Unrecognized PostgreSQL directory; refusing to initialize it');
  const port = Number(process.env.INSTANT_PG_PORT ?? 55432);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INSTANT_PG_PORT must be 1024–65535');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  settings = { owner: 'instant-local-development', port };
  await writeFile(marker, JSON.stringify(settings), { flag: 'wx', mode: 0o600 });
}

if (command === 'status') {
  const result = await run(ctl, ['-D', data, 'status'], true);
  console.log(result.output.trim());
  process.exitCode = result.code === 0 ? 0 : 1;
} else if (command === 'stop') {
  const status = await run(ctl, ['-D', data, 'status'], true);
  if (status.code === 0) await required(ctl, ['-D', data, '-m', 'fast', '-w', 'stop']);
  else console.log('Instant local database is already stopped.');
} else {
  if (!await exists(join(data, 'PG_VERSION'))) await required(join(bin, 'initdb'), ['-D', data, '-U', 'instant', '-A', 'trust', '--encoding=UTF8', '--no-locale']);
  const status = await run(ctl, ['-D', data, 'status'], true);
  if (status.code !== 0) {
    // No global service, no shared database, and no publicly reachable listener.
    await required(ctl, ['-D', data, '-l', join(directory, 'postgres.log'), '-w', '-o', `-h 127.0.0.1 -p ${settings.port} -k ''`, 'start']);
  }
  const connection = ['-h', '127.0.0.1', '-p', String(settings.port), '-U', 'instant'];
  const check = await run(join(bin, 'psql'), [...connection, '-d', 'postgres', '-Atc', "SELECT 1 FROM pg_database WHERE datname = 'instant_development'"], true);
  if (check.code !== 0) throw new Error('Cannot inspect the local Instant database');
  if (check.output.trim() !== '1') await required(join(bin, 'createdb'), [...connection, 'instant_development']);
  console.log(`Instant PostgreSQL ready: postgresql://instant@127.0.0.1:${settings.port}/instant_development`);
  console.log('Use .env.example for API/Worker configuration. Data remains in .local/postgres after stop.');
}
