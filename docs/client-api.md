# Client API

The language-independent [application protocol v1](../contracts/client-protocol.md)
defines the client/server boundary, payload shapes, stream reduction, retries
and platform extension limits. Read it before implementing a new client; this
page is the shorter implementation map and Echo reference.

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

## Echo timeline

`GET /api/v1/listening/timeline?timeZone=Asia%2FShanghai` returns the complete
owned inventory as `{timeZone, days:[{date:"2026-09-29", ids:["record-uuid"]}]}`.
Days and IDs are newest first, ordered by recording time and UUID for ties.
Deleted recordings are omitted. The inventory contains no audio, transcript
text, or location, and does not read the transcript archive. The response is a
snapshot; refresh it to discover new recordings.

`GET /api/v1/listening/segments?ids=uuid1,uuid2` hydrates up to 180 IDs, with
ownership checked again on every request. Missing/deleted IDs are omitted;
clients reconcile those slots. The iOS timeline requests at most 30 at once.
These commands avoid mutable offset pagination for distant viewport loads.
The older calendar/count and cursor-history endpoints remain supported.

## Direct Echo uploads

1. Seal one immutable JSON batch on disk. Compute its byte length and SHA-256.
2. `POST /api/v1/listening/uploads` with `{batch, sha256, byteLength}`. Each
   metadata item replaces `audio` with `audioBytes`; all other fields are unchanged.
3. For `status: upload`, PUT the exact file to `url` using the returned `headers`.
   Do not attach the app's bearer token or follow redirects. URLs expire in 15 minutes
   and bind the checksum, content type and length. `status: uploaded` skips this PUT.
4. `POST /api/v1/listening/uploads/:batchId/complete` with `{}`. The server verifies
   S3, copies the object to an immutable worker destination and starts a durable job.
5. Delete local bytes only after a matching `202` receipt containing `batchId`,
   `streamId`, `sequence` and `status: accepted`. A prepare response with
   `status: accepted` includes the same receipt for a previously accepted batch.

Retry the same batch after an interrupted PUT or lost confirmation. Preparation
detects an existing object and refreshes expired URLs. Conflicting identifiers or
content return `409`; foreign batches return `404`; explicit deletion returns `410`.
S3 rejects a checksum mismatch. Limits are 16 items, 1 MiB decoded audio and
1,500,000 bytes per sealed file. Legacy `/listening/batches` remains available.

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
