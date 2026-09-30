# Impo for Android

Impo's Android client uses Kotlin and Jetpack Compose with the shared
[application protocol](../contracts/client-protocol.md). The source includes
Chat, Tasks, Brief, Memories, Echo recording/history, connections, native
Calendar Provider and Health Connect adapters, and account/settings screens.
The debug build, unit tests and API 35 emulator acceptance have passed. Physical
device behavior and deployed account/provider access still require validation.

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
application/account portal and your own API deployment. The app uses Clerk's
native SDK for account access, session observation, token refresh and sign-out.
Browser dismissal alone does not establish a session or connector account.
All provider secrets, Clerk server keys, Rebyte, Composio, S3 and transcription
credentials remain on the server.

## Code boundaries

```text
app/ui/          Compose navigation/screens, native rich text and Brief export
app/data/        Account-scoped settings, authentication and screen coordination
app/nativebridge/ Microphone/VAD, durable Echo, location, calendar/health, receipts
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
| Chat and Tasks | Streamed replies, progress, Unicode/Markdown, history recovery, saved retries, explicit cancellation, isolated task conversations and follow-ups. |
| Rich responses | Markdown/headings/lists/code/GFM tables, offline LaTeX, horizontal overflow, copy and native text selection frozen during streaming. |
| Brief | Editions, dates, sources, deletion, time/locale/city settings; complete paginated PDF and PNG sharing through FileProvider. |
| Memories | Echo timeline/ID hydration/date jumps/details/place labels; About you categories and forgetting. |
| Echo capture | User-started microphone foreground service, ongoing pause/stop notification, bundled Silero VAD, WAV segments and durable upload batches. |
| Echo transfer | SHA-256-bound exact-file PUT, owned upload manifests, matching acceptance receipts before cleanup, WorkManager retry and Wi-Fi-only preference. |
| Device context | Optional recording-time coarse place resolution; no coordinates in uploaded context. Read-only Calendar Provider and Health Connect tools with explicit permission checks. |
| Connections | Discover/search the server shelf, browser authorization, status refresh and disconnect. |
| Account and settings | Clerk access, local assistant/profile customization, permission explanations, privacy/terms/support, sign-out and notification settings. |

Native calendar/health tools use `impo_list_calendar_events` and
`impo_get_health_summary`; installed iOS aliases remain valid. See the
[native tool contract](../contracts/native-device-tools.md) for units,
provenance, unknown/permission states and overlapping sleep intervals. The server
advertises only capabilities from the device attached to the message. Missing
Health data is never silently turned into zero activity or permission denial.

Echo records only after the user starts the microphone foreground service.
Android may stop it because of permissions, audio interruptions or process
termination. The app does not promise to restart microphone capture on boot or
from an unrestricted background job. Upload retry is a separate, durable task.
Optional location and Health Connect use their own permission boundaries.

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

Verified on 2026-09-30 with JDK 17 and `Impo_API_35` (Android 15, arm64):

- Debug APK build and Android lint passed.
- 86 non-UI unit tests passed: 50 protocol/client and 36 app/native cases.
- The opt-in production-router contract integration passed separately.
- All 12 instrumentation tests passed with no skips. They cover onboarding,
  streamed chat/cancel, tasks/follow-ups, Brief evidence and complete PDF/PNG
  export, memory forgetting, Echo history/date jumps/labels/deletion, saved
  preferences, browser authorization return/disconnect, native text selection,
  Markdown/math, microphone notification controls, Calendar permission/provider
  reads, and actual Silero inference on English/Mandarin audio and silence.
- The existing root server/Swift regression suite passed.

The emulator uses the local synthetic fixture described above. It validates
client transport and native UI behavior, not production OAuth, model responses
or real transcription. Test reports are generated under each module's
`build/reports/` directory.

Before claiming hardware parity, check a physical microphone, lock-screen
capture, interruptions, long offline queues, geocoding/location, Calendar
Provider data, Health Connect availability/grants and account switching.

Voice-chat/hold-to-speak, attachments/camera uploads, billing/subscriptions,
recurring user-created tasks, diary generation, immediate account deletion and
remote push registration are not implemented backend features. The Android UI
does not turn iOS previews into promises. Web remains planned.
