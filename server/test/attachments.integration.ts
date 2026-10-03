import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { RuntimeRepository } from '../src/db/repositories/runtime-repository.js';
import { AttachmentRepository } from '../src/db/repositories/attachment-repository.js';
import { AttachmentService } from '../src/attachments/service.js';
import { attachments, messages } from '../src/db/schema.js';
import { createApiServer } from '../src/http/api-server.js';
import { attachmentSource, type AttachmentManifest } from '../src/attachments/contract.js';
import { hydrateMessages } from '../src/db/repositories/conversation-history.js';
import { ServiceError } from '../src/errors.js';
import { FakeRebyte } from './helpers/fake-rebyte.js';
import { RebyteRepository } from '../src/db/repositories/rebyte-repository.js';
import { RebyteGateway } from '../src/rebyte/gateway.js';
import { RebyteWorker } from '../src/worker/rebyte-worker.js';
import { runtimeSubmissions } from '../src/db/schema.js';
import { setTimeout as delay } from 'node:timers/promises';

const database = createDatabase(process.env.DATABASE_URL!);
after(() => database.close());
const runtime = new RuntimeRepository(database.db);
const repository = new AttachmentRepository(database.db);
const data = new Map<string, Buffer>();
const service = new AttachmentService(repository, {
  async prepare() { return null; },
  async commit(source) {
    const bytes = data.get(source.key);
    if (!bytes) throw new ServiceError(409, 'upload_incomplete', 'Upload is incomplete.');
    assert.equal(bytes.length, source.byteLength);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  },
  async load(source) { const bytes = data.get(source.key); assert.ok(bytes); return bytes; },
  async delete(source) { data.delete(source.key); },
});

test('a lost upload acknowledgement recovers the same Rebyte file before exactly one input is sent', async () => {
  const remote = new FakeRebyte();
  const baseURL = await remote.listen();
  try {
    const backend = new RebyteRepository(database.db, { provider: 'rebyte', agentConfig: {
      provider: 'rebyte', baseURL, model: 'gpt-6-luna', instructions: 'Read the user attachments.', tools: [],
      useSavedAgent: false, environment: { type: 'openai_hosted', network: { access: 'enabled' } },
    } });
    const user = await backend.findOrCreateUser('attachment-test', randomUUID(), 'Attachment retry');
    const bytes = Buffer.from('Stable upload identity'); const file = manifest(bytes);
    await service.prepare(user.id, file); data.set(attachmentSource(user.id, file).key, bytes); await service.complete(user.id, file.id);
    const accepted = await backend.acceptMessage(user.id, { clientMessageId: randomUUID(), text: 'Read this file', attachmentIds: [file.id] });
    const worker = new RebyteWorker(backend, new RebyteGateway({ baseURL, apiKey: 'instant-fake-rebyte-key', model: 'gpt-6-luna' }), {
      leaseMs: 10000, pollIntervalMs: 10, remotePollMs: 10, attachments: service,
    });
    remote.loseNextFileAcknowledgement = true;
    const deadline = Date.now() + 20000;
    let complete = false;
    while (Date.now() < deadline && !complete) {
      await worker.tick(AbortSignal.timeout(10000));
      const [submission] = await database.db.select().from(runtimeSubmissions).where(eq(runtimeSubmissions.id, accepted.submissionId));
      complete = submission!.status === 'completed';
      if (!complete) await delay(200);
    }
    assert.equal(complete, true, JSON.stringify({ errors: remote.errors, requests: remote.requests.map(request => [request.method, request.path]), environments: remote.sessions.map(session => session.environment) }));
    assert.equal(remote.sessions.length, 1);
    assert.equal(remote.sessions[0]!.environment.files.length, 1);
    assert.equal(remote.sessions[0]!.turns.length, 1);
    assert.equal(remote.requests.filter(request => request.method === 'POST' && request.path.includes('/environments/')).length, 1);
    const input = remote.requests.find(request => request.body?.events?.[0]?.type === 'agent.session.input.message')!;
    assert.ok(JSON.stringify(input.body).includes(remote.sessions[0]!.environment.files[0].id));
    assert.ok(JSON.stringify(input.body).includes(file.id));
    assert.deepEqual(remote.errors, []);
  } finally { await remote.close(); }
});
function manifest(bytes: Buffer, name = 'note.txt', mediaType = 'text/plain'): AttachmentManifest {
  return { id: randomUUID(), name, mediaType, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function owned(bytes: Buffer, name = 'note.txt', mediaType = 'text/plain') {
  const user = (await runtime.findUser('alice'))!;
  const file = manifest(bytes, name, mediaType);
  await service.prepare(user.id, file); data.set(attachmentSource(user.id, file).key, bytes);
  await service.complete(user.id, file.id);
  return { user, file };
}

test('owned uploads and attachment-only messages survive retries and provider text clearing', async () => {
  const { user, file } = await owned(Buffer.from('ORBIT 5826'));
  const server = createApiServer(runtime, { attachments: service });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const request = (path: string, token = 'instant-dev-alice', body?: unknown) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const command = { clientMessageId: randomUUID(), text: '', attachmentIds: [file.id] };
    const first = await request('/conversation/messages', undefined, command); assert.equal(first.status, 202);
    const receipt = await first.json();
    assert.deepEqual(await (await request('/conversation/messages', undefined, command)).json(), receipt);
    assert.equal((await request('/conversation/messages', undefined, { ...command, text: 'Changed' })).status, 409);
    assert.equal((await request('/conversation/messages', 'instant-dev-bob', { ...command, clientMessageId: randomUUID() })).status, 404);
    assert.equal((await request(`/files/upload_${file.id}`, 'instant-dev-bob')).status, 404);
    const download = await request(`/files/upload_${file.id}`); assert.equal(download.status, 200); assert.equal(await download.text(), 'ORBIT 5826');
    const pending = manifest(Buffer.from('pending')); await repository.reserve(user.id, pending);
    assert.equal((await request('/conversation/messages', undefined, { ...command, clientMessageId: randomUUID(), attachmentIds: [pending.id] })).status, 404);
    assert.equal((await request('/attachments/prepare', undefined, { ...file, sha256: '0'.repeat(64) })).status, 409);
    await database.db.update(messages).set({ text: '', parts: [] }).where(eq(messages.id, receipt.messageId));
    const [row] = await database.db.select().from(messages).where(eq(messages.id, receipt.messageId));
    const [hydrated] = await hydrateMessages(database.db, undefined, user.id, [row!]);
    assert.equal((hydrated!.parts[0] as { data: { fileId: string } }).data.fileId, `upload_${file.id}`);
    const task = await runtime.createUserTask(user.id, { clientMessageId: randomUUID(), text: '', attachmentIds: [file.id] });
    const conversation = await runtime.getTaskConversation(user.id, task.taskId);
    assert.equal(conversation.messages[0]!.parts[1]?.type, 'data-instant-file');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
