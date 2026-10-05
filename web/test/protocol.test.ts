import test from "node:test";
import assert from "node:assert/strict";
import { ImpoClient, ApiError, safeHTTPS } from "../src/api/client.ts";
import { StreamReducer, consumeStream } from "../src/api/stream.ts";
import { Outbox } from "../src/api/outbox.ts";
import { ConversationController } from "../src/api/conversation.ts";

const encoder = new TextEncoder();
const frame = (v: unknown) =>
  `data: ${typeof v === "string" ? v : JSON.stringify(v)}\r\n\r\n`;
const chunks = [
  { type: "start", messageId: "assistant-1" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "Hello 你好 👋" },
  { type: "text-end", id: "t" },
  { type: "finish" },
  "[DONE]",
];
test("SSE survives every byte boundary, CRLF, Unicode and comments", async () => {
  const bytes = encoder.encode(
    ": keep-alive\r\n\r\n" + chunks.map(frame).join(""),
  );
  for (const split of [1, 2, 3, 7, 63]) {
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= bytes.length) c.close();
        else {
          c.enqueue(bytes.slice(at, at + split));
          at += split;
        }
      },
    });
    let state: { text: string; done: boolean } = { text: "", done: false };
    await consumeStream(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      (s) => {
        state = s;
      },
      new AbortController().signal,
    );
    assert.equal(state?.text, "Hello 你好 👋");
    assert.equal(state?.done, true);
  }
});
test("truncated or out-of-order core events cannot complete a reply", async () => {
  for (const data of [
    chunks.slice(0, -1),
    chunks.slice(0, -2),
    [{ type: "text-delta", id: "t", delta: "bad" }],
    ["[DONE]"],
    [
      { type: "start", messageId: "a" },
      { type: "text-start", id: "t" },
      { type: "finish" },
    ],
  ]) {
    await assert.rejects(
      consumeStream(
        new Response(data.map(frame).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        }),
        () => {},
        new AbortController().signal,
      ),
    );
  }
});
test("unknown optional data is tolerated; stable submission identity is enforced", () => {
  const r = new StreamReducer();
  r.apply(JSON.stringify(chunks[0]));
  r.apply(JSON.stringify({ type: "data-future", data: { schemaVersion: 7 } }));
  r.apply(
    JSON.stringify({
      type: "data-instant-submission",
      data: { schemaVersion: 1, submissionId: "run1", status: "running" },
    }),
  );
  assert.throws(() =>
    r.apply(
      JSON.stringify({
        type: "data-instant-submission",
        data: { schemaVersion: 1, submissionId: "run2", status: "running" },
      }),
    ),
  );
});
test("one coordinated token refresh retries the exact write without cookies", async () => {
  let refreshes = 0;
  const requests: { body: unknown; credentials: unknown }[] = [];
  const api = new ImpoClient(
    "alice",
    async (force) => {
      if (force) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 5));
        return "new";
      }
      return "old";
    },
    async (_, init) => {
      requests.push({ body: init?.body, credentials: init?.credentials });
      return new Headers(init?.headers).get("Authorization") === "Bearer old"
        ? new Response("", { status: 401 })
        : Response.json({ ok: true });
    },
  );
  await Promise.all([
    api.mutate("/conversation/messages", { clientMessageId: "fixed" }),
    api.get("/profile"),
  ]);
  assert.equal(refreshes, 1);
  assert.deepEqual(
    requests.filter((x) => x.body).map((x) => x.body),
    ['{"clientMessageId":"fixed"}', '{"clientMessageId":"fixed"}'],
  );
  assert.ok(requests.every((r) => r.credentials === "omit"));
});
test("account closure fences a token that arrives late", async () => {
  let release!: (t: string) => void;
  let calls = 0;
  const api = new ImpoClient(
    "alice",
    () =>
      new Promise((r) => {
        release = r;
      }),
    async () => {
      calls++;
      return Response.json({});
    },
  );
  const request = api.get("/profile");
  api.close();
  release("old-account-token");
  await assert.rejects(request);
  assert.equal(calls, 0);
});
test("API errors preserve server codes and do not retry uncertain writes", async () => {
  let calls = 0;
  const api = new ImpoClient(
    "a",
    async () => "token",
    async () => {
      calls++;
      return Response.json(
        {
          error: {
            code: "idempotency_conflict",
            message: "Already changed",
            retryable: false,
          },
        },
        { status: 409 },
      );
    },
  );
  await assert.rejects(
    api.mutate("/tasks", {}),
    (e: unknown) =>
      e instanceof ApiError &&
      e.code === "idempotency_conflict" &&
      !e.retryable,
  );
  assert.equal(calls, 1);
});
test("outbox freezes commands across reload and scopes accounts", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) || null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
  const a = new Outbox("alice", "main", storage);
  const body = {
    clientMessageId: "same-key",
    text: "Original",
    attachmentIds: ["owned"],
  };
  a.save({ path: "/conversation/messages", body, createdAt: "now" });
  body.text = "Edited";
  assert.equal(
    new Outbox("alice", "main", storage).read()?.body.text,
    "Original",
  );
  assert.equal(new Outbox("bob", "main", storage).read(), null);
  assert.throws(() => a.save({ path: "/tasks", body, createdAt: "later" }));
  a.clear();
  assert.equal(a.read(), null);
});
test("unsafe provider URLs never become clickable actions", () => {
  for (const u of [
    "javascript:alert(1)",
    "https://user:password@example.com",
    "https://example.com/ bad",
    "https:\\evil.com",
    "//evil.com",
    "http://example.com",
  ])
    assert.equal(safeHTTPS(u), undefined);
  assert.equal(
    safeHTTPS("https://example.com/product?id=1"),
    "https://example.com/product?id=1",
  );
});

