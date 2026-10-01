# App Store preparation — 2026-10-01

App: Impo (`ai.impo`, App Store Connect ID `6816377222`). Formal version: **1.0**, manual release, **no build selected or submitted**.

## Listing and artwork

The English listing in `metadata.en-US.json` is the source for name, subtitle, description, keywords, promotional text, URLs and review notes. Slogan: **A little more room for life.** Product categories are Productivity and Lifestyle. Support and privacy pages are public on impo.ai.

Six 1320 × 2868 iPhone screenshots use the paper/forest-green brand and actual native app screens populated with synthetic review-safe content. `screenshots/source` contains the original simulator captures; `render-screenshots.swift` composes the phone frames and editorial copy. Run `swift ios/AppStore/render-screenshots.swift` from the repository root. `screenshots/contact-sheet.png` is the overview. The six `screenshots/iphone-6.9` assets were uploaded in numbered order to App Store Connect and all reached `COMPLETE`. Source capture used iOS commit `c5eba2d`; screenshots must be compared with the final chosen binary before submission.

## Privacy and age rating

The published privacy questionnaire declares 16 data types, linked to the user, used for App Functionality; relevant context types also have Product Personalization. No tracking or advertising purpose is declared. Types: name, email address, health, fitness, coarse location, contacts, emails/text messages, photos/videos, audio, customer support, other user content, search history, user ID, device ID, product interaction and other diagnostics. Reassess when providers or collection change.

The native privacy manifest describes these categories and required-reason uses for app-private UserDefaults, container file timestamps and elapsed event timing. Both clients disclose AI processing before onboarding proceeds. Age answers include health/wellness and infrequent medical information, with a 13+ override matching the terms. These are disclosures, not an assurance of App Review acceptance.

## Checks before selecting the submission build

- Build a **1.0** candidate containing account deletion and explicit AI-processing consent; existing **0.1.0 (47)** is not that submission candidate. Preserve manual release until the owner chooses a build.
- Resolve reviewer access. Apple/Google signup exists, but a dedicated reviewer account or a fully featured review mode has not been supplied or verified. No credentials are fabricated. Test a complete review path and replace the preparation text in review notes.
- Verify two-step deletion with a disposable account on physical iOS and Android, including Apple authorization revocation or the documented manual fallback, stopping an active Echo recording, relaunch after a lost response, and completed cloud cleanup. Automated checks cover confirmation, ownership, receipts and cleanup retry; physical OAuth remains unverified.
- Verify final production login, background microphone/Live Activity, optional permissions, notifications and final screenshot-to-binary accuracy. New users may need account context and the next background cycle before Brief and Memories have content.
- Keep secrets in server-side Secrets Manager. Signing files, API tokens, reviewer passwords and release logs remain untracked. Do not put them in this directory.

Official review references: [Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), [account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/), [Apple token revocation and missing grants](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple), [App Privacy](https://developer.apple.com/app-store/app-privacy-details/), and [screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/).
