# Model modes

The original native `mode` preference has two stable, case-sensitive values:
`Balanced` and `Power`. `GET /api/v1/profile` returns the signed-in account's
mode, defaulting to `Balanced`. `PATCH /api/v1/profile` accepts a partial update
such as `{"mode":"Power"}`. Unknown values, null and caller-supplied ownership
fields are rejected. Older clients can omit `mode` without overwriting it.

PostgreSQL `user_profiles.mode` is authoritative. The existing iOS `instant.mode`
key remains a device cache; Android stores the value in its account-scoped profile.
Both Settings screens expose the selector outside debug mode and show sync errors.
They display tier names and benefit descriptions, without provider or model names.
iOS changes its selected value after server acknowledgement; Android retains a
pending account-scoped patch for retry across restarts. Opening Settings refreshes
the server preference. Signing out clears the previous account's visible choice.

## Runtime behavior

`server/src/model-modes.ts` maps tiers to server-controlled Rebyte model IDs:

| Mode | Intended model | Rebyte ID |
| --- | --- | --- |
| Balanced | DeepSeek V4.1 Flash | `deepseek-flash` |
| Power | GPT-6 Luna | `gpt-6-luna` |

Clients cannot submit arbitrary model IDs or provider credentials. Main Chat,
direct and delegated Tasks, scheduled occurrences and Brief all use the account
mode when accepting new execution. A scheduled plan reads the current mode when
it fires, rather than freezing the mode when the plan is created. Internal Memory
consolidation and audio transcription retain their dedicated server configuration.

Accepted input retains its immutable model snapshot, including idempotent retries.
Changing mode never restarts or changes a running task. An idle conversation
rotates its provider Session before the next input and retains its product history.
When overriding a Saved Agent model, Session creation resets inherited `reasoning`,
`service_tier` and `text` configuration to provider defaults. Instruction-only or
tool-only overrides preserve the Saved Agent's other settings. Explicit creation
rejections (HTTP 400/401/403/404/422) fail the submission, retire its binding and
allow a new user submission; input rejected before any remote Session exists stays
in the owned local history. Timeouts and ambiguous responses still require metadata
reconciliation and must never blindly create a second remote execution.

If the existing conversation still has queued or running work, new input returns
retryable `409 config_upgrade_pending` until that work ends. Brief creation records
the selected model before the remote request; recovery reconciles that same Session
regardless of subsequent preference edits.

## Availability and compatibility

Real Agent Session probes passed for both routes on 2026-10-02 using the production key and endpoint. GPT-6 Sol requires paid access on that account; this release uses the available GPT-6 Luna route with matching native labels. No billing entitlement was changed.

Clients send `X-Impo-Model-Catalog: 2` on authenticated API requests. Only those clients receive `mode` and may change it. Earlier builds receive the legacy profile shape and retain their disabled preview instead of labeling Luna as Sol. A legacy mode update returns `409 model_catalog_upgrade_required`.

Run `npm run test:model-modes:live` before release. It verifies both inline execution and changes from a legacy GPT Saved Agent, using
synthetic prompts and deleting only its own Sessions and Agents. Offline validation is `npm run test:model-modes` plus native account/profile and interaction tests. Deploy the additive `user_profiles.mode` column and check before releasing API/Worker, then iOS build 55 and Android 0.1.9.
