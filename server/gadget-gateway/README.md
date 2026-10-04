# Gadget gateway

Cloud end of the open-source gadget link protocol
([upstream](https://github.com/facebookincubator/muse-gadget-sdk),
[Impo fork](https://github.com/impoai/impo-gadget-sdk) with this gateway as the default), so
that ESP32 and Linux gadgets can connect to Impo. A Cloudflare Worker serves the
device API and routes each gadget's WebSocket to one Durable Object per account
route (`vm_id`). The object uses WebSocket hibernation: an idle connection stays
open at the edge while the object is evicted, and the Noise cipher state is
restored from the socket attachment on the next frame.

Production: `https://gadgets.impo.ai` (API and WebSocket on the same host; the
`workers.dev` route is disabled). `GET /` serves the developer landing page from
`home.mjs`; keep its "What works today" list in step with this file.

Status: live. Gadget text and voice notes posted on `POST /chat/stream` are
forwarded to the Impo API as chat or voice messages for the account whose
subject is the route (`vm_id`), and the streamed reply is relayed to gadgets on
`POST /chat/subscribe`. Verified with the Linux clients and the fork's ESP32
firmware on an Espressif ESP-SparkBot. The agent cannot yet invoke gadget
commands, no Impo client pairs gadgets, and `/api/voice/dictation`,
`/device_token/mint` and the home-network tunnel (`/link-tunnel`) are not
implemented.

The route is the account's identity-provider subject. `IMPO_API_URL` (a
variable) and `IMPO_SERVICE_TOKEN` (a secret, equal to the API's
`GADGET_GATEWAY_SERVICE_TOKEN`) enable the forwarding; without them messages
are only stored.

## Protocol

1. `GET /fetch_vms` with the device token returns the route and a five-minute
   bearer. `POST /device_token/refresh` rotates the device token pair.
2. `GET /v1/noise?vm_id=…` upgrades to a WebSocket with that bearer, then runs a
   `Noise_XX_25519_AESGCM_SHA256` handshake. Every later frame is encrypted.
3. Inside the session, frames carry multiplexed HTTP-shaped streams. The gadget
   keeps `POST /link-control` open: it sends `link.register` with its commands,
   the gateway sends `link.invoke`, and the gadget answers `link.result`.
   `POST /chat/stream` delivers a gadget-originated message and returns an ack.

Tokens are HMAC-signed and stateless; each names a `vm_id` and a pairing id.
Deleting a pairing rejects its tokens, sends `link.unpaired` and closes the
socket.

## Admin routes

All require `Authorization: Bearer $ADMIN_TOKEN`. They are for the Impo server.

| Route | Purpose |
| --- | --- |
| `POST /admin/vms/:vm_id/pairings` | Create a pairing. `pairing` in the response is the record a gadget stores as `pairing.json`. |
| `DELETE /admin/vms/:vm_id/pairings/:pairing_id` | Unpair and disconnect. |
| `GET /admin/vms/:vm_id` | Pairings, registered gadgets with their commands, and the last 50 gadget messages. |
| `POST /admin/vms/:vm_id/replies` | `{text, reply_to_message_id?, message_id?}`; delivers one assistant message to every gadget holding `POST /chat/subscribe` on the route, as `delta.message_start`, `delta.text_append` and `delta.message_done` events. `409 no_subscriber` when none is connected. |
| `POST /admin/vms/:vm_id/invoke` | `{command, params, timeout_ms?, node_id?}`; waits for the gadget's result. `409 device_offline` when no gadget is connected. |

`system.run` executes shell commands on the gadget. Callers must enforce account
ownership and user consent before invoking; the gateway only authenticates the
admin token.

## Commands

```sh
npm run test:gadget-gateway      # unit tests, no network
npm run deploy:gadget-gateway    # wrangler deploy
```

Secrets `TOKEN_SECRET` and `ADMIN_TOKEN` are set with `wrangler secret put`.
Local copies live in the untracked `.local/gadget-gateway.env`.

`sdk-e2e.py` drives the upstream SDK's own `LinkSession` against a gateway. It
creates and removes a pairing under the `e2e-check` route:

```sh
# local: wrangler dev --port 8799 --var TOKEN_SECRET:x --var ADMIN_TOKEN:local-admin
uv run --no-project --with /path/to/impo-gadget-sdk/linux python sdk-e2e.py
# deployed
uv run --no-project --with /path/to/impo-gadget-sdk/linux python sdk-e2e.py "$GADGET_GATEWAY_URL" "$GADGET_GATEWAY_ADMIN_TOKEN"
```

To run the unmodified client, save the `pairing` object from a new pairing as
`$IMPOGADGET_STATE_DIR/pairing.json` and start `impogadget run`. This replaces
BLE setup, which normally delivers the same record from the phone app.
