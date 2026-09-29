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
and retries. Temporal coordinates per-user ordering, admission and transcription
retries; Google Gemini produces transcripts. With S3 configured, transcript text
is archived per user and PostgreSQL keeps metadata. Processed audio is removed
from the app/server upload path; normal provider/Temporal retention still applies.

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

The main Agent does not read consolidated memory yet. Manual Echo label edits do
not replay already-consumed evidence. Deleting source recordings does not silently
claim to erase facts already derived from them; users can forget those separately.

## Tools and permissions

Device, external-service and internal business tools share a server dispatcher.
iOS Calendar and Health reads require native permissions and owned device claims.
Empty HealthKit data is unknown, not zero or proof of denied access. Gmail connects
through Composio OAuth with server ownership checks and supports implemented reads
and drafts. The roadmap targets Composio's catalog; full connector coverage is
not implemented. OAuth consent and real-account verification are separate from
tests with protocol doubles.

Subscription screens, some connection previews and voice previews remain demos.
Android and Web clients, diary generation and broader connector support are planned.
