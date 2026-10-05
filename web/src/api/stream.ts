import { record, type Part } from "./types";

export interface StreamState {
  messageId: string;
  text: string;
  parts: Part[];
  status: string;
  error?: string;
  finished: boolean;
  done: boolean;
}
export class StreamReducer {
  state: StreamState = {
    messageId: "",
    text: "",
    parts: [],
    status: "running",
    finished: false,
    done: false,
  };
  private texts = new Map<string, string>();
  private open = new Set<string>();
  private tools = new Map<string, Part>();
  private submissionId?: string;
  private aborted = false;
  apply(raw: string) {
    const fail = (): never => {
      throw new Error("The reply stream was interrupted. Reconnecting…");
    };
    if (this.state.done) return fail();
    if (raw === "[DONE]") {
      if (!this.state.finished) return fail();
      this.state = { ...this.state, done: true };
      return;
    }
    if (this.state.finished) return fail();
    let value;
    try {
      value = record(JSON.parse(raw));
    } catch {
      return fail();
    }
    if (!value || typeof value.type !== "string") return fail();
    const v = value as Record<string, unknown> & { type: string };
    const id = typeof v.id === "string" && v.id ? v.id : undefined;
    if (v.type === "start") {
      if (
        this.state.messageId ||
        typeof v.messageId !== "string" ||
        !v.messageId
      )
        return fail();
      this.state = { ...this.state, messageId: v.messageId };
      return;
    }
    if (!this.state.messageId) return fail();
    switch (v.type) {
      case "text-start":
        if (!id || this.texts.has(id)) return fail();
        this.texts.set(id, "");
        this.open.add(id);
        break;
      case "text-delta":
        if (!id || !this.open.has(id) || typeof v.delta !== "string")
          return fail();
        this.texts.set(id, this.texts.get(id)! + v.delta);
        break;
      case "text-end":
        if (!id || !this.open.delete(id)) return fail();
        break;
      case "tool-input-available": {
        if (
          typeof v.toolCallId !== "string" ||
          typeof v.toolName !== "string" ||
          this.tools.has(v.toolCallId)
        )
          return fail();
        this.tools.set(v.toolCallId, {
          type: "dynamic-tool",
          toolCallId: v.toolCallId,
          toolName: v.toolName,
          input: v.input,
          state: "input-available",
        });
        break;
      }
      case "tool-output-available":
      case "tool-output-error": {
        const tool = this.tools.get(String(v.toolCallId));
        if (!tool || tool.state !== "input-available") return fail();
        this.tools.set(String(v.toolCallId), {
          ...tool,
          state:
            v.type === "tool-output-error"
              ? "output-error"
              : "output-available",
          output: v.output,
          errorText: v.errorText,
        });
        break;
      }
      case "data-instant-submission": {
        const d = record(v.data);
        if (
          !d ||
          d.schemaVersion !== 1 ||
          typeof d.submissionId !== "string" ||
          typeof d.status !== "string" ||
          (this.submissionId && this.submissionId !== d.submissionId)
        )
          return fail();
        this.submissionId = d.submissionId;
        this.state.status = d.status;
        break;
      }
      case "error":
        if (typeof v.errorText !== "string") return fail();
        this.state.error = v.errorText;
        break;
      case "abort":
        this.aborted = true;
        this.state.status = "cancelled";
        break;
      case "finish":
        if (this.open.size && !this.aborted) return fail();
        this.state.finished = true;
        break;
      default: {
        if (!v.type.startsWith("data-")) return fail();
        const d = record(v.data);
        if (!d || d.schemaVersion !== 1) break;
        if (
          v.type === "data-instant-file" &&
          (typeof d.fileId !== "string" ||
            typeof d.name !== "string" ||
            typeof d.mediaType !== "string" ||
            !Number.isSafeInteger(d.sizeBytes) ||
            Number(d.sizeBytes) < 0)
        )
          break;
        if (
          v.type === "data-impo-products" &&
          (typeof d.selectionId !== "string" ||
            d.selectionId.length > 200 ||
            !Array.isArray(d.productIds) ||
            !d.productIds.length ||
            d.productIds.length > 8 ||
            d.productIds.some(
              (p) =>
                typeof p !== "string" ||
                !p.startsWith("gid://shopify/") ||
                p.length > 200,
            ))
        )
          break;
        if (
          v.type === "data-instant-step" &&
          (typeof d.title !== "string" || typeof d.status !== "string")
        )
          break;
        const key = String(d.fileId || d.selectionId || id || v.type);
        const part = { type: v.type, id: key, data: d };
        const index = this.state.parts.findIndex(
          (p) => p.type === part.type && p.id === key,
        );
        this.state.parts =
          index < 0
            ? [...this.state.parts, part]
            : this.state.parts.map((p, i) => (i === index ? part : p));
      }
    }
    this.state = {
      ...this.state,
      text: [...this.texts.values()].join(""),
      parts: [
        ...this.state.parts.filter((p) => p.type !== "dynamic-tool"),
        ...this.tools.values(),
      ],
    };
  }
  finish() {
    if (!this.state.finished || !this.state.done)
      throw new Error("The reply stream ended early. Reconnecting…");
  }
}

/** Incremental UTF-8 and SSE framing. Transport closure is never a successful run. */
export async function consumeStream(
  response: Response,
  onState: (state: StreamState) => void,
  signal: AbortSignal,
) {
  if (
    !response.headers.get("content-type")?.includes("text/event-stream") ||
    !response.body
  )
    throw new Error("Impo returned an invalid reply stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reducer = new StreamReducer();
  let buffer = "";
  let data: string[] = [];
  let size = 0;
  const line = (value: string) => {
    if (!value) {
      if (data.length) {
        reducer.apply(data.join("\n"));
        onState({ ...reducer.state });
        data = [];
        size = 0;
      }
    } else if (value.startsWith("data:")) {
      data.push(value.slice(5).replace(/^ /, ""));
      size += value.length;
      if (size > 1_048_576) throw new Error("Reply event is too large.");
    }
  };
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (buffer.length > 1_048_576)
        throw new Error("Reply event is too large.");
      if (chunk.done) break;
    }
    signal.throwIfAborted();
    reducer.finish();
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
