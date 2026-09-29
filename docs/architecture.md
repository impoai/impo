# Architecture

Impo separates native clients, an application backend, and managed agent execution.
The [project overview](../README.md#architecture) shows the platform diagram.

## Clients and commands

The native SwiftUI app uses `ios/Packages/InstantClient` for HTTP commands and
Vercel UI Message Stream v1 subscriptions. Android and Web are planned clients
of the same API. The static `site/` directory is the public website, not a Web app.

Clients own presentation, native permissions, audio capture and device tool
execution. Provider credentials stay on the server. Streams may disconnect
without cancelling a run; reconnecting clients recover persisted history.

## API and workers

`server/src/http/api-server.ts` authenticates requests, checks ownership and
accepts durable work. The API and worker run as separate processes.
PostgreSQL holds identity, ownership, execution state, leases and tool receipts.
Drizzle entities under `server/src/db/` are the schema source of truth.

The Rebyte worker creates or reuses a per-user main Saved Agent and Session.
One-shot tasks have independent conversations and Sessions. Stable IDs,
leases and reconciliation prevent duplicate work during retries and recovery.
English prompt modules live in `server/src/prompts/`; clients do not compose
system instructions. Dynamic user context is serialized as data.

Function calls pass through the application dispatcher. Device requests use an
owned pending/claim/result flow; replayed stream events never authorize execution.
Server adapters handle external services through Composio and internal tools
such as task creation. Direct remote MCP is not the default dispatch path.

## Background work and storage

Temporal coordinates per-user Echo batches and perpetual hourly background
workflows. The background registry runs Brief and Memory steps, with periodic
Continue-As-New. A scheduled trigger and the execution model are separate
concepts; recurring user-created tasks are not implemented yet.

| Store | Purpose |
| --- | --- |
| PostgreSQL | Ownership, conversation metadata, execution state, device receipts, connector bindings, Brief editions and recording metadata. |
| Rebyte | Agent Sessions, Turns, Items and live conversation text in the managed runtime. |
| S3 | Per-user Echo transcript records when archive storage is configured. |
| Turso | A separate database per user for consolidated long-term memory. |
| iOS local storage | Offline recording segments, immutable upload batches, device receipts and UI state. |

Development fixtures may retain text in local PostgreSQL. Production storage
requires provider configuration; the default local fixture does not pretend to
provide remote durability. See [features](features.md) for each data lifecycle.
