# Impo Web

The React 19 / TypeScript client lives at **https://impo.ai/app/**. It uses Meta
Astryx components with Impo's paper and forest-green theme, Clerk authentication,
and the same authenticated client protocol as iOS and Android. The existing
marketing homepage remains in `site/`.

## Development

Run commands from the repository root with Node 22 or newer:

```sh
npm ci
npm run dev:web
npm run typecheck:web
npm run test:web
npm run build:web
```

Vite serves `http://127.0.0.1:5178/app/`. The default development proxy targets
the deployed Impo API. The public production Clerk key is not a secret, but
Clerk production authentication requires the approved production domain. Use a
Clerk development instance and its corresponding backend for local real-account
testing; put `VITE_CLERK_PUBLISHABLE_KEY` in untracked `web/.env.local`.

For isolated UI work, run these in separate terminals:

```sh
npm run dev:web:fixture
IMPO_WEB_API_ORIGIN=http://127.0.0.1:3041 VITE_IMPO_FIXTURE=1 npm run dev:web
```

This reuses the native HTTP/SSE fixture and explicitly labels its synthetic data.
The fixture identity is compiled out of production builds and additionally
requires a loopback hostname. The account security button switches between its
two isolated accounts. No provider credentials are involved.

## Implemented surfaces

| Surface | Web behavior |
| --- | --- |
| Authentication | Clerk sign-in/sign-up, account security, sign-out, server-backed onboarding |
| Chat | Streaming Markdown, GFM tables, mathematics, history recovery, stop, copy and editable drafts |
| Files and voice | Up to eight signed uploads, owned file downloads, short foreground dictation with an editable transcript |
| Shopping | Owned product selections, fresh product details and merchant links; browsing only |
| Feed | History/date filters, source inspection, editable Chat suggestions, feedback, deletion and browser print/PDF |
| Tasks | Create, inspect, follow up, recover and stop runs; one-time/daily/weekly schedules and run history |
| Memories | Category filters, loaded-history search, pagination and deletion |
| Echo | Phone transcript history/date filters, loaded-history search, place labels, speaker review/exclusions and deletion |
| Connections | Server-owned connector discovery, OAuth popup, status reconciliation and disconnect |
| Settings | Personal agent name/avatar/mode, Feed preferences, Echo schedules, phone notification categories and account deletion |

Browser dictation requires HTTPS, an explicit microphone grant and a supported
MediaRecorder format. It stops after two minutes or the upload size limit. Web
does not record background Echo or execute native Health, contacts, calendar,
location or camera tools. Those remain on registered phones. Browser push is not
implemented; notification preferences explicitly describe phone delivery.

## Protocol and ownership

See [the Web protocol guide](../contracts/web-client.md). Query caches and API
clients are scoped to the Clerk user and session. Sign-out aborts requests and
uploads, clears the query cache and removes only that account's browser drafts
and pending message commands. No provider tokens or Clerk bearer tokens are
persisted by the client.

An outbox command is saved before sending. A lost acceptance response is retried
with the original body and `clientMessageId`, including its uploaded file IDs.
Leaving Chat aborts the subscription, not the server run. History and active
submissions restore it on return; stream replay replaces text by message ID.

The SSE parser validates ordered text/tool events, UTF-8 framing, submission
identity and the final `finish` plus `[DONE]`. Truncated streams reconcile with
history. It never interprets a transport close as successful execution.

## Design and components

Astryx's settings-sidebar and ai-chat templates supplied the initial frames.
`AppShell`, `Layout`, stacks, `ChatLayout`, `ChatComposer`, `ChatComposerInput`,
buttons, text fields, switches and dialogs provide the interactive primitives.
Impo's theme source is `src/theme.ts`; compiled theme artifacts are committed in
`src/generated/`. Regenerate with:

```sh
npm run astryx -- theme build src/theme.ts --out src/generated/impo.css
```

Desktop uses a persistent navigation column. Narrow screens use accessible,
icon-only Chat/Feed/Tasks/Memories navigation with the remaining destinations in
the menu. File attachment and voice controls remain inside the composer.
Chat headings, message bylines and the sidebar use the account profile's personal
agent name and selected avatar. Successful profile saves update the shared cache
immediately; foreground refreshes pick up changes from other clients. Missing
profile fields use a neutral placeholder instead of inventing a name or avatar.
The six built-in avatars are shared across clients; iOS custom photos remain
device-local because the profile protocol does not transfer photo bytes.

The theme defines a 44-pixel minimum for buttons and single-line fields. Shared
dialog bodies scroll independently; schedule actions and merchant links remain
visible in their footers. The UI release pass covers 320, 390, 768 and 1440 CSS
pixel viewports, including form validation, focus and narrow-screen dialogs.

## Deployment

`npm run build:web` typechecks/builds the app and stages it in ignored `site/app/`.
Existing hashed assets remain available for tabs open across deployments.
`npm run deploy:web` publishes the combined website and app to the existing
Cloudflare Pages project. Authentication, ownership, Rebyte execution and worker
coordination remain in the existing server deployment.

The Pages worker serves SPA deep links and proxies `/api/v1/*` to the fixed
`https://mcp.xyznot.com/instant/api/v1/*` origin. It preserves streaming bodies,
forwards an allowlist of protocol headers, omits cookies and disables API caching.
No arbitrary upstream URL is accepted. Download and native release routes remain
owned by their original worker.

Signed S3 PUTs go directly to the server-issued URL. The production transcript
bucket CORS rule in `server/downloads/web-upload-cors.json` allows only
`https://impo.ai`, PUT, and the signed content/checksum headers. It grants no
additional object access and no browser reads of stored audio.

## Validation boundaries

Protocol tests cover byte-split Unicode streams, truncation, duplicate/invalid
ordering, token refresh, account fencing, durable outbox identity, history replay
and safe action URLs. Pages tests cover streaming proxy isolation, origin checks,
deep links and preservation of native download routes. Browser validation covers
the local fixture plus production authentication, account history, product
details and a clearly labeled live task through Rebyte, including a signed S3
attachment read by the agent. Currency/TeX rendering also has regression coverage.
Browser emulation does not establish physical microphone quality, mobile keyboard
behavior or native background permission behavior. Third-party connector OAuth
has not been independently exercised in the Web release check.
