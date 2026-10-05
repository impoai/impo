import type { Conversation } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = "network_error",
    public retryable = true,
  ) {
    super(message);
  }
}
export class ImpoClient {
  readonly controller = new AbortController();
  private refresh?: Promise<string | null>;
  constructor(
    readonly account: string,
    private token: (refresh: boolean) => Promise<string | null>,
    private fetcher: typeof fetch = (...args) => fetch(...args),
    readonly base = "/api/v1",
  ) {}
  close() {
    this.controller.abort();
  }
  async response(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Invalid API path");
    const signal = init.signal
      ? AbortSignal.any([init.signal, this.controller.signal])
      : this.controller.signal;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const token = attempt
        ? await (this.refresh ??= this.token(true).finally(() => {
            this.refresh = undefined;
          }))
        : await this.token(false);
      signal.throwIfAborted();
      if (!token)
        throw new ApiError("Please sign in again.", 401, "unauthorized", false);
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      headers.set("X-Impo-Model-Catalog", "2");
      if (init.body) headers.set("Content-Type", "application/json");
      let response: Response;
      try {
        response = await this.fetcher(this.base + path, {
          ...init,
          headers,
          signal,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ApiError(
          "Could not reach Impo. Check your connection and try again.",
        );
      }
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new ApiError(
          body?.error?.message || `Request failed (${response.status}).`,
          response.status,
          body?.error?.code,
          body?.error?.retryable ?? response.status >= 500,
        );
      }
      return response;
    }
    throw new ApiError("Please sign in again.", 401, "unauthorized", false);
  }
  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return (await this.response(path, { signal })).json();
  }
  async mutate<T>(
    path: string,
    body: unknown = {},
    method = "POST",
  ): Promise<T> {
    return (
      await this.response(path, { method, body: JSON.stringify(body) })
    ).json();
  }
  async history(path: string, signal?: AbortSignal): Promise<Conversation> {
    let after = 0;
    let result: Conversation | undefined;
    do {
      const page = await this.get<Conversation>(
        `${path}?afterSequence=${after}&limit=100`,
        signal,
      );
      result = result
        ? { ...page, messages: [...result.messages, ...page.messages] }
        : page;
      if (!page.hasMore) return result;
      if (
        !Number.isSafeInteger(page.nextAfterSequence) ||
        page.nextAfterSequence <= after
      )
        throw new Error("Conversation pagination did not advance.");
      after = page.nextAfterSequence;
    } while (!signal?.aborted);
    throw new DOMException("Aborted", "AbortError");
  }
}
export function clientContext() {
  const language = navigator.language || "en";
  let country: string | undefined;
  try {
    country = new Intl.Locale(language).region;
  } catch {}
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    currentDate: new Date().toISOString(),
    language,
    ...(country ? { country } : {}),
  };
}
export function safeHTTPS(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096 || /[\s\\]/.test(value))
    return;
  try {
    const u = new URL(value);
    if (u.protocol === "https:" && !u.username && !u.password) return u.href;
  } catch {}
}
