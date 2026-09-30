import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] ?? 'build';
const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), 'Library/Android/sdk'), '/opt/homebrew/share/android-commandlinetools'].find(p => p && existsSync(join(p, 'platform-tools/adb')));
const java = [process.env.JAVA_HOME, '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home', '/usr/lib/jvm/java-17-openjdk-amd64'].find(p => p && existsSync(join(p, 'bin/java')));
if (command !== 'fixture' && (!java || (!sdk && command !== 'client-test'))) throw new Error('Install JDK 17 and, for app commands, the Android SDK; set JAVA_HOME and ANDROID_HOME. See android/README.md.');
const env = { ...process.env, ...(sdk ? { ANDROID_HOME: sdk } : {}), ...(java ? { JAVA_HOME: java, PATH: `${java}/bin:${process.env.PATH}` } : {}) };
const serial = process.env.IMPO_ANDROID_SERIAL ?? 'emulator-5584';
const adb = sdk ? join(sdk, 'platform-tools/adb') : '';
const app = 'ai.impo.android.debug';
const local = join(root, '.local/android');
mkdirSync(local, { recursive: true });
function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, env, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${binary} exited with ${code}`)));
  });
}
function read(binary, args) {
  const r = spawnSync(binary, args, { env, encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : '';
}
const gradleBinary = process.env.IMPO_GRADLE_BIN || join(root, 'android/gradlew');
const gradle = (...args) => run(gradleBinary, ['-p', join(root, 'android'), '--console=plain', ...args]);
const device = (...args) => run(adb, ['-s', serial, ...args]);
async function initializeSigning() {
  const directory = join(local, 'release');
  const properties = join(directory, 'signing.properties');
  const keystore = join(directory, 'impo-release.jks');
  if (existsSync(properties) || existsSync(keystore)) {
    if (!existsSync(properties) || !existsSync(keystore)) throw new Error('Signing setup is incomplete. Restore the existing release key/properties; initialization never replaces them.');
    console.log(`Reusing existing release signing material in ${directory}; no files changed.`);
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const password = randomBytes(36).toString('base64url');
  const base = `storeFile=../.local/android/release/impo-release.jks\nstorePassword=${password}\nkeyAlias=impo\nkeyPassword=${password}\n`;
  // Save the password before creating the key, so interrupted initialization is recoverable.
  writeFileSync(properties, base, { flag: 'wx', mode: 0o600 });
  const signingEnv = { ...env, IMPO_SIGNING_PASSWORD: password };
  const keytool = join(java, 'bin/keytool');
  await run(keytool, ['-genkeypair', '-alias', 'impo', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=Impo Android, O=Impo', '-storetype', 'PKCS12', '-keystore', keystore, '-storepass:env', 'IMPO_SIGNING_PASSWORD', '-keypass:env', 'IMPO_SIGNING_PASSWORD'], { env: signingEnv });
  chmodSync(keystore, 0o600);
  const certificate = spawnSync(keytool, ['-exportcert', '-alias', 'impo', '-keystore', keystore, '-storepass:env', 'IMPO_SIGNING_PASSWORD'], { env: signingEnv, timeout: 15000 });
  if (certificate.status !== 0 || !certificate.stdout?.length) throw new Error('Key was preserved, but certificate export failed. Repair signing metadata without replacing the key.');
  const fingerprint = createHash('sha256').update(certificate.stdout).digest('hex');
  writeFileSync(properties, `${base}certificateSha256=${fingerprint}\n`, { mode: 0o600 });
  console.log(`Created persistent release signing key. Back up ${directory} securely.\nPublic certificate SHA-256: ${fingerprint}`);
}
async function emulator() {
  if (read(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']) === '1') return;
  const avd = 'Impo_API_35';
  if (!read(join(sdk, 'emulator/emulator'), ['-list-avds']).split('\n').includes(avd)) {
    const manager = join(sdk, 'cmdline-tools/latest/bin/avdmanager');
    await run(manager, ['create', 'avd', '-n', avd, '-k', 'system-images;android-35;google_apis;arm64-v8a', '-d', 'pixel_7'], { stdio: ['ignore', 'inherit', 'inherit'] });
  }
  if (!read(adb, ['devices']).includes(serial)) {
    const log = openSync(join(local, 'emulator.log'), 'a');
    const child = spawn(join(sdk, 'emulator/emulator'), ['-avd', avd, '-port', serial.split('-')[1], '-no-snapshot-load', '-no-snapshot-save', '-no-metrics', '-crash-report-mode', 'never', '-gpu', process.env.IMPO_ANDROID_GPU ?? 'auto', '-audio', process.env.IMPO_ANDROID_AUDIO ?? 'none', '-no-boot-anim'], { env, detached: true, stdio: ['ignore', log, log] });
    child.unref();
  }
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    if (read(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']) === '1') {
      await device('shell', 'input', 'keyevent', '82');
      console.log(`Android Emulator ready: ${serial}`); return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Emulator did not boot. Inspect ${local}/emulator.log`);
}
async function launch(fixture = false) {
  await emulator();
  await device('install', '-r', join(root, 'android/app/build/outputs/apk/debug/app-debug.apk'));
  if (fixture) await device('reverse', 'tcp:3011', 'tcp:3011');
  await device('shell', 'am', 'start', '-n', `${app}/ai.impo.MainActivity`, ...(fixture ? ['--es', 'impo.test.api', 'http://127.0.0.1:3011'] : []));
}
switch (command) {
  case 'build': await gradle(':app:assembleDebug'); break;
  case 'signing-init': await initializeSigning(); break;
  case 'release': {
    const version = [];
    if (process.env.IMPO_ANDROID_VERSION_CODE) version.push(`-Pimpo.versionCode=${process.env.IMPO_ANDROID_VERSION_CODE}`);
    if (process.env.IMPO_ANDROID_VERSION_NAME) version.push(`-Pimpo.versionName=${process.env.IMPO_ANDROID_VERSION_NAME}`);
    await gradle(...version, ':app:assembleRelease');
    console.log('Signed release APK: android/app/build/outputs/apk/release/app-release.apk');
    break;
  }
  case 'test': await gradle(':client:test', ':app:testDebugUnitTest'); break;
  case 'client-test': await gradle('--configure-on-demand', ':client:test'); break;
  case 'lint': await gradle(':app:lintDebug'); break;
  case 'emulator': await emulator(); break;
  case 'launch': await launch(process.argv.includes('--fixture')); break;
  case 'fixture': await run(process.execPath, ['--import', 'tsx', 'scripts/android-ui-fixture.ts', '--port', '3011', '--public-host', '127.0.0.1']); break;
  case 'smoke': {
    await emulator();
    await device('reverse', 'tcp:3011', 'tcp:3011');
    const fixture = spawn(process.execPath, ['--import', 'tsx', 'scripts/android-ui-fixture.ts', '--port', '3011', '--public-host', '127.0.0.1'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
    let ready = false;
    let output = '';
    let startupError;
    fixture.once('error', error => { startupError = error; });
    fixture.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      output += chunk.toString();
      let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.event === 'android_fixture_ready' && event.url === 'http://127.0.0.1:3011') ready = true;
        } catch { /* Ordinary server diagnostics are forwarded unchanged. */ }
      }
    });
    try {
      for (let i = 0; i < 100; i++) {
        if (startupError) throw startupError;
        if (fixture.exitCode !== null) throw new Error('Android fixture exited before readiness');
        if (ready) break;
        await new Promise(r => setTimeout(r, 200));
      }
      if (!ready) throw new Error('Android fixture was not ready');
      const testClass = process.env.IMPO_ANDROID_TEST_CLASS;
      await run(gradleBinary, ['-p', join(root, 'android'), '--console=plain', ...(testClass ? [`-Pandroid.testInstrumentationRunnerArguments.class=${testClass}`] : []), ':app:connectedDebugAndroidTest'], { env: { ...env, ANDROID_SERIAL: serial } });
    } finally { fixture.kill('SIGTERM'); }
    break;
  }
  default: throw new Error(`Unknown Android command: ${command}`);
}
