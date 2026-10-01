import { appReleaseResponse, releaseChannels } from './app-releases.mjs';
// Public, read-only facade over the dedicated private release metadata/APK bucket.
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RELEASE = /^\/android\/releases\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})-([1-9][0-9]*)\/impo\.apk$/;
const HASH = /^[a-fA-F0-9]{64}$/;
const APK = 'application/vnd.android.package-archive';
const LATEST = 'android/latest.json';
const NO_STORE = 'no-store';
const IMMUTABLE = 'public, max-age=31536000, immutable';

export function validateManifest(value) {
  if (!value || typeof value.versionName !== 'string' || !VERSION.test(value.versionName) || !Number.isSafeInteger(value.versionCode) || value.versionCode < 1 ||
      !Number.isSafeInteger(value.size) || value.size < 1 || typeof value.sha256 !== 'string' || !HASH.test(value.sha256) ||
      typeof value.certificateSha256 !== 'string' || !HASH.test(value.certificateSha256) ||
      value.packageName !== 'ai.impo.android' || typeof value.publishedAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.publishedAt) || !Number.isFinite(Date.parse(value.publishedAt)) ||
      value.objectKey !== `android/releases/${value.versionName}-${value.versionCode}/impo.apk`) return null;
  if (value.minimumSdk !== undefined && (!Number.isInteger(value.minimumSdk) || value.minimumSdk < 28 || value.minimumSdk > 1000)) return null;
  return Object.fromEntries(['versionName', 'versionCode', 'sha256', 'size', 'certificateSha256', 'packageName', 'objectKey', 'publishedAt', ...(value.minimumSdk === undefined ? [] : ['minimumSdk'])].map(key => [key, value[key]]));
}

function unchanged(header, etag) {
  return header?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag) ?? false;
}

function canUseRange(header, metadata) {
  if (!header) return true;
  if (header.startsWith('"') || header.startsWith('W/')) return header === metadata.httpEtag;
  const timestamp = Date.parse(header);
  return Number.isFinite(timestamp) && Math.floor(metadata.uploaded.getTime() / 1000) <= Math.floor(timestamp / 1000);
}

function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ([first, last].some(value => value !== null && !Number.isSafeInteger(value))) return null;
  const start = first === null ? Math.max(0, size - last) : first;
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  return start < 0 || start >= size || end < start ? null : { offset: start, length: end - start + 1 };
}

function headersFor(metadata, cache, type) {
  return new Headers({
    'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff',
    ETag: metadata.httpEtag, 'Last-Modified': metadata.uploaded.toUTCString(),
  });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const historical = RELEASE.exec(path);
    const latestApk = path === '/android.apk';
    const metadataRoute = path === '/android/latest.json';
    const releaseKey = /^\/app-releases\/([a-z-]+)\.json$/.exec(path)?.[1];
    const releaseRoute = releaseKey && Object.hasOwn(releaseChannels, releaseKey);
    const fail = (status, message, extra = {}) => new Response(request.method === 'HEAD' ? null : message, {
      status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': NO_STORE, 'X-Content-Type-Options': 'nosniff', ...extra },
    });
    if (!latestApk && !metadataRoute && !historical && !releaseRoute) return fail(404, 'Not found');
    if (!['GET', 'HEAD'].includes(request.method)) return fail(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    if (historical && !Number.isSafeInteger(Number(historical[2]))) return fail(404, 'Not found');
    try {
      const bucket = env.ANDROID_RELEASES;
      if (releaseRoute) return await appReleaseResponse(request, bucket, releaseKey, validateManifest);
      let manifest, pointer;
      if (!historical) {
        pointer = await bucket.get(LATEST);
        if (!pointer) return fail(404, 'No Android release is available');
        if (pointer.size > 8192 || !pointer.body) { await pointer.body?.cancel(); return fail(503, 'Release temporarily unavailable'); }
        manifest = validateManifest(await pointer.json());
        if (!manifest) return fail(503, 'Release temporarily unavailable');
      }
      if (metadataRoute) {
        const headers = headersFor(pointer, NO_STORE, 'application/json; charset=utf-8');
        if (unchanged(request.headers.get('If-None-Match'), pointer.httpEtag)) return new Response(null, { status: 304, headers });
        const body = JSON.stringify(manifest);
        headers.set('Content-Length', String(new TextEncoder().encode(body).length));
        return new Response(request.method === 'HEAD' ? null : body, { headers });
      }
      const key = historical ? path.slice(1) : manifest.objectKey;
      const metadata = await bucket.head(key);
      if (!metadata) return fail(latestApk ? 503 : 404, 'Release unavailable');
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || (manifest && metadata.size !== manifest.size)) return fail(503, 'Release temporarily unavailable');
      const version = historical ? `${historical[1]}-${historical[2]}` : `${manifest.versionName}-${manifest.versionCode}`;
      const headers = headersFor(metadata, latestApk ? NO_STORE : IMMUTABLE, APK);
      headers.set('Content-Disposition', `attachment; filename="impo-${version}.apk"`);
      headers.set('Accept-Ranges', 'bytes');
      if (unchanged(request.headers.get('If-None-Match'), metadata.httpEtag)) return new Response(null, { status: 304, headers });
      let range;
      const requestedRange = request.headers.get('Range');
      if (request.method === 'GET' && requestedRange && canUseRange(request.headers.get('If-Range'), metadata)) {
        range = byteRange(requestedRange, metadata.size);
        if (!range) return fail(416, 'Range not satisfiable', { 'Content-Range': `bytes */${metadata.size}`, 'Accept-Ranges': 'bytes' });
        headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
      }
      headers.set('Content-Length', String(range?.length ?? metadata.size));
      if (request.method === 'HEAD') return new Response(null, { headers });
      // Immutable keys are still conditionally read: an overwrite between head/get must
      // never stream new bytes with old size, range or validator headers.
      const object = await bucket.get(key, { onlyIf: { etagMatches: metadata.etag }, ...(range ? { range } : {}) });
      if (!object) return fail(latestApk ? 503 : 404, 'Release unavailable');
      if (!object.body || object.httpEtag !== metadata.httpEtag || object.size !== metadata.size) {
        await object.body?.cancel();
        return fail(503, 'Release temporarily unavailable');
      }
      return new Response(object.body, { status: range ? 206 : 200, headers });
    } catch {
      return fail(503, 'Release temporarily unavailable');
    }
  },
};
