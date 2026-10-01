# Echo schedule

iOS and Android share one account-owned weekly plan. The schedule is off by
default; its initial values are Monday–Friday, 09:00 reminder, 18:00 automatic
stop. Settings and the Echo timeline both link to the schedule editor.

`GET /api/v1/echo/schedule` returns the full plan. `PUT` replaces it:

```json
{
  "enabled": true,
  "weekdays": [1, 2, 3, 4, 5],
  "reminderTime": "09:00",
  "stopTime": "18:00",
  "autoStop": true,
  "timeZone": "Asia/Shanghai",
  "revision": null
}
```

Weekdays use ISO numbering, Monday 1 through Sunday 7. Times are `HH:mm`.
Automatic stop requires a stop time later than the reminder on the same day;
overnight windows are not supported. The first editor defaults to the phone's
time zone. The saved IANA time zone stays fixed during travel, with an explicit
option to adopt the phone's current zone. A missing daylight-saving clock time
shifts forward by the gap; a repeated time uses its first occurrence only.

The server stores the plan at `notification_settings.preferences.echoSchedule`.
Every successful change returns a new UUID revision. Send the last received
revision, including explicit `null` before the first save. Stale edits return
409 `echo_schedule_changed`; an exact retry after a lost response returns the
existing revision. Category patches and plan updates preserve each other's JSON
fields. No endpoint accepts another account's ID.

The worker discovers changes every ten seconds and signals a durable per-user
Temporal workflow, `impo/echo-schedule/<userId>`. Its calendar timer creates one
outbox event per revision and local date. Reminder delivery expires after fifteen
minutes and rechecks the plan revision, enabled state, category preference,
registration, ownership and foreground presence. Edits cancel pending timers;
old queued events are suppressed before delivery. Account deletion removes the
plan and terminates its owned workflow. Reminders never invoke an Agent.

The `echo` notification preference controls reminders independently of automatic
stop. Tapping a reminder opens Echo, without acquiring the microphone. Starting
recording always requires an explicit user action and native microphone access.

An enabled automatic stop ends any ongoing Echo at the next selected weekday's
stop time after the original recording session began. A manual start after
today's stop time uses the next selected day. Pause, interruption, recorder
replacement and resume never advance that original deadline. Editing the plan
recomputes the deadline from the same original session start; an overdue stop
ends the recording immediately. Disabling the plan or automatic stop removes
the deadline. The recording UI displays the absolute next stop in local time.

Each phone persists its last received plan per account. A running recording
uses a local timer and capture-health checks; no network or push is required to
stop. Foreground clients refresh the account plan at most once per minute.
Changes made on another phone take effect after the recording phone next syncs.
Timers can run with active background audio; a paused or suspended app may not
execute until the OS wakes it, but it must not resume an overdue microphone.
OS termination already stops capture, and a cold launch never restarts it.
Stopping finalizes accepted audio through the existing durable upload path.

Validation includes real PostgreSQL and time-skipping Temporal, shared DST tests,
controlled iOS capture lifecycle tests, native schedule editors, and Android
emulator AudioRecord/background-stop checks. Simulator and emulator evidence does
not establish physical-device overnight/background reliability.
