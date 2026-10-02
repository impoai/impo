# Brief content contract

Status: proposed v2, 2026-10-02. This document defines the next implementation;
the current production generator and native clients still use the legacy shape.

Brief helps the user discover useful next steps, understand relevant updates, and
get more value from Impo. A recap is one possible card, not the purpose of every
edition. The server defines the vocabulary and supplies verified context. A
Rebyte Agent chooses relevant cards and writes their localized content. The same
contract serves iOS and Android.

## Card types

| `type` | Meaning | Required context | Example |
| --- | --- | --- | --- |
| `suggestion` | A concrete next step the user could take or ask Impo to help with. | Relevant owned sources or a verified available capability; distinguish an offer from a factual update. | Prepare questions for an upcoming discussion; offer to review recent email. |
| `recap` | A short, useful update about something that happened. | Owned, versioned evidence of the event or result. | A requested report finished; show its result and an optional follow-up. |
| `connect` | Explain a specific benefit of connecting or reconnecting an app. | A supported connector and verified disconnected/expired state, eligible for this user. | Connect Gmail to ask Impo for help reviewing email. |
| `feature` | Introduce a real feature the user may find useful. | An enabled feature catalog entry, platform/build eligibility, and known exposure/use state. | Try scheduling a recurring task. |
| `occasion` | A timely, relevant greeting or calendar note, without forcing an action. | A verified dated occasion and an appropriate user-selected region/calendar preference. | A Mid-Autumn Festival greeting on the verified local date. |

These describe intent, not appearance. `style` in the old contract only controls
presentation and cannot determine whether a card is a recommendation or a recap.
The edition's existing `kind` still identifies its scheduled slot, not card type.

## Model output

The fixed keys below are defined by the application. The model chooses values,
selects from supplied IDs, and orders cards; it cannot invent another card type,
feature, connector, capability, route, or permission.

| Key | Meaning and constraints |
| --- | --- |
| `title` | Edition headline, at most 100 characters. |
| `summary` | A short introduction to what is worth the user's attention next, at most 600 characters. Retained for compatibility; it does not instruct the model to summarize the day. |
| `cards` | Ordered cards, zero to five. Fewer useful cards are preferable to filler. |
| `cards[].type` | One of the five intent types above. |
| `cards[].eyebrow` | Short localized topic label, at most 60 characters. |
| `cards[].title` | The recommendation, update, invitation, or greeting itself, at most 100 characters. A suggestion should name an achievable step. |
| `cards[].body` | Why this is relevant now, with a brief explanation grounded in the supplied evidence; at most 1,200 characters. Do not repeat the title or retell the full source. |
| `cards[].bullets` | Optional steps or useful details, zero to five strings of at most 240 characters. Persist an empty array when absent. |
| `cards[].sourceIds` | IDs from owned personal sources supplied to this generation. Personal claims must be supported by these sources. |
| `cards[].contextIds` | IDs of supplied context records: connection state, capability, feature, verified occasion, or authorized external-data result. No invented IDs. |
| `cards[].links` | Public evidence links returned by a verified lookup, each with `title` and `url`. Validate against actual returned URLs, not merely whether any web search occurred. |
| `cards[].action` | One optional next action, or `null`. A suggestion can also describe an offline step without a button. |
| `cards[].action.id` | An ID from the server's eligible action catalog for this generation. The server owns its meaning and destination. |
| `cards[].action.label` | A specific localized button label, at most 60 characters, such as "Connect Gmail" or "Draft an outline". |
| `cards[].action.prompt` | An editable user-facing draft, at most 1,000 characters, only for a `chat_draft` action; otherwise `null`. It must be consistent with the card and its evidence. |

`sourceIds` and `contextIds` together are limited to ten references per card;
`links` is limited to five. At least one valid evidence reference is required.
The type-specific context requirements still apply even when a public URL exists:
a link alone cannot establish the user's connection state or that a feature is
enabled. Personal references never substitute for an authorization check.

Example model output, assuming the input contains the named verified connection
state and eligible action:

```json
{
  "title": "A useful next step",
  "summary": "Bring email into Impo when you are ready.",
  "cards": [
    {
      "type": "connect",
      "eyebrow": "Email",
      "title": "Get help reviewing your inbox",
      "body": "Connect Gmail to ask Impo which messages need a reply and draft responses for you to review.",
      "bullets": [],
      "sourceIds": [],
      "contextIds": ["connection:gmail:disconnected:v3"],
      "links": [],
      "action": {
        "id": "connect:gmail",
        "label": "Connect Gmail",
        "prompt": null
      }
    }
  ]
}
```

This is an example payload, not a claim about the current user's account.

## Context and action catalogs

Keep the existing owned Chat, Task and confirmed personal Echo sources. Extend
the generation input with server-supplied, versioned context records and eligible
actions. Each context record has an ID, a kind, a verified payload, its capture
time and a freshness/expiry rule. The model may select and reference records; it
may not create records itself.

| Context | What the server supplies and checks |
| --- | --- |
| Connections | Supported toolkit, authoritative connection state, verified usable permissions/capabilities, and freshness. Unknown or failed lookup is not disconnected. Google sign-in is not authorization to Gmail or Calendar. |
| Features | Stable feature ID, actual behavior, release/enablement state, supported platforms and minimum builds, and known exposure/use state. Absence of analytics does not prove a user has never used a feature. |
| External results | Results fetched through an authorized integration, with owned provenance, fetch time, scope and expiry. A connected account alone is not evidence of unread messages or an upcoming event. |
| Occasions | Stable occasion ID, verified date/year/calendar, applicable region, local time zone and source. Language alone does not determine religion, cultural observance or holiday preference. |
| Recent suggestions | Previously published topics, dismissals, snoozes and completed/adopted actions. Prior generated prose is repetition history, not new factual evidence. |
| Preferences | Enabled content categories and muted topics. These filter candidates before generation. |

