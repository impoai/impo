# Feature behavior

## Chat and tasks

Each user has one main conversation and current main Agent Session. One-shot
tasks use isolated conversations and Sessions. Work survives a client disconnect;
task rows show relative last-modified time. User-defined one-time, daily and weekly plans are available in Tasks → Scheduled,
with Chat creation, explicit time zones, pause/resume and run history. See the
[shared contract](../contracts/scheduled-tasks.md).

Chat and tasks run in a Rebyte Sandbox, so a reply can deliver files such as a PDF,
spreadsheet or image. The Agent saves them in `/workspace/outputs/`; Rebyte keeps
each one as an immutable Session artifact after the Sandbox expires. The reply
shows a card per file. Tapping it downloads the file through the API (with an
ownership check) into the signed-in account's cache. iOS opens it in Quick Look,
which can also share it or save it to Files. Android opens it in a viewer app.
Impo stores neither the bytes nor the file names.

iOS and Android support hold-to-talk across the empty input field: tap to type,
hold to record, release to send, or swipe up to cancel. The app records a short
AAC clip (up to two minutes) and uploads it on release. A "…" bubble holds its
place while the server transcribes it with Gemini;
the transcript then replaces the bubble and the reply starts from that same text
without another client round trip. The server does not retain the audio. Android
keeps uncertain Chat clips in its private account-scoped outbox for exact-command
retry until acceptance is recovered. Tasks and busy Chat use transcription-only
requests, followed by task commands or a composer draft. This is separate from Echo.
Physical microphone and language behavior still require device acceptance.

Account profiles preserve the assistant's name, avatar selection and onboarding
completion across sign-ins. Custom avatar photos stay on the device that chose
them. Existing accounts with chat history also skip onboarding.

## Brief

Chat and Task completions and new Brief editions support remote notifications
on iOS and Android through Firebase. Settings has an account-synced switch for
each category. Chat and Task alerts stay quiet while Impo is active on an owned
device; native foreground presentation is suppressed for every category. Brief
notification preference is independent of its generation schedule. Delivery and
account-binding rules are defined in [the notification contract](../contracts/notifications.md).

An hourly Temporal workflow evaluates configured local briefing hours. A Rebyte
Agent receives bounded source context and produces validated JSON. Editions are
append-only. Source versions allow edited/deleted evidence to invalidate old
content. Locale, time zone and optional city guide timing and presentation.
The interface is named Brief; internal `today` routes and types remain compatible.

The proposed [Brief content contract](../contracts/brief.md) defines suggestions,
recaps, connection guidance, feature introductions and occasion greetings, with
verified context and explicit actions. It describes the next implementation;
those card categories and actions are not yet implemented in production.

## Echo

The iOS app detects speech locally with Silero VAD. Audio segments and metadata
are saved before upload. Sealed batches are immutable across offline recovery
and retries. Speech is sealed about every 30 seconds; Wi-Fi and cellular are
allowed by default, with an optional Wi-Fi-only setting. The app uploads files
directly to private S3 using short-lived, checksum-bound URLs. The API verifies
the object and durably starts a Temporal job before the app deletes local audio.
Each batch transcribes independently; one failed batch does not block uploads.
Google Gemini produces transcripts and anonymous speaker turns, archived per user.
Users select their voice, choose Not sure or None of these is me, and exclude
misassigned passages. Only confirmed personal speech can enter Memory and Brief;
the full transcript remains in Echo. Labels apply only within a recording and
can be wrong. PostgreSQL keeps review state and metadata; new Temporal jobs carry
object references instead of audio. See the [speaker contract](../contracts/echo-speakers.md).
Processed audio is deleted from S3. Failed jobs retain audio for retry until the
recording is deleted. Unconfirmed staging objects expire after one day when the
documented bucket lifecycle is configured. Legacy clients remain supported.

Echo's timeline defaults to Day. A complete, owned date/record-ID inventory
reserves the entire scroll range before transcript bodies load. Native reusable
cells hydrate the viewport and nearby rows by ID, with at most 180 cached bodies;
evicting text does not remove scroll positions. Distant date jumps fetch their
own records directly. Fixed-height previews keep placeholders and loaded rows in
the same position; the detail screen shows the full text. Failed loads retry in
place, and silent recordings retain an explicit no-speech row. Refresh reconciles
new/deleted IDs while preserving a visible recording where possible.

Optional recording-time location uses iOS permission and Apple's place-name
service. It runs only while Echo capture is active, including a locked screen.
It stops on pause, stop, account change or disabling the setting. Raw coordinates
are not uploaded to Impo. Device spans preserve place names, measurement time,
accuracy and the associated recording interval. Stale/unresolved locations stay
unknown, and recordings can contain several places. Home/Office/custom labels
are explicit annotations. A combined transcript has no sentence-level location
alignment. Physical-device location, background and battery behavior need real
hardware verification; Simulator tests do not establish those results.

## Memory

The hourly Memory step reads completed chat history and confirmed personal Echo evidence. An Agent
extracts useful lasting facts and proposes ADD/UPDATE/DELETE operations against
existing memory. Facts have categories, source references and optional expiry.
A pure planner selects bounded windows, defers active conversations and sweeps
expired facts. Each user has a separate Turso database. The API supports summary,
listing and forgetting; the clients’ About you views display these records.

The main Chat prompt requires `impo_search_memory` first on every user turn,
before answering or using other tools. The server retrieves only that user's
unexpired memories. The Agent uses relevant facts and prefers the user's latest
statements. Empty or unavailable retrieval lets the conversation continue without
inventing recalled facts. Tasks and scheduled tasks do not get this requirement
or the retrieval tool. Existing main Sessions adopt the new configuration on the
next user message after any active turn finishes.

Manual Echo place-label edits do not replay already-consumed evidence. Speaker
review changes create new evidence revisions. Revoked or deleted Echo sources
withdraw dependent memories and Brief editions when accessed or reconciled.
Mixed-source facts are withdrawn as a whole; audit history remains. This does
not erase previously delivered responses or content already seen by the user.

## Tools and permissions

Device, external-service and internal business tools share a server dispatcher.
iOS Calendar/HealthKit and Android Calendar Provider/Health Connect reads require
native permissions and owned device claims. Neutral `impo_*` tools and legacy
`ios_*` aliases are selected only from the device attached to the message; see
the [native tool contract](../contracts/native-device-tools.md).
iOS also supports reading and creating Apple Reminders and searching Apple
Contacts, only when requested and permitted. Reminder writes persist an uncertain
outcome before execution so a crash cannot silently cause a duplicate on retry.
Empty HealthKit data is unknown, not zero or proof of denied access. External apps
come from Rebyte's Composio shelf (about 120 apps) and connect through Composio
OAuth with server ownership checks; each connection is one pinned Tool Router
Session. The agent uses four fixed connector Functions (list, search, schemas,
execute) instead of per-app tools. Every tool of a connected app's Composio toolkit is available,
as in Rebyte. OAuth consent and real-account verification are separate from
tests with protocol doubles.

Subscription screens and some connection previews remain demos.
The Kotlin/Compose Android implementation includes the shared features above,
with build, unit tests and local API 35 emulator acceptance verified. Web and diary generation
remain planned. Native Android microphone/location/Health Connect behavior also
requires physical-device validation. See the [Android guide](../android/README.md).
