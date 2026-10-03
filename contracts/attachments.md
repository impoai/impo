# Input attachments

Chat, new tasks and task follow-ups accept up to eight uploaded files per message,
including messages with no text. Each file is limited to 10 MiB. Supported formats
are PDF, DOC, DOCX, UTF-8 TXT/Markdown/CSV/JSON and JPEG/PNG/WebP/GIF. The iOS photo
picker converts selected photos to JPEG before upload.

## Ownership and delivery

1. The client generates an upload UUID and SHA-256 checksum, then calls
   `POST /api/v1/attachments/prepare` with `id`, `name`, `mediaType`, `sizeBytes`
   and `sha256`.
2. It uploads the bytes using the returned signed S3 PUT URL and headers. Provider
   credentials and the Impo authorization header never go to this URL.
3. `POST /api/v1/attachments/{id}/complete` verifies the stored object's size and
   checksum. Only ready, owned IDs may enter a message's `attachmentIds` array.
4. The worker creates or recovers the conversation's Rebyte Session, copies the
   conversation's admitted attachments into deterministic environment paths, then
   sends the message with its existing durable idempotency key.

Impo owns account authorization, original-file storage, upload receipts and the
association between a file and a message. Rebyte owns parsing, file-reading tools
and model protocol conversion. Impo has no PDF, Word or image parser.

Rebyte's `list_files` and `read_file(file_id, page?, offset?, view?)` tools provide
the same interface for every model. Documents return paginated text. Images and
rendered PDF pages return typed image content with a base64 data URL; the data URL
is never substituted for actual image input by inserting it into plain text.
Model vision support remains a property of the selected provider and model.
There is no automatic model substitution or OCR model call.

The input contains both the Impo `attachmentId` and the Session's Rebyte `fileId`.
Delegating to `instant_create_task` uses Impo IDs in `attachment_ids`; `read_file`
uses Rebyte IDs. On Session rotation, the worker restores owned conversation
attachments and the model can discover the new IDs through `list_files`.

## History and retention

File associations remain in PostgreSQL after message text moves to Rebyte. History
projects the same `data-instant-file` cards used for output files. An input file's
download ID is `upload_{uuid}` and `/api/v1/files/{fileId}` checks ownership before
serving the original bytes. Removing an attachment from a composer does not
delete an uploaded original. Originals remain private until account deletion;
account cleanup removes their database rows and S3 objects.

Uploads in progress or awaiting retry block Send. Account changes cancel pending
uploads and clear composer attachments. Accepted message retries retain the same
attachment IDs and never turn into a second message.

Rebyte bounds document parsing with a 30 second deadline and a disposable process.
PDF text is extracted one page at a time; `view=image` renders a page for scanned
documents and visual inspection. DOC/DOCX return body and notes, without embedded
images or layout. Images use their first frame and are normalized to JPEG at up to
1600 pixels per side. Downloads always retain the original upload.
