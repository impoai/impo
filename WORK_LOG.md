# Work log

- 2026-09-29 | Completed | Prepared the public source baseline: removed screenshots, visual studies, internal planning and release records; consolidated English developer documentation and added secret checks.
- 2026-09-29 | Included | Native iOS, durable API/workers, chat/tasks, Brief, Echo recording locations, connector/device tools and background Memory. Android and Web clients remain planned.
- 2026-09-29 | Verified | Host tests, 94 native tests and one UI smoke test passed without maintainer credentials; one environment-dependent test skipped. Updated retry fixtures to cover automatic retries and manual recovery.
- 2026-09-29 | Verified | Public files and known local provider credentials checked before the new source baseline; automated secret checks run on pushes and pull requests.
- 2026-09-29 | Completed | Added the MIT license approved by the maintainer.
- 2026-09-29 | Planned | Remaining release readiness: broaden service connections and let the main agent search owned Memory.
- 2026-09-29 | Completed | Echo now uploads immutable files directly to private S3 with signed SHA-256/length-bound URLs; matching durable job receipts gate local deletion, and independent batch jobs remove transcription admission blocking.
- 2026-09-29 | Verified | Host suite, 24 targeted native cases, real PostgreSQL/Temporal retry/deletion/restart tests, a slow 1.35 MB S3 transfer and real Simulator background S3 upload passed; physical network/background acceptance remains pending.
- 2026-09-29 | Deployed | S3 upload API and workers are healthy in production; an isolated production test verified signed upload, one real transcription despite duplicate confirmation, and audio deletion. TestFlight 0.1.0 (31) is available to the internal Team group; privacy disclosure is live.
- 2026-09-29 | Verified | Real Simulator foreground and background S3 transfers both preserved local audio until API confirmation; final server suite passed 53 tests and GitHub secret scanning passed.
- 2026-09-29 | Completed | Echo defaults to Day and reserves the complete timeline from an owned date/ID inventory; reusable cells load nearby bodies, keep at most 180 cached transcripts and retry in place without removing scroll positions.
- 2026-09-29 | Verified | Host suite, 9 PostgreSQL Echo cases, 10 native history/timeline cases and two 20,000-record/500-day UI flows passed, including a five-second body delay, failed-load retry, distant seeks and scrolling beyond the text cache.
- 2026-09-29 | Deployed | Complete Echo timeline API is healthy in production; a read-only check covered 1,010 recordings without fetching transcripts. TestFlight 0.1.0 (32) is available to the internal Team group; physical-device timeline acceptance remains pending.
