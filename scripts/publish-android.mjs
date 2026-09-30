import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../server/downloads/worker.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'https://impo.ai';
const bucket = 'impo-android-releases';
const config = join(root, 'server/downloads/wrangler.jsonc');
const args = process.argv.slice(2);
if (args.some(arg => !['--check'].includes(arg))) throw new Error('Usage: npm run publish:android [-- --check]');
const apk = join(root, 'android/app/build/outputs/apk/release/app-release.apk');
if (!existsSync(apk)) throw new Error('Build the signed APK first: npm run build:android:release');
const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), 'Library/Android/sdk'), '/opt/homebrew/share/android-commandlinetools']
  .find(path => path && existsSync(join(path, 'build-tools')));
if (!sdk) throw new Error('Set ANDROID_HOME to an installed Android SDK.');
const buildTools = readdirSync(join(sdk, 'build-tools')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  .map(version => join(sdk, 'build-tools', version)).find(path => existsSync(join(path, 'apksigner')) && existsSync(join(path, 'aapt2')));
if (!buildTools) throw new Error('Install Android SDK Build Tools.');
const java = [process.env.JAVA_HOME, '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home', '/usr/lib/jvm/java-17-openjdk-amd64']
  .find(path => path && existsSync(join(path, 'bin/java')));
const env = { ...process.env, ...(java ? { JAVA_HOME: java, PATH: `${java}/bin:${process.env.PATH}` } : {}) };
function output(binary, arguments_) {
  return execFileSync(binary, arguments_, { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function wrangler(arguments_) {
  execFileSync('wrangler', [...arguments_, '--config', config], { cwd: root, env, stdio: 'inherit' });
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function remoteHash(url) {
  console.log(`Downloading and verifying ${url}`);
  const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(900_000) });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/vnd.android.package-archive'))
    throw new Error(`APK download failed: HTTP ${response.status} (${url})`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) { hash.update(chunk); size += chunk.byteLength; }
  console.log(`Verified download bytes: ${size}`);
  return { sha256: hash.digest('hex'), size };
}
async function currentManifest() {
  const response = await fetch(`${base}/android/latest.json`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
    throw new Error('The download Worker must be deployed and healthy before publishing.');
  const manifest = validateManifest(await response.json());
  if (!manifest) throw new Error('Published release metadata is invalid; stop and investigate.');
  return manifest;
}

// Inspect an immutable private snapshot, so another build cannot change upload bytes.
const staging = join(root, '.local/android/releases', `staging-${process.pid}`);
mkdirSync(staging, { recursive: true, mode: 0o700 });
const snapshot = join(staging, 'impo.apk');
copyFileSync(apk, snapshot);
const badging = output(join(buildTools, 'aapt2'), ['dump', 'badging', snapshot]);
const identity = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m.exec(badging);
if (!identity || identity[1] !== 'ai.impo.android' || /^application-debuggable/m.test(badging))
  throw new Error('Only the non-debuggable ai.impo.android release package may be published.');
const certificate = output(join(buildTools, 'apksigner'), ['verify', '--verbose', '--print-certs', snapshot]);
const certificateSha256 = /^Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})$/mi.exec(certificate)?.[1]?.toLowerCase();
if (!certificateSha256 || /Android Debug/i.test(certificate) || /^Signer #2 certificate/m.test(certificate))
  throw new Error('APK must have one verified non-debug release signing identity.');
const sha256 = await hashFile(snapshot);
const versionName = identity[3];
const versionCode = Number(identity[2]);
const manifest = validateManifest({
  versionName, versionCode, sha256, size: statSync(snapshot).size, certificateSha256,
  packageName: identity[1], objectKey: `android/releases/${versionName}-${versionCode}/impo.apk`,
  publishedAt: new Date().toISOString(),
});
if (!manifest) throw new Error('APK version or manifest fields are invalid.');
const archived = join(root, '.local/android/releases', `${versionName}-${versionCode}`, sha256);
mkdirSync(archived, { recursive: true, mode: 0o700 });
const manifestPath = join(archived, 'latest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ...manifest, downloadUrl: `${base}/android.apk` }, null, 2));
if (args.includes('--check')) { rmSync(staging, { recursive: true }); process.exit(0); }

// Serialize this workstation's publishers. Other machines must coordinate too;
// the pointer check below detects changes but is not a distributed lock.
const lock = join(root, '.local/android/releases/publish.lock');
try { mkdirSync(lock, { mode: 0o700 }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  throw new Error(`Another publication holds ${lock}. Check its owner.json; remove a stale lock only after confirming that publisher stopped.`);
}
process.once('exit', () => rmSync(lock, { recursive: true, force: true }));
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));
writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });

const previous = await currentManifest();
if (previous) {
  if (previous.certificateSha256 !== certificateSha256)
    throw new Error('Signing key changed. Existing users could not update; publication stopped.');
  if (versionCode <= previous.versionCode) {
    if (versionCode === previous.versionCode && versionName === previous.versionName && sha256 === previous.sha256) {
      const checked = await remoteHash(`${base}/android.apk`);
      if (checked.sha256 !== sha256 || checked.size !== manifest.size) throw new Error('Existing download integrity mismatch.');
      console.log(`Already published and verified: ${base}/android.apk`);
      rmSync(staging, { recursive: true });
      process.exit(0);
    }
    throw new Error(`Increase IMPO_ANDROID_VERSION_CODE above ${previous.versionCode} and rebuild.`);
  }
  writeFileSync(join(archived, 'previous.json'), JSON.stringify(previous, null, 2) + '\n');
}

const versionUrl = `${base}/${manifest.objectKey}`;
const existing = await fetch(versionUrl, { method: 'HEAD', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000) });
if (existing.status === 404) {
  wrangler(['r2', 'object', 'put', `${bucket}/${manifest.objectKey}`, '--remote', '--file', snapshot,
    '--content-type', 'application/vnd.android.package-archive', '--content-disposition', `attachment; filename="impo-${versionName}.apk"`,
    '--cache-control', 'public, max-age=31536000, immutable']);
} else if (!existing.ok) throw new Error(`Could not inspect archived APK: HTTP ${existing.status}`);
// Never replace an existing version object. Prove all bytes before moving latest.
const uploaded = await remoteHash(versionUrl);
if (uploaded.sha256 !== sha256 || uploaded.size !== manifest.size)
  throw new Error('Archived APK differs from the signed local artifact; latest was not changed.');
const beforePromotion = await currentManifest();
if (JSON.stringify(beforePromotion) !== JSON.stringify(previous))
  throw new Error('Another release changed latest during upload; publication stopped.');
wrangler(['r2', 'object', 'put', `${bucket}/android/latest.json`, '--remote', '--file', manifestPath,
  '--content-type', 'application/json', '--cache-control', 'no-store']);
const published = await currentManifest();
if (published?.sha256 !== sha256 || published?.versionCode !== versionCode)
  throw new Error('Latest release metadata did not match the published artifact.');
const downloaded = await remoteHash(`${base}/android.apk`);
if (downloaded.sha256 !== sha256 || downloaded.size !== manifest.size)
  throw new Error('Public download integrity verification failed.');
writeFileSync(join(archived, 'verified.json'), JSON.stringify({ ...manifest, verifiedAt: new Date().toISOString(), downloadUrl: `${base}/android.apk`, versionUrl }, null, 2) + '\n');
console.log(`Published and downloaded SHA-256-verified APK: ${base}/android.apk`);
rmSync(staging, { recursive: true });
