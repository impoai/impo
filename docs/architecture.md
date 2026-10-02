# Architecture

Impo separates native clients, an application backend, and managed agent execution.
The [project overview](../README.md#architecture) shows the platform diagram.

## Clients and commands

The native SwiftUI app uses `ios/Packages/InstantClient` for HTTP commands and
Vercel UI Message Stream v1 subscriptions. The Kotlin Android client uses
`android/client` for the same commands, SSE framing/reduction and recovery, with
Compose screens and Android permissions in `android/app`. Android build, unit
tests and local API 35 emulator acceptance have passed; physical-device and
deployed-account validation remain. Web remains a planned client of the API.
The static `site/` directory is the public website, not a Web app.

Clients own presentation, native permissions, audio capture and device tool
execution. Provider credentials stay on the server. Streams may disconnect
without cancelling a run; reconnecting clients recover persisted history.

## API and workers

`server/src/http/api-server.ts` authenticates requests, checks ownership and
accepts durable work. The API and worker run as separate processes.
PostgreSQL holds identity, ownership, execution state, leases and tool receipts.
Drizzle entities under `server/src/db/` are the schema source of truth.
The `db/repositories/` layer owns every database query: API handlers, workers,
application services and maintenance scripts call its domain operations. The
layer preserves transaction boundaries, user ownership, queue ordering and lease
fencing; it does not expose connections or query builders to application services.
PostgreSQL tables are exported by `db/schema.ts`; `db/memory-schema.ts` maps the
per-user Turso memory content, embeddings, history and metadata. Database-specific
SQL functions stay inside this layer. A source-boundary test prevents direct
ORM/driver access from application code.

The Rebyte worker keeps one main Saved Agent per user and rotates its current
Session before unsent input after six idle hours, eight turns, or an estimated
12,000-token context. It carries two completed turns (up to 3,000 text characters),
adds the profile, and keeps Memory retrieval first. Historical Session mappings
preserve the complete conversation for clients. Rotation adds no summarization call.
Brief v2 uses a shared [typed content contract](../contracts/brief.md) for useful
next steps, short recaps, connection offers, feature tips and opted-in occasions.
The hourly worker supplies owned evidence and verified context to an isolated
Rebyte Agent. Server validation resolves eligible action IDs and persists content
preferences and repetition state in `today_settings`. Native actions open an
editable draft or an existing destination; they do not execute automatically.

Account-level `mode` selects a server-owned model for Chat, Tasks, scheduled
occurrences and Brief. Accepted work retains its model snapshot; changes apply
after active work ends. See [model modes](../contracts/model-modes.md) for rollout
prerequisites and current provider limitations.
One-shot tasks have independent conversations and Sessions. Stable IDs,
leases and reconciliation prevent duplicate work during retries and recovery.
English prompt modules live in `server/src/prompts/`; clients do not compose
system instructions. Dynamic user context is serialized as data.

Hold-to-talk transcription is the one model call inside an API request: the
user is waiting on a clip of at most two minutes, the call is bounded to 30 seconds and
stores nothing, and the same request then accepts the text as durable work.
Idempotency by `clientMessageId` makes a retried clip return the text that was already accepted.
Both native clients use this route. Android records bounded AAC/MP4 clips and
persists the exact command before acceptance; releasing the clip transfers its
lifetime from the view to the signed-in account. Task and draft transcription
uses a separate route that accepts no Chat message and follows the view lifecycle.

Function calls pass through the application dispatcher. Device requests use an
owned pending/claim/result flow; replayed stream events never authorize execution.
Server adapters handle external services through Composio and internal tools
such as task creation. Direct remote MCP is not the default dispatch path.

## Background work and storage

Temporal coordinates independent Echo batch jobs and perpetual hourly background
workflows. The background registry runs Brief and Memory steps, with periodic
Continue-As-New. A scheduled trigger and the execution model are separate
concepts. Account-owned scheduled tasks use a dedicated Temporal calendar workflow
per plan and atomically admit ordinary isolated Tasks. Revisions fence old timers;
overlapping runs are skipped. See [scheduled tasks](../contracts/scheduled-tasks.md).

Chat/Task completion and the hourly Brief step both write notification events in
their completion transaction. One per-user JSON preference document controls
Chat, Tasks, Scheduled tasks, Brief and Echo. A shared outbox starts Temporal delivery workflows; the
Worker sends through FCM, which bridges to APNs on iOS. API handlers register
owned installations and preferences but never call a push provider. Chat/Task
events are suppressed while any owned installation has fresh foreground presence.
Native clients also suppress foreground presentation. See the
[notification contract](../contracts/notifications.md) for expiry, retries,
account binding and the limits of in-flight OS delivery.

| Store | Purpose |
| --- | --- |
| PostgreSQL | Ownership, conversation metadata, execution state, device receipts, connector bindings, Brief editions and recording metadata. |
| Rebyte | Agent Sessions, Turns, Items, live conversation text and delivered files (Session artifacts) in the managed runtime. |
| S3 | Private direct audio uploads and per-user Echo transcript records. |
| Turso | A separate database per user for consolidated long-term memory. |
| Android local storage | Account-scoped preferences, immutable Echo batches, durable device receipts and retry state. WorkManager owns upload retry; microphone capture uses a separate foreground service. |
| iOS local storage | Offline recording segments, immutable upload batches, device receipts and UI state. |

Development fixtures may retain text in local PostgreSQL. Production storage
requires provider configuration; the default local fixture does not pretend to
provide remote durability. See [features](features.md) for each data lifecycle.

## Native device capability selection

Android advertises `impo_list_calendar_events`, `impo_get_health_summary` and
`impo_search_contacts` when enabled;
installed iOS clients keep their `ios_*` aliases and also advertise
`impo_get_current_location` while location access is granted. The API captures the attached,
owned device's capabilities at admission. Agent tools are selected from that
specific device, not the union of all devices owned by the user. Dispatch also
rechecks current capabilities and never substitutes an alias or another device.
Changing capabilities rotates an idle Rebyte Session with history preservation;
a busy Session returns `config_upgrade_pending` until the current turn settles.
Tasks never receive native device tools. See the
[native tool contract](../contracts/native-device-tools.md).

## Echo speaker confirmation

The transcription worker joins each batch into one media timeline for anonymous
speaker diarization. Archived utterances are immutable; a revisioned PostgreSQL
review records the user's selected voices and excluded passages. The shared
`personalTranscript` projection supplies Memory and Brief, with no full-text
fallback. Source revisions and read/write validation withdraw stale derived
content when a review changes or the recording is deleted. Labels never identify
people across recordings. See [Echo speakers](../contracts/echo-speakers.md).

## Echo calendar reminders and native stop

`EchoScheduleRepository` owns a revisioned plan in the notification preference
JSON. `EchoScheduleProvisioner` discovers changes and signals one Temporal
calendar workflow per user. Due reminders enter the existing notification outbox
with a fifteen-minute expiry and revision checks. No provider model call or
microphone command runs in the scheduling workflow. iOS `ListeningModel` and
Android `EchoRecordingService` apply the last synced plan to their own active
recording, using an immutable session anchor and an offline local deadline.
The API, timezone rules and lifecycle limits are in
[Echo schedule](../contracts/echo-schedule.md).
