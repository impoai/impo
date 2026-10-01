import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
import { validateRelease } from './app-releases.mjs';

const release = { schemaVersion: 1, platform: 'ios', channel: 'testflight', latest: {
  version: '1.0', build: 49, minimumSystemVersion: '18.0', url: 'https://testflight.apple.com/join/Wgkx6k3V', expiresAt: '2099-01-01T00:00:00Z',
} };
function fixture(stored, artifact = { size: 10 }) {
  return { ANDROID_RELEASES: {
    get: async () => stored === null ? null : { size: JSON.stringify(stored).length, body: new ReadableStream(), json: async () => stored },
    head: async () => artifact,
  } };
}
const request = (key, method = 'GET') => new Request(`https://impo.ai/app-releases/${key}.json`, { method });
test('public releases isolate platform/channel, hide expired betas and reject unsafe destinations', () => {
  assert.deepEqual(validateRelease(release, 'ios-testflight'), release);
  assert.equal(validateRelease(release, 'ios-app-store'), null);
  assert.equal(validateRelease(release, 'android-apk'), null);
  for (const bad of [{ build: 0 }, { build: 2147483648 }, { build: '50' }, { url: 'https://impo.ai.evil.test/android.apk' }, { version: 'hello' }, { minimumSystemVersion: '' }, { expiresAt: null }])
    assert.equal(validateRelease({ ...release, latest: { ...release.latest, ...bad } }, 'ios-testflight'), null);
  assert.equal(validateRelease(release, 'ios-testflight', Date.parse('2100-01-01')).latest, null);
});
test('release reads are public, uncached and strictly read-only; missing channels return no update', async () => {
  let response = await worker.fetch(request('ios-testflight'), fixture(release));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), release);
  response = await worker.fetch(request('ios-app-store'), fixture(null));
  assert.deepEqual(await response.json(), { schemaVersion: 1, platform: 'ios', channel: 'app-store', latest: null });
  assert.equal(await (await worker.fetch(request('ios-testflight', 'HEAD'), fixture(release))).text(), '');
  assert.equal((await worker.fetch(request('ios-testflight', 'PUT'), fixture(release))).status, 405);
  assert.equal((await worker.fetch(request('private'), fixture(release))).status, 404);
  assert.equal((await worker.fetch(request('ios-testflight'), fixture({ ...release, schemaVersion: 2 }))).status, 503);
});
test('Android latest follows the verified APK pointer and requires a compatible artifact manifest', async () => {
  const manifest = { versionName: '0.1.5', versionCode: 6, minimumSdk: 28, size: 10, sha256: 'a'.repeat(64), certificateSha256: 'b'.repeat(64), packageName: 'ai.impo.android', objectKey: 'android/releases/0.1.5-6/impo.apk', publishedAt: '2026-10-01T00:00:00Z' };
  const response = await worker.fetch(request('android-apk'), fixture(manifest));
  assert.deepEqual(await response.json(), { schemaVersion: 1, platform: 'android', channel: 'apk', latest: { version: '0.1.5', build: 6, minimumSystemVersion: '28', url: 'https://impo.ai/android.apk' } });
  assert.equal((await worker.fetch(request('android-apk'), fixture(manifest, null))).status, 503);
  assert.equal((await worker.fetch(request('android-apk'), fixture({ ...manifest, minimumSdk: undefined }))).status, 503);
});
