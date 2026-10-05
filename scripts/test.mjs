import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const swift = ['test', '--package-path', 'ios/Packages/InstantClient'];
const children = new Set();
const ios = process.argv.includes('--ios');
let simulator;
function simctl(...args) {
  return execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout: 30000 });
}
function cleanupSimulator() {
  if (!simulator) return;
  const id = simulator;
  const devices = Object.values(JSON.parse(simctl('list', 'devices', '-j')).devices).flat();
  if (devices.some(d => d.udid === id && d.state !== 'Shutdown')) simctl('shutdown', id);
  simctl('delete', id);
  simulator = undefined;
}
function child(command, args, options = {}) {
  const proc = spawn(command, args, { cwd: root, detached: process.platform !== 'win32', stdio: 'inherit', ...options });
  children.add(proc);
  proc.once('exit', () => children.delete(proc));
  return proc;
}
async function run(command, args, env = process.env, capture = false, cwd = root) {
  const proc = child(command, args, { env, cwd, ...(capture ? { stdio: ['ignore', 'pipe', 'pipe'] } : {}) });
  let output = '';
  if (capture) {
    for (const [stream, destination] of [[proc.stdout, process.stdout], [proc.stderr, process.stderr]]) {
      stream.on('data', data => { output += data; destination.write(data); });
    }
  }
  const [code, signal] = await once(proc, 'close');
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`);
  return output;
}
async function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = once(proc, 'exit');
  const kill = signal => {
    try {
      if (process.platform === 'win32') proc.kill(signal);
      else process.kill(-proc.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  kill('SIGTERM');
  const force = setTimeout(() => kill('SIGKILL'), 3000);
  force.unref();
  try { await exited; } finally { clearTimeout(force); }
}
function ensureSwiftTestsRan(output, label) {
  if (!/Executed [1-9]\d* tests?, with 0 failures/.test(output) || /with [1-9]\d* tests? skipped/.test(output)) {
    throw new Error(`Swift ${label} tests must execute at least one test with no skips`);
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await Promise.all([...children].map(stop));
    cleanupSimulator();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

let fixture;
try {
  const unitEnv = { ...process.env };
  delete unitEnv.INSTANT_TEST_BASE_URL;
  if (!ios && !process.argv.includes('--e2e-only')) {
    await run('npm', ['run', 'typecheck']);
    await run('npm', ['run', 'test:server']);
    await run('npm', ['run', 'typecheck:web']);
    await run('npm', ['run', 'test:web']);
    await run('npm', ['run', 'test:android:downloads']);
    const unitOutput = await run('swift', [...swift, '--filter', 'ProtocolTests|ConversationTests|DeviceToolRunnerTests'], unitEnv, true);
    ensureSwiftTestsRan(unitOutput, 'unit');
  }
  fixture = child(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: `${root}/server`, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const baseURL = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: fixture.stdout });
    const timeout = setTimeout(() => done(new Error('Fixture startup timed out')), 10000);
    const earlyExit = (code, signal) => done(new Error(`Fixture exited before ready (${signal ?? code})`));
    fixture.once('exit', earlyExit);
    fixture.once('error', done);
    function done(error, url) {
      clearTimeout(timeout);
      lines.close();
      fixture.off('exit', earlyExit);
      fixture.off('error', done);
      if (error) reject(error); else resolve(url);
    }
    lines.on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value.event === 'listening' && value.mode === 'fixture') done(null, value.url);
      } catch { /* Startup logs need not be JSON. */ }
    });
  });
  console.log(`\nSwift HTTP integration → ${baseURL}`);
  if (ios) {
    const runtimes = JSON.parse(simctl('list', 'runtimes', '-j')).runtimes;
    const runtime = runtimes.filter(r => r.isAvailable && r.identifier.includes('.iOS-'))
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
    const device = runtime?.supportedDeviceTypes.find(d => d.productFamily === 'iPhone');
    if (!runtime || !device) throw new Error('Install an iOS Simulator runtime in Xcode first');
    simulator = simctl('create', 'Instant Protocol Tests', device.identifier, runtime.identifier).trim();
    const resultPath = `${root}/ios/DerivedData/protocol-${Date.now()}.xcresult`;
    console.log(`Temporary Simulator: ${device.name} / ${runtime.name}`);
    await run('xcodebuild', [
      'test', '-scheme', 'InstantClient', '-destination', `platform=iOS Simulator,id=${simulator}`,
      '-skip-testing:InstantClientTests/RebyteLiveTests', // Opt-in real-provider suite is verified separately by test:live.
      '-parallel-testing-enabled', 'NO', '-derivedDataPath', `${root}/ios/DerivedData/InstantClient`,
      '-resultBundlePath', resultPath, 'CODE_SIGNING_ALLOWED=NO', '-quiet',
    ], { ...process.env, TEST_RUNNER_INSTANT_TEST_BASE_URL: new URL(baseURL).origin }, false,
    `${root}/ios/Packages/InstantClient`);
    const summary = JSON.parse(execFileSync('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', resultPath], { encoding: 'utf8' }));
    if (!(summary.passedTests > 0) || summary.failedTests !== 0 || summary.skippedTests !== 0) {
      throw new Error(`Simulator tests must run without skips: ${JSON.stringify(summary)}`);
    }
    const tree = JSON.parse(execFileSync('xcrun', ['xcresulttool', 'get', 'test-results', 'tests', '--path', resultPath], { encoding: 'utf8' }));
    const flatten = nodes => nodes.flatMap(n => [n, ...flatten(n.children ?? [])]);
    const integrations = flatten(tree.testNodes).filter(n => n.nodeIdentifier?.startsWith('IntegrationTests/'));
    if (integrations.length === 0 || integrations.some(n => n.result !== 'Passed') ||
        !summary.devicesAndConfigurations.some(d => d.device.platform === 'iOS Simulator' && d.device.deviceId === simulator)) {
      throw new Error('Expected real HTTP IntegrationTests on the requested iOS Simulator');
    }
    console.log(`Simulator: ${summary.passedTests} passed, no failures or skips. Results: ${resultPath}`);
  } else {
    const integrationOutput = await run('swift', [...swift, '--filter', 'IntegrationTests'], {
      ...process.env, INSTANT_TEST_BASE_URL: new URL(baseURL).origin,
    }, true);
    ensureSwiftTestsRan(integrationOutput, 'HTTP integration');
  }
  console.log('\nPASS: Swift ↔ HTTP/SSE ↔ TypeScript + Vercel AI SDK (fixture runtime).');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await stop(fixture);
  cleanupSimulator();
}
