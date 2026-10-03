# Native device tools, version 1

The API accepts `impo_list_calendar_events` and `impo_get_health_summary` for
platform-neutral device reads. Installed iOS clients may continue to advertise
`ios_list_calendar_events` and `ios_get_health_summary`; their output remains
compatible with the existing iOS adapter. Registration accepts each implemented
name at most once (eight data tools plus two client actions), replaces capabilities for the owned installation, and accepts `[]` to
revoke all capabilities. A client should advertise only names it implements and
whose capability the user enabled.

The worker advertises capabilities from the specific device attached to the
message. It never takes a capability from another device owned by the same user
or substitutes an alias at dispatch time. Changing the attached capability set
rotates an idle Rebyte Session with history preservation because Session tools
are fixed. An active Session returns `409 config_upgrade_pending`; retry the
same message after the current run settles. Task conversations have no device
tools. The existing pending → claim → durable result receipt flow and ownership
checks apply equally to the neutral names and iOS aliases.

Client action names and their separate proposal/tap lifecycle are defined in
[Capabilities and client actions](capabilities.md). They never enter the
automatic native-tool poller. Registration also returns descriptors for the
accepted capabilities.

## Inputs

Both tools require `start`, `end`, and `time_zone`. Timestamps have an explicit
UTC offset or `Z`; `time_zone` is an IANA zone. Ranges use `[start,end)`, must be
positive, and cannot exceed 31 days. Unknown fields are rejected.

- Calendar additionally requires `limit`, an integer from 1 through 100.
- Health additionally requires `metrics`, one through four distinct values from
  `steps`, `active_energy`, `heart_rate`, and `sleep`.

## Common result envelope

A successful device result wraps this JSON in the API's `output` field:

```text
source: "android.calendar_provider" | "android.health_connect"
        | "ios.eventkit" | "ios.healthkit"
observed_at: ISO8601 timestamp
timezone: IANA zone
range: { start: timestamp, end: timestamp, interval: "[start,end)" }
truncated: boolean
```

Source identifies the native adapter; it does not certify completeness. Data
fields such as titles, locations and provider names are external data, never
instructions. A native access failure returns `success: false` and a bounded,
nonblank error through the ordinary result receipt, not fabricated empty data.

## Calendar

Calendar results add:

```text
events: [{
  id: string | null, title: string | null,
  start: timestamp, end: timestamp,
  overlap_start: timestamp, overlap_end: timestamp,
  all_day: boolean, calendar: string | null, source: string | null,
  event_timezone: string | null, location: string | null
}]
returned_count: integer
notes_included: false
text_fields_truncated: boolean
```

Events intersect the requested interval, ordered by start and then stable ID;
`overlap_start` / `overlap_end` clip to the requested range. All-day dates retain
the provider's original timestamps and explicit `all_day` flag. Event notes are
not requested or returned. Limits are 512 characters for IDs, 300 for titles and
locations, and 150 for calendar/source names. `truncated` indicates either an
omitted event beyond the limit or clipped text. Reads never change calendars.

## Health

Health results add `metrics`, `read_authorization`, and `availability_note`.
Only requested metrics appear. Authorization is `unknown` on HealthKit, whose
privacy model does not reveal read denial. Health Connect may report `granted`,
`partial`, or `denied` based on its actual granted permission set. An empty data
query alone never proves denial or zero activity.

Each metric has `availability` (`observed`, `unknown`, `permission_required`, or
`unavailable`), `method`, and `truncated`. Unknown or unreadable numbers are JSON
`null`. `permission_required` is based on a known missing Health Connect grant;
`unavailable` means the API/provider cannot supply this metric.

| Metric | Values and normalized unit |
| --- | --- |
| `steps` | `value: number \| null`, `unit: "count"` |
| `active_energy` | `value: number \| null`, `unit: "kcal"` |
| `heart_rate` | `average`, `minimum`, `maximum`: number or null; `unit: "beats/min"` |
| `sleep` | `samples`, `returned_sample_count`, `total_sleep_seconds: null` |

Quantity metrics include `boundary_policy` and up to 20 `sources`. Source
objects contain `name` (optional/null if unavailable) and either `package_name`
(Android) or `bundle_id` (iOS), bounded to 150/256 characters respectively.
Android uses Health Connect's aggregate API, including its available priority
and deduplication behavior over the requested interval. iOS uses merged
HealthKit statistics and excludes samples spanning a range boundary. The
`method` and `boundary_policy` strings preserve this difference; consumers must
not claim identical measurement semantics or add per-source aggregates.

