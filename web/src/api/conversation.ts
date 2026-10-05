import { ImpoClient } from "./client";
import { consumeStream } from "./stream";
import {
  terminal,
  type Conversation,
  type Message,
  type Receipt,
} from "./types";

export interface ConversationState {
  messages: Message[];
  active: string[];
  loading: boolean;
  error?: Error;
  title?: string;
}
/** Owns subscriptions only. Leaving a page never cancels its durable runs. */
export class ConversationController {
  state: ConversationState = { messages: [], active: [], loading: true };
  private controller = new AbortController();
  private streams = new Map<string, AbortController>();
  private failures = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private loading = false;
  private revision = 0;
  constructor(
    private api: ImpoClient,
    readonly historyPath: string,
    private change: (state: ConversationState) => void,
  ) {}
  private emit(patch: Partial<ConversationState> = {}) {
    if (!this.controller.signal.aborted) {
      this.state = { ...this.state, ...patch };
      this.change(this.state);
    }
  }
  async refresh() {
    if (this.loading || this.controller.signal.aborted) return;
    this.loading = true;
    const revision = this.revision;
    try {
      const page: Conversation = await this.api.history(
        this.historyPath,
        this.controller.signal,
      );
      if (this.controller.signal.aborted || revision !== this.revision) return;
      const streamingIds = new Set([...this.streams.keys()]);
      // Keep newer streamed text while background history hydration completes.
      const byId = new Map(page.messages.map((m) => [m.id, m]));
      for (const m of this.state.messages)
        if (m.status === "streaming") byId.set(m.id, m);
      this.emit({
        messages: [...byId.values()].sort((a, b) => a.sequence - b.sequence),
        title: page.title,
        loading: false,
        active: page.activeSubmissions
          .filter((run) => !terminal(run.status))
          .map((run) => run.submissionId),
        error: page.activeSubmissions.some(
          (run) =>
            !terminal(run.status) &&
            (this.failures.get(run.submissionId) || 0) >= 5,
        )
          ? new Error(
              "Live updates paused after repeated interruptions. Reconnect to try again; your task is still on the server.",
            )
          : undefined,
      });
      for (const run of page.activeSubmissions)
        if (!terminal(run.status) && !streamingIds.has(run.submissionId))
          this.subscribe(run.submissionId);
    } catch (error) {
      if (!this.controller.signal.aborted)
        this.emit({ loading: false, error: error as Error });
    } finally {
      this.loading = false;
      if (!this.controller.signal.aborted) {
        clearTimeout(this.timer);
        this.timer = setTimeout(
          () => void this.refresh(),
          this.state.active.length ? 15000 : 60000,
        );
      }
    }
  }
  accepted(receipt: Receipt, text: string) {
    this.revision++;
    if (!this.state.messages.some((m) => m.id === receipt.messageId))
      this.emit({
        messages: [
          ...this.state.messages,
          {
            id: receipt.messageId,
            role: "user",
            text,
            status: "completed",
            createdAt: new Date().toISOString(),
            sequence:
              Math.max(0, ...this.state.messages.map((m) => m.sequence)) + 1,
          },
        ],
      });
    this.subscribe(receipt.submissionId);
    void this.refresh();
  }
  private subscribe(id: string) {
    if (
      this.streams.has(id) ||
      this.controller.signal.aborted ||
      (this.failures.get(id) || 0) >= 5
    )
      return;
    const stream = new AbortController();
    this.streams.set(id, stream);
    this.emit({ active: [...new Set([...this.state.active, id])] });
    const signal = AbortSignal.any([
      stream.signal,
      this.controller.signal,
      this.api.controller.signal,
    ]);
    void (async () => {
      let assistantId: string | undefined;
      let completed = false;
      try {
        const response = await this.api.response(
          `/submissions/${encodeURIComponent(id)}/stream`,
          { headers: { Accept: "text/event-stream" }, signal },
        );
        await consumeStream(
          response,
          (value) => {
            if (!value.messageId || signal.aborted) return;
            assistantId = value.messageId;
            if (value.done && terminal(value.status)) completed = true;
            const prior = this.state.messages.find(
              (m) => m.id === value.messageId,
            );
            const message: Message = {
              id: value.messageId,
              role: "assistant",
              text: value.text,
              parts: value.parts,
              status: value.finished
                ? value.error
                  ? "failed"
                  : value.status
                : "streaming",
              createdAt: prior?.createdAt || new Date().toISOString(),
              sequence:
                prior?.sequence ??
                Math.max(0, ...this.state.messages.map((m) => m.sequence)) + 1,
            };
            this.emit({
              messages: prior
                ? this.state.messages.map((m) =>
                    m.id === message.id ? message : m,
                  )
                : [...this.state.messages, message],
              ...(value.error ? { error: new Error(value.error) } : {}),
            });
          },
          signal,
        );
        this.failures.delete(id);
      } catch (error) {
        if (!signal.aborted) {
          this.failures.set(id, (this.failures.get(id) || 0) + 1);
          this.emit({ error: error as Error });
        }
      } finally {
        this.streams.delete(id);
        if (assistantId)
          this.emit({
            messages: this.state.messages.map((m) =>
              m.id === assistantId && m.status === "streaming"
                ? { ...m, status: "reconnecting" }
                : m,
            ),
          });
        if (completed)
          this.emit({ active: this.state.active.filter((run) => run !== id) });
        if (!this.controller.signal.aborted) {
          clearTimeout(this.timer);
          this.timer = setTimeout(
            () => void this.refresh(),
            Math.min(1500 * 2 ** (this.failures.get(id) || 0), 30000),
          );
        }
      }
    })();
  }
  reconnect() {
    this.failures.clear();
    return this.refresh();
  }
  async cancel() {
    await Promise.all(
      this.state.active.map((id) =>
        this.api.mutate(`/submissions/${encodeURIComponent(id)}/cancel`),
      ),
    );
  }
  close() {
    this.controller.abort();
    clearTimeout(this.timer);
    this.streams.forEach((stream) => stream.abort());
    this.streams.clear();
  }
}
