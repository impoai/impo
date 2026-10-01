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

The Rebyte worker keeps one main Saved Agent per user and rotates its current
Session before unsent input after six idle hours, eight turns, or an estimated
12,000-token context. It carries two completed turns (up to 3,000 text characters),
adds the profile, and keeps Memory retrieval first. Historical Session mappings
preserve the complete conversation for clients. Rotation adds no summarization call.
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
concepts; recurring user-created tasks are not implemented yet.

| Store | Purpose |
| --- | --- |
| PostgreSQL | Ownership, conversation metadata, execution state, device receipts, connector bindings, Brief editions and recording metadata. |
| Rebyte | Agent Sessions, Turns, Items and live conversation text in the managed runtime. |
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
installed iOS clients keep their `ios_*` aliases. The API captures the attached,
owned device's capabilities at admission. Agent tools are selected from that
specific device, not the union of all devices owned by the user. Dispatch also
rechecks current capabilities and never substitutes an alias or another device.
Changing capabilities rotates an idle Rebyte Session with history preservation;
a busy Session returns `config_upgrade_pending` until the current turn settles.
Tasks never receive native device tools. See the
[native tool contract](../contracts/native-device-tools.md).
