# Notifications v1

iOS and Android share this server-owned policy. FCM delivers to Android and to
APNs for iOS. Provider private keys belong only in the server secret store.

| Category | Trigger | Setting | Destination |
| --- | --- | --- | --- |
| `chat` | A main Chat turn completes or fails | Chat replies | Main Chat |
| `tasks` | A Task turn completes or fails | Task updates | That Task |
| `brief` | A new Brief edition completes | Brief | That edition |

Streaming chunks, tool progress, cancellation, failed Brief generation and Echo
recording do not create remote alerts. Each source event has a unique key and is
committed with the completed source transaction. Existing historical results are
not backfilled. Brief notification preference does not change its generation plan.

Preferences are one extensible JSON object per authenticated account in PostgreSQL
(`notification_settings.preferences`) and sync across devices. Patches merge only
the selected keys, preserving other categories. All three
default to enabled; displaying an alert additionally requires native OS permission
and an enabled, registered installation. System notification settings remain final.

Scheduled Task updates and user-scheduled Echo reminders are future categories.
They are not exposed as working settings until those features exist. Both the
hourly background producer (Brief) and ordinary Agent completion producers feed
the same outbox and preference evaluation; notification delivery never generates
an Agent response or runs an independent content-generation schedule.

Chat and Task alerts are suppressed for the whole account when any installation
has reported foreground presence within 60 seconds. Clients refresh presence every
20 seconds and report background immediately. The server checks both when the event
is created and immediately before sending. Suppressed events are not sent later.
Brief alerts are independent of foreground presence on other devices; each receiving
client suppresses banners while its own UI is active. Crashes/offline transitions
can leave foreground presence stale for up to 60 seconds. A notification already
handed to FCM/APNs cannot be recalled by a subsequent presence/preference update.

Delivery uses a PostgreSQL outbox and a Temporal workflow per event. Retries expire
after one hour and recheck preferences, ownership and token validity. Invalid FCM
tokens are disabled. A stable event ID is used for collapse/display deduplication;
FCM has no exactly-once send operation, so an ambiguous network response can cause
a retry. A provider acceptance receipt is not proof of display on a device.

Lock-screen copy is generic and contains no conversation, task or Brief content.
Payload v1 contains `eventId`, `category`, `targetId`, `registrationId` and
`expiresAt`. Clients validate their current registration before navigation and
always fetch the destination through the authenticated Impo API. Android receives
data messages and checks the account, preference, expiry and foreground state before
display. iOS uses APNs alerts for reliable background delivery; its foreground
delegate suppresses banners. Sign-out revokes registration before ending the session
and clears local notifications; in-flight OS alerts can briefly survive revocation.

## Authenticated API

- `GET /api/v1/notifications/settings` returns `{chat, tasks, brief}`.
- `PATCH /api/v1/notifications/settings` accepts any nonempty subset of these boolean fields.
- `PUT /api/v1/notifications/installations/:installationId` accepts
  `{installationSecret, revision, registrationId, platform, token, enabled, foreground}`.
  IDs are UUIDs, the installation secret is a random UUID kept only on that device,
  and revision is a persisted, monotonically increasing safe integer. `token` may
  be null when permission or Firebase is unavailable. Returns `{registrationId}`.
- `DELETE` on that path accepts `{installationSecret, revision, registrationId}`
  and returns `{revoked: true}`. It requires the current account owner.

The installation secret is stored as a hash. It proves possession during an account
switch; higher revisions fence delayed writes from previous sessions. Every other
operation checks account ownership. Registration identifiers change with login scope.
FCM tokens, installation secrets, private keys and OAuth tokens must never be logged.
