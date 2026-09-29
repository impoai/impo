# Client API

The application API is separate from the Rebyte Agents API. Clients authenticate
with a Clerk bearer token in deployed mode. Fixed local development identities
work only with the explicitly enabled local runtime and database.

The base URL does not include `/api/v1`; `InstantClient` appends that prefix.
Commands use stable client IDs where supported. Resource ownership is enforced
for reads, writes, streams, device requests, uploads and artifact access.

| Area | Implementation |
| --- | --- |
| Conversation commands and subscriptions | `server/src/http/api-server.ts`, `server/src/persistence/`, `InstantClient.swift` |
| Stream parsing and UI projection | `SSEParser.swift`, `UIMessageReducer.swift`, `server/src/rebyte/` |
| Device pending/claim/result flow | `server/src/tools/device-tools.ts`, `DeviceTools.swift` |
| Task conversations | `server/src/tools/task-tools.ts`, `Tasks.swift` |
| Echo batches, receipts and history | `server/src/listening/`, `Listening.swift` |
| Brief configuration and editions | `server/src/today/`, `Today.swift` |
| Memory summary, list and forgetting | `server/src/memory/`, `Memories.swift` |

Source files under `ios/Packages/InstantClient/Sources/InstantClient/` define the
Swift request and response contracts. API handlers and integration tests are the
authoritative route/validation definitions; fixtures exercise a deliberate subset.

## Streams and recovery

Responses use Vercel UI Message Stream v1 over SSE. Text, reasoning, tool and
status updates have stable identities. The subscription lifetime is independent
of a run. Reconnect using the server's persisted history, and issue an explicit
cancel command when cancellation is intended. Replaying a tool event only renders
it; clients execute a device request after claiming the owned pending command.

## Recording locations

An Echo batch item may include up to 16 ordered location spans. Each includes
`from`, `to`, `capturedAt`, `accuracyMeters`, `source: device`, `granularity`,
`city`, `country`, and optional `district`. The API rejects coordinates and
unknown fields. Spans must be inside the recording interval and fresh at capture.
Legacy uploads without this field keep their canonical content hash.

History exposes nullable `location` context with device spans and an optional
manual label. `PATCH /api/v1/listening/segments/:id/location` accepts exactly
`{"label":"Office"}` or `{"label":null}` and returns the updated `{"segment":...}`.
Manual annotations do not rewrite immutable upload bytes. Deletion clears
associated location metadata and the transcript archive object.

See [protocol fixtures](../contracts/README.md) and the server integration tests
for Unicode streaming, disconnect/recovery, duplicate delivery and ownership.
