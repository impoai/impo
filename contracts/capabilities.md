# Capabilities and client actions, version 1

Impo separates the user's intent, the provider that implements it, the execution
location, and the interaction required to execute it. Rebyte selects registered
functions; Impo owns authorization, routing and native adapters. A function name
does not grant arbitrary control of another application.

## Execution boundaries

| Capability | Execution | Availability | Interaction and result |
| --- | --- | --- | --- |
| Cloud service, such as Google Calendar | Server through the existing Composio connector tools | User's connected account and that provider's actual action catalog | Provider result; independent of the mobile operating system |
| Impo task or schedule | Server through internal tools; Temporal coordinates scheduled work | Implemented application service and user ownership | Durable Impo task or schedule receipt |
| Native data or write, such as Health or Apple Reminders | Device adapter | Exact installation attached to the message, implemented adapter and required permission | Existing device claim, deadline and immutable result receipt |
| Open a link or directions | Server prepares a proposal; device performs the handoff | Exact attached installation advertises the action | A visible button; only a foreground tap opens the destination |

A cloud reminder, a scheduled Impo task, and a phone countdown are different
capabilities. Do not substitute one without the user's agreement. A Google
account alone does not imply a cloud timer API. Discover actual cloud actions
through the connected provider; never invent a provider action.

## Catalog and platform adapters

`server/src/tools/registry.ts` owns server tool execution metadata. Existing
connector discovery remains authoritative for cloud providers.
`server/src/tools/device-tools.ts` owns native data capabilities and registration.
`server/src/tools/client-actions.ts` owns the client-action catalog and schemas.
Each action describes its stable name, semantic intent, version, execution
location, interaction, effect, icon key, supported platforms and implementations.

`POST /devices/register` continues to accept `{installationId, tools}`. It now
returns `{deviceId, capabilities}` with descriptors for the exact accepted names.
Old clients can ignore the additional response field. Registration replaces the
installation's capabilities; `[]` revokes them. Unsupported names are rejected.
Action selection, like native data access, never borrows another device's
capabilities. Dispatch rechecks both the admitted capability snapshot and the
currently registered names. Idle Session rotation preserves history when the
available function set changes.

Clients advertise only implemented adapters. This version adds:

| Name | Arguments | iOS adapter | Android adapter |
| --- | --- | --- | --- |
| `impo_open_link` | `url`: HTTPS, at most 4096 characters | Universal Links / system URL opening | App Links / `ACTION_VIEW` |
| `impo_navigate` | `destination`: 1–300 characters; `mode`: driving, walking or transit | Apple Maps directions URL | Google Maps directions URL |

HTTPS credentials, whitespace/control characters, backslashes, arbitrary URL
schemes and unknown argument fields are rejected. Maps URLs are assembled and
escaped by native code. No API key is needed for these handoffs. Installed apps,
OS settings and user choices determine the actual handler; a web fallback is
valid. Opening directions does not prove turn-by-turn navigation started.

Main Chat advertises these tools on capable clients. Tasks currently have no
attached native-device tool context and do not advertise them. Both conversation
renderers understand the shared action format.

## Proposal lifecycle

The preparation tool executes on the server and immediately returns:

```json
{
  "kind": "client_action",
  "schemaVersion": 1,
  "actionId": "2b30cd6c-2d20-4f3c-8e98-464974947025",
  "capability": "impo_navigate",
  "execution": "device",
  "interaction": "tap",
  "status": "ready",
  "parameters": { "destination": "Union Square, San Francisco", "mode": "walking" }
}
```

`ready` means a button is prepared. It never means opened, created or completed.
The agent finishes its reply without waiting for a tap. The action never enters
the automatic native-tool poller. The client accepts only a completed output of
the matching known tool, with supported version and validated parameters; text,
Markdown, arbitrary tool results and unknown action versions cannot execute it.

The server persists the owned action with its assistant message in
`message_client_actions`, separately from transient tool receipts and chat text.
This metadata contains the URL or destination needed to restore the button.
Message history restores cards even after transient projections are purged.
Account deletion removes these records. Stream/history replay only renders them.
Native clients derive English labels and icons from the validated capability and
destination; they do not load model-supplied logos, scripts or executable code.

Handoff buttons can be tapped again, including from another supported device
signed into the same account. Each tap uses that device's adapter. They report
opening failures locally; no claim of external task completion is sent to the
agent. The framework does not observe whether a video played or a journey began.

## Adding capabilities

1. Define the intent and whether it is a cloud operation, an Impo operation, a
   native read/write, or a user-initiated handoff. Do not infer this from its logo.
2. Define strict arguments, provider/platform adapters, required permissions,
   minimum OS/API version, result semantics and replay behavior.
3. Register only real, available adapters. Keep installed-client compatibility;
   incompatible schemas require a new capability name/version and client support.
4. Use durable claims and receipts for non-repeatable writes. A future timer or
   calendar creation must record the native resource identifier, handle uncertain
   completion after a crash and reconcile before retrying. A handoff proposal is
   insufficient to prove that a write completed.
5. Test capability filtering, ownership, revocation, argument validation, replay,
   history restoration, account teardown and the platform adapter.

Timer/AlarmKit, calendar-editor buttons, sharing and Shortcuts are not implemented
or advertised by this version. AlarmKit requires an iOS 26+ adapter and explicit
authorization; older OS versions need a separately described alternative.
Android needs its own timer implementation and availability checks. Permission
prompts remain explicit UI actions.

## Rollout and verification

Apply the Drizzle schema (new owned action table and expanded capability check),
then deploy API and Worker before shipping clients that register the new names.
No migration history is added. Existing clients retain their original tools.

Run `npm run typecheck`, `npm run test:server`, `npm run test:devices`,
`npm run test:accounts`, `npm run test:swift`, `npm run test:android` and native
builds. The device integration test runs the production API/Worker, real
PostgreSQL and Rebyte SDK against a deterministic remote fixture; it does not
prove a real model's selection or physical Universal/App Link behavior.

References: [Apple Universal Links](https://developer.apple.com/library/archive/documentation/General/Conceptual/AppSearch/UniversalLinks.html),
[Apple Maps links](https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/MapLinks/MapLinks.html),
[Google Maps URLs](https://developers.google.com/maps/documentation/urls/get-started),
[AlarmKit](https://developer.apple.com/videos/play/wwdc2025/230/).
