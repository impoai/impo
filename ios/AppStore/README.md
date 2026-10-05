# App Store preparation — 2026-10-01

App: Impo (`ai.impo`, App Store Connect ID `6816377222`). Formal version: **1.0**, build **60** selected, `PREPARE_FOR_SUBMISSION`. The live release setting is `AFTER_APPROVAL`; no review submission has been created.

## Submission fields completed — 2026-10-04

Selected the latest uploaded build, **1.0 (60)**, after verifying `VALID`,
`APP_STORE_ELIGIBLE` and not expired. The owner confirmed free download pricing
and permission to use the third-party content the app displays. Saved
`USES_THIRD_PARTY_CONTENT` and a permanent free price with USA as the existing
base territory. API readbacks confirmed the selected build, content declaration,
one free base price and 174 free automatic territory prices. Review credentials
and notes remain populated and match the dedicated account.

The live version was already configured for automatic release after approval;
this operation preserved that setting. No review submission was created.
Availability still returns HTTP 404 through the public API and remains a
separate unverified setting. Private receipts: `.local/app-store-submit-setup/`.

## TestFlight 1.0 (60) — 2026-10-04

Build **60** is `VALID` and `IN_BETA_TESTING` for the internal **Team** group.
It includes email/password sign-in, password reset, Device Trust/MFA continuation
and the personal agent wording. English test notes and group membership were read
back through App Store Connect. Signing, production configuration, entitlements,
minimum OS versions and release resource checks passed for the archive and IPA.
The uploaded IPA is SHA-256 `9d6962ff55fd751c9ebf2d9ea0764298a604b1c15628112f6fbf2d60ecd82e6e`.
Private source snapshot and receipts: `.local/release60/`. External beta review,
the public update feed and formal App Store submission were not changed.

## Dedicated review account — 2026-10-04

Created a production account reserved for Apple review, `appreview@impo.ai`, with
a generated password and no connected personal accounts. App Review and
TestFlight Beta App Review both have `demoAccountRequired` enabled and the same
username/password in their private sign-in fields. Exact API readbacks matched.
The public App Store and TestFlight descriptions now explain email/password
sign-in for existing accounts; review notes describe build 60, login, optional
setup and city prompts, and the feature walkthrough. Credentials are excluded
from public descriptions and tracked files.

Clerk Client Trust is bypassed only for this dedicated review account, so a
reviewer does not need access to an email inbox. Global production authentication
settings remain unchanged. A fresh iOS Simulator running a Release build of the
frozen build 60 source passed production password login, a real Chat reply,
sign-out and repeat login without a verification code. Production profile,
conversation and task API access also passed, including the completed reply.
This was not a physical-device TestFlight test. The account remains available;
private credentials and evidence are in `.local/app-review/`.

## Product terminology update — 2026-10-04

Use **personal agent** consistently. The English subtitle is now **Your personal agent**; the description, keywords, review notes and TestFlight description have been updated through the Apple API and read back. Posters 01 and 05 were rendered with the new wording; the Connections screen was recaptured from the original native screenshot checkout with the matching copy change for poster 06. All six uploaded screenshots are `COMPLETE`, in numbered order, with checksums matching the local files. Visual inspection and OCR found no old product terminology in the six posters.

The website, privacy policy and terms now use the same terminology. Native iOS labels and accessibility text ship in TestFlight 1.0 (60); Android and server copy still require their next release or deployment. Reviewer access, review notes, build selection, Content Rights and pricing from the historical audit below are now resolved; the remaining submission checks still apply. Build 60 is selected but has not been submitted for formal review.

## Read-only readiness audit — 2026-10-03

Live App Store Connect API reads confirm that the listing is prepared, but the app is not ready to submit:

| Area | Verified state |
| --- | --- |
| Formal version | `1.0`, `PREPARE_FOR_SUBMISSION`, manual release; selected build is null and there are no review submissions. |
| Latest uploaded candidate | `1.0 (59)`, `VALID`, `APP_STORE_ELIGIBLE`, internal `IN_BETA_TESTING`, non-exempt encryption false. This is not an App Review approval. |
| Screenshots | Six English 1320 × 2868 images in `APP_IPHONE_67`, all `COMPLETE`, with no delivery errors. Every source checksum and file size matches the committed artwork. The build 59 archive targets iPhone only. |
| Listing | English name, subtitle, description, keywords, promotional text, copyright, Productivity/Lifestyle categories, support and privacy URLs are present. Public website, support, privacy and terms pages return HTTP 200. |
| Icon and age rating | Apple exposes a 1024 × 1024 App Store icon. Age answers and the 13+ override are saved; territory ratings vary. |
| Review access | Contact fields are populated. `demoAccountRequired` is true, but both credential fields are empty. A working reviewer access path remains unresolved. |
| Review notes | Still contain preparation text, refer to build 48 and incorrectly say scheduled tasks are not implemented. Replace with verified instructions for the chosen build. |
| Content Rights | `contentRightsDeclaration` is null. |
| Price and territories | Availability and detailed price reads return HTTP 404. The API exposes a price-schedule wrapper and USA base territory, but no actual configured prices could be verified. Confirm and complete these settings before submission. |
| App Privacy and account agreements | The October 1 evidence records publication of 16 data types. Current publication and account agreement status were not verified: the public API schema has no App Privacy questionnaire endpoint, and the supplementary browser session requires login. |

