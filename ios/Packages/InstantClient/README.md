# Impo Swift client (`InstantClient`)

Native Swift 6 package for Impo's HTTP and streaming API. Targets iOS 16+ and
macOS 13+; the SwiftUI app has its own iOS 18+ requirement. The package has no UI,
third-party Swift dependency, model runtime, or Rebyte key.
`InstantClient` and ICA v1 retain their existing compatibility names.

## Implemented

- Authenticated HTTP commands and cancellable `URLSession` SSE subscriptions.
- Byte framing, fragmented UTF-8, LF/CRLF/CR, BOM, comments, and multiline SSE data.
- Message/text/tool IDs, submission/device extensions, ordered updates, and
  terminal-stream validation.
- Conversation history, task commands, app connectors, Listening batches,
  and Today preferences/history.
- `DeviceToolRunner`: pending-work discovery, claims, permission checks, and
  file-backed execution receipts for native device tools.
- `DeviceToolDispatcher`: the original process-local fixture dispatcher.

The downstream format is Vercel UI Message Stream v1. The package implements the
[documented contract](../../../contracts/README.md) and its extensions, rather
than Vercel's React hooks or the entire multimodal UI schema. Unknown optional
`data-*` extensions are ignored; unsupported core chunks fail explicitly.
Known `data-instant-*` extensions require a supported schema version.
Stream success requires both `finish` and `[DONE]`.

## Test

From the repository root:

```sh
swift test --package-path ios/Packages/InstantClient
INSTANT_TEST_BASE_URL=http://127.0.0.1:3000 swift test --package-path ios/Packages/InstantClient --filter IntegrationTests
```

`INSTANT_TEST_BASE_URL` is the server origin without `/api/v1`. HTTP tests skip
when it is absent. The root `npm test` command starts its own fixture server and
runs both language suites and the HTTP integration tests. `npm run test:ios`
uses a temporary iOS Simulator.

## Fixture example

Start `npm run dev:fixture` for this manual example:

```swift
let client = InstantClient(
    baseURL: URL(string: "http://127.0.0.1:3000")!,
    bearerToken: "instant-test-alice" // Fixture identity only.
)
let device = try await client.registerDevice(installationId: "local-test-device")
let dispatcher = DeviceToolDispatcher(client: client, deviceId: device.deviceId)
let receipt = try await client.sendMessage(
    clientMessageId: UUID().uuidString,
    text: "Test the device tool",
    scenario: "tool",
    deviceId: device.deviceId
)
for try await message in client.stream(submissionId: receipt.submissionId) {
    _ = try await dispatcher.dispatchAvailable(in: message) { name, input in
        return .object(["echo": input["text"] ?? .null])
    }
    // Replace the previous UI projection for message.messageId.
}
```

`scenario` and `instant-test-alice` belong to the fixture. Persistent development
uses `instant-dev-alice` and rejects fixture scenarios. The app's native handlers
use `DeviceToolRunner` with real permissions and a receipt file isolated by
server, user, and device.

## Recovery boundaries

A new subscription starts a fresh reducer and replaces the previous snapshot by
stable message ID. Cancelling the subscription closes HTTP only;
`cancelSubmission` explicitly cancels execution.

`DeviceToolRunner` saves completed native results before upload, so lost receipts
and app restarts can reuse the result. The fixture dispatcher only keeps its
receipts in process memory. Neither is a general guarantee of exactly-once
side effects: native handlers must account for interruption and permission changes.

There is no automatic command retry or continuous reconnection loop in the
package. Callers retain `clientMessageId`, reconnect by `submissionId`, and retry
identical result bodies. The server owns authorization and idempotency checks.
