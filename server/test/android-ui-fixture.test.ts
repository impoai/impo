import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createAndroidFixture } from '../../scripts/android-ui-fixture.js';

test('Android smoke fixture exercises real HTTP/SSE, resource isolation and mutable screen data', async (t) => {
  const server = createAndroidFixture({ delayMs: 10 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', body?: unknown, identity = 'alice') => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer instant-dev-${identity}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await fetch(`${base}/api/v1/conversation`)).status, 401);
  const initial = await request('/conversation');
  assert.ok(initial.body.messages[1].text.includes('你好'));
  const input = { clientMessageId: randomUUID(), text: 'Hello Android' };
  const accepted = await request('/conversation/messages', 'POST', input);
  assert.equal(accepted.status, 202);
  assert.deepEqual((await request('/conversation/messages', 'POST', input)).body, accepted.body);
  assert.equal((await request('/conversation/messages', 'POST', { ...input, text: 'changed' })).status, 409);
  assert.equal(
    (await request(`/submissions/${accepted.body.submissionId}`, 'GET', undefined, 'bob')).status,
    404,
  );
  const stream = await fetch(`${base}/api/v1/submissions/${accepted.body.submissionId}/stream`, {
    headers: { authorization: 'Bearer instant-dev-alice' },
  });
  const sse = await stream.text();
  assert.ok(sse.includes('text-delta'));
  assert.ok(sse.includes('[DONE]'));
  const recovered = await request('/conversation');
  assert.equal(recovered.body.messages.at(-1).status, 'completed');
  assert.ok(recovered.body.messages.at(-1).text.includes('Hello Android 👋'));
  const slow = await request('/conversation/messages', 'POST', {
    clientMessageId: randomUUID(),
    text: 'slow reply to cancel',
  });
  assert.equal(
    (await request(`/submissions/${slow.body.submissionId}/cancel`, 'POST', {})).body.status,
    'cancelled',
  );
  const task = await request('/tasks', 'POST', {
    clientMessageId: randomUUID(),
    text: 'Plan a native launch',
  });
  assert.equal(task.status, 202);
  assert.equal(
    (await request(`/tasks/${task.body.taskId}/conversation`, 'GET', undefined, 'bob')).status,
    404,
  );
  assert.equal(
    (
      await request(`/tasks/${task.body.taskId}/messages`, 'POST', {
        clientMessageId: randomUUID(),
        text: 'Add a walking break',
      })
    ).status,
    202,
  );
  assert.ok((await request('/tasks')).body.tasks.some((row: any) => row.title === 'Plan a native launch'));
  const settings = (await request('/today/settings')).body.settings;
  assert.equal(
    (
      await request('/today/settings', 'PUT', {
        timeZone: settings.timeZone,
        locale: 'en-US',
        displayName: 'Android Tester',
      })
    ).body.settings.slots.length,
    2,
  );
  assert.equal(
    (await request('/today/settings', 'PUT', { timeZone: 'invalid', locale: 'en-US' })).status,
    400,
  );
  const brief = (await request('/today/briefs')).body.briefs[0];
  assert.equal((await request(`/today/briefs/${brief.id}`, 'GET', undefined, 'bob')).status, 404);
  assert.ok(
    (await request(`/today/briefs/${brief.id}/sources/${brief.sources[0].recordId}`)).body.text.includes(
      'coffee',
    ),
  );
  const memory = (await request('/memories?category=technology')).body.memories[0];
  assert.equal((await request(`/memories/${memory.id}`, 'DELETE', undefined, 'bob')).status, 404);
  assert.equal((await request(`/memories/${memory.id}`, 'DELETE')).status, 200);
  assert.equal((await request('/memories/summary')).body.total, 2);
  const timeline = (await request('/listening/timeline?timeZone=Asia%2FShanghai')).body;
  assert.equal(timeline.days.flatMap((day: any) => day.ids).length, 45);
  const recordId = timeline.days[0].ids[0];
  assert.equal(
    (await request(`/listening/segments?ids=${recordId}`, 'GET', undefined, 'bob')).body.segments.length,
    0,
  );
  assert.equal(
    (await request(`/listening/segments/${recordId}/location`, 'PATCH', { label: 'Android walk' })).body
      .segment.location.label,
    'Android walk',
  );
  assert.equal((await request(`/listening/segments/${recordId}`, 'DELETE')).status, 200);
  assert.equal((await request(`/today/briefs/${brief.id}`)).body.status, 'withdrawn');
  assert.equal((await request(`/today/briefs/${brief.id}`, 'DELETE')).status, 200);
  assert.equal((await request('/today/briefs')).body.briefs.length, 2);
  const catalog = (await request('/connectors')).body.connectors;
  assert.equal(catalog.length, 3);
  const connection = await request('/connectors/gmail/connect', 'POST', {});
  assert.ok((await (await fetch(connection.body.redirectURL)).text()).includes('Synthetic development'));
  await fetch(connection.body.redirectURL, { method: 'POST' });
  assert.equal((await request('/connectors/gmail/refresh', 'POST', {})).body.status, 'connected');
  assert.equal((await request('/connectors/gmail', 'GET', undefined, 'bob')).body.status, 'disconnected');
  assert.equal((await request('/connectors/gmail', 'DELETE')).status, 200);
  const now = Date.now() - 30000;
  const batch = {
    batchId: randomUUID(),
    streamId: randomUUID(),
    sequence: 1,
    sessionId: randomUUID(),
    items: [
      {
        segmentId: randomUUID(),
        startedAt: new Date(now).toISOString(),
        endedAt: new Date(now + 1000).toISOString(),
        mimeType: 'audio/mp4',
        audio: 'AQIDBA==',
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(batch));
  const manifest = {
    batch: { ...batch, items: batch.items.map(({ audio: _, ...item }) => ({ ...item, audioBytes: 4 })) },
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
  };
  const ticket = await request('/listening/uploads', 'POST', manifest);
  assert.equal(ticket.body.status, 'upload');
  assert.equal(
    (
      await fetch(ticket.body.url, {
        method: 'PUT',
        body: bytes,
        headers: { ...ticket.body.headers, Authorization: 'Bearer instant-dev-alice' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(ticket.body.url, { method: 'PUT', body: 'corrupt', headers: ticket.body.headers })).status,
    422,
  );
  assert.equal(
    (await fetch(ticket.body.url, { method: 'PUT', body: bytes, headers: ticket.body.headers })).status,
    200,
  );
  assert.equal((await request('/listening/uploads', 'POST', manifest)).body.status, 'uploaded');
  const receipt = await request(`/listening/uploads/${batch.batchId}/complete`, 'POST', {});
  assert.equal(receipt.status, 202);
  assert.equal(receipt.body.batchId, batch.batchId);
  assert.deepEqual(
    (await request(`/listening/uploads/${batch.batchId}/complete`, 'POST', {})).body,
    receipt.body,
  );
  assert.equal((await request('/listening/uploads', 'POST', manifest)).body.status, 'accepted');
  assert.equal((await request(`/listening/batches/${batch.batchId}`, 'GET', undefined, 'bob')).status, 404);
  const uploaded = (await request('/listening/segments?limit=100')).body.segments.find(
    (row: any) => row.batchId === batch.batchId,
  );
  assert.ok(uploaded);
  assert.equal((await request(`/listening/segments/${uploaded.id}`, 'DELETE')).status, 200);
  assert.equal((await request('/listening/uploads', 'POST', manifest)).status, 410);
  assert.equal((await request(`/listening/uploads/${batch.batchId}/complete`, 'POST', {})).status, 410);
});
