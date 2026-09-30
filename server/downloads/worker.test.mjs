import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker, { validateManifest } from './worker.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const uploaded = new Date('2026-09-30T08:00:00.000Z');
function fixture() {
  const objects = new Map(), calls = [];
  function put(key, text) { const bytes = Buffer.from(text); objects.set(key, { bytes, etag: digest(bytes) }); }
  function metadata(key) {
    const entry = objects.get(key);
    return entry && { key, etag: entry.etag, httpEtag: `"${entry.etag}"`, size: entry.bytes.length, uploaded };
  }
  const bucket = {
    async head(key) { calls.push(['head', key]); return metadata(key) ?? null; },
    async get(key, options) {
      calls.push(['get', key, options]);
      const info = metadata(key);
      if (!info) return null;
      if (options?.onlyIf && options.onlyIf.etagMatches !== info.etag) return info;
      const original = objects.get(key).bytes;
      const bytes = options?.range ? original.subarray(options.range.offset, options.range.offset + options.range.length) : original;
      const response = new Response(bytes);
      return { ...info, body: response.body, json: () => response.json() };
    },
  };
  function publish(versionName = '0.1.0', versionCode = 1, bytes = '0123456789') {
    const objectKey = `android/releases/${versionName}-${versionCode}/impo.apk`;
    const manifest = { versionName, versionCode, sha256: digest(bytes), size: Buffer.byteLength(bytes), certificateSha256: 'a'.repeat(64), packageName: 'ai.impo.android', objectKey, publishedAt: uploaded.toISOString() };
    put(objectKey, bytes); put('android/latest.json', JSON.stringify(manifest));
    return manifest;
  }
  const manifest = publish();
  const fetch = (path = '/android.apk', options) => worker.fetch(new Request(`https://impo.ai${path}`, options), { ANDROID_RELEASES: bucket });
  return { objects, calls, put, bucket, publish, manifest, fetch };
}

