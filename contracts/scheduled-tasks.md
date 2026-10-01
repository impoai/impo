# Scheduled tasks

iOS and Android manage the same account-owned plans in Tasks → Scheduled. Main
Chat can create a plan with `instant_schedule_task`. Plans run on the server
while the app is closed. Offline Demo cannot run schedules.

## API

All paths below start with `/api/v1/scheduled-tasks`, require authentication,
and enforce account ownership. Identifiers and revisions are UUIDs.

| Method and suffix | Request | Response |
| --- | --- | --- |
| `GET /` | None | `{schedules: ScheduledTask[]}` |
| `POST /` | `{clientRequestId,title,goal,schedule,enabled}` | 201 `ScheduledTask` |
| `GET /:id` | None | `ScheduledTask` |
| `PUT /:id` | `{revision,title,goal,schedule,enabled}` | `ScheduledTask` |
| `DELETE /:id` | `{revision}` | `{deleted:true}` |
| `GET /:id/runs` | Optional opaque `before` cursor | `{runs,nextCursor}`; 30 per page |

`ScheduledTask` contains `id`, `title`, `goal`, `schedule`, `enabled`, `revision`,
`nextRunAt` (ISO timestamp or null), `createdAt` and `updatedAt`. Titles contain
1–120 code units and goals 1–4,000. Up to 50 undeleted plans can belong to one
account. Every schedule field below is required, including explicit nulls:

```json
{
  "frequency": "weekly",
  "timeZone": "Asia/Shanghai",
  "runAt": null,
  "time": "09:00",
  "weekdays": [1, 2, 3, 4, 5]
}
```

- `once`: a future `runAt` with an explicit UTC offset, null `time`, empty days.
- `daily`: null `runAt`, local `HH:mm` `time`, empty days.
- `weekly`: null `runAt`, local `HH:mm` `time`, unique ISO weekdays (Monday 1
  through Sunday 7), at least one day.
- The IANA time zone is saved explicitly. Traveling does not change it. In a
  daylight-saving gap, the clock shifts forward by the gap; repeated clocks use
  the first occurrence. One-time plans store an absolute instant.

Create retries reuse the same request ID and payload. A changed payload for an
existing ID returns 409. Edits and deletes require the current revision; stale
edits return 409 `schedule_changed`. Exact edit retries return the saved plan.
An enabled one-time plan with no next run has completed admission; consult its
history for the task's execution status. Changing a completed plan to a new
future date schedules it again. Unknown fields are rejected.

## Execution and recovery

Drizzle owns `scheduled_tasks` and `scheduled_task_runs`. A discovery loop
signals one Temporal workflow, `impo/task-schedule/<userId>/<scheduleId>`, on
creation or revision changes. Database configuration is authoritative, so API
availability does not depend on a synchronous Temporal call. Temporal failure
retries admission; database state survives API and Worker restarts.

Each occurrence atomically creates one ordinary Task and independent conversation,
records its task ID, and advances the schedule. The existing durable execution
queue runs the Rebyte Agent; the timer does not generate content. Scheduled Agents
have web search and the user's connected apps, without native device tools,
main-chat history or recursive scheduling. The prompt instructs autonomous work
and reporting missing information without waiting for a reply.

An active prior run, including a queued follow-up, produces a `skipped_overlap`
history entry. A missed window catches up once, then advances past the current
time; it does not replay every missed day. Pausing/resuming recalculates the next
future occurrence. Pausing or deleting never cancels work already admitted.
Deleted plans are tombstoned to fence stale timers; their existing Task results
remain in Tasks. Account deletion removes plans/history and captures all workflow
IDs for cloud cleanup. Temporal histories contain IDs and timestamps, not goals.

Run history has `{id,taskId,scheduledAt,createdAt,status}`. `taskId` is null for an
overlap skip. Other statuses reflect the latest submission in that run's Task:
`queued`, `running`, `waiting_device`, `completed`, `failed`, or `cancelled`.

Completion/failure alerts use the separate `scheduledTasks` preference and route
to the generated Task. They share the ordinary Task copy and foreground
suppression policy in [Notifications](notifications.md). Disabling alerts does
not pause execution.

`npm run test:scheduled-tasks` exercises isolated PostgreSQL, the production HTTP
adapter, durable Task completion and real Temporal timers. Native UI tests cover
create, pause, process recreation and delete against a synthetic API fixture;
they do not prove physical-device push presentation.
