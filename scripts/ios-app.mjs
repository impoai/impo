import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const [action, ...arguments_] = process.argv.slice(2);
const actions = ['generate', 'build', 'test', 'install', 'launch'];

function usage() {
  console.error('Usage: node scripts/ios-app.mjs generate|build|test|install|launch [--simulator UDID | --device UDID]');
  console.error('Build defaults to a generic iOS Simulator. Test requires a Simulator; install/launch require an explicit physical device.');
  process.exitCode = 1;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

async function main() {
  if (!actions.includes(action)) { usage(); return; }
  let destinationKind;
  let identifier;
  if (arguments_.length) {
    if (arguments_.length !== 2 || !['--simulator', '--device'].includes(arguments_[0]) || !/^[A-Fa-f0-9-]+$/.test(arguments_[1])) {
      usage(); return;
    }
    [destinationKind, identifier] = arguments_;
  }
  if (action === 'generate' && destinationKind) { usage(); return; }
  if (action === 'test' && destinationKind !== '--simulator') { usage(); return; }
  if (['install', 'launch'].includes(action) && destinationKind !== '--device') { usage(); return; }

  const device = destinationKind === '--device';
  const derivedData = join(root, 'ios/DerivedData', device ? `App-Device-${identifier}` : 'App-Simulator-Signed');
  if (action === 'install') {
    const app = join(derivedData, 'Build/Products/Debug-iphoneos/Instant.app');
    await access(app).catch(() => { throw new Error('Build the device app first with: node scripts/ios-app.mjs build --device <UDID>'); });
    await run('codesign', ['--verify', '--deep', '--strict', app]);
    await run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', identifier, app]);
    return;
  }
  if (action === 'launch') {
    await run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', identifier, 'ai.impo']);
    return;
  }

  await run('xcodegen', ['generate', '--spec', 'ios/App/project.yml']);
  if (action === 'generate') return;
  const destination = identifier
    ? `platform=${device ? 'iOS' : 'iOS Simulator'},id=${identifier}`
    : 'generic/platform=iOS Simulator';
  const args = [
    '-quiet', '-project', 'ios/App/Instant.xcodeproj', '-scheme', 'Instant',
    '-configuration', 'Debug', '-destination', destination, '-derivedDataPath', derivedData,
  ];
  if (device) args.push('-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration');
  // HealthKit requires the entitlement even on Simulator. Disabling signing
  // produces a runnable app whose Health authorization always fails.
  else args.push('CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-');
  if (action === 'test') {
    args.push(
      '-parallel-testing-enabled', 'NO', '-collect-test-diagnostics', 'never',
      '-test-timeouts-enabled', 'YES', '-default-test-execution-time-allowance', '180',
      '-resultBundlePath', join(root, 'ios/DerivedData', `App-UI-${Date.now()}.xcresult`), 'test',
    );
  } else args.push('build');
  await run('xcodebuild', args);
}

void main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