test('stable URL switches atomically with the pointer while historical releases stay immutable', async () => {
  const f = fixture();
  const first = await f.fetch();
  assert.equal(first.status, 200); assert.equal(await first.text(), '0123456789');
  assert.equal(first.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(first.headers.get('content-disposition'), 'attachment; filename="impo-0.1.0-1.apk"');
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const oldEtag = first.headers.get('etag');
  const next = f.publish('0.2.0-beta.1', 2, 'new release bytes');
  const current = await f.fetch('/android.apk', { headers: { 'If-None-Match': oldEtag } });
  assert.equal(current.status, 200); assert.equal(await current.text(), 'new release bytes');
  assert.equal((await f.fetch('/android/latest.json')).headers.get('cache-control'), 'no-store');
  assert.deepEqual(await (await f.fetch('/android/latest.json')).json(), next);
  f.objects.delete('android/latest.json'); // The publisher verifies history before promoting a pointer.
  const history = await f.fetch(`/${f.manifest.objectKey}`);
  assert.equal(await history.text(), '0123456789');
  assert.equal(history.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

test('HEAD and conditional validators avoid fetching APK bodies and never send a response body', async () => {
  const f = fixture();
  const head = await f.fetch('/android.apk', { method: 'HEAD', headers: { Range: 'bytes=1-2' } });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
  assert.equal(f.calls.filter(([method, key]) => method === 'get' && key.endsWith('.apk')).length, 0);
  for (const method of ['GET', 'HEAD']) {
    const response = await f.fetch('/android.apk', { method, headers: { 'If-None-Match': `"another", W/${head.headers.get('etag')}` } });
    assert.equal(response.status, 304); assert.equal(await response.text(), '');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const pointer = await f.fetch('/android/latest.json', { method: 'HEAD' });
  assert.equal(await pointer.text(), '');
  assert.ok(Number(pointer.headers.get('content-length')) > 0);
  const unchanged = await f.fetch('/android/latest.json', { headers: { 'If-None-Match': pointer.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
  assert.equal((await f.fetch('/android.apk', { headers: { 'If-None-Match': '*' } })).status, 304);
});

test('closed, open and suffix ranges preserve exact bytes and reject impossible or multi ranges', async () => {
  const f = fixture();
  for (const [header, expected, contentRange] of [
    ['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-99', '89', 'bytes 8-9/10'], ['bytes=-99', '0123456789', 'bytes 0-9/10'],
  ]) {
    const response = await f.fetch('/android.apk', { headers: { Range: header } });
    assert.equal(response.status, 206, header); assert.equal(await response.text(), expected);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(response.headers.get('content-length'), String(expected.length));
  }
  for (const value of ['bytes=10-', 'bytes=4-1', 'bytes=-0', 'bytes=1-2,4-5', 'bytes=-', 'items=0-1', 'bytes=99999999999999999999-']) {
    const response = await f.fetch('/android.apk', { headers: { Range: value } });
    assert.equal(response.status, 416, value); assert.equal(response.headers.get('content-range'), 'bytes */10');
  }
});

test('If-Range applies only for a matching strong ETag or an unmodified date', async () => {
  const f = fixture();
  const etag = (await f.fetch('/android.apk', { method: 'HEAD' })).headers.get('etag');
  for (const validator of [etag, uploaded.toUTCString()]) {
    const response = await f.fetch('/android.apk', { headers: { Range: 'bytes=0-1', 'If-Range': validator } });
    assert.equal(response.status, 206); assert.equal(await response.text(), '01');
  }
  for (const validator of [`W/${etag}`, '"old"', 'invalid date', 'Tue, 29 Sep 2026 08:00:00 GMT']) {
    const response = await f.fetch('/android.apk', { headers: { Range: 'bytes=0-1', 'If-Range': validator } });
    assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
  }
});

test('routes expose only permitted release objects and malformed pointers never select arbitrary keys', async () => {
  const f = fixture();
  assert.equal(validateManifest(null), null);
  assert.equal(validateManifest({ ...f.manifest, versionName: ['0.1.0'] }), null);
  assert.equal(validateManifest({ ...f.manifest, sha256: [f.manifest.sha256] }), null);
  for (const path of ['/android/', '/secrets', '/android/releases/0.1.0-0/impo.apk', '/android/releases/0.1.0-1/other.apk', '/android/releases/%2fprivate-1/impo.apk']) {
    assert.equal((await f.fetch(path)).status, 404, path);
  }
  assert.equal(f.calls.length, 0);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await f.fetch('/android.apk', { method });
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }
  for (const bad of [{ objectKey: 'private/signing-key' }, { size: -1 }, { sha256: 'bad' }, { certificateSha256: 'bad' }, { versionName: '../private' }, { packageName: 'ai.impo.android.debug' }, { versionCode: 0 }, { publishedAt: 'yesterday' }]) {
    f.put('android/latest.json', JSON.stringify({ ...f.manifest, ...bad }));
    const response = await f.fetch(); assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private|signing|yesterday/);
  }
  assert.equal(f.calls.filter(([method]) => method === 'head').length, 0);
  f.put('android/latest.json', JSON.stringify({ ...f.manifest, privateExtra: 'not public' }));
  assert.deepEqual(await (await f.fetch('/android/latest.json')).json(), f.manifest);
});

test('missing objects, R2 failure and a concurrent overwrite fail safely without mixed metadata', async () => {
  const f = fixture();
  f.objects.delete(f.manifest.objectKey);
  assert.equal((await f.fetch()).status, 503);
  assert.equal((await f.fetch(`/${f.manifest.objectKey}`)).status, 404);
  f.objects.delete('android/latest.json');
  assert.equal((await f.fetch()).status, 404);
  f.publish();
  f.put(f.manifest.objectKey, 'wrong size');
  f.put('android/latest.json', JSON.stringify({ ...f.manifest, size: 100 }));
  assert.equal((await f.fetch()).status, 503);
  f.publish();
  const get = f.bucket.get;
  f.bucket.get = async (key, options) => { if (key.endsWith('.apk')) f.put(key, 'replaced data'); return get(key, options); };
  const changed = await f.fetch();
  assert.equal(changed.status, 503); assert.equal(changed.headers.get('content-disposition'), null);
  f.bucket.get = async () => { throw new Error('private bucket/internal path'); };
  const failed = await f.fetch('/android.apk', { method: 'HEAD' });
  assert.equal(failed.status, 503); assert.equal(await failed.text(), '');
  f.bucket.get = get;
  f.bucket.head = async () => { throw new Error('private internal metadata error'); };
  assert.equal((await f.fetch(`/${f.manifest.objectKey}`)).status, 503);
  f.put('android/latest.json', 'broken JSON');
  assert.equal((await f.fetch('/android/latest.json')).status, 503);
  f.put('android/latest.json', JSON.stringify({ ...f.manifest, extra: 'x'.repeat(8192) }));
  assert.equal((await f.fetch('/android/latest.json')).status, 503);
});
