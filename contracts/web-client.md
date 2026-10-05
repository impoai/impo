# Web client protocol

Web is a presentation client of [Client Protocol v1](client-protocol.md), not a
separate agent runtime. The same user account owns its Chat, tasks, Feed, memories,
Echo records, connections and profile on all three platforms.

```text
React / Astryx + Clerk session
  → /api/v1 commands (same-origin Pages proxy)
  → existing Impo API ownership checks
  → durable submission / Rebyte worker
  → /submissions/{id}/stream
  → Web stream reducer and native-equivalent message parts
```

| Client concern | Contract |
| --- | --- |
| Authentication | Clerk Bearer token per request; one refresh after 401; `X-Impo-Model-Catalog: 2` |
| Account profile | GET/PATCH `/profile`; shared name, avatar, onboarding and mode |
| Chat and Tasks | Original message UUID/body survives uncertain acceptance; no stream-lifetime cancellation |
| Context | IANA time zone, ISO current date and browser BCP-47 language; region only when the locale explicitly supplies one |
| Replies | Vercel UI Message Stream v1, same Impo file/step/product parts; unknown optional data remains ignorable |
| Product cards | Server-owned assistant message and selection IDs; details are fetched from the Impo API |
| Attachments | Prepare → signed S3 PUT without bearer/cookies → complete → owned attachment IDs |
| Voice | Explicit foreground MediaRecorder → `/voice/transcriptions` → editable text draft |
| Feed | Same `/today/*` routes and content/action version 2; resolve actions on tap, never auto-send drafts |
| Schedules | Same time-zone/DST handling and revision-checked create/update/delete; Web does not run timers itself |
| Echo review | Same recording IDs, speaker revision and personal-context inclusion rules |
| OAuth | Same server connect/refresh/status/disconnect routes; closing a popup is not proof of a connection |
| Account deletion | Persist confirmed intent before DELETE; recover via challenge ID and receipt credential without resubmitting |

The browser does not register a pretend iOS/Android device or advertise native
device tools. A device request in a stream is displayed as waiting for the
connected phone. Supported client actions are HTTPS link opening and map
navigation, always initiated by the user's tap.

All query caches, subscriptions, uploads and drafts belong to the originating
Clerk user/session. Account changes fence late tokens and asynchronous responses.
Tokens and provider credentials are never stored in browser outbox commands.
Outbox and draft content is local to the browser profile and cleared on sign-out.

The app does not persist cached API responses through a service worker. Static
hashed assets may be cached; authenticated API responses and streams may not.
Server authorization remains authoritative even when a client hides a control.
