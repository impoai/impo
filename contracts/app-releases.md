# Optional app updates

On each process's first foreground launch, iOS and Android check public release
metadata once. Navigation, login, activity recreation and foreground return do
not repeat the check. A higher build number shows **Update available**, with
**Update** and **Later**. Back/outside dismissal is also supported on Android.
Dismissal lasts for the process lifetime; a new cold launch checks again.
No update is downloaded or installed automatically. There is no minimum allowed
app build, forced update, blocking loader or account dependency.

The public release service runs in the existing Cloudflare Pages download
Worker on `impo.ai`, backed by the private release R2 bucket. It is independent
of the authenticated conversation API and sends no account token or identifier.
These GET routes return JSON with `Cache-Control: no-store`:

- `/app-releases/android-apk.json`
- `/app-releases/ios-testflight.json`
- `/app-releases/ios-app-store.json`

```json
{
  "schemaVersion": 1,
  "platform": "ios",
  "channel": "testflight",
  "latest": {
    "version": "1.0",
    "build": 49,
    "minimumSystemVersion": "18.0",
    "url": "https://testflight.apple.com/join/Wgkx6k3V",
    "expiresAt": "2026-12-30T00:00:00Z"
  }
}
```

This is an example, not a claim that build 49 is externally available. `latest`
is null for an unpublished channel or expired beta. Build numbers are positive
integers up to 2,147,483,647 and must increase across marketing versions on each
platform. iOS reads CFBundleVersion; Android reads VERSION_CODE. Marketing
versions are only for display. `minimumSystemVersion` is an iOS version or an
Android SDK level (e.g. `28`). The clients ignore incompatible releases,
same/older builds, malformed/unknown schema, wrong platform/channel, expired
betas, and URLs outside the exact Impo download/store destinations. All network
and decoding failures silently leave the app usable; the public request has a
five-second timeout and no retry until the next cold launch.

iOS chooses the channel from the verified StoreKit AppTransaction environment
(sandbox / production). It never refreshes StoreKit or requests authentication
for this check. Unknown or unavailable environments skip the prompt. Xcode and
Android debug builds skip live checks and accept debug-only synthetic fixtures.
TestFlight metadata expires with its Apple build. App Store users never receive
TestFlight suggestions. Android opens the existing signed APK URL in the browser;
the OS/user continues to control installation and its permissions.

## Publication

Deploy endpoint changes with `npm run deploy:android:downloads`. This updates the
existing public release service; no ECS or database change is required.

`npm run publish:android` inspects the signed APK's version, signing certificate
and minimum SDK, verifies the immutable artifact, then promotes `android/latest.json`.
The update endpoint derives its response from that same pointer and checks the
artifact exists, so no second Android version setting can get out of sync.

After each iOS release is processed, run:

```sh
# Set ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH in the private release environment.
npm run publish:ios:update -- --testflight --check
npm run publish:ios:update -- --testflight
# Only after the app is actually released through the App Store:
npm run publish:ios:update -- --app-store
```

The publisher reads Apple state before choosing the newest available build.
TestFlight requires an unexpired, valid, approved build in the enabled public
group; internal-only or pending-review builds are not advertised. App Store
requires a released version. It refuses lower build numbers and verifies the
public result. Re-run after beta review approval, not just upload. Serialize
release publication between operators. R2 stores only public version metadata;
Apple credentials remain in the private operator environment, never Git, R2 or
either client. A rollback may suppress a channel by setting `latest: null`, but
must not tell users to downgrade.

The first builds containing this feature cannot retrofit a prompt into older
installed binaries. Users must first install a build with the check; subsequent
published builds can then trigger it.
