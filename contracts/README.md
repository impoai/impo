# Impo client contract — ICA v1 fixture

For the complete application boundary, start with the
[application protocol v1](client-protocol.md): commands, JSON models, SSE,
recovery, Echo uploads and platform capability limits. The
[Android guide](../android/README.md) describes the Kotlin client, native UI and
verification commands. This page remains the narrower fixture specification; its test
identities and scenarios are not production API fields.

ICA retains its original Instant Client API name as a protocol identifier.
This is the shared contract for the no-UI Swift ↔ TypeScript fixture milestone.
It uses the real `ai` package to encode Vercel UI Message Stream v1. No model,
Rebyte API, database, or persistent worker is involved in this fixture.

This page describes the original fixture only. The persistent Rebyte runtime now
also implements the same device command shapes for native Calendar and Health;
see [device tools](../docs/client-api.md) and [server HTTP commands](../server/README.md#native-device-tools).
It accepts optional `{deviceId,clientContext:{timeZone,currentDate}}` on messages,
has no fixture `scenario`, and uses `instant-dev-*` development identities.
Its error codes include `invocation_not_claimed`, `idempotency_conflict`,
`permission_revoked`, `invocation_cancelled`, and `invocation_expired`; another
user/device's resource is hidden with 404. The fixture-only codes below are not
an alternative persistent API specification.

## HTTP

- Prefix: `/api/v1`; loopback only. Bearer tokens: `instant-test-alice`, `instant-test-bob` (fixture identities only).
- Errors: `{ "error": { "code": "...", "message": "...", "retryable": false }, "requestId": "..." }`.
- `POST /devices/register`, body `{installationId, tools:["instant_test_echo"]}` → 200 `{deviceId}`. Same user/installation reuses device.
- `POST /conversation/messages`, body `{clientMessageId,text,scenario?,deviceId?}` → 202 `{messageId,submissionId}`.
- Scenarios (fixture-only): `text` (default), `tool`, `tool_timeout`, `slow_text`, `broken_stream`.
- Same clientMessageId + identical body returns the original IDs; different body → 409 `idempotency_conflict`.
- `GET /submissions/{id}` → `{submissionId,messageId,status,resultCount,subscriberCount}`. Status: queued/running/waiting_device/completed/failed/cancelled. messageId here is the assistant message ID; POST returns the user message ID.
- `GET /submissions/{id}/stream` → SSE; `x-vercel-ai-ui-message-stream: v1`. Each open starts with a complete reconstruction of the current message and then live updates. The client creates a fresh reducer for this response and replaces its previous message by stable ID.
- `POST /submissions/{id}/cancel`, body `{}` → 200 submission status. Repeated cancel is harmless; terminal completed/failed states remain unchanged.
- `GET /devices/{id}/tool-invocations?status=pending` → `{invocations:[{invocationId,toolCallId,deviceId,expiresAt,toolName,input}]}`. Includes claimed, unexpired, unfinished work.
- `POST /device-tool-invocations/{id}/claim`, body `{deviceId}` → 200 `{executionId,expiresAt}`. Same device repeats receive same executionId. Wrong owner → 404; wrong target → 403 `wrong_device`; expired/cancelled → 410 `invocation_expired`.
- `POST /device-tool-invocations/{id}/result`, body `{deviceId,executionId,success,output?,error?}` → 200 `{accepted:true,duplicate:boolean}`. Wrong executionId → 409 `execution_mismatch`. Identical retry accepted once (even after completed); conflicting retry → 409 `result_conflict`. Unclaimed → 409 `not_claimed`. Expired first result → 410 `invocation_expired`. User/device ownership is always checked before returning a stored receipt.
- Missing/bad token → 401 `unauthorized`; another user's resource → 404 `not_found`; malformed input → 400 `invalid_request`.
- `GET /health` (outside prefix, no auth) → `{status:"ok",mode:"fixture"}`.

## Stream and runtime

- Standard chunks: start, text-start/delta/end, tool-input-available,
  tool-output-available/error, finish, error, abort; terminal `[DONE]` marker.
- `data-instant-submission`: data `{schemaVersion:1,submissionId,status}`.
- `data-instant-device-request`: data `{schemaVersion:1,invocationId,toolCallId,deviceId,expiresAt}`; tool name/input comes from matching standard tool-input-available.
- Text and tool scenarios intentionally use Mandarin text and emoji to exercise
  Unicode streaming. Exact payloads are defined in the
  [fixture implementation](../server/src/server.ts) and its tests.
- The fixture tool is `instant_test_echo`, with input `{text: string}` and success
  output `{echo: string}`.
- Tool handler failure emits tool-output-error, a failure message, submission
  `failed`, then finish + DONE. An accepted protocol receipt does not imply a
  successful tool execution.
- Timeout: server emits tool-output-error `device_timeout`, failed status and terminal markers. Fixture deadline configurable for tests; not Rebyte's production deadline.
- Runtime starts when POST is accepted, independent of any subscriber. Closing SSE must never cancel a submission. Multiple subscribers each get the full current message then live updates.
- `slow_text` delays completion to allow deterministic disconnect/cancel tests; `broken_stream` intentionally closes the socket mid-event without finish/DONE.
- Replay is for rendering only. Receiving tool-input-available alone never executes a handler. Only a matching live/pending device request and valid claim authorize a handler; clients keep invocation receipts to avoid re-execution on replay.
- Fixture state is process memory. No process-restart durability is claimed.

## Test commands

`npm test` typechecks and runs TypeScript tests, Swift unit tests, then Swift HTTP integration tests against an automatically started fixture server on a random port. Server lifecycle is owned by the runner and cleaned up on failure/signals. `npm run test:ios` runs both Swift suites on a temporary iOS Simulator without an App UI, verifies results through xcresulttool, then deletes the temporary device. Both commands fail if the selected integration suite is empty or skipped.

## Connector commands

`GET /api/v1/connectors` returns `{ connectors: [...] }`, the shelf in display
order (featured first), each with `toolkit`, `name`, optional `description` and
`logoURL`, `featured`, and this user's connection state. Commands for one app
under `/api/v1/connectors/{toolkit}` support GET status, POST `/connect` and
`/refresh` with `{}`, and DELETE disconnect. Status is
`disconnected|pending|connected|expired`; a connect result contains `redirectURL`
and `expiresAt`. Provider account and auth config IDs and credentials are
server-owned. The Swift client implements this contract; see
[client API](../docs/client-api.md). Connector tool calls use the existing UI tool
input/output stream events and durable submission commands; they do not dispatch
to the device.

## Listening

Authenticated audio upload, paginated all-history and per-day transcript listing, and deletion are implemented by the server and `InstantClient`. Without `from`/`to`, GET accepts `limit` and an opaque `cursor` and returns `nextCursor`; existing day queries remain compatible. The HTTP headers, response fields, limits and retry semantics are defined in [Listening](../docs/client-api.md). These source transcripts are independent of chat/UI stream events.

## Android UI fixture

`npm run dev:android-fixture` starts a separate, loopback-only synthetic fixture
on port 3011 using the production HTTP/SSE adapter and in-memory repositories.
It exercises Chat, Tasks/follow-ups, Brief/settings/sources, Memories,
Echo hydration/labels/deletion, simulated connector authorization and exact-byte
uploads. The server rejects production mode and has no provider credentials.
The fixed Bearer identity is `instant-dev-alice` (or `instant-dev-bob` for
ownership tests). Fixture data is reset at restart; authorization browser pages
and transcript output explicitly identify synthetic behavior.

`npm run test:android:ui` starts its own instance and forwards emulator port
3011. It is separate from the small Swift protocol fixture documented above.
Kotlin protocol and app-unit checks run through `npm run test:android`; Android
build/emulator acceptance is tracked in the platform guide.
