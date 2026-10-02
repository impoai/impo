# Echo speakers and personal evidence

Echo groups speech into anonymous voices within one recording. Speaker A in one
recording is not an identity and has no relationship to Speaker A elsewhere.
The server does not infer which voice belongs to the signed-in user.

## Transcription and storage

The server uses Gemini 3.5 Transcribe with `diarization_mode: speaker` and word
timestamps. A batch with several audio files is decoded and joined into one
16 kHz mono WAV before transcription, so labels and offsets share one media
timeline. FFmpeg accepts only pipe/cache input, with bounded decoding time and
output. Its seek cache supports M4A metadata at the end of a file. The runtime
image includes FFmpeg; local worker development needs it on PATH.

Annotation text offsets are UTF-8 byte offsets. The adapter validates boundaries
and groups words at speaker changes, sentence endings, pauses and long passages.
Media timestamps describe retained speech, not elapsed wall time or precise
recording-time location. Invalid annotations leave the full transcript readable
without making any speech eligible for personal evidence.

Transcript text and immutable utterances are archived together in the user's S3
prefix. PostgreSQL keeps the review state and metadata; the API hydrates text
and utterances from the archive. Audio is still removed after successful
transcription. This version provides text-based selection, not audio replay or
voice enrollment. Existing upload batch boundaries remain unchanged; grouping
long conversations across batches is future work.

## Client contract

Listening record responses add these fields:

```json
{
  "utterances": [
    { "id": "u1", "speaker": "spk:0", "startMs": 0, "endMs": 2400, "text": "I prefer walking." },
    { "id": "u2", "speaker": "spk:1", "startMs": 2500, "endMs": 5000, "text": "I prefer cycling." }
  ],
  "speakerReview": {
    "revision": 0,
    "status": "unconfirmed",
    "selfSpeakerIds": [],
    "excludedUtteranceIds": []
  }
}
```

Utterance IDs address immutable archive order. A null speaker is unknown and
cannot be selected. Native clients display anonymous letters in first-appearance
order and allow multiple labels when the model splits one voice.

`PATCH /api/v1/listening/segments/:id/speakers` accepts the complete
`speakerReview` object, with the revision the client last read. It returns
`{segment: ...}` with the new revision. Ownership, completed transcription,
known labels/utterances, consistent state, duplicate IDs and unknown fields are
checked server-side. A concurrent edit returns `409 speaker_review_conflict`;
clients refresh before retrying. Unknown or other-user records return 404.

| Status | Selection | Personal evidence |
| --- | --- | --- |
| `unconfirmed` | None; the user is not sure or has not reviewed | None |
| `not_present` | None of the voices is the user | None |
| `confirmed` | One or more selected voices | Selected utterances except explicit exclusions |

Both clients offer Choose/Change, Not sure, None of these is me, and per-passage
Include/Exclude controls. They wait for the server acknowledgement before showing
a saved choice. A single detected voice still needs confirmation. Old records
without speaker annotations remain readable but do not supply personal evidence.
Clients tolerate older servers without these fields and hide review controls.

The full conversation transcript stays in Echo until deletion. Excluding speech
from personal evidence does not erase that text. Model labels can merge people
or split one person; users must review the passages before confirming a voice.

## Memory and Brief

`personalTranscript` is the shared server-side projection for both consumers.
There is no fallback to the full transcript. Agents must still distinguish the
user's preferences from quotations or statements about other people.

Memory windows advance by review time, allowing an older recording confirmed
today to enter a new window. Source IDs include the review revision:
`echo:<recordId>:v<revision>`. Before applying Agent output, the worker rereads
the evidence. Memory writes, reads/search and hourly reconciliation validate
Echo references against the current owned, confirmed revision.

Changing a selection, excluding a passage, revoking confirmation or deleting a
recording invalidates its previous revisions. A memory containing an invalid
reference is withdrawn as a whole because mixed prose cannot safely be separated
by source. Legacy unversioned Echo references are also invalid. A later confirmed
revision can produce new facts. Audit history remains available; withdrawal is
not a claim of erasure from past conversations or already delivered content.

Brief selects recently confirmed speech by review time, while keeping the
recording's original date in its source context. Source versions include the selected text and review. Generation and
retrieval validate these sources; affected published editions are withdrawn
rather than silently rewritten. Previously downloaded client content updates
when refreshed. No automatic regeneration of an old edition is promised.

## Verification and limits

Server tests cover ownership, stale revisions, concurrent edits, archive
hydration, exclusions, late confirmation, stale Agent output and withdrawal of
Memory/Brief sources. Swift/Kotlin protocol tests and native UI tests cover
selection, exclusion, persistence across relaunch and revocation.

A live Gemini probe with synthetic alternating English voices separated two
voices correctly. A four-voice English/Mandarin probe misassigned some Mandarin
speech to another voice.
This is not a real-world accuracy benchmark. Noisy physical recordings,
overlapping speech and larger groups still need acceptance testing.

Provider references: [transcription guide](https://ai.google.dev/gemini-api/docs/transcribe),
[model limits](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe),
and [Interactions annotation offsets](https://ai.google.dev/api/interactions-api).
