# Account deletion

Settings exposes two confirmations on iOS and Android: an irreversible-data warning, then an exact `DELETE` entry. The first step requests a five-minute server challenge; the final action supplies its ID and random token. Canceling either step keeps the account intact.

The server verifies user ownership, atomically removes owned PostgreSQL data and stores an isolated cleanup manifest. A hashed identity tombstone prevents an old session from silently recreating the account. The client signs out, stops account work and removes this account’s pending messages and audio. A persisted receipt recovers an accepted deletion if its HTTP response is lost; recovery never submits an unconfirmed deletion. Another account’s cached data is preserved.

Temporal discovers pending requests from PostgreSQL and durably retries independent provider cleanup: owned workflow histories, Rebyte sessions and agents, connected-app authorization, the per-user Turso database, S3 audio/transcripts and the Clerk identity. A second sweep after two hours covers uploads and provider creation already in flight. Workflow deletion is asynchronous, so cleanup verifies disappearance before marking a receipt complete. Cloud cleanup normally finishes within 24 hours; outages retain the pending receipt and retry. Completion scrubs the provider manifest, retaining only minimal deletion status and hashed identity/receipt evidence. Backups and operational logs follow the published retention policy.

Apple authorization codes are exchanged and revoked on the server using `APPLE_SIGN_IN_JSON` from Secrets Manager. Native clients can obtain a fresh code at deletion; the server checks the linked Apple subject. A valid stored web grant can also be revoked. When Apple authorization is unavailable, deletion still proceeds and the receipt provides manual Apple Account instructions, following Apple TN3194. Tokens and private keys are never stored in client source or logged.

## API

- `POST /api/v1/account/deletion-challenge`, authenticated, body `{}` → challenge ID, token and expiry, plus optional Apple reauthorization availability.
- `DELETE /api/v1/account`, authenticated, body `{challengeId, token, confirmation: "DELETE", appleAuthorizationCode?}` → `202` and a receipt. Repeating the accepted confirmation is idempotent.
- `GET /api/v1/account/deletions/{requestId}`, using the receipt token as the Bearer credential → `deleting` or `deleted`. It remains available after the login identity is removed. Invalid credentials return `404`.
- Closed identities receive `410 account_deleted` on ordinary API routes. New signup with a new Clerk identity starts an empty account.

## Validation

`npm run test:accounts` covers real PostgreSQL ownership, expired/replaced challenges, atomic deletion, repeat requests, identity fencing, cleanup retries, receipt access, and a local Temporal server’s two sweeps/history purge. Server unit tests cover Apple token exchange/revocation and failure handling. iOS native and UI tests cover exact confirmation, receipt presentation and account-scoped audio cleanup. Android client tests cover wire authentication, post-signout receipts and account-scoped interrupted outbox writes.

Physical-device Apple reauthorization, Android device cleanup and final release-build verification remain release checks; simulator/unit tests do not establish those outcomes. Never test deletion against a person’s live account.
