import type { ImpoClient } from "./api/client";
export interface Attachment {
  id: string;
  file: File;
  status: "uploading" | "ready" | "failed";
  error?: string;
}
const types: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};
export async function uploadAttachment(
  api: ImpoClient,
  attachment: Attachment,
) {
  const { file, id } = attachment;
  const ext = file.name.split(".").at(-1)?.toLowerCase() || "";
  if (!types[ext])
    throw new Error(
      "Choose a PDF, Word document, text file or JPG, PNG, WebP or GIF image.",
    );
  if (!file.size || file.size > 10 * 1024 * 1024)
    throw new Error("Each file must be between 1 byte and 10 MB.");
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const ticket = await api.mutate<{
    status: string;
    url?: string;
    headers?: Record<string, string>;
  }>(`/attachments/prepare`, {
    id,
    name: file.name,
    mediaType: types[ext],
    sizeBytes: file.size,
    sha256,
  });
  if (ticket.status === "upload") {
    if (!ticket.url) throw new Error("Upload URL is missing.");
    const url = new URL(ticket.url);
    const local =
      import.meta.env.DEV && ["127.0.0.1", "localhost"].includes(url.hostname);
    if (
      !local &&
      (url.protocol !== "https:" ||
        !url.hostname.endsWith(".amazonaws.com") ||
        url.username ||
        url.password)
    )
      throw new Error("Upload URL is invalid.");
    const headers = new Headers(ticket.headers);
    for (const name of headers.keys())
      if (["authorization", "cookie", "host"].includes(name.toLowerCase()))
        throw new Error("Invalid upload headers.");
    const response = await fetch(url, {
      method: "PUT",
      body: bytes,
      headers,
      credentials: "omit",
      redirect: "error",
      signal: api.controller.signal,
    });
    if (!response.ok) throw new Error("Upload failed. Retry this file.");
  }
  if (ticket.status !== "ready")
    await api.mutate(`/attachments/${id}/complete`);
}
