# Model modes

The original native `mode` preference has two stable, case-sensitive values:
`Balanced` and `Power`. `GET /api/v1/profile` returns the signed-in account's
mode, defaulting to `Balanced`. `PATCH /api/v1/profile` accepts a partial update
such as `{"mode":"Power"}`. Unknown values, null and caller-supplied ownership
fields are rejected. Older clients can omit `mode` without overwriting it.

PostgreSQL `user_profiles.mode` is authoritative. The existing iOS `instant.mode`
key remains a device cache; Android stores the value in its account-scoped profile.
Both Settings screens expose the selector outside debug mode and show sync errors.
iOS changes its selected value after server acknowledgement; Android retains a
pending account-scoped patch for retry across restarts. Opening Settings refreshes
the server preference. Signing out clears the previous account's visible choice.

## Runtime behavior

`server/src/model-modes.ts` maps tiers to server-controlled Rebyte model IDs:

| Mode | Intended model | Rebyte ID |
| --- | --- | --- |
| Balanced | DeepSeek V4.1 Flash | `deepseek-flash` |
| Power | GPT-6 Sol | `gpt-6-sol` |

Clients cannot submit arbitrary model IDs or provider credentials. Main Chat,
direct and delegated Tasks, scheduled occurrences and Brief all use the account
mode when accepting new execution. A scheduled plan reads the current mode when
it fires, rather than freezing the mode when the plan is created. Internal Memory
consolidation and audio transcription retain their dedicated server configuration.

Accepted input retains its immutable model snapshot, including idempotent retries.
Changing mode never restarts or changes a running task. An idle conversation
rotates its provider Session before the next input and retains its product history.
If the existing conversation still has queued or running work, new input returns
retryable `409 config_upgrade_pending` until that work ends. Brief creation records
the selected model before the remote request; recovery reconciles that same Session
regardless of subsequent preference edits.

## Deployment status and prerequisites

Implemented and locally verified on 2026-10-02; production rollout is blocked by
provider availability. The production Rebyte key rejects `gpt-6-sol` Session
creation with `403 paid_model_required` and rejects the official `deepseek-flash`
ID as unsupported. Its legacy `deepseek-v4-flash` alias maps to V4 Pro in the
deployed Relay source and failed both isolated Session probes, so it is not an
acceptable substitute for V4.1 Flash. A control probe using the existing production
GPT Luna route completed. No credentials, billing entitlements or production
services were changed during these checks.

Before deploying this feature, provide paid GPT access and a working Rebyte Flash
route, then run `npm run test:model-modes:live` for real Session acceptance with both
modes. This uses the configured Rebyte credentials, runs synthetic prompts, and
removes only its own test Sessions. Offline verification is
`npm run test:model-modes` and the native account/profile and UI suites. Push the additive Drizzle
profile column and check constraint before releasing API/Worker and native clients.
Do not deploy the new default routing while either mode is unavailable.

The iOS client can be distributed ahead of the model-routing backend: a legacy
profile response without `mode` shows a disabled **Mode preview**, with neither
choice presented as active. This does not enable model switching or change the
production model. Keep the backend rollout prerequisites above in place.
