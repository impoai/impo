import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pages from '../../site/_worker.js';

test('Pages delegates every other route to ASSETS with the original request and response', async () => {
  for (const path of ['/', '/privacy/', '/terms/', '/assets/site.css', '/android.apk.backup', '/android/latest.json/extra', '/android/releases/invalid', '/android/releases/0.1.0-0/impo.apk']) {
    const request = new Request(`https://impo.ai${path}?preserve=query`, { method: 'HEAD', headers: { 'If-None-Match': '"asset-version"' } });
    const response = new Response(null, { status: 304, headers: { ETag: '"asset-version"' } });
    let forwarded;
    const result = await pages.fetch(request, {
      ASSETS: { fetch: original => { forwarded = original; return response; } },
      get ANDROID_RELEASES() { throw new Error('Website requests must never access releases'); },
    });
    assert.equal(forwarded, request, path);
    assert.equal(result, response, path);
  }
});

test('Pages sends only the exact download paths to the shared R2 handler, never asset HTML', async () => {
  const calls = [];
  const env = {
    ANDROID_RELEASES: {
      get: async key => { calls.push(['get', key]); return null; },
      head: async key => { calls.push(['head', key]); return null; },
    },
    ASSETS: { fetch() { throw new Error('Download requests must not fall through to the website'); } },
  };
  for (const path of ['/android.apk', '/android/latest.json', '/android/releases/0.2.0-beta.1-2/impo.apk']) {
    const response = await pages.fetch(new Request(`https://impo.ai${path}?release=latest`), env);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  }
  assert.deepEqual(calls, [['get', 'android/latest.json'], ['get', 'android/latest.json'], ['head', 'android/releases/0.2.0-beta.1-2/impo.apk']]);
  const rejected = await pages.fetch(new Request('https://impo.ai/android.apk', { method: 'PUT' }), env);
  assert.equal(rejected.status, 405);
  assert.equal(calls.length, 3);
});

test('Pages invocation routes keep ordinary static assets outside the Function', async () => {
  const routes = JSON.parse(await readFile(new URL('../../site/_routes.json', import.meta.url), 'utf8'));
  assert.deepEqual(routes, { version: 1, include: ['/android.apk', '/android/latest.json', '/android/releases/*'], exclude: [] });
});
