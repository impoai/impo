// Publish only builds already available through the selected Apple channel.
// Signing credentials are read from the operator's environment/files, never stored.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseChannels, validateRelease } from '../server/downloads/app-releases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const channel = args.includes('--testflight') ? 'testflight' : args.includes('--app-store') ? 'app-store' : null;
if (!channel || args.some(arg => !['--testflight', '--app-store', '--check'].includes(arg)) || (args.includes('--testflight') && args.includes('--app-store')))
  throw new Error('Usage: npm run publish:ios:update -- (--testflight | --app-store) [--check]');
const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH } = process.env;
if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_PRIVATE_KEY_PATH) throw new Error('Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY_PATH in the release environment.');
const privateKey = readFileSync(ASC_PRIVATE_KEY_PATH, 'utf8');
const key = `ios-${channel}`;
const target = releaseChannels[key];
async function apple(path) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' })}.${encode({ iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`;
  const jwt = `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, { headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Apple release verification failed: HTTP ${response.status}`);
  return response.json();
}

let build, version;
if (channel === 'testflight') {
  const group = await apple('/v1/betaGroups/eda2a0cd-c068-48e4-8a23-2ca7eccd27f4');
  if (!group.data.attributes.publicLinkEnabled || group.data.attributes.publicLink !== target.url) throw new Error('Public TestFlight link is unavailable.');
  const members = await apple('/v1/betaGroups/eda2a0cd-c068-48e4-8a23-2ca7eccd27f4/builds?limit=200');
  const response = await apple('/v1/builds?filter[app]=6816377222&sort=-uploadedDate&limit=200&include=buildBetaDetail,preReleaseVersion');
  const eligible = response.data.filter(item => {
    const state = response.included?.find(detail => detail.type === 'buildBetaDetails' && detail.id === item.id)?.attributes.externalBuildState;
    return item.attributes.processingState === 'VALID' && !item.attributes.expired && Date.parse(item.attributes.expirationDate) > Date.now() &&
      ['BETA_APPROVED', 'IN_BETA_TESTING'].includes(state) && members.data.some(member => member.id === item.id);
  }).sort((a, b) => Number(b.attributes.version) - Number(a.attributes.version));
  build = eligible[0];
  if (build) version = response.included.find(item => item.type === 'preReleaseVersions' && item.id === build.relationships.preReleaseVersion.data.id)?.attributes.version;
} else {
  const response = await apple('/v1/apps/6816377222/appStoreVersions?filter[platform]=IOS&include=build&limit=200');
  const eligible = response.data.filter(item => ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'].includes(item.attributes.appStoreState))
    .map(item => ({ version: item.attributes.versionString, build: response.included?.find(entry => entry.type === 'builds' && entry.id === item.relationships.build.data?.id) }))
    .filter(item => item.build?.attributes.processingState === 'VALID')
    .sort((a, b) => Number(b.build.attributes.version) - Number(a.build.attributes.version));
  ({ build, version } = eligible[0] ?? {});
}
if (!build) throw new Error(`No available ${channel} release. Existing metadata was not changed.`);
const document = validateRelease({ schemaVersion: 1, platform: 'ios', channel, latest: {
  version, build: Number(build.attributes.version), url: target.url, minimumSystemVersion: build.attributes.minOsVersion,
  ...(channel === 'testflight' ? { expiresAt: build.attributes.expirationDate } : {}),
} }, key);
if (!document?.latest) throw new Error('Apple returned an invalid or expired release.');
const directory = resolve(root, '.local/app-releases');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = resolve(directory, `${key}.json`);
writeFileSync(file, JSON.stringify(document, null, 2) + '\n');
console.log(JSON.stringify({ ...document, appleBuildId: build.id, checkOnly: args.includes('--check') }, null, 2));
if (args.includes('--check')) process.exit(0);
const url = `https://impo.ai/app-releases/${key}.json`;
const read = async () => {
  const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Deploy the release endpoint before publishing.');
  const value = validateRelease(await response.json(), key);
  if (!value) throw new Error('Invalid published metadata.');
  return value;
};
const previous = await read();
if (previous.latest?.build > document.latest.build) throw new Error('Refusing to lower the published build number.');
if (JSON.stringify(previous) === JSON.stringify(document)) { console.log('Release metadata is already current.'); process.exit(0); }
if (previous.latest?.build === document.latest.build) throw new Error('Existing build metadata differs; investigate before replacing.');
writeFileSync(resolve(directory, `${key}-previous.json`), JSON.stringify(previous, null, 2) + '\n');
execFileSync('wrangler', ['r2', 'object', 'put', `impo-android-releases/app-releases/${key}.json`, '--remote', '--file', file,
  '--content-type', 'application/json', '--cache-control', 'no-store', '--config', resolve(root, 'server/downloads/wrangler.jsonc')], { cwd: root, stdio: 'inherit' });
if (JSON.stringify(await read()) !== JSON.stringify(document)) throw new Error('Published metadata verification failed.');
console.log(`Published and verified ${url}`);
