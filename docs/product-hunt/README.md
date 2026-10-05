# Impo Product Hunt launch kit

Prepared on October 4, 2026. Public launch copy is in English and uses **personal agent**.

## Positioning

**Open source Muse**

Impo connects the context a person chooses to share with practical help: remembering a thought, handing off work, finding something to buy, and following through. Lead with that everyday benefit. Echo, Memory, Tasks, Feed, shopping and optional connections explain how it works.

Shopping is a primary launch story: state a need and budget, browse products and details, compare options, then continue to the merchant. The current implementation does not execute checkout, payment or orders. Native shopping cards are available on iOS; Web also supports cards and details. Do not imply that Android has the same shopping-card interface.

## Review the materials

- [Listing fields and maker comment](listing.json)
- [All eight gallery images](assets/contact-sheet.png)
- [Narrated 1080p walkthrough](assets/impo-walkthrough-1080p.mp4)
- [English captions](assets/impo-walkthrough.en.srt)
- [Clickable product tour](tour.html)
- [Video narration and timing](video-timeline.json)
- [Source capture provenance](source/manifest.json)

The tour works from a local file or any static web server. It is a guided sequence of screenshots, not a live agent session. The video is a narrated walkthrough of those captures, not a real-time screen recording. All personal content is synthetic; shopping screens are real catalog results captured during a dedicated product test. Catalog prices are snapshots, not current offers.

## Gallery order

| File | Purpose |
| --- | --- |
| `01-meet-impo.png` | Explain the personal agent and its everyday value. |
| `02-shopping.png` | Show product discovery, price information and product details. |
| `03-echo.png` | Show spoken thoughts as a transcript timeline. |
| `04-memory.png` | Explain remembered context and user control. |
| `05-tasks.png` | Show a completed independent task. |
| `06-feed.png` | Show next steps in the real Web interface. |
| `07-your-choice.png` | Explain optional connections and the open-source project. |
| `08-start.png` | Give a clear Web/Android entry point. |

Each gallery image is 1270 × 760 PNG and under 0.4 MB. The thumbnail is 240 × 240 PNG. Upload the numbered gallery files in order, excluding the contact sheet and thumbnail.

Source captures are retained unchanged. Some iOS captures precede the latest navigation-label updates, so the screenshots include earlier dock labels or the Brief name. Marketing copy uses Feed; the screenshot provenance preserves the original interface. The Web Feed capture explicitly labels its synthetic account. These captures do not establish physical-device microphone/background validation.

## Field plan

| Product Hunt field | Prepared value / action |
| --- | --- |
| Product name | Impo |
| Main URL | https://impo.ai |
| Tagline | Open source Muse (16 characters); see `listing.json`. |
| Description | 337 characters; see `listing.json`. |
| Additional links | Web app, Android APK, GitHub, Discord where the form accepts them. |
| Thumbnail | `assets/thumbnail-240.png` |
| Gallery | Eight numbered PNGs. |
| Video | MP4, YouTube title and description prepared. A YouTube or Loom upload is needed for the current Product Hunt video field. |
| Interactive demo | Local clickable tour prepared. The Product Hunt form's supported host must be checked before adding a URL. |
| Maker | CJ, the signed-in owner; verify the profile in the form. |
| Launch tags | Prefer Artificial Intelligence, Productivity, Open Source; use the closest actual options. |
| Pricing | Free; current app download is free and no active billing enforcement was found. Do not promise permanent free hosted usage. |
| First comment | Prepared in `listing.json`. |
| Shoutouts | Temporal, Shopify, Clerk, with specific explanations. Rebyte was not present in the live product search. |
| Product X handle | No verified product handle found. Leave blank unless supplied. |
| Promo | No active discount/code supplied. Leave blank. |
| Co-makers | No additional maker identities supplied. Do not invent or invite people. |
| Launch date | Not selected. Keep the launch as a draft until the owner chooses publication timing. |

This is a preparation manifest, not confirmation that the live form has saved these values. Live field status belongs in `form-status.json`. The saved draft is [Impo on Product Hunt](https://www.producthunt.com/products/impo?launch=impo); it is unscheduled.

## Availability and claims

- Public entry points: [Web](https://impo.ai/app/) and [Android APK](https://impo.ai/android.apk).
- The website currently states that the iOS beta is not accepting new testers. Do not advertise App Store availability or unrestricted TestFlight access.
- Echo recording and native permissions remain phone capabilities. Web can review Echo history, but it does not perform background Echo capture.
- Product search covers eligible Shopify Catalog merchants. Final price, delivery and checkout are controlled by the merchant.
- Server-side work continues after the client disconnects; the client does not need to keep a stream open for the whole task.
- Memories and Feed require context and background processing. Do not promise an immediately populated Feed for a new account.
- Full source publication and implementation are separate: the public GitHub README currently lags behind the locally implemented/deployed Web client. The existing marketing page also still contains a sentence saying Web is planned. These external-copy inconsistencies should be resolved before publication; this kit does not overwrite unrelated website work.

## Rebuild

Run from the repository root on macOS:

```sh
swift scripts/render-product-hunt.swift
python3 scripts/build-product-hunt-video.py
```

The video renderer needs `ffmpeg`, `ffprobe` and the macOS Samantha voice. Temporary audio and intermediate video remain under ignored `.local/product-hunt/`. The final MP4 includes an English subtitle track; the separate SRT can be uploaded to YouTube.

## Validation

Gallery dimensions, file sizes, English-only authored copy, tagline and description limits were checked. The rendered contact sheet was visually inspected and a clipping issue was corrected. The 68.8-second MP4 has H.264 1920 × 1080 video, AAC audio and an English subtitle track; a full decode reported no errors. The live form was completed through the checklist and saved as an unscheduled draft. Public gallery images were downloaded and compared against the originals. All eight are present, but batch upload completion changed their order; correction remains pending. The requested tagline, **Open source Muse**, was saved and read back on the unscheduled draft. Browser interaction checks for the local tour remain pending.

Product Hunt's current [launch preparation guide](https://www.producthunt.com/launch/preparing-for-launch) specifies the recommended image sizes, text limits, video support and interactive demo providers. The current live form also accepts Loom, although the launch guide only mentions YouTube. The live form remains authoritative if it differs.
