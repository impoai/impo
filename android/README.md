# Impo for Android

Impo's Android client uses Kotlin and Jetpack Compose with the shared
[application protocol](../contracts/client-protocol.md). The source includes
Chat, Tasks, Brief, Memories, Echo recording/history, connections, native
Calendar Provider, Health Connect and Contacts adapters, hold-to-talk input,
and server-backed account/profile settings.
The debug and signed release builds, unit tests and API 35 emulator acceptance
have passed. Download the signed testing build from
[impo.ai/android.apk](https://impo.ai/android.apk). Production Google/Apple login
pages are verified; full account login and physical-device behavior remain pending.

## Local setup

Use JDK 17, Android SDK Platform 36, Android SDK Build Tools, platform-tools,
and an Android Emulator. The checked-in wrapper uses Gradle 8.13; the Android
Gradle Plugin is 8.13.2 and Kotlin is 2.3.10. The app targets API 36 and supports
API 28 and later. Health Connect remains optional and is checked at runtime.

On Apple Silicon, the emulator command uses the
`system-images;android-35;google_apis;arm64-v8a` image and creates `Impo_API_35`.
Install that image before running the command. The default emulator serial is
`emulator-5584`; `IMPO_ANDROID_SERIAL` selects a different running device.
`ANDROID_HOME` and `JAVA_HOME` can override the local SDK and JDK paths.

Install JavaScript dependencies from the repository root:

```sh
npm ci
```

Run the Android commands from the root as well:

```sh
npm run test:android
npm run build:android
npm run android:emulator
```

The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.
Build output, local configuration, signing material and local recordings are
untracked. Android Studio can open the `android/` directory directly.

The local runner uses the `Impo_API_35` AVD on `emulator-5584`. It disables
host audio by default: this machine's CoreAudio backend hung the emulator when
opening input. The guest still provides virtual silence for AudioRecord service
and notification tests; bundled English/Mandarin WAVs verify real ONNX inference.
Use `IMPO_ANDROID_AUDIO` and `IMPO_ANDROID_GPU` to select supported emulator
backends before starting the AVD. Host microphone capture is not acceptance
evidence for a physical Android microphone. `IMPO_ANDROID_SERIAL` selects an
already configured emulator/device for launch and UI tests.

### Explore with local data

Run the fixture in one terminal:

```sh
npm run dev:android-fixture
```

Then install and launch the app:

```sh
npm run android:launch -- --fixture
```

The runner forwards emulator port 3011 to the loopback fixture and supplies a
DEBUG-only launch intent. The fixture uses `instant-dev-alice`, synthetic
records, real API validation/SSE transport and in-memory repositories. Its state
resets on restart. It never uses model keys, a remote database, real OAuth
accounts or real transcription. Sending “Hello Android” exercises rich Unicode
responses; a message containing “slow” allows explicit cancellation testing.

The fixture includes tasks and follow-ups, Brief cards/settings/sources,
memories/filtering/forgetting, 45 Echo records/place labels/deletion, simulated
connector authorization, and checksum-bound audio uploads. Connector browser
pages explicitly identify themselves as synthetic development authorization.
Audio uploaded to this fixture receives a synthetic transcript; this verifies
transport, not speech recognition.

For an ordinary local backend, choose **Developer connection** on the debug
welcome screen and use `http://10.0.2.2:3001` for the host machine's API. Debug
connections accept only loopback/emulator hosts. Release builds do not expose
fixed development identities or permit cleartext API access.

### Configure your deployed account

Add the following to untracked `android/local.properties` (preserve any existing
`sdk.dir`). These are an API base URL and a public Clerk client key:

```properties
impo.apiUrl=https://your-impo-api.example
impo.clerkKey=pk_test_your_publishable_key
```

The API base URL excludes `/api/v1`. Matching Gradle properties can also be
supplied by the build environment. Configure the corresponding Clerk
application and your own API deployment. The app uses Clerk's native SDK for
Google and Apple sign-in/sign-up, session observation, token refresh and sign-out.
Enable the Native API and both social providers in your Clerk instance, including
their production web OAuth credentials. The pinned Clerk Android SDK 1.0.1 uses
`clerk://<applicationId>.oauth`; allowlist `clerk://ai.impo.android.oauth` for the
release app. Debug builds have a separate `.debug` application ID and callback.
The SDK supplies the matching manifest receiver and activates the native session
when authentication completes. Account Portal behavior in newer SDK documentation
uses a different API and callback; it does not describe this pinned version.
Browser dismissal alone does not establish a session or connector account.
All provider secrets, Clerk server keys, Rebyte, Composio, S3 and transcription
credentials remain on the server.

Apple's browser flow also needs a Services ID, a Sign in with Apple private
key, Team ID and Key ID in Clerk. Enabling native iOS Apple sign-in alone does
not supply those credentials. Production uses `ai.impo.signin` with the Clerk
domain and `https://clerk.impo.ai/v1/oauth_callback` as its return URL. Keep the
private key out of client configuration and source control.

### Signed releases

Configure production public values in ignored `android/local.properties`:

```properties
impo.release.apiUrl=https://your-production-api.example
impo.release.clerkKey=pk_live_your_publishable_key
```

Release-specific values keep debug configuration independent. If omitted, a
release uses `impo.apiUrl` and `impo.clerkKey`; the release build still requires
a public HTTPS endpoint and a live Clerk publishable key. In the live Clerk
instance, enable the Native API, Google and Apple, and allowlist the exact
`clerk://ai.impo.android.oauth` callback used by the pinned SDK 1.0.1 and the
merged release manifest. Recheck SDK callback and registration requirements
when upgrading; newer Account Portal documentation uses a different flow.

Initialize a signing key once from the repository root:

```sh
npm run android:signing:init
```

This creates a persistent RSA signing key in PKCS12 format and private signing
properties under ignored `.local/android/release/`. The directory is restricted
to its owner; the keystore and properties have mode `0600`. Passwords are passed
to `keytool` through its environment and never printed. Back up both files
securely: installed apps can only update with the same signing key. Re-running
initialization preserves existing files and refuses an incomplete key setup.
Restore missing files from backup; do not replace an established release key.

Build a signed, optimized APK, increasing the version code for each publication:

```sh
IMPO_ANDROID_VERSION_CODE=3 IMPO_ANDROID_VERSION_NAME=0.1.2 npm run build:android:release
```

The APK is `android/app/build/outputs/apk/release/app-release.apk`, with package
`ai.impo.android`, minimum API 28 and target API 36. `impo.versionCode` and
`impo.versionName` in local/Gradle properties also supply version values; the
runner's environment values take precedence. Builds verify the expected
signing-certificate fingerprint and fail for missing or changed signing
material. `-Pimpo.signingProperties=/absolute/private/signing.properties` can
select a protected signing file on another build machine; `storeFile` paths
inside it are relative to `android/` unless absolute. Keep signing files out of
source control and never pass passwords as Gradle command-line properties.

Release builds disable debuggability and cleartext traffic, omit debug launch
identities and instrumentation audio, and include the same production Silero
model as the debug app. A signed build verifies packaging; it does not replace
live account/provider or physical-device acceptance.

### Publish the Android download

The permanent download URL is **https://impo.ai/android.apk**. A private
Cloudflare R2 bucket, `impo-android-releases`, stores signed APKs. The existing
`impo-ai` Pages project serves only the download paths through
`site/_worker.js`; other requests retain normal website asset handling. Its
configuration preserves the existing `PR_DOCUMENTS` binding.

After building the signed release, run from the repository root:

```sh
npm run publish:android -- --check
npm run publish:android
```

`--check` validates only the local APK and prints its metadata. Cloudflare
access and checks against the current remote version/signature run during
publication.

The publisher snapshots and verifies the release APK, rejects debug signatures,
checks the package and increasing version code, and preserves the signing
certificate used by previous releases. It uploads an immutable version path,
downloads and verifies every byte, then updates `android/latest.json`. Finally
it downloads the permanent URL and verifies the SHA-256 again. Private local
receipts are saved under `.local/android/releases/`. A local lock prevents
parallel publication from this checkout. Publish one release at a time across
machines too; a detected change to the latest pointer stops promotion, but
this is not a distributed lock.

For the next release, increment the version code and keep the same signing key:

```sh
IMPO_ANDROID_VERSION_CODE=4 IMPO_ANDROID_VERSION_NAME=0.1.3 npm run build:android:release
npm run publish:android
```

Public release metadata is at https://impo.ai/android/latest.json. Versioned
files use `/android/releases/<versionName>-<versionCode>/impo.apk`; old versions
are retained. The permanent URL is not cached, while versioned files are
immutable. GET, HEAD and byte ranges are supported. A repeated publication of
the identical current APK verifies it without replacing anything.

Download handler or website changes require an authenticated Cloudflare CLI:

```sh
npm run test:android:downloads
npm run deploy:android:downloads
```

This deploys the full `site/` directory to production Pages with the required R2
bindings. Keep Wrangler bundling enabled so the shared download module is
included. APK-only releases do not need a website deployment.

## Code boundaries

```text
app/ui/          Compose navigation/screens, native rich text and Brief export
app/data/        Account-scoped settings, authentication and screen coordination
app/nativebridge/ AAC voice capture, microphone/VAD, durable Echo, location, device tools
client/          Android-independent Kotlin protocol/recovery library and tests
```

`client/` owns DTOs, OkHttp commands and SSE decoding/reduction, token refresh,
message retry identity, conversation recovery, cancellation, Echo history
hydration and signed-file transfer. It has no Compose, Activity, Clerk or native
permission dependency. `app/` owns presentation and Android lifecycle/permission
boundaries. Provider protocols and model calls remain on the server.

The UI uses ViewModels, StateFlow, lifecycle-aware collection and Navigation.
DataStore keeps account-scoped local preferences. Native upload batches and
device receipts use atomic private files; WorkManager retries immutable uploads
independently of the recording service. Account changes cancel old subscriptions
and native dispatch; another account never uploads a previous account's audio.

## Included behavior

| Area | Android implementation |
| --- | --- |
| Chat and Tasks | Streamed replies, progress, Unicode/Markdown, history recovery, saved retries, explicit cancellation, isolated task conversations and follow-ups; native hold-to-talk with release to send and slide up to cancel. |
| Rich responses | Markdown/headings/lists/code/GFM tables, offline LaTeX, horizontal overflow, copy and native text selection frozen during streaming. |
| Brief | Editions, dates, sources, deletion, time/locale/city settings; complete paginated PDF and PNG sharing through FileProvider. |
| Memories | Echo timeline/ID hydration/date jumps/details/place labels; About you categories and forgetting. |
| Echo capture | User-started microphone foreground service, ongoing pause/stop notification, bundled Silero VAD, WAV segments and durable upload batches. |
| Echo transfer | SHA-256-bound exact-file PUT, owned upload manifests, matching acceptance receipts before cleanup, WorkManager retry and Wi-Fi-only preference. |
| Device context | Optional recording-time coarse place resolution; no coordinates in uploaded context. Read-only Calendar Provider, Health Connect and Contacts tools with explicit permission checks. |
| Connections | Optional onboarding connections; discover/search the server shelf, browser authorization, status refresh and disconnect. |
| Account and settings | Clerk access; server-restored onboarding, assistant name/look and display name; durable pending profile changes; permission explanations, privacy/terms/support, sign-out and notification settings. |

Native device tools use `impo_list_calendar_events`, `impo_get_health_summary`
and `impo_search_contacts`; installed iOS aliases remain valid. See the
[native tool contract](../contracts/native-device-tools.md) for units,
provenance, unknown/permission states and overlapping sleep intervals. The server
advertises only capabilities from the device attached to the message. Missing
Health data is never silently turned into zero activity or permission denial.

Echo records only after the user starts the microphone foreground service.
Android may stop it because of permissions, audio interruptions or process
termination. The app does not promise to restart microphone capture on boot or
from an unrestricted background job. Upload retry is a separate, durable task.
Optional location and Health Connect use their own permission boundaries.

### iOS parity update — 2026-09-30

Reviewed today's iOS additions through `caf5358` and shared backend changes in
`e344097`, following the initial Android implementation in `8311c9b`.

| iOS addition | Android behavior |
| --- | --- |
| Whole-composer hold-to-talk | Hold an empty composer for 350 ms, release to send once, or slide up 65 dp to cancel. A tap edits normally; nonempty drafts retain native selection. Audio levels and transcription status are visible. |
| Voice lifecycle fixes | Native AAC recording. Permission approval requires a fresh hold; navigation, backgrounding and account changes cancel unreleased capture. Echo and voice input share microphone exclusion. Released Chat commands have their own account-scoped durable lifecycle. |
| Returning account recovery | `GET/PATCH /profile` restores onboarding, assistant name and shared avatar indices. Display names use existing Brief settings. Pending writes survive process death; responses from old login sessions cannot update the new session. |
| Optional native Contacts | Explicit read-only permission and account-specific opt-in; requested searches return bounded matching contact details, never a bulk address-book upload. Revocation stops capability advertisement and execution. |
| Onboarding connections and slogan | “Meet Impo, an open assistant that captures everything around your life.” Echo and open source are prominent; native and external connections are optional before entering Chat. |
| Citation links and Chat city context | Shared server behavior already applies to Android. Native Markdown renders source links; the server uses fresh Brief location, never a city inferred from a time zone. |
| Apple Reminders | No universal Android provider. Android does not advertise the iOS reminder tools; external task services are available only when returned by the server's connector directory. |
| iOS custom avatar photo | Photo bytes are device-local on iOS. Android preserves its available avatar for remote index 6; built-in avatars share identical wire indices and existing Android choices migrate once. |

### iOS parity update — 2026-10-01

Reviewed iOS changes after Android 0.1.1 (`808a859`) through `b28f955`.

| iOS addition | Android behavior |
| --- | --- |
| Server voice transcription | MediaRecorder captures mono 16 kHz AAC in MP4; both clients use the shared Gemini transcription routes. No installed speech recognition service is required. The composer displays a waveform while held, then a pending transcript bubble. |
| Atomic Chat voice messages | Persist the exact clip, message ID, device and clock context before requesting acceptance. Retry the same command after an uncertain response or process restart; accepted transcript receipts replace the bubble without sending a second text message. Silence clears the rejected clip. |
| Tasks and busy Chat drafts | Use transcription-only requests. Task input sends through the normal task command; busy Chat appends the transcript to the draft. Leaving the view cancels this draft request, while released Chat acceptance continues for the signed-in account. |
| Stable empty Echo history | Show initial loading until a successful timeline fetch, then keep the confirmed empty state visible through refreshes and errors. |
| Removed payment step; steady scenario pager | Android already has no payment step or scenario pager, so no corresponding change is needed. |

Voice recordings stop at two minutes or the 2 MiB upload limit, release the
microphone, and wait for the finger to release or cancel. Short or silent holds
are discarded. Capture files are removed after conversion to immutable bytes;
uncertain Chat commands remain in the private, account-scoped outbox until
accepted history is recovered. Server voice audio is not retained or added to
Echo. Transcription requires a network connection and the server's Gemini
configuration; the composer discloses this processing.

## Validation

| Root command | Boundary |
| --- | --- |
| `npm run test:android:client` | Kotlin/JVM protocol, SSE, auth, retry, recovery and account isolation. |
| `npm run test:android` | Client tests plus app non-UI unit tests: native inputs, capture batching/receipts, rich parsing/selection and export pagination. |
| `npm run build:android` | Debug app compilation/package. |
| `npm run lint:android` | Android lint. |
| `npm run test:android:ui` | Boots the emulator, starts its own local fixture, reverses port 3011 and runs native/Compose instrumentation. Stop a manually started fixture first. |
| `npm test` | Existing server/Swift/protocol regressions; does not itself compile Android. |
| `npm run test:devices` | Persistent neutral and legacy device capabilities, ownership, Session selection/rotation, claims, revocation and receipt recovery. |

The client-only command needs JDK 17 but no Android SDK. With a manually running
fixture, `IMPO_ANDROID_FIXTURE_URL=http://127.0.0.1:3011 npm run test:android:client`
also runs the production-router contract integration; changing that URL
invalidates Gradle's test cache.

To isolate an instrumentation failure, set `IMPO_ANDROID_TEST_CLASS` to a fully
qualified test class, optionally followed by `#methodName`, before running
`npm run test:android:ui`. Omit it for the complete acceptance suite.

Verified on 2026-10-01 with JDK 17 and `Impo_API_35` (Android 15, arm64):

- Debug APK build and Android lint passed.
- 149 non-UI unit tests passed: 69 protocol/client and 80 app/native cases.
- The opt-in production-router contract integration passed separately.
- All 29 instrumentation tests passed with no skips. They cover onboarding,
  streamed chat/cancel, tasks/follow-ups, Brief evidence and complete PDF/PNG
  export, memory forgetting, Echo history/date jumps/labels/deletion, saved
  preferences, browser authorization return/disconnect, native text selection,
  Markdown/math, hold-to-talk gestures/cancellation/session teardown, server profile
  recovery after clearing the local cache, microphone notification controls,
  Calendar/Contacts permission and provider reads, immediate native opt-out, and
  actual Silero inference on English/Mandarin audio and silence. New voice checks
  cover pending acceptance across navigation/recreation, silence cleanup,
  transcription-only task flows, native AAC encoding and capture-file cleanup,
  busy-reply cancellation, and task input. Empty Echo refreshes retain their layout.
- All 81 server unit tests, server typecheck and 9 download-handler tests passed.

The emulator uses the local synthetic fixture described above. It validates
client transport and native UI behavior, not production OAuth, model responses
or real transcription. Test reports are generated under each module's
`build/reports/` directory.

Before claiming hardware parity, check a physical microphone, lock-screen
capture, interruptions, long offline queues, geocoding/location, Calendar
Provider data, Contacts matches, server transcription/languages,
Health Connect availability/grants and account switching. Voice gesture tests
inject a recorder, and server-flow tests use deterministic synthetic clips.
Separate instrumentation checks native AAC recording and temporary-file cleanup
with emulator silence; none of these proves physical speech recognition.

Replies can deliver files. A file card downloads an account-scoped copy through
the authenticated API and opens a native viewer, with sharing as a fallback.
Downloads validate the complete byte count before becoming available. Settings
also supports account deletion with two confirmations and durable cloud cleanup.
The Android app does not yet include attachments/camera uploads,
billing/subscriptions or diary generation.
Web remains planned.

## Optional updates

Each cold launch checks the public APK release metadata. A newer compatible
build offers **Update** (opens the signed download in a browser) and **Later**.
Dismissal survives navigation, activity recreation and foreground return.
Offline or failed checks silently leave the app usable. Publishing through
`npm run publish:android` also updates the version check automatically. See the
[shared update contract](../contracts/app-releases.md).

## Remote notifications

FCM data messages use five native channels: Chat replies, Task updates, Scheduled
tasks, Brief and Echo reminders. The server supplies the same title and body used by iOS, including
clear completion/failure wording. Brief alerts say “You have a brief”. Settings category switches sync to the per-user server JSON; Android's
notification permission and channel controls remain additional gates. The app
reports foreground presence, suppresses foreground presentation, deduplicates
events, rejects expired or old-account routes and revokes registration before
sign-out. The same [notification policy](../contracts/notifications.md) applies
to iOS. Echo reminders use the shared [weekly schedule](../contracts/echo-schedule.md); task schedules use the shared [task schedule contract](../contracts/scheduled-tasks.md).

Build configuration comes from ignored `local.properties` entries
`impo.firebase.projectId`, `impo.firebase.senderId`, `impo.firebase.apiKey`,
`impo.firebase.appId` (release) and `impo.firebase.debug.appId` (debug). Register
the exact package IDs `ai.impo.android` and `ai.impo.android.debug` in Firebase.
These are client identifiers, never the server service-account credential.
Without this configuration, category preferences still sync; FCM registration
stays disabled. Never put an FCM service-account JSON or APNs key in the app.

Run `npm run test:android:client` for route/transport checks and
`IMPO_ANDROID_TEST_CLASS=ai.impo.notifications.PushInstrumentedTest npm run test:android:ui`
for category synchronization, native foreground/expiry/account suppression,
deduplication and notification tap handling against the local fixture. Injected
messages verify native behavior; they do not prove real FCM or physical delivery.

### Notification polish release — 2026-10-01

Android **0.1.4 (5)** is published at [impo.ai/android.apk](https://impo.ai/android.apk),
with the original signing certificate. This version includes shared notification
copy, independent notification tap destinations, account deletion with two
confirmations, and delivered-file download/open/share support.

Four emulator notification tests passed, including malformed payloads and two
event IDs whose integer hashes collide. A real FCM message reached the synthetic
Android emulator account and displayed “You have a brief” / “Tap to read it.”
The signed APK cold-launched and both immutable and permanent download URLs
passed complete SHA-256 verification. Physical-device and production-account
acceptance remain unverified.

## Echo speakers

Echo details also show anonymous speaker turns with Choose/Change, Not sure,
None of these is me and passage exclusions. The server uses only confirmed
personal speech in Memory and Brief. See the [speaker contract](../contracts/echo-speakers.md).
Run `IMPO_ANDROID_TEST_CLASS=ai.impo.ui.EchoSpeakersInstrumentedTest npm run test:android:ui`
for selection, exclusion, relaunch and revocation against the synthetic fixture.
This does not establish physical microphone or real conversation accuracy.

## Echo schedules

Settings → Echo schedule and the clock button in Memories → Echo edit the same
account plan as iOS. Choose weekdays, a reminder time, an optional automatic stop
and a fixed time zone. Saving a plan never starts the microphone. The native
foreground service reads its account cache before capture and keeps the original
session deadline across pauses and interruptions. It finalizes accepted audio
when stopping, including offline. Other-device changes apply after a foreground
sync. See [the shared contract](../contracts/echo-schedule.md) for exact timing.

## Scheduled tasks

Tasks → Scheduled supports one-time, daily and weekly plans, explicit time zones,
editing, pause/resume, deletion and paged run history. Chat can also create plans.
Each run opens an ordinary Task conversation. Settings → Notifications has a
separate Scheduled tasks switch. Schedules require a live server with Temporal.

## Brief guidance

Brief uses the shared [v2 content contract](../contracts/brief.md). The preferences
screen controls next steps, updates, connection suggestions, feature tips and
occasion greetings independently from push notifications. Cards can be hidden
indefinitely or for a week. Chat actions fill an editable draft, preserving existing
text unless the user confirms replacement; they never send automatically.

Mode Settings synchronize `Balanced` and `Power`. The UI describes each tier's
benefit without exposing provider or model names.
Current clients identify their catalog to the API; older builds keep their disabled
preview instead of displaying the wrong model.
