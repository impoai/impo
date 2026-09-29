# Feature behavior

## Chat and tasks

Each user has one main conversation and current main Agent Session. One-shot
tasks use isolated conversations and Sessions. Work survives a client disconnect;
task rows show relative last-modified time. User-defined recurring tasks are planned.

## Brief

An hourly Temporal workflow evaluates configured local briefing hours. A Rebyte
Agent receives bounded source context and produces validated JSON. Editions are
append-only. Source versions allow edited/deleted evidence to invalidate old
content. Locale, time zone and optional city guide timing and presentation.
The interface is named Brief; internal `today` routes and types remain compatible.

## Echo

The iOS app detects speech locally with Silero VAD. Audio segments and metadata
are saved before upload. Sealed batches are immutable across offline recovery
and retries. Speech is sealed about every 30 seconds; Wi-Fi and cellular are
allowed by default, with an optional Wi-Fi-only setting. The app uploads files
directly to private S3 using short-lived, checksum-bound URLs. The API verifies
the object and durably starts a Temporal job before the app deletes local audio.
Each batch transcribes independently; one failed batch does not block uploads.
Google Gemini produces transcripts, which are archived per user. PostgreSQL
keeps metadata; new Temporal jobs carry object references instead of audio.
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

The hourly Memory step reads completed chat history and Echo evidence. An Agent
extracts useful lasting facts and proposes ADD/UPDATE/DELETE operations against
existing memory. Facts have categories, source references and optional expiry.
A pure planner selects bounded windows, defers active conversations and sweeps
expired facts. Each user has a separate Turso database. The API supports summary,
listing and forgetting; the iOS Notes interface displays these records.

The main Chat prompt requires `impo_search_memory` first on every user turn,
before answering or using other tools. The server retrieves only that user's
unexpired memories. The Agent uses relevant facts and prefers the user's latest
statements. Empty or unavailable retrieval lets the conversation continue without
inventing recalled facts. Tasks and scheduled tasks do not get this requirement
or the retrieval tool. Existing main Sessions adopt the new configuration on the
next user message after any active turn finishes.

Manual Echo label edits do
not replay already-consumed evidence. Deleting source recordings does not silently
claim to erase facts already derived from them; users can forget those separately.

## Tools and permissions

Device, external-service and internal business tools share a server dispatcher.
iOS Calendar and Health reads require native permissions and owned device claims.
Empty HealthKit data is unknown, not zero or proof of denied access. External apps
come from Rebyte's Composio shelf (about 120 apps) and connect through Composio
OAuth with server ownership checks; each connection is one pinned Tool Router
Session. The agent uses four fixed connector Functions (list, search, schemas,
execute) instead of per-app tools. Every tool of a connected app's Composio toolkit is available,
as in Rebyte. OAuth consent and real-account verification are separate from
tests with protocol doubles.

Subscription screens, some connection previews and voice previews remain demos.
Android and Web clients, diary generation and broader connector support are planned.