No App Store Connect data was changed during this audit. No in-app purchases or subscription groups are configured. Screenshot artwork was visually inspected, but a complete comparison with the final submission build and physical-device sign-in, deletion, microphone/background and notification acceptance remain outstanding. Private API receipts are in `.local/app-store-audit-2026-10-03/`.

## Listing and artwork

The English listing in `metadata.en-US.json` is the source for name, subtitle, description, keywords, promotional text, URLs and review notes. Slogan: **A little more room for life.** Product categories are Productivity and Lifestyle. Support and privacy pages are public on impo.ai.

Six 1320 × 2868 iPhone screenshots use the paper/forest-green brand and actual native app screens populated with synthetic review-safe content. `screenshots/source` contains the original simulator captures; `render-screenshots.swift` composes the phone frames and editorial copy. Run `swift ios/AppStore/render-screenshots.swift` from the repository root. `screenshots/contact-sheet.png` is the overview. The six `screenshots/iphone-6.9` assets were uploaded in numbered order to App Store Connect and all reached `COMPLETE`. Source capture used iOS commit `c5eba2d`; screenshots must be compared with the final chosen binary before submission.

## Privacy and age rating

The published privacy questionnaire declares 16 data types, linked to the user, used for App Functionality; relevant context types also have Product Personalization. No tracking or advertising purpose is declared. Types: name, email address, health, fitness, coarse location, contacts, emails/text messages, photos/videos, audio, customer support, other user content, search history, user ID, device ID, product interaction and other diagnostics. Reassess when providers or collection change.

The native privacy manifest describes these categories and required-reason uses for app-private UserDefaults, container file timestamps and elapsed event timing. Both clients disclose AI processing before onboarding proceeds. Age answers include health/wellness and infrequent medical information, with a 13+ override matching the terms. These are disclosures, not an assurance of App Review acceptance.

## Account-deletion delivery

Account deletion is committed as `9073c14`. It passed real PostgreSQL and Temporal integration checks, native iOS confirmation/isolation tests, both client build/test suites, and a production synthetic-account cleanup canary across PostgreSQL, S3, Turso, Rebyte and Temporal. The initial backend rollout used `instant-api:46` / `instant-worker:44`; the subsequent file-download release is live as `instant-api:47` / `instant-worker:45`. The native change, explicit AI-processing consent, and delivered-file previews are included in **TestFlight 1.0 (48)**, source `c548657`. Apple processed this build as VALID and it is available to Team; it is attached to Impo Public Beta with external beta review pending. This is a TestFlight release, not an App Store submission.

## Password login preparation — 2026-10-04

- Source now includes native email/password sign-in and password reset on iOS and
  Android, plus Device Trust and MFA continuation. Apple/Google signup remains.
- Clerk production and development configuration was read back: password and
  email reset strategies are already enabled. Production Device Trust is enabled;
  instance settings remain unchanged. The dedicated review account now has the
  per-user Client Trust bypass described above.
- iOS development-account authentication and reset are validated separately from
  production review access. TestFlight **1.0 (60)** includes this change and is
  available to the internal Team group.
- The production reviewer account and private Apple sign-in fields are complete.
  The fresh-client password and returning-account flows passed against production
  on iOS Simulator. Physical-device TestFlight acceptance remains outstanding.

## Remaining submission checks

- Build **1.0 (60)** is selected at the owner's request and includes account deletion, explicit AI-processing consent, file downloads and password login. The existing live release setting is automatic after approval.
- Content Rights and free pricing are complete with owner confirmation. Confirm release availability separately; the public API still returns HTTP 404 for that resource.
- Keep the dedicated review account active and its credentials synchronized in both App Review and TestFlight Beta App Review. If deletion is exercised with this account, recreate and revalidate reviewer access before review continues.
- Verify two-step deletion with a disposable account on physical iOS and Android, including Apple authorization revocation or the documented manual fallback, stopping an active Echo recording, relaunch after a lost response, and completed cloud cleanup. Automated checks cover confirmation, ownership, receipts and cleanup retry; physical OAuth remains unverified.
- Verify final production login, background microphone/Live Activity, optional permissions, notifications and final screenshot-to-binary accuracy. New users may need account context and the next background cycle before Brief and Memories have content.
- Keep secrets in server-side Secrets Manager. Signing files, API tokens, reviewer passwords and release logs remain untracked. Do not put them in this directory.

Official review references: [Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), [account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/), [Apple token revocation and missing grants](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple), [App Privacy](https://developer.apple.com/app-store/app-privacy-details/), and [screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/).
