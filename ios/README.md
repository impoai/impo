# Impo for iOS

The native Swift client for Impo. The SwiftUI app targets iOS 18 and later;
the reusable networking package is independent of the UI.

```text
App/                       SwiftUI app, native tools, widgets, and UI tests
Packages/InstantClient/     HTTP/SSE client, device dispatch, and protocol tests
Tools/                     Isolated development and device-validation utilities
```

Start with the [app guide](App/README.md) for building, signing, local API setup,
and the boundary between live features and demos. Read the
[client package guide](Packages/InstantClient/README.md) and
[shared contract](../contracts/README.md) for the protocol implementation.

From the repository root, run `npm test` for host verification or
`npm run test:ios` for Swift protocol tests on a temporary iOS Simulator.
The Xcode scheme and Swift package retain their existing `Instant` and
`InstantClient` identifiers; the product name is Impo.

## Echo speakers

Echo details also show anonymous speaker turns. Choose your voice, leave it
uncertain, mark yourself absent, or exclude individual passages. Selection is
recording-specific and is shared with Android through the
[speaker contract](../contracts/echo-speakers.md). `EchoSpeakerUITests` uses the
synthetic fixture on port 3018 to verify selection, exclusion, relaunch and
revocation. Physical microphone and real conversation accuracy remain separate
acceptance checks.

## Echo schedules

Settings → Echo schedule and the Echo timeline clock button edit the account
weekly plan shared with Android. Start reminders only open Echo. User action
and microphone permission are still required to record. An optional native
automatic stop uses the original session start across audio interruptions and
checks the deadline before resuming or accepting a late microphone activation.
The saved account plan works offline; other-device edits apply after the next
foreground sync. See [the shared contract](../contracts/echo-schedule.md).

## Brief guidance

Brief uses the shared [v2 content contract](../contracts/brief.md). The preferences
screen controls next steps, updates, connection suggestions, feature tips and
occasion greetings independently from push notifications. Cards can be hidden
indefinitely or for a week. Chat actions fill an editable draft, preserving existing
text unless the user confirms replacement; they never send automatically.

Model Settings synchronize `Balanced` (DeepSeek Flash) and `Power` (GPT-6 Luna).
Current clients identify their catalog to the API; older builds keep their disabled
preview instead of displaying the wrong model.
