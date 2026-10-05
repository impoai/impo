# Impo server

The TypeScript backend exposes the client HTTP/SSE API and runs independent
workers for agent conversations, tool dispatch, Echo transcription, and Brief and Memory
processing. PostgreSQL and Drizzle persist application state; Rebyte executes
Agents, and Temporal coordinates audio batches and hourly background work.

See the [architecture overview](../README.md#architecture). Server dependencies
and TypeScript configuration belong to this npm workspace. Run the commands below
from the repository root. Existing `INSTANT_*` variables and `@instant/server`
remain compatibility identifiers.

## Start the persistent development server

Requires Node.js 22+ and PostgreSQL server binaries: `postgres`, `initdb`,
`pg_ctl`, `psql`, and `createdb`. The scripts search `PATH` and common installation
paths; set `PG_BIN` to your PostgreSQL binary directory if needed.

```sh
npm ci
```

If the root `.env` does not exist, create it once:

```sh
cp .env.example .env
```

Then prepare the database:

```sh
npm run db:start
npm run db:push
npm run db:seed
```

`db:start` creates a repository-local cluster under `.local/postgres/` and the
`instant_development` database on `127.0.0.1:55432`. It does not use a global
PostgreSQL service. `db:status` checks it; `db:stop` stops it without deleting data.
To choose a different port on first initialization, set `INSTANT_PG_PORT` and
update `DATABASE_URL` in `.env`.

Start the API and worker in separate terminals:

```sh
npm run dev:api
```

```sh
npm run dev:worker
```

Both read the root `.env`. The API defaults to `127.0.0.1:3001`; `PORT=0` selects
an available port. The worker is independent of HTTP requests: accepted work
stays queued while it is stopped and resumes when it starts. An interrupted job
can be claimed again after its lease expires.

## Configuration

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | Default local value: `postgresql://instant@127.0.0.1:55432/instant_development`. |
| `INSTANT_AUTH_MODE` | `local-dev` for fixed development identities; `clerk` for live authentication. |
| `INSTANT_RUNTIME` | `development` for deterministic echo; `rebyte` for remote agent execution. |
| `HOST` / `PORT` | Default `127.0.0.1` / `3001`; use a Mac private IPv4 address for local iPhone access. |
| `INSTANT_WORKER_POLL_MS` | Worker poll interval; default `100`. |
| `WORKER_LEASE_MS` | Execution lease; default `10000`. |
| `DEVICE_TOOL_TIMEOUT_MS` | Device tool deadline; default `300000`. |
| `REBYTE_API_KEY` | Required for the Rebyte runtime; server-only. |
| `REBYTE_BASE_URL` / `REBYTE_MODEL` | Rebyte endpoint and model ID; see `.env.example`. |
| `COMPOSIO_API_KEY` / `COMPOSIO_AUTH_CONFIG_PREFIX` | Optional app connectors; the shelf is every enabled managed auth config named `<prefix><toolkit>` (default `rebyte-dev-`). |
| `GEMINI_API_KEY` | Real Echo and hold-to-talk transcription; without it, development uses deterministic transcribers. |
| `VOICE_TRANSCRIPTION_MODEL` | Hold-to-talk model; default `gemini-3.5-transcribe`. |
| `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` | Set both to enable batch coordination and background workflows. |
| `TEMPORAL_API_KEY` | Authentication for the configured Temporal Cloud service. |
| `LISTENING_TASK_QUEUE` | Shared worker queue; defaults to `impo-listening-v1`. |
| `CLERK_SECRET_KEY` / `CLERK_PUBLISHABLE_KEY` | Required in Clerk authentication mode. |

Local development mode requires a loopback database named `instant` or
`instant_<name>` and refuses `NODE_ENV=production`. Seeding creates Alice, Bob,
and the development agent/tool configuration. Schema push and seeding are repeatable.

## Rebyte execution and recovery

Set `INSTANT_RUNTIME=rebyte` and your `REBYTE_API_KEY`, then restart both API and
worker. `/health` reports the selected runtime. The server pins
`@rebyteai/agent-sdk@0.2.4` and uses `client.beta.agents`.

Each user has one main conversation, a lazily created Saved Agent, and one current
main Session. Main Chat rotates before an unsent turn after six idle hours, eight
remote turns, or an estimated 12,000-token context (including the next input).
The replacement carries only the last two completed turns, up to 3,000 text
characters, with 750 per message; profile and Memory-first instructions remain.
The conversation, Saved Agent and full readable history survive rotation. No
extra model summary is generated. Tasks use separate conversations and inline agent
Sessions; they do not create a Saved Agent for every task.

`src/persistence/main-session-policy.ts` owns these server-side defaults. Context
size is a soft estimate from UTF-8 JSON bytes / 3, including instructions, tools
and Session Items; it is not an exact tokenizer or aggregate Turn usage. A single
large turn can exceed the budget and triggers rotation before the next input.
Existing Sessions without an estimate rotate on their next unsent turn. Queued
messages move together; active, waiting and uncertain remote inputs retain their
original Session for recovery. Tasks and background briefs are unaffected.

The worker subscribes to Rebyte events before follow-up input and reconciles
ordered Turns and Items. Stable IDs support history recovery without repeating
already displayed text. Database leases are renewed while a worker is alive;
an expired owner cannot overwrite the replacement's result.

Remote Agent/Session creation can have an uncertain outcome after a lost response.
The worker persists creation intent and reconciles metadata before attempting
another create. An ambiguous result remains pending reconciliation instead of
creating a duplicate resource.

Cancellation is explicit: the local submission reaches its terminal state after
the remote Turn is terminal. Closing the client stream only removes a subscription.
On first switching from the echo runtime, a completed development binding is
retired and a real binding is created. Use an isolated database when switching
back from an existing real conversation to the development runtime.

## HTTP contract

In local development, use `Authorization: Bearer instant-dev-alice` or
`Authorization: Bearer instant-dev-bob` for `/api/v1` requests. These differ from
the in-memory fixture tokens. JSON writes require `Content-Type: application/json`.

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Process health and selected runtime. |
| `GET /ready` | Database/schema readiness; returns 503 when unavailable. |
| `POST /api/v1/conversation/messages` | Accepts `{clientMessageId,text,deviceId?,clientContext?}`; returns a message/submission receipt. |
| `GET /api/v1/conversation?afterSequence=0&limit=50` | Conversation history, active submissions, and pagination. |
| `GET /api/v1/submissions/:id` | Execution status and saved result count. |
| `POST /api/v1/submissions/:id/cancel` | Explicit cancellation, with body `{}`. |
| `GET /api/v1/submissions/:id/stream` | Reconstructed message state followed by streamed updates. |
| `GET/POST /api/v1/scheduled-tasks` | List/create owned scheduled tasks. See [the contract](../contracts/scheduled-tasks.md) for editing, deletion and run history. |
| `GET /api/v1/tasks` | Owned tasks, latest execution status, and `updatedAt`, ordered by latest modification. |
| `POST /api/v1/tasks` | Starts a task with `{clientMessageId,text,clientContext?}`. |
| `GET /api/v1/tasks/:id/conversation` | History for an isolated task conversation. |
| `POST /api/v1/tasks/:id/messages` | Follow-up input within that task's Session. |

Task `updatedAt` is the latest persisted change to the task, conversation, or run.
It advances on follow-ups and execution updates; reading the list does not change
it. Clients display this as a relative time, independently of execution duration.
The existing `createdAt` and last-run timestamps remain available.

Example:

```sh
IMPO_DEV_TOKEN=instant-dev-alice
curl --fail-with-body http://127.0.0.1:3001/api/v1/conversation/messages \
  -H "Authorization: Bearer ${IMPO_DEV_TOKEN}" \
  --json '{"clientMessageId":"demo-1","text":"Hello Impo"}'
```

An identical retried command returns its original receipt; conflicting reuse of
an idempotency key returns 409. Every resource is checked against the authenticated
user. Another user's resource is hidden with 404. Persistent message commands
accept device/context fields, but reject fixture-only fields such as `scenario`.

Streams use the Vercel UI Message Stream v1 encoder from the `ai` package.
Reconnection starts a fresh client projection using stable message IDs. Streaming
is a subscription to execution; no stream needs to stay open for work to finish.
The implemented fixture subset is documented in [contracts](../contracts/README.md).

## Native device tools

Calendar and Health use the `ios_list_calendar_events` and
`ios_get_health_summary` functions. Swift registers the installation and opted-in
capabilities, includes `deviceId` and `clientContext` with messages, and executes
only owned pending work after a server claim.

| HTTP command | Purpose |
| --- | --- |
| `POST /api/v1/devices/register` | Idempotent installation registration and current tool capabilities. |
| `GET /api/v1/devices/:id/tool-invocations?status=pending` | Owned, unexpired pending/claimed calls. |
| `POST /api/v1/device-tool-invocations/:id/claim` | Stable execution ID and deadline for the target device. |
| `POST /api/v1/device-tool-invocations/:id/result` | Immutable, idempotent success/error receipt. |

The native app persists results before upload. Revoking a capability blocks new
claims and first result submissions; an already accepted identical receipt stays
idempotent. Device work waits for the phone or expires. Tasks do not have device
tools and cannot create nested tasks. See [device tools](../docs/features.md).

## App connectors

Impo uses Rebyte's Composio shelf: every enabled, Composio-managed auth config
named `<COMPOSIO_AUTH_CONFIG_PREFIX><toolkit>` (about 120 apps, Gmail, Google
Calendar, Notion, GitHub, Outlook and more) is a connector. The server reads that
directory from Composio and caches it for ten minutes; there is nothing to seed.
Configure `COMPOSIO_API_KEY`, synchronize the schema, and restart the API and
worker. In iOS Library → Connections, authorize an app through the hosted OAuth
flow. Only a server-verified account is connected.

Each connection owns one Composio Tool Router Session pinned to that account. As in
Rebyte, the agent never receives per-app tools: it always has the same four
Functions — `instant_list_connectors`, `instant_search_connector_tools`,
`instant_get_connector_tool_schemas` and `instant_execute_connector_tools` — each
naming one connected app. Search returns the concrete Composio tools for the task,
and every tool the app's Composio toolkit offers can run, exactly as in Rebyte.
Work continues server-side when the app closes. See
[tools and permissions](../docs/features.md) for ownership and recovery contracts.

## Echo and Listening batches

The worker requires FFmpeg on PATH for multi-file audio decoding; the runtime
Docker image includes it. Gemini returns anonymous speaker turns, and the user
must confirm their voice before speech enters Memory or Brief. See the shared
[speaker contract](../contracts/echo-speakers.md). Run `npm run test:server`,
`npm run test:listening`, `npm run test:listening-batches`, `npm run test:memory`
and `npm run test:today` for the relevant protocol and persistence checks.

Clients request a signed URL at `POST /api/v1/listening/uploads`, PUT the immutable
file directly to S3, then confirm at `/api/v1/listening/uploads/:batchId/complete`.
See the [upload contract](../docs/client-api.md#direct-echo-uploads). The API and
worker share a Temporal namespace and task queue. Each batch gets an independent,
deduplicated workflow; bounded worker concurrency controls transcription load.
PostgreSQL and new Temporal inputs contain metadata and S3 references, not audio.

Set `TRANSCRIPT_BUCKET` and `AWS_REGION` for direct uploads. The service role needs
S3 Get/Put/Delete on `users/*` plus prefix-scoped ListBucket for missing-object
checks. Keep the bucket private, encrypted and without object versioning.
Configure an expiration lifecycle of one day for the exact `users/_uploads/`
prefix. Confirmed audio is copied to `users/<userId>/echo-audio/` and retained
through failures for explicit retry; the worker deletes it after transcription.
Do not apply staging expiration to confirmed audio or transcript prefixes.

`GET /api/v1/listening/segments` merges batch and legacy recording history,
newest first. It accepts `limit` (default 30, maximum 100) and an opaque `cursor`,
or `from`/`to` for a day. Failed batches can be retried with
`POST /api/v1/listening/batches/:batchId/retry`. Deletion leaves a tombstone.
The legacy upload/lease path remains for older clients and queued recordings.
See [batch coordination and diagnostics](../docs/features.md).

For local Temporal development, run its CLI server in a separate terminal:

```sh
temporal server start-dev --port 7239 --headless
```

Set `TEMPORAL_ADDRESS=127.0.0.1:7239` and `TEMPORAL_NAMESPACE=default` in `.env`
and restart the API and worker. A local server does not need a Temporal API key.

## Hourly background work and Brief

With Temporal configured, the worker provisions one `impo/background/<user UUID>`
workflow per app user. It uses durable hourly timers and Continue-As-New after
24 ticks. The `today.v1` step is registered when the Rebyte runtime is configured;
additional Agent/function steps can be added through the background step registry.
Each step receives a stable idempotency key.

Brief checks saved locale, time zone, and brief-time preferences, invokes a
dedicated Rebyte Agent, and saves append-only card editions with source/runtime
provenance. Existing days are not overwritten. Rebyte's Schedule API is not used.
See [background workflows](../docs/features.md) and
[Brief](../docs/features.md).

## Database and code layout

Notifications share one [cross-platform policy](../contracts/notifications.md).
`notification_settings.preferences` is the per-user JSON document. Completion
transactions enqueue Chat/Task/Brief events and snapshot eligible installations;
Temporal handles delivery retries and the Worker rechecks preferences, presence,
ownership and expiry immediately before FCM. No historical notification backfill
is performed when a user enables a category or registers a device.

Set `NOTIFICATIONS_ENABLED=true` and inject `FCM_SERVICE_ACCOUNT_JSON` into the
Worker from the deployment secret store. A configured Temporal connection is
required. The API needs neither the FCM credential nor a direct provider call.
In production, `rebyte/prod/impo-fcm` holds the dedicated `impo-push` sender key;
APNs keys are configured in Firebase, with separate secret-store backups. No
private push key belongs in Git, a Docker build context, or a native app.

| Area | Implementation |
| --- | --- |
| PostgreSQL Drizzle entities | `src/db/entities/`, exported by `src/db/schema.ts`. |
| Per-user Turso Drizzle entities | `src/db/memory-schema.ts`: memories, history, metadata and vector indexes. |
| Database access | `src/db/repositories/`: domain operations, ownership, transactions, leases and typed CRUD. |
| Connections and schema synchronization | `src/db/client.ts`, `src/db/memory-client.ts`, `drizzle.config.ts`, `npm run db:push`. |
| Durable conversations and commands | `src/db/repositories/runtime-repository.ts` and `rebyte-repository.ts`; Session policy remains in `src/persistence/`. |
| HTTP API and authentication | `src/http/`, `src/api-main.ts`. |
| Execution and tool dispatch | `src/worker/`, `src/worker-main.ts`, `src/tools/`. |
| Rebyte SDK boundary | `src/rebyte/`. |
| Audio and background workflows | `src/listening/`, `src/background/`, `src/temporal/`. |
| Brief generation | `src/today/` (retained compatibility name). |
| Long-term memory | `src/memory/`. |

Database constraints enforce ownership references, a single main conversation
and current binding, and unique command/call/job identifiers. Command acceptance
and enqueueing happen in one transaction. During development, edit the Drizzle
entities and run `npm run db:push`; do not generate SQL migrations, histories,
or Drizzle snapshots/journals. Integration tests initialize their databases through
the same schema synchronization path.

API handlers, workers and application services call domain repositories; they do
not import query builders, drivers or table values. Only composition entry points
open database connections and inject repositories. Repository methods own complete
operations (for example, accepting a message and enqueueing work in one transaction)
and return records or receipts, without exposing a query builder or connection.
`test/database-boundary.test.ts` enforces this boundary in `npm run test:server`.

The PostgreSQL entities cover users/profiles, conversations/messages/tasks,
Agent/Session creation and bindings, submissions, tools/devices, connectors,
recordings/batches, Brief, memory coordination and notifications. Turso entities
cover the memory content, source/category JSON, embeddings, operation history and
embedding metadata in each user's separate database. `MemoryStore` handles
embedding and application validation; its repositories handle both database stores.
Each memory change and its history receipt commit together, including forgetting
and expiration. Existing v1 databases retain their layout and contents. New
per-user databases are initialized from the Drizzle definitions, without a SQL
migration history.

Use Drizzle selects, joins, unions, inserts, updates and deletes for CRUD. Small
parameterized SQL expressions remain inside the database layer for PostgreSQL
advisory locks, database clocks, JSON operations and date formatting, and for
Turso vector/JSON functions. Schema bootstrap DDL is confined to the database
adapter. Cross-user administrative scans and purges belong exclusively to
`MaintenanceRepository`, used by the explicit maintenance scripts; request
handlers must use the owned domain repositories.

## Verification

| Command | Requirements and coverage |
| --- | --- |
| `npm test` | Node and Swift; typechecks, server tests, Swift unit tests, and HTTP/SSE fixture integration. |
| `npm run test:ios` | Xcode/Simulator; Swift protocol tests on a temporary device. |
| `npm run test:db` | PostgreSQL; transactions, idempotency, ownership, restarts, leases, cancellation, and constraints. |
| `npm run test:rebyte` | PostgreSQL; real SDK against a local protocol double, including uncertain requests and recovery. |
| `npm run test:devices` | PostgreSQL; durable native dispatch, receipts, and permissions. |
| `npm run test:connectors` | PostgreSQL; connector ownership and durable external-tool recovery with protocol doubles. |
| `npm run test:listening` | PostgreSQL; recording persistence and recovery. |
| `npm run test:listening-batches` | PostgreSQL and Temporal CLI; durable batch coordination across API/worker instances. |
| `npm run test:background` | PostgreSQL and Temporal CLI; hourly timers, Continue-As-New, provisioning, and recovery. Apple Silicon time-skipping tests require Rosetta. |
| `npm run test:scheduled-tasks` | PostgreSQL and Temporal; owned CRUD, idempotency, revisions, overlap, timer replacement, notifications and account deletion. |
| `npm run test:today` | PostgreSQL; brief scheduling, append-only editions, source invalidation, and Rebyte protocol recovery. |
| `npm run test:live` | Rebyte credentials, PostgreSQL, and Swift; real runtime and Swift acceptance. |

Database suites create isolated temporary clusters rather than clearing the
normal development database. Live tests use the configured development organization
and clean up test-owned resources. Native permission and microphone acceptance
remain separate from protocol-double tests.

## In-memory protocol fixture

```sh
npm run dev:fixture
npm run test:e2e
```

The fixture listens on `127.0.0.1:3000`, uses `instant-test-alice` and
`instant-test-bob`, and exposes scripted scenarios with `instant_test_echo`.
It needs no database or model key; its state disappears when the process exits.
`npm test` and `test:e2e` own their own fixture lifecycle, so a separately started
fixture is only needed for manual exploration. See [contracts](../contracts/README.md).

### Upgrading an existing Gmail-only database

The connector toolkit check has a new name because the pinned Drizzle Kit skips
expression changes on checks with the same name. For an existing database, choose
**create** for `connector_connections_toolkit_slug_check` when `db:push` asks;
this replaces the old Gmail-only check. The equivalent non-interactive command is:

```sh
npm --workspace @instant/server run db:push -- --hints '[{"type":"create","kind":"check","entity":["public","connector_connections","connector_connections_toolkit_slug_check"]}]'
```

The connector database tests verify this upgrade from the previous schema before
exercising multiple app connections. No migration history is required.

The device capability check was renamed the same way when Reminders and Contacts
tools were added. Choose **create** for `device_capabilities_tool_v2_check` too;
with both hints:

```sh
npm --workspace @instant/server run db:push -- --hints '[{"type":"create","kind":"check","entity":["public","connector_connections","connector_connections_toolkit_slug_check"]},{"type":"create","kind":"check","entity":["public","device_capabilities","device_capabilities_tool_v2_check"]}]'
```

`user_profiles` stores whether an account finished onboarding and its personal agent
name and look (`GET`/`PATCH /api/v1/profile`). Accounts that already chatted
before this table existed count as onboarded.

Product discovery uses the read-only `impo_search_products` and `impo_get_product` functions through the existing durable worker. Shopify Catalog receives the requested market, language, currency and price bounds. No new credentials, tables or schema changes are required. The API serves the public UCP profile and ownership-checked fresh product reads; see [the shopping contract](../contracts/shopping.md). Deploy both API and worker for this feature.
