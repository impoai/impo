import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { createAndroidFixture } from "../../scripts/android-ui-fixture.ts";
import { ImpoClient } from "../src/api/client.ts";
import { consumeStream } from "../src/api/stream.ts";

test("Web client uses the native HTTP adapter for owned history, writes, schedules and settings", async () => {
  const server = createAndroidFixture({ files: true, delayMs: 5 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const alice = new ImpoClient(
    "alice",
    async () => "instant-dev-alice",
    fetch,
    base,
  );
  const bob = new ImpoClient("bob", async () => "instant-dev-bob", fetch, base);
  try {
    const profile = await alice.get("/profile");
    assert.equal(profile.mode, "Balanced");
    assert.equal(profile.assistantName, undefined);
    assert.equal(profile.avatarIndex, undefined);
    const personalized = await alice.mutate(
      "/profile",
      { assistantName: " Cedar ", avatarIndex: 0, mode: "Power" },
      "PATCH",
    );
    assert.equal(personalized.assistantName, "Cedar");
    assert.equal(personalized.avatarIndex, 0);
    assert.equal(personalized.mode, "Power");
    assert.deepEqual(await alice.get("/profile"), personalized);
    assert.equal((await bob.get("/profile")).assistantName, undefined);
    assert.equal((await bob.get("/profile")).avatarIndex, undefined);
    const history = await alice.history("/conversation");
    assert.ok(history.messages.length > 0);
    const body = {
      clientMessageId: randomUUID(),
      text: "Web transport integration check",
    };
    const receipt = await alice.mutate("/conversation/messages", body);
    assert.deepEqual(
      await alice.mutate("/conversation/messages", body),
      receipt,
    );
    const states = [];
    await consumeStream(
      await alice.response(`/submissions/${receipt.submissionId}/stream`, {
        headers: { Accept: "text/event-stream" },
      }),
      (s) => states.push(s),
      new AbortController().signal,
    );
    assert.equal(states.at(-1).done, true);
    assert.ok(states.at(-1).text.length > 0);
    await assert.rejects(
      bob.get(`/submissions/${receipt.submissionId}`),
      (e) => e.status === 404,
    );
    const task = await alice.mutate("/tasks", {
      clientMessageId: randomUUID(),
      text: "Prepare a Web task",
    });
    assert.ok(task.taskId);
    assert.equal(
      (await alice.get(`/tasks/${task.taskId}/conversation`)).taskId,
      task.taskId,
    );
    await assert.rejects(
      bob.get(`/tasks/${task.taskId}/conversation`),
      (e) => e.status === 404,
    );
    const schedule = {
      title: "Web schedule test",
      goal: "Review one useful priority",
      enabled: false,
      schedule: {
        frequency: "weekly",
        timeZone: "America/Los_Angeles",
        runAt: null,
        time: "09:00",
        weekdays: [1, 3, 5],
      },
    };
    const scheduled = await alice.mutate("/scheduled-tasks", {
      ...schedule,
      clientRequestId: randomUUID(),
    });
    assert.ok(
      (await alice.get("/scheduled-tasks")).schedules.some(
        (s) => s.id === scheduled.id,
      ),
    );
    const updated = await alice.mutate(
      `/scheduled-tasks/${scheduled.id}`,
      { ...schedule, title: "Updated", revision: scheduled.revision },
      "PUT",
    );
    await assert.rejects(
      alice.mutate(
        `/scheduled-tasks/${scheduled.id}`,
        { ...schedule, revision: scheduled.revision },
        "PUT",
      ),
      (e) => e.status === 409,
    );
    await alice.mutate(
      `/scheduled-tasks/${scheduled.id}`,
      { revision: updated.revision },
      "DELETE",
    );
    const feed = (await alice.get("/today/briefs")).briefs[0];
    const card = feed.content.cards.find((c) => c.action);
    assert.equal(
      (await alice.mutate(`/today/briefs/${feed.id}/cards/${card.id}/action`))
        .action.kind,
      "chat_draft",
    );
    const existing = (await alice.get("/today/settings")).settings;
    const settings = {
      timeZone: existing.timeZone,
      locale: existing.locale,
      displayName: "Web Tester",
      slots: existing.slots,
      contentPreferences: {
        categories: {
          suggestion: true,
          recap: true,
          connect: true,
          feature: true,
          occasion: true,
        },
        occasionCalendar: "none",
      },
    };
    await alice.mutate("/today/settings", settings, "PUT");
    assert.equal((await alice.get("/profile")).displayName, "Web Tester");
    const recording = (await alice.get("/listening/segments?limit=30"))
      .segments[0];
    await alice.mutate(
      `/listening/segments/${recording.id}/location`,
      { label: "Web review" },
      "PATCH",
    );
    const review = {
      ...recording.speakerReview,
      status: "confirmed",
      selfSpeakerIds: [recording.utterances[0].speaker],
      excludedUtteranceIds: [],
    };
    await alice.mutate(
      `/listening/segments/${recording.id}/speakers`,
      review,
      "PATCH",
    );
    const echo = await alice.get("/echo/schedule");
    const saved = await alice.mutate(
      "/echo/schedule",
      { ...echo, enabled: false },
      "PUT",
    );
    assert.ok(saved.revision);
    await alice.mutate("/notifications/settings", { brief: false }, "PATCH");
    assert.equal((await alice.get("/notifications/settings")).brief, false);
    const file = history.messages
      .flatMap((m) => m.parts || [])
      .find((p) => p.type === "data-instant-file").data;
    assert.ok(
      (await (await alice.response(`/files/${file.fileId}`)).arrayBuffer())
        .byteLength > 0,
    );
    await assert.rejects(
      bob.response(`/files/${file.fileId}`),
      (e) => e.status === 404,
    );
    await assert.rejects(
      alice.mutate("/attachments/prepare", {}),
      (e) => e.code === "attachments_unavailable",
    );
    const challenge = await alice.mutate("/account/deletion-challenge");
    const deletion = await alice.mutate(
      "/account",
      {
        challengeId: challenge.challengeId,
        token: challenge.token,
        confirmation: "DELETE",
      },
      "DELETE",
    );
    assert.equal(deletion.status, "deleting");
    const recovery = new ImpoClient(
      "receipt",
      async () => challenge.token,
      fetch,
      base,
    );
    assert.equal(
      (await recovery.get(`/account/deletions/${challenge.challengeId}`))
        .status,
      "deleting",
    );
    await assert.rejects(alice.get("/profile"), (e) => e.status === 410);
    assert.ok((await bob.get("/profile")).onboarded);
  } finally {
    alice.close();
    bob.close();
    server.closeAllConnections();
    server.close();
  }
});
