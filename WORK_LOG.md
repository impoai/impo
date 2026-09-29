# Work log

- 2026-09-29 | Completed | Prepared the public source baseline: removed screenshots, visual studies, internal planning and release records; consolidated English developer documentation and added secret checks.
- 2026-09-29 | Included | Native iOS, durable API/workers, chat/tasks, Brief, Echo recording locations, connector/device tools and background Memory. Android and Web clients remain planned.
- 2026-09-29 | Verified | Host tests, 94 native tests and one UI smoke test passed without maintainer credentials; one environment-dependent test skipped. Updated retry fixtures to cover automatic retries and manual recovery.
- 2026-09-29 | Verified | Public files and known local provider credentials checked before the new source baseline; automated secret checks run on pushes and pull requests.
- 2026-09-29 | Completed | Added the MIT license approved by the maintainer.
- 2026-09-29 | Planned | Release readiness: broaden service connections, reduce Echo sync delay and backlog, and let the main agent search owned Memory.
- 2026-09-29 | Completed | Echo now uploads immutable files directly to private S3 with signed SHA-256/length-bound URLs; matching durable job receipts gate local deletion, and independent batch jobs remove transcription admission blocking.
- 2026-09-29 | Verified | Host suite, 24 targeted native cases, real PostgreSQL/Temporal retry/deletion/restart tests, a slow 1.35 MB S3 transfer and real Simulator background S3 upload passed; physical network/background acceptance remains pending.
