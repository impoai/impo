// Public release metadata contains no credentials or account information.
export const releaseChannels = {
  'ios-testflight': { platform: 'ios', channel: 'testflight', url: 'https://testflight.apple.com/join/Wgkx6k3V' },
  'ios-app-store': { platform: 'ios', channel: 'app-store', url: 'https://apps.apple.com/app/id6816377222' },
  'android-apk': { platform: 'android', channel: 'apk', url: 'https://impo.ai/android.apk' },
};

export function validateRelease(value, key, now = Date.now()) {
  const target = releaseChannels[key];
  if (!target || !value || value.schemaVersion !== 1 || value.platform !== target.platform || value.channel !== target.channel) return null;
  if (value.latest === null) return { schemaVersion: 1, platform: target.platform, channel: target.channel, latest: null };
  const latest = value.latest;
  if (!latest || typeof latest.version !== 'string' || !/^[0-9]+(?:\.[0-9]+){0,2}$/.test(latest.version) || latest.version.length > 32 ||
      !Number.isSafeInteger(latest.build) || latest.build < 1 || latest.build > 2147483647 || latest.url !== target.url ||
      typeof latest.minimumSystemVersion !== 'string' || !/^[0-9]+(?:\.[0-9]+){0,2}$/.test(latest.minimumSystemVersion) || latest.minimumSystemVersion.length > 32) return null;
  const result = { version: latest.version, build: latest.build, url: target.url, minimumSystemVersion: latest.minimumSystemVersion };
  if (target.channel === 'testflight') {
    if (typeof latest.expiresAt !== 'string' || !Number.isFinite(Date.parse(latest.expiresAt))) return null;
    if (Date.parse(latest.expiresAt) <= now) return { schemaVersion: 1, platform: target.platform, channel: target.channel, latest: null };
    result.expiresAt = latest.expiresAt;
  }
  return { schemaVersion: 1, platform: target.platform, channel: target.channel, latest: result };
}

export async function appReleaseResponse(request, bucket, key, validateAndroid) {
  const target = releaseChannels[key];
  let value = { schemaVersion: 1, platform: target.platform, channel: target.channel, latest: null };
  const pointer = await bucket.get(key === 'android-apk' ? 'android/latest.json' : `app-releases/${key}.json`);
  if (pointer) {
    if (pointer.size > 8192 || !pointer.body) { await pointer.body?.cancel(); throw new Error('Invalid release'); }
    const stored = await pointer.json();
    if (key === 'android-apk') {
      const manifest = validateAndroid(stored);
      if (!manifest) throw new Error('Invalid APK manifest');
      const artifact = await bucket.head(manifest.objectKey);
      if (!artifact || artifact.size !== manifest.size) throw new Error('APK unavailable');
      // The publisher extracts the SDK requirement from the signed APK.
      if (!Number.isInteger(stored.minimumSdk) || stored.minimumSdk < 28) throw new Error('Missing APK SDK requirement');
      value.latest = { version: manifest.versionName, build: manifest.versionCode, url: target.url, minimumSystemVersion: String(stored.minimumSdk) };
    } else value = stored;
  }
  const release = validateRelease(value, key);
  if (!release) throw new Error('Invalid release');
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(release), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
