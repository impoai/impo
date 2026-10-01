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

## Echo schedules

Settings → Echo schedule and the Echo timeline clock button edit the account
weekly plan shared with Android. Start reminders only open Echo. User action
and microphone permission are still required to record. An optional native
automatic stop uses the original session start across audio interruptions and
checks the deadline before resuming or accepting a late microphone activation.
The saved account plan works offline; other-device edits apply after the next
foreground sync. See [the shared contract](../contracts/echo-schedule.md).