test("repeated broken streams stop automatic subscriptions while explicit cancellation remains available", async () => {
  let streamCount = 0;
  let cancelled = false;
  const api = new ImpoClient(
    "a",
    async () => "token",
    async (path) => {
      if (String(path).endsWith("/cancel")) {
        cancelled = true;
        return Response.json({ status: "cancelling" });
      }
      if (String(path).endsWith("/stream")) {
        streamCount++;
        return new Response(chunks.slice(0, 3).map(frame).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return Response.json({
        conversationId: "c",
        messages: [],
        activeSubmissions: [
          { submissionId: "run", messageId: "u", status: "running" },
        ],
        hasMore: false,
        nextAfterSequence: 0,
      });
    },
  );
  const controller = new ConversationController(api, "/conversation", () => {});
  try {
    for (let i = 0; i < 8; i++) {
      await controller.refresh();
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(streamCount, 5);
    assert.deepEqual(controller.state.active, ["run"]);
    assert.match(controller.state.error?.message || "", /Live updates paused/);
    await controller.cancel();
    assert.equal(cancelled, true);
    await controller.reconnect();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(streamCount, 6);
  } finally {
    controller.close();
    api.close();
  }
});

test("duplicate tool outputs and text after finish are protocol errors", () => {
  const r = new StreamReducer();
  for (const v of [
    { type: "start", messageId: "a" },
    {
      type: "tool-input-available",
      toolCallId: "tool",
      toolName: "read",
      input: {},
    },
    { type: "tool-output-available", toolCallId: "tool", output: {} },
  ])
    r.apply(JSON.stringify(v));
  assert.throws(() =>
    r.apply(
      JSON.stringify({
        type: "tool-output-available",
        toolCallId: "tool",
        output: {},
      }),
    ),
  );
  const ended = new StreamReducer();
  for (const v of chunks.slice(0, -1)) ended.apply(JSON.stringify(v));
  assert.throws(() =>
    ended.apply(JSON.stringify({ type: "text-start", id: "late" })),
  );
});
test("conversation reconnect replaces assistant text by ID and never cancels the run on close", async () => {
  let streams = 0;
  const requests: string[] = [];
  let latest = "";
  const history = {
    conversationId: "c",
    messages: [
      {
        id: "u",
        sequence: 1,
        role: "user",
        text: "Question",
        status: "completed",
        createdAt: "now",
      },
    ],
    activeSubmissions: [
      { messageId: "u", submissionId: "run", status: "running" },
    ],
    hasMore: false,
    nextAfterSequence: 1,
  };
  const api = new ImpoClient(
    "a",
    async () => "token",
    async (path) => {
      requests.push(String(path));
      if (String(path).endsWith("/stream")) {
        streams++;
        return new Response(chunks.map(frame).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return Response.json(history);
    },
  );
  const controller = new ConversationController(api, "/conversation", (s) => {
    latest = s.messages.find((m) => m.id === "assistant-1")?.text || latest;
  });
  await controller.refresh();
  await new Promise((r) => setTimeout(r, 20));
  await controller.refresh();
  await new Promise((r) => setTimeout(r, 20));
  controller.close();
  assert.equal(latest, "Hello 你好 👋");
  assert.equal(streams, 2);
  assert.ok(!requests.some((p) => p.endsWith("/cancel")));
});