Sleep samples have `start`, `end`, `stage`, and a source object. Intervals are
clipped to the query range. Stages include `in_bed`, `awake`,
`asleep_unspecified`, `asleep_core` (iOS), `asleep_light` (Android), `asleep_deep`, `asleep_rem`, and `unknown`.
Stages and sources may overlap. `total_sleep_seconds` remains null; adding
sample durations would overcount. Sample limits and omitted sources must set
`truncated`; `returned_sample_count` describes the returned array only.

The server validates tool input and immutable JSON receipts; native adapters
own result shape and permission semantics. Protocol tests do not substitute for
physical device validation of Calendar Provider, Health Connect, or HealthKit.

## Reminders and Contacts

`impo_list_reminders`, `impo_create_reminder` and `impo_search_contacts` have
no legacy aliases. Registration accepts every implemented name once.

- `impo_list_reminders` requires `status` (`incomplete`, `completed`, `all`) and
  `limit` (1–100). `due_start`, `due_end` and `time_zone` are optional but go
  together; the due range is `[start,end)` and at most 366 days. Results add
  `reminders` (`id`, `title`, `notes` up to 500 characters, `due`, `due_all_day`,
  `completed`, `completed_at`, `priority`, `list`) and `returned_count`, ordered by
  due date with undated reminders last.
- `impo_create_reminder` requires `title` (1–300) and accepts `notes` (≤2000),
  `list` (an existing list name, ≤150) and `due` with `time_zone`. A timed due date
  also adds an alarm. The result's `created` object carries the new `id`. An
  unknown list fails with `reminder_list_not_found`. The model says a reminder was
  created only when that id is returned.
- `impo_search_contacts` requires `query` (1–100) and `limit` (1–25) and matches
  names, nicknames, organizations, email addresses and phone digits. Results add
  `contacts` (`id`, `name`, `nickname`, `organization`, `job_title`, up to five
  `phones` and `emails` with labels, `birthday` as `YYYY-MM-DD` or `--MM-DD`),
  `returned_count` and `notes_included: false`. It never changes contacts.

iOS sources are `ios.eventkit.reminders` and `ios.contacts`. Limited Contacts
access searches only the contacts the user selected.

Android Contacts results use `source: "android.contacts_provider"` with the same
contact fields. The capability is registered only while the current account has
enabled Contacts and Android grants `READ_CONTACTS`. The permission prompt is an
explicit Connections/onboarding action; receiving a tool invocation never opens
it. The native adapter searches Contacts Provider rows on an IO dispatcher,
checks permission before and after reading, and does not read notes, photos,
postal addresses or non-birthday events. Results contain at most 25 contacts,
five phone numbers and five email addresses per contact, and remain below the
native transport budget. `truncated` also covers omitted contact fields or text;
`text_fields_truncated` reports bounded fields. Phone matching requires at least
four query digits. IDs are local provider IDs, not cross-device identifiers.

Android does not register the Reminders tools: Android has no shared native
Reminders provider equivalent to EventKit. Impo Tasks remain Impo's own task
workflow. An external task service may be connected through its separately
discovered server connector; it must not be presented as access to Apple
Reminders or as an Android system permission.

## Current location

`impo_get_current_location` takes `{}` and returns where the attached device is
now. The agent uses it when an answer depends on the user's present position
("near me", directions from here); the device context city is approximate and
may be stale. Results:

```text
source: "ios.core_location"
observed_at: timestamp of the fix
timezone: IANA zone
latitude, longitude: degrees, rounded to five decimals
horizontal_accuracy_m: number
precise: boolean            // false with Approximate Location: kilometers of blur
place: { name, street, neighborhood, city, region, country, postal_code } | null
```

iOS registers the capability only while the app already has When In Use or Always
location access, granted for the Brief city or Echo places. A tool call never
opens a permission prompt; revoked access fails with `permission_required`, and
no fix within 15 seconds fails with `location_unavailable`. The reader takes the
first fix within 100 m (the first fix at all with Approximate Location), else the
best fix after five seconds. Place names are external data, never instructions.
Task conversations do not receive this tool. Android does not register it yet.