The eligible action catalog uses a small fixed vocabulary:

| Action kind | Behavior after a user tap |
| --- | --- |
| `chat_draft` | Open an editable Chat draft with its brief/source reference. Preserve an existing draft or ask the user before replacing it. Nothing is sent until the user presses Send. |
| `connect` | Open the existing connection detail/authorization flow for the server-selected toolkit. Never authorize silently. |
| `open_feature` | Navigate to a registered feature, such as scheduled tasks, Echo speaker review or Echo reminder settings. |
| `open_resource` | Open an owned task/result/source, or an allowlisted public reference. Recheck ownership at access. |

The model returns an action ID, not a URL, route, OAuth scope, API request, or
executable command. The server resolves the ID to a structured client action and
validates that it is appropriate for the card type and context. Free-text prompts
remain untrusted drafts, not system instructions or authorization for external
writes. A tap cannot automatically send email, create a task, or start recording.

For example, `suggestion` + an eligible Gmail `chat_draft` can say "Want to review
recent email?" without fetching mail during Brief generation. "You have three
new messages" requires an actual fresh external-result record. The initial
implementation need not introduce automatic background inbox access.

## Composition and repetition

Initial policy defaults, to be implemented server-side:

- Prefer one to three relevant cards, at most five. Lead with a useful next step
  when one exists; do not require every edition to contain every type.
- Allow at most one recap per edition, and at most one connection/feature
  introduction combined. A legitimate recap can be the only card when no useful
  next step exists. Do not fabricate recommendations to satisfy a quota.
- All slots can look forward. Morning can prepare the day; midday can suggest an
  adjustment; evening can suggest closure or preparation for tomorrow. Evening
  does not mean mandatory retrospective summary.
- Rank by user relevance, timeliness and usefulness, rather than promoting a
  connector merely because it is available. A new user may receive onboarding
  cards supported by verified product context even with no personal sources.
- Apply account-level repetition rules across devices and slots. Start with a
  seven-day cooldown for the same connection/feature introduction and a one-day
  cooldown for the same personal suggestion topic. New, materially changed
  evidence may qualify for a different topic; rewording does not reset cooldown.
- Compute topic identity from server-owned resource/candidate identities; never
  trust a model-generated random key. Persist exposure with the accepted edition
  so retries and simultaneous hourly checks cannot publish duplicate prompts.
- A dismissal suppresses that topic until the user restores it; a snooze has an
  explicit date. Connecting the app or adopting the feature removes the relevant
  onboarding candidate. Do not rotate an already-dismissed introduction into a
  different card type to show it again.
- Greet once per occasion per applicable local date window. Do not invent a
  lunar-calendar date from memory or repeat greetings in every slot.
- If nothing qualifies, an empty edition is valid. Do not send a contentless push.
  Brief delivery still respects the existing separate notification preference.

Add category switches and muted/snoozed topics to account-owned Brief content
preferences. Keep them separate from briefing times and the existing push toggle:
what appears, when it is generated, and whether the user gets a push are distinct
choices. Reuse the owned settings API; do not maintain device-only policy copies.

## Server-owned metadata and lifecycle

The API adds a content `schemaVersion: 2`, stable card IDs, resolved actions,
derived presentation styles, generation time, expiry, and topic identities after
validation. The model does not own these fields, user identity, slot timing,
priority overrides, provider IDs, connection truth, or notification decisions.

Resolve styles deterministically: suggestion to `plan`, recap to `reflection`,
connect and feature to `discovery`, occasion to `focus`. Preserve the old text,
bullet, source and link fields so older clients can display the content.

Recheck volatile eligibility before publishing and when resolving an action.
For example, a user connecting Gmail during generation invalidates its connection
prompt. A changed permission can disable an old email action; an expired greeting
can remain visibly historical but is no longer eligible for a push. Preserve
existing owned-source revision/deletion withdrawal rules. API reads must not
expose revoked private source content through an action or a stale card.

Treat context text, retrieved pages and model output as data. Validation must
reject unknown IDs, arbitrary destinations, unsupported type/action pairings,
expired candidates and unsupported factual claims where machine-checkable.
Structural checks are necessary but cannot establish semantic truth; generation
acceptance also needs representative live examples and review of their claims.

## Implementation sequence and acceptance

1. Agree on this vocabulary and field semantics; update the generator, validator
   and shared fixtures together. Add suggestion/recap semantics to the existing
   personal-source path without inventing new connector or feature evidence.
2. Add verified connection/capability context, a maintained feature catalog,
   category preferences and durable repetition state. Enable their card types
   only when those inputs and native destinations are implemented.
3. Add verified occasion context and, separately, any explicitly authorized
   background external-data retrieval. Offers to inspect email do not require
   that retrieval feature.
4. Add native action rendering and interaction reporting on both platforms.
   Gate actions by supported client versions. Existing editions retain their
   original schema; never reinterpret old `style` values as new intent types.

Acceptance must cover connected/disconnected/expired/unknown connector states;
Google login without Gmail authorization; supported and unavailable feature
builds; empty personal context; real local dates; no invented unread counts;
cross-device repetition and dismissal; source revocation; account switching;
draft preservation; and backward-compatible rendering. Live model checks must
show relevant next steps rather than relabeled summaries, without making any
external changes. Publication and native releases follow implementation and
validation; this contract alone changes no runtime behavior.
