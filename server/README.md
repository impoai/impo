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
| `COMPOSIO_API_KEY` / `COMPOSIO_GMAIL_AUTH_CONFIG_ID` | Optional Gmail connector configuration. |
| `GEMINI_API_KEY` | Real Echo transcription; development uses a deterministic transcriber. |
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
main Session. Ordinary follow-ups reuse that Session. Instructions and tools are
configured for the Session. Tasks use separate conversations and inline agent
Sessions; they do not create a Saved Agent for every task.

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

## Gmail connector

Configure `COMPOSIO_API_KEY` and `COMPOSIO_GMAIL_AUTH_CONFIG_ID`, synchronize the
schema, and restart the API and worker. In iOS Settings → Connectors, authorize
Gmail through the hosted OAuth flow. Only a server-verified account is connected.
Search, reads, and draft creation use the current user's account and continue
server-side when the app closes. Sending mail is not implemented.
See [Gmail](../docs/features.md) for ownership and recovery contracts.

## Echo and Listening batches

Clients post immutable audio arrays to `POST /api/v1/listening/batches`.
The API and worker must use the same Temporal namespace and task queue. A fixed
per-user workflow coordinates admission, sequence, retries, and deduplication.
Raw batch audio is handed to Temporal; the application database records batch
identity, source times, execution state, and result references/data.

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

| Area | Implementation |
| --- | --- |
| Drizzle entities | `src/db/entities/`, exported by `src/db/schema.ts`. |
| Database access and schema synchronization | `src/db/client.ts`, `drizzle.config.ts`, `npm run db:push`. |
| Durable conversations and commands | `src/persistence/`. |
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

## Verification

| Command | Requirements and coverage |
| --- | --- |
| `npm test` | Node and Swift; typechecks, server tests, Swift unit tests, and HTTP/SSE fixture integration. |
| `npm run test:ios` | Xcode/Simulator; Swift protocol tests on a temporary device. |
| `npm run test:db` | PostgreSQL; transactions, idempotency, ownership, restarts, leases, cancellation, and constraints. |
| `npm run test:rebyte` | PostgreSQL; real SDK against a local protocol double, including uncertain requests and recovery. |
| `npm run test:devices` | PostgreSQL; durable native dispatch, receipts, and permissions. |
| `npm run test:gmail` | PostgreSQL; connector ownership and durable external-tool recovery with protocol doubles. |
| `npm run test:listening` | PostgreSQL; recording persistence and recovery. |
| `npm run test:listening-batches` | PostgreSQL and Temporal CLI; durable batch coordination across API/worker instances. |
| `npm run test:background` | PostgreSQL and Temporal CLI; hourly timers, Continue-As-New, provisioning, and recovery. Apple Silicon time-skipping tests require Rosetta. |
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
