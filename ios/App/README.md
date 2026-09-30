# Impo native iOS app

SwiftUI application for iOS 18 and later. The Xcode scheme remains `Instant` and
the reusable package remains `InstantClient` for compatibility.

## Requirements

- macOS, Xcode with Swift 6, an installed iOS Simulator, and XcodeGen.
- The local API from the [server guide](../../server/README.md) for live data.
- Your own Clerk instance for real sign-in. Provider secret keys stay server-side.

From the repository root:

```sh
npm ci
node scripts/ios-app.mjs generate
open ios/App/Instant.xcodeproj
```

Select `Instant` and an iOS Simulator. To explore without signing in, add
`--show-main` to the scheme's launch arguments. In Settings, enable the local
API and use `http://127.0.0.1:3001` for the development runtime. Debug builds
also accept `--live-backend <base-url>` for an explicitly chosen test backend.

## Local deployment configuration

Copy `ios/App/Config.local.example.xcconfig` to `ios/App/Config.local.xcconfig`.
The latter is ignored by Git and included optionally by `Config.xcconfig`.

- `IMPO_CLERK_KEY_DEBUG`: your development Clerk publishable key.
- `IMPO_CLERK_KEY_RELEASE`: your release Clerk publishable key.
- `IMPO_API_BASE_URL`: your deployed API base URL, without `/api/v1`.
- `DEVELOPMENT_TEAM`: your Apple signing team for physical-device builds.

Keep the xcconfig URL syntax `https:/$()/your-host.example` so `//` is not read
as a comment. Match client publishable keys and server Clerk credentials to the
same instance. Empty keys disable real sign-in and permit offline/development
use. No maintainer keys, signing identity or production endpoint are supplied.

For a physical device, configure your own signing team and bundle identifiers
in Xcode or `project.yml`. Use an API address the device can reach. Regenerate
with XcodeGen after adding files or editing project configuration. Keep signing
certificates, provisioning profiles, API credentials and exports outside Git.

## Build and test

```sh
node scripts/ios-app.mjs build
npm run test:ios
node scripts/ios-app.mjs test --simulator <SIMULATOR_UDID>
```

The first builds the app for a generic Simulator. `test:ios` exercises protocol
boundaries on a temporary Simulator. App UI tests may require the documented
local fixture on port 3009; start `node --env-file=.env scripts/echo-ui-fixture.mjs`
only with a local development database. Opt-in `InstantDeviceLive` tests require
your own device, backend, permissions and short-lived authentication tickets.

The Echo slow-network UI test also needs `node scripts/echo-ui-proxy.mjs`, a
loopback-only fault proxy on port 3010. It exercises placeholders, direct date
seeks, retries and scrolling past the text cache against the 20,000-record fixture.

The app uses Calendar, Health, Reminders, Contacts, microphone and optional location authorization.
Device tool execution comes from owned pending/claim requests. Echo preserves
immutable audio/location batches across offline retries. Background recording,
real GPS, lock-screen behavior and battery use need physical-device testing.

## Resources and release builds

The committed asset catalog is required product artwork. The Silero VAD model
and its license are under `Resources/SileroVAD/`; test recordings stay in the test
bundle. The post-build script verifies the copied ONNX framework's minimum OS
version. Verify signing, deployment targets and resource inclusion in both the
archive and exported IPA before distributing your own build.

Implemented features and demo boundaries are documented in
[feature behavior](../../docs/features.md). The static website, backend, Android
client and future Web client have separate repository-root boundaries.

## Response rendering and selection

Chat and Task replies render headings, paragraphs, lists, quotes, code and GFM
tables through Swift Markdown. Wide tables, code and display equations scroll
horizontally. LaTeXSwiftUI renders inline and display math locally, including
`$...$`, `$$...$$`, `\(...\)` and `\[...\]`. Currency and code remain literal.
The vendored [LaTeXSwiftUI package](../Packages/LaTeXSwiftUI/README.md) records a
small fix to the upstream MathJax number pattern. Third-party notices ship in
the app's `ResponseRenderingLicenses.txt` resource.

Long-press a paragraph, heading or list item and choose **Select Text** to select
in place with native handles. **Done** returns to reading. The reply stays fixed
while selecting, and Chat pauses automatic scrolling so streaming cannot move
the handles. **Select Full Response** opens one read-only native text view for
selection across paragraphs, including LaTeX source and tab-separated table
cells. Blocks containing math use this full-response fallback. **Copy** copies
the complete reply; code blocks also have their own copy action. Reading uses
SwiftUI and a cached parse; a native text view exists only while selecting.

`ResponseDocumentTests` covers parsing and the real offline math engine.
`ResponseRenderingUITests` covers rendering, native selection, streaming snapshots,
100-message scrolling and the actual Chat menu. Its `--response-render-fixture`
launch surface is compiled only in Debug.
