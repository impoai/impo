import { nextTaskOccurrence, parseScheduledTask } from '../server/src/scheduling/contract.js';
/** Local, synthetic Android smoke fixture. No database, model, OAuth or cloud credentials.
 * Uses the production HTTP/SSE adapter; state is intentionally reset on process restart.
 * Run from the root: node --import tsx scripts/android-ui-fixture.ts --port 3011 --public-host 127.0.0.1
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { UIMessageChunk } from 'ai';
import { createApiServer, type ApiRepository, type ApiOptions } from '../server/src/http/api-server.js';
import { ServiceError } from '../server/src/errors.js';
import { parseUploadManifest } from '../server/src/listening/audio-upload.js';
import { parseListeningBatch } from '../server/src/listening/batch-input.js';
import { parseConfirmation } from '../server/src/accounts/contract.js';
import { defaultEchoSchedule, parseEchoSchedule, type EchoSchedule } from '../server/src/echo/schedule.js';
import { TranscriptionError } from '../server/src/listening/transcriber.js';
import { validateTodaySettings } from '../server/src/db/repositories/today-repository.js';
import { isDeviceTool, deviceHash, deviceToolNames } from '../server/src/tools/device-tools.js';
import type { Dictation } from '../server/src/voice/dictation.js';
type Json = Record<string, any>;
const id = (name: string) => {
  const hex = createHash('sha256').update(`android-fixture:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const missing = () => new ServiceError(404, 'not_found', 'Fixture resource not found');
const conflict = () =>
  new ServiceError(409, 'idempotency_conflict', 'Message ID already has different content');
const stamp = '2026-09-30T08:00:00.000Z';
const richText = `Hello Android 👋 — your native client is connected.\n\n## A little room for today\nKeep **one clear priority**, then take a walk.\n\n- Review the morning Brief\n- Try Echo and label a recording\n- Follow up on your task\n\n> Progress can be quiet. 你好，世界。\n\n\`\`\`kotlin\nval greeting = "Hello Android"\n\`\`\`\n\n[Visit Impo](https://impo.ai)\n\n| Plan | Time |\n| --- | --- |\n| Focus | 25 min |\n| Break | 5 min |`;
/** Explicit synthetic payloads for local API/UI tests; these bytes are not real audio. */
export const androidFixtureVoice = Object.freeze({
  transcript: 'Android voice fixture transcript',
  speech: Buffer.from('IMPO_ANDROID_FIXTURE_VOICE').toString('base64'),
  silence: Buffer.from('IMPO_ANDROID_FIXTURE_SILENCE').toString('base64'),
  unavailable: Buffer.from('IMPO_ANDROID_FIXTURE_VOICE_UNAVAILABLE').toString('base64'),
});
export function createAndroidFixture(
  options: {
    publicHost?: string;
    delayMs?: number;
    voiceDelayMs?: number;
    files?: boolean;
  } = {},
) {
  if (process.env.NODE_ENV === 'production') throw new Error('Android fixtures are local development only');
  let port = 3011;
  const pdfObjects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const pdfText = 'BT /F1 20 Tf 40 230 Td (Impo file download verified) Tj ET';
  pdfObjects.push(`<< /Length ${pdfText.length} >>\nstream\n${pdfText}\nendstream`);
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of pdfObjects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const fileBytes = Buffer.from(pdf);
  const filePart = (userId: string) => {
    const fileId = `${id(`${userId}:file-binding`)}_artifact_ui`;
    return { type: 'data-instant-file', id: fileId, data: { schemaVersion: 1, fileId, name: 'Impo download test.pdf', mediaType: 'application/pdf', sizeBytes: fileBytes.length } };
  };
  const publicBase = () => `http://${options.publicHost ?? '127.0.0.1'}:${port}`;
  let serial = 0;
  const users = new Map(['alice', 'bob'].map((subject) => [subject, { id: id(subject), subject }]));
  const conversations = new Map<string, Json>();
  const tasks = new Map<string, Json>();
  const submissions = new Map<string, Json>();
  const keys = new Map<string, Json>();
  const devices = new Map<string, Json>();
  const settings = new Map<string, Json>();
  const profiles = new Map<string, Json>();
  const notificationPreferences = new Map<string, Json>();
  const schedules = new Map<string, Json>();
  const scheduleKeys = new Map<string, string>();
  const echoSchedules = new Map<string, EchoSchedule>();
  const briefs = new Map<string, Json>();
  const memories = new Map<string, Json>();
  const records = new Map<string, Json>();
  const connections = new Map<string, Json>();
  const authorizations = new Map<
    string,
    {
      userId: string;
      toolkit: string;
    }
  >();
  const uploads = new Map<string, Json>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const own = (map: Map<string, Json>, userId: string, key: string) => {
    const row = map.get(key);
    if (!row || row.userId !== userId) throw missing();
    return row;
  };
  const visible = (map: Map<string, Json>, userId: string) =>
    [...map.values()].filter((row) => row.userId === userId && !row.deleted);
  const strip = ({ userId: _, deleted: __, ...row }: Json) => row;
  const main = (userId: string) => own(conversations, userId, id(`${userId}:main`));
  const emit = (run: Json, chunk: UIMessageChunk) =>
    run.events.push({ sequence: run.events.length + 1, chunk });
  const runView = (run: Json) => ({
    submissionId: run.submissionId,
    messageId: run.messageId,
    status: run.status,
    version: run.events.length,
    error: null,
    resultCount: 0,
    cancelRequested: run.status === 'cancelled',
  });
  const finish = (run: Json, status = 'completed') => {
    if (['completed', 'cancelled'].includes(run.status)) return;
    run.status = status;
    const conversation = own(conversations, run.userId, run.conversationId);
    const message = conversation.messages.find((entry: Json) => entry.id === run.messageId);
    message.status = status;
    if (status === 'completed') {
      message.text = richText;
      message.parts = [{ type: 'text', text: richText }];
      emit(run, { type: 'text-start', id: 'text-1' });
      for (const delta of richText.match(/.{1,53}(?:\n|$)?|\n/gs) ?? [richText])
        emit(run, { type: 'text-delta', id: 'text-1', delta });
      emit(run, { type: 'text-end', id: 'text-1' });
    }
    emit(run, {
      type: 'data-instant-submission',
      data: { schemaVersion: 1, submissionId: run.submissionId, status },
    });
    emit(run, { type: 'finish' });
    const task = [...tasks.values()].find((row) => row.conversationId === run.conversationId);
    if (task) {
      task.status = status;
      task.lastRunCompletedAt = new Date().toISOString();
      task.updatedAt = task.lastRunCompletedAt;
    }
  };
  const accept = (userId: string, conversation: Json, input: Json) => {
    if (input.deviceId) own(devices, userId, input.deviceId);
    const key = `${userId}:${input.clientMessageId}`,
      hash = deviceHash({ conversationId: conversation.conversationId, ...input });
    const previous = keys.get(key);
    if (previous) {
      if (previous.hash !== hash) throw conflict();
      return previous.receipt;
    }
    const submissionId = id(`run:${++serial}`),
      userMessageId = id(`user:${serial}`),
      assistantMessageId = id(`assistant:${serial}`),
      createdAt = new Date().toISOString();
    conversation.messages.push({
      id: userMessageId,
      role: 'user',
      sequence: conversation.messages.length + 1,
      text: input.text,
      parts: [{ type: 'text', text: input.text }],
      status: 'completed',
      createdAt,
    });
    conversation.messages.push({
      id: assistantMessageId,
      role: 'assistant',
      sequence: conversation.messages.length + 1,
      text: '',
      parts: [],
      status: 'running',
      createdAt,
    });
    const run = {
      userId,
      submissionId,
      messageId: assistantMessageId,
      conversationId: conversation.conversationId,
      status: 'running',
      events: [],
    };
    submissions.set(submissionId, run);
    emit(run, { type: 'start', messageId: assistantMessageId });
    emit(run, {
      type: 'data-instant-submission',
      data: { schemaVersion: 1, submissionId, status: 'running' },
    });
    const receipt = { messageId: userMessageId, submissionId };
    keys.set(key, { hash, receipt, conversationId: conversation.conversationId });
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        finish(run);
      },
      /slow|cancel/i.test(input.text) ? 15000 : (options.delayMs ?? 600),
    );
    timers.add(timer);
    return receipt;
  };
  const history = (userId: string, conversation: Json, after = 0, limit = 50) => {
    const messages = conversation.messages.filter((m: Json) => m.sequence > after);
    return {
      conversationId: conversation.conversationId,
      messages: messages.slice(0, limit),
      hasMore: messages.length > limit,
      nextAfterSequence: messages.slice(0, limit).at(-1)?.sequence ?? after,
      activeSubmissions: [...submissions.values()]
        .filter(
          (run) =>
            run.userId === userId &&
            run.conversationId === conversation.conversationId &&
            run.status === 'running',
        )
        .map((run) => ({ submissionId: run.submissionId, messageId: run.messageId, status: run.status })),
    };
  };
  for (const user of users.values()) {
    const conversationId = id(`${user.id}:main`);
    conversations.set(conversationId, {
      userId: user.id,
      conversationId,
      messages: [
        {
          id: id(`${user.id}:welcome-user`),
          role: 'user',
          sequence: 1,
          text: 'Help me make room for a good day.',
          parts: [{ type: 'text', text: 'Help me make room for a good day.' }],
          status: 'completed',
          createdAt: stamp,
        },
        {
          id: id(`${user.id}:welcome-answer`),
          role: 'assistant',
          sequence: 2,
          text: richText,
          parts: [{ type: 'text', text: richText }, ...(options.files ? [filePart(user.id)] : [])],
          status: 'completed',
          createdAt: stamp,
        },
      ],
    });
    const taskId = id(`${user.id}:task`),
      taskConversationId = id(`${user.id}:task-conversation`);
    tasks.set(taskId, {
      userId: user.id,
      taskId,
      conversationId: taskConversationId,
      title: 'Plan a quiet weekend',
      status: 'completed',
      createdAt: stamp,
      updatedAt: stamp,
      lastRunStartedAt: stamp,
      lastRunCompletedAt: stamp,
    });
    conversations.set(taskConversationId, {
      userId: user.id,
      conversationId: taskConversationId,
      messages: [
        {
          id: id(`${user.id}:task-answer`),
          role: 'assistant',
          sequence: 1,
          text: 'Start with the bookshop, then take the riverside walk. Leave the afternoon free.',
          parts: [
            {
              type: 'text',
              text: 'Start with the bookshop, then take the riverside walk. Leave the afternoon free.',
            },
            ...(options.files ? [filePart(user.id)] : []),
          ],
          status: 'completed',
          createdAt: stamp,
        },
      ],
    });
    settings.set(user.id, {
      timeZone: 'Asia/Shanghai',
      locale: 'en-US',
      displayName: 'Alex',
      location: { city: 'Shanghai', country: 'China', source: 'manual', capturedAt: stamp },
      slots: [
        { id: 'morning', label: 'Morning Brief', hour: 8, enabled: true },
        { id: 'evening', label: 'Evening Brief', hour: 20, enabled: true },
      ],
    });
    for (let i = 0; i < 45; i++) {
      const startedAt = new Date(
        Date.parse(stamp) - Math.floor(i / 15) * 86400000 - (i % 15) * 120000,
      ).toISOString();
      const endedAt = new Date(Date.parse(startedAt) + 30000).toISOString(),
        recordId = id(`${user.id}:echo:${i}`);
      records.set(recordId, {
        userId: user.id,
        id: recordId,
        clientSegmentId: id(`${recordId}:client`),
        startedAt,
        endedAt,
        status: 'transcribed',
        transcript:
          [
            'Leave a little room this afternoon. Take the long way home and stop for coffee.',
            'Start with the smallest useful version, then ask what we learned.',
            'The quiet bookshop near the station would be lovely this weekend.',
          ][i % 3] + ` [Echo ${i + 1}]`,
        model: 'synthetic-development-fixture',
        error: null,
        location:
          i === 0
            ? {
                label: 'Morning walk',
                source: 'manual',
                spans: [
                  {
                    from: startedAt,
                    to: endedAt,
                    capturedAt: startedAt,
                    accuracyMeters: 80,
                    source: 'device',
                    granularity: 'district',
                    city: 'Shanghai',
                    country: 'China',
                    district: 'Jing’an',
                  },
                ],
              }
            : null,
      });
    }
    for (let i = 0; i < 3; i++) {
      const briefId = id(`${user.id}:brief:${i}`),
        recordId = id(`${user.id}:echo:${i}`),
        localDate = `2026-09-${30 - i}`,
        sourceId = `echo:${recordId}`;
      briefs.set(briefId, {
        userId: user.id,
        id: briefId,
        localDate,
        timeZone: 'Asia/Shanghai',
        kind: 'morning',
        label: 'Morning Brief',
        scheduledAt: stamp,
        createdAt: stamp,
        completedAt: stamp,
        status: 'completed',
        errorCode: null,
        inputCutoff: stamp,
        inputTruncated: false,
        content: {
          title: i === 0 ? 'Make room for a good day' : 'A quieter kind of progress',
          summary: 'A clear priority, a little fresh air, and time for the things that matter.',
          cards: [
            {
              style: 'focus',
              eyebrow: 'YOUR FOCUS',
              title: 'Start with the smallest useful version',
              body: 'You noticed that progress feels better when the next step is clear. Give your most useful idea a little uninterrupted time.',
              bullets: ['Choose one meaningful next step', 'Save room for a short walk'],
              sourceIds: [sourceId],
              links: [],
            },
            {
              style: 'reflection',
              eyebrow: 'FROM ECHO',
              title: 'Take the long way home',
              body: 'A quiet bookshop and a coffee stop could make a lovely end to the day.',
              bullets: [],
              sourceIds: [sourceId],
              links: [],
            },
            {
              style: 'discovery',
              eyebrow: 'EXPLORE',
              title: 'Make something native',
              body: 'A Compose interface can keep the important things close at hand.',
              bullets: [],
              sourceIds: [],
              links: [{ title: 'Impo', url: 'https://impo.ai' }],
            },
          ],
        },
        sources: [
          {
            id: sourceId,
            kind: 'transcript',
            recordId,
            title: 'Morning reflection',
            occurredAt: stamp,
            version: 'fixture-v1',
          },
        ],
      });
    }
    [
      ['Prefers quiet mornings and a short walk before focused work.', ['user_preferences', 'health']],
      ['Enjoys exploring independent bookshops when travelling.', ['hobbies', 'travel']],
      ['Is building a native Android companion in Kotlin.', ['professional_details', 'technology']],
    ].forEach(([content, categories], i) => {
      const memoryId = id(`${user.id}:memory:${i}`);
      memories.set(memoryId, {
        userId: user.id,
        id: memoryId,
        content,
        categories,
        sourceIds: [`echo:${id(`${user.id}:echo:${i}`)}`],
        createdAt: stamp,
        updatedAt: stamp,
        expiresAt: null,
      });
    });
  }
  const paginate = (rows: Json[], limit: number, cursor?: string) => {
    const start = cursor ? rows.findIndex((row) => (row.id ?? row.taskId) === cursor) + 1 : 0;
    const page = rows.slice(start, start + limit);
    return { page, nextCursor: rows.length > start + limit ? page.at(-1)!.id : null };
  };
  const repository = {
    health: async () => {},
    findUser: async (subject: string) => {
      const user = users.get(subject);
      if (!user) throw missing();
      return user;
    },
    findOrCreateUser: async () => {
      throw new Error('Fixture does not accept production authentication');
    },
    acceptMessage: async (userId: string, input: Json) => accept(userId, main(userId), input),
    findUserMessage: async (userId: string, clientMessageId: string) => {
      const accepted = keys.get(`${userId}:${clientMessageId}`);
      if (!accepted) return undefined;
      const conversation = own(conversations, userId, accepted.conversationId);
      const message = conversation.messages.find((row: Json) => row.id === accepted.receipt.messageId && row.role === 'user');
      return message ? { text: message.text } : undefined;
    },
    getConversation: async (userId: string, after: number, limit: number) =>
      history(userId, main(userId), after, limit),
    getSubmission: async (userId: string, runId: string) => runView(own(submissions, userId, runId)),
    cancelSubmission: async (userId: string, runId: string) => {
      const run = own(submissions, userId, runId);
      finish(run, 'cancelled');
      return runView(run);
    },
    readEvents: async (userId: string, runId: string, after: number) => {
      const run = own(submissions, userId, runId);
      return { submission: runView(run), events: run.events.filter((event: Json) => event.sequence > after) };
    },
    listTasks: async (userId: string) => ({ tasks: visible(tasks, userId).reverse().map(strip) }),
    createUserTask: async (userId: string, input: Json) => {
      const taskId = id(`${userId}:task:${input.clientMessageId}`),
        conversationId = id(`${taskId}:conversation`);
      if (!tasks.has(taskId)) {
        tasks.set(taskId, {
          userId,
          taskId,
          conversationId,
          title: input.text,
          status: 'in_progress',
          createdAt: stamp,
          updatedAt: stamp,
          lastRunStartedAt: stamp,
          lastRunCompletedAt: null,
        });
        conversations.set(conversationId, { userId, conversationId, messages: [] });
      }
      return { taskId, conversationId, ...accept(userId, own(conversations, userId, conversationId), input) };
    },
    getTaskConversation: async (userId: string, taskId: string, after: number, limit: number) => {
      const task = own(tasks, userId, taskId);
      return {
        taskId,
        title: task.title,
        ...history(userId, own(conversations, userId, task.conversationId), after, limit),
      };
    },
    acceptTaskMessage: async (userId: string, taskId: string, input: Json) => {
      const task = own(tasks, userId, taskId);
      const receipt = accept(userId, own(conversations, userId, task.conversationId), input);
      task.status = 'in_progress';
      return receipt;
    },
    devices: {
      register: async (userId: string, input: Json) => {
        if (
          input.tools.length > deviceToolNames.length ||
          new Set(input.tools).size !== input.tools.length ||
          input.tools.some((tool: string) => !isDeviceTool(tool))
        )
          throw new ServiceError(400, 'invalid_request', 'Unsupported capabilities');
        const deviceId = id(`${userId}:${input.installationId}`);
        devices.set(deviceId, { userId, deviceId, ...input });
        return { deviceId };
      },
      pending: async (userId: string, deviceId: string) => {
        own(devices, userId, deviceId);
        return { invocations: [] };
      },
      claim: async () => {
        throw missing();
      },
      result: async () => {
        throw missing();
      },
    },
  } as unknown as ApiRepository;
  const connectors = {
    list: async (userId: string) =>
      Promise.all(
        [
          {
            toolkit: 'gmail',
            name: 'Gmail',
            description: 'Synthetic development connection — no real mailbox access.',
            featured: true,
          },
          {
            toolkit: 'notion',
            name: 'Notion',
            description: 'Synthetic development connection — no real workspace access.',
            featured: true,
          },
          {
            toolkit: 'github',
            name: 'GitHub',
            description: 'Synthetic development connection — no real repository access.',
            featured: false,
          },
        ].map(async (item) => ({ ...item, ...(await connectors.getStatus(userId, item.toolkit)) })),
      ),
    getStatus: async (userId: string, toolkit: string) => {
      if (!['gmail', 'notion', 'github'].includes(toolkit)) throw missing();
      return connections.get(`${userId}:${toolkit}`) ?? { status: 'disconnected' };
    },
    connect: async (userId: string, toolkit: string) => {
      await connectors.getStatus(userId, toolkit);
      const token = id(`authorization:${userId}:${toolkit}`),
        expiresAt = new Date(Date.now() + 900000).toISOString();
      connections.set(`${userId}:${toolkit}`, { status: 'pending', expiresAt });
      authorizations.set(token, { userId, toolkit });
      return { redirectURL: `${publicBase()}/fixture/authorize/${token}`, expiresAt };
    },
    refresh: async (userId: string, toolkit: string) => connectors.getStatus(userId, toolkit),
    disconnect: async (userId: string, toolkit: string) => {
      await connectors.getStatus(userId, toolkit);
      connections.delete(`${userId}:${toolkit}`);
      for (const [token, authorization] of authorizations)
        if (authorization.userId === userId && authorization.toolkit === toolkit)
          authorizations.delete(token);
    },
  };
  const dictation: Dictation = {
    model: 'synthetic-android-development-fixture',
    async transcribe(audio, _mimeType, signal) {
      // Preserve the real router's validation, cancellation, silence and provider-error
      // paths. Never decode or send captured audio to an external transcription service.
      await delay(options.voiceDelayMs ?? 700, undefined, { signal });
      if (audio.equals(Buffer.from(androidFixtureVoice.silence, 'base64'))) return '';
      if (audio.equals(Buffer.from(androidFixtureVoice.unavailable, 'base64')))
        throw new TranscriptionError('Synthetic development voice failure', true, 'fixture_unavailable');
      return androidFixtureVoice.transcript;
    },
  };
  const deletionChallenges = new Map<string, { challengeId: string; token: string; expiresAt: string }>();
  const deletionReceipts = new Map<string, Json>();
  const apiOptions = {
    files: options.files ? { open: async (userId: string, fileId: string) => {
      const file = filePart(userId).data;
      if (fileId !== file.fileId) throw new ServiceError(404, 'not_found', 'File not found');
      return { name: file.name, mediaType: file.mediaType, sizeBytes: file.sizeBytes, body: new Response(fileBytes).body! };
    } } : undefined,
    accountDeletionEnabled: true,
    accounts: {
      closedIdentity: async (_provider: string, subject: string) => {
        const user = users.get(subject);
        return user && deletionReceipts.has(user.id) ? { userId: user.id } : undefined;
      },
      prepare: async (userId: string) => {
        const challenge = { challengeId: randomUUID(), token: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 300_000).toISOString() };
        deletionChallenges.set(userId, challenge); return challenge;
      },
      confirm: async (userId: string, input: unknown) => {
        const value = parseConfirmation(input), challenge = deletionChallenges.get(userId);
        if (!challenge || value.challengeId !== challenge.challengeId || value.token !== challenge.token) throw new ServiceError(400, 'deletion_confirmation_required', 'Confirm the warning first.');
        const receipt = deletionReceipts.get(userId) ?? { requestId: challenge.challengeId, receiptToken: challenge.token, status: 'deleting', requestedAt: new Date().toISOString(), appleManualRevocationRequired: false };
        deletionReceipts.set(userId, receipt); return receipt;
      },
      status: async (requestId: string, token: string) => {
        const receipt = [...deletionReceipts.values()].find(r => r.requestId === requestId && r.receiptToken === token);
        if (!receipt) throw missing(); return receipt;
      },
    },
    scheduledTasks: {
      list: async (userId: string) => ({ schedules: visible(schedules, userId).map(strip) }),
      get: async (userId: string, id: string) => { const row = own(schedules, userId, id); if (row.deleted) throw missing(); return strip(row); },
      create: async (userId: string, key: string, value: Json) => {
        const input = parseScheduledTask(value), existing = scheduleKeys.get(`${userId}:${key}`);
        if (existing) return apiOptions.scheduledTasks.get(userId, existing);
        const row = { id: randomUUID(), userId, ...input, revision: randomUUID(), nextRunAt: input.enabled ? nextTaskOccurrence(input.schedule, new Date())?.toISOString() ?? null : null, createdAt: stamp, updatedAt: stamp };
        schedules.set(row.id, row); scheduleKeys.set(`${userId}:${key}`, row.id); return strip(row);
      },
      update: async (userId: string, id: string, revision: string, value: Json) => {
        const previous = own(schedules, userId, id); if (previous.deleted) throw missing();
        if (previous.revision !== revision) throw new ServiceError(409, 'schedule_changed', 'Reload your schedule.');
        const input = parseScheduledTask(value), row = { ...previous, ...input, revision: randomUUID(), nextRunAt: input.enabled ? nextTaskOccurrence(input.schedule, new Date())?.toISOString() ?? null : null, updatedAt: new Date().toISOString() };
        schedules.set(id, row); return strip(row);
      },
      remove: async (userId: string, id: string, revision: string) => {
        const row = own(schedules, userId, id); if (row.revision !== revision) throw new ServiceError(409, 'schedule_changed', 'Reload your schedule.');
        row.deleted = true; return { deleted: true };
      },
      runs: async (userId: string, id: string) => { await apiOptions.scheduledTasks.get(userId, id); return { runs: [], nextCursor: null }; },
    },
    echoSchedules: {
      get: async (userId: string) => echoSchedules.get(userId) ?? defaultEchoSchedule(),
      save: async (userId: string, value: unknown) => {
        const next = parseEchoSchedule(value), previous = echoSchedules.get(userId) ?? defaultEchoSchedule();
        if (next.revision !== previous.revision) throw new ServiceError(409, 'echo_schedule_changed', 'Reload your schedule.');
        const saved = { ...next, revision: randomUUID() }; echoSchedules.set(userId, saved); return saved;
      },
    },
    notifications: {
      settings: async (userId: string) => ({ chat: true, tasks: true, scheduledTasks: true, brief: true, echo: true, ...notificationPreferences.get(userId) }),
      updateSettings: async (userId: string, patch: Json) => {
        const saved = { chat: true, tasks: true, scheduledTasks: true, brief: true, echo: true, ...notificationPreferences.get(userId), ...patch };
        notificationPreferences.set(userId, saved); return saved;
      },
      register: async (_userId: string, _id: string, input: { registrationId: string }) => ({ registrationId: input.registrationId }),
      revoke: async () => ({ revoked: true }),
    },
    auth: { mode: 'local-dev' },
    pollIntervalMs: 30,
    streamKeepAliveMs: 500,
    connectors,
    dictation,
    profiles: {
      get: async (userId: string): Promise<Json> => ({
        onboarded: main(userId).messages.some((message: Json) => message.role === 'user'),
        ...profiles.get(userId),
        ...(settings.get(userId)?.displayName ? { displayName: settings.get(userId)!.displayName } : {}),
      }),
      update: async (userId: string, input: Json): Promise<Json> => {
        const invalid = () => new ServiceError(400, 'invalid_request', 'Invalid profile update');
        if (Object.keys(input).some(key => !['assistantName', 'avatarIndex', 'onboarded'].includes(key))) throw invalid();
        if (input.assistantName !== undefined && (typeof input.assistantName !== 'string' || !input.assistantName.trim() || input.assistantName.trim().length > 30 || input.assistantName.includes('\0'))) throw invalid();
        if (input.avatarIndex !== undefined && (!Number.isInteger(input.avatarIndex) || input.avatarIndex < 0 || input.avatarIndex > 6)) throw invalid();
        if (input.onboarded !== undefined && input.onboarded !== true) throw invalid();
        profiles.set(userId, { ...profiles.get(userId), ...input,
          ...(input.assistantName !== undefined ? { assistantName: input.assistantName.trim() } : {}),
        });
        return apiOptions.profiles.get(userId);
      },
    },
    today: {
      settings: async (userId: string) => settings.get(userId),
      configure: async (userId: string, value: Json) => {
        const validated = validateTodaySettings(value);
        const next = {
          ...settings.get(userId),
          ...validated,
          slots: validated.slots ?? settings.get(userId)!.slots,
        };
        settings.set(userId, next);
        return next;
      },
      list: async (userId: string, limit: number, cursor?: string, date?: string) => {
        const { page, nextCursor } = paginate(
          visible(briefs, userId).filter((row) => !date || row.localDate === date),
          limit,
          cursor,
        );
        return { briefs: page.map(strip), nextCursor };
      },
      owned: async (userId: string, briefId: string) => {
        const row = own(briefs, userId, briefId);
        if (row.deleted) throw missing();
        return row;
      },
      view: async (row: Json) => strip(row),
      currentSource: async (userId: string, source: Json) => {
        const record = records.get(source.recordId);
        return record?.userId === userId && !record.deleted
          ? { ...source, text: record.transcript, location: record.location }
          : undefined;
      },
      delete: async (userId: string, briefId: string) => {
        own(briefs, userId, briefId).deleted = true;
      },
    },
    memories: {
      summary: async (userId: string) => {
        const rows = visible(memories, userId),
          categories: Record<string, number> = {};
        for (const row of rows)
          for (const category of row.categories) categories[category] = (categories[category] ?? 0) + 1;
        return { total: rows.length, categories };
      },
      page: async (userId: string, query: Json) => {
        const { page, nextCursor } = paginate(
          visible(memories, userId).filter(
            (row) => !query.category || row.categories.includes(query.category),
          ),
          query.limit,
          query.cursor,
        );
        return { memories: page.map(strip), nextCursor };
      },
      forget: async (userId: string, memoryId: string) => {
        const row = memories.get(memoryId);
        if (!row || row.userId !== userId || row.deleted) return false;
        row.deleted = true;
        return true;
      },
    },
    listeningEnabled: true,
    listening: {
      timeline: async (userId: string, timeZone: string) => {
        const days = new Map<string, string[]>();
        for (const row of visible(records, userId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
          const date = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(new Date(row.startedAt));
          days.set(date, [...(days.get(date) ?? []), row.id]);
        }
        return { timeZone, days: [...days].map(([date, ids]) => ({ date, ids })) };
      },
      calendar: async (userId: string, timeZone: string) => {
        const timeline = await apiOptions.listening.timeline(userId, timeZone);
        return { timeZone, days: timeline.days.map((day) => ({ date: day.date, count: day.ids.length })) };
      },
      records: async (userId: string, ids: string[]) => ({
        segments: visible(records, userId)
          .filter((row) => ids.includes(row.id))
          .map(strip),
      }),
      history: async (userId: string, limit: number, cursor?: string, before?: Date, direction = 'older') => {
        let rows = visible(records, userId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        if (before) rows = rows.filter((row) => Date.parse(row.startedAt) < before.getTime());
        if (direction === 'newer')
          rows = rows
            .slice(
              0,
              rows.findIndex((row) => row.id === cursor),
            )
            .reverse();
        const { page, nextCursor } = paginate(rows, limit, direction === 'older' ? cursor : undefined);
        return { segments: page.map(strip), nextCursor, previousCursor: null };
      },
      list: async (userId: string, from: Date, to: Date) => ({
        segments: visible(records, userId)
          .filter(
            (row) => Date.parse(row.startedAt) >= from.getTime() && Date.parse(row.startedAt) < to.getTime(),
          )
          .map(strip),
      }),
      labelLocation: async (userId: string, recordId: string, label: unknown) => {
        if (
          label !== null &&
          (typeof label !== 'string' || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label))
        )
          throw new ServiceError(400, 'invalid_request', 'Invalid location label');
        const row = own(records, userId, recordId);
        if (row.deleted) throw missing();
        row.location = {
          ...(row.location ?? { spans: [] }),
          label: typeof label === 'string' ? label.trim() || undefined : undefined,
          source: 'manual',
        };
        return { segment: strip(row) };
      },
      delete: async (userId: string, recordId: string) => {
        const record = own(records, userId, recordId);
        record.deleted = true;
        if (record.batchId) {
          const upload = uploads.get(`${userId}:${record.batchId}`);
          if (upload) {
            upload.status = 'deleted';
            delete upload.bytes;
          }
        }
        for (const brief of visible(briefs, userId))
          if (brief.sources.some((source: Json) => source.recordId === recordId)) {
            brief.status = 'withdrawn';
            brief.content = null;
          }
      },
    },
    uploads: {
      prepare: async (userId: string, raw: Json) => {
        const parsed = parseUploadManifest(raw, userId),
          key = `${userId}:${parsed.batchId}`,
          prior = uploads.get(key);
        if (prior?.status === 'deleted')
          throw new ServiceError(410, 'batch_deleted', 'This batch was deleted.');
        if (prior && deviceHash(prior.manifest) !== deviceHash(raw))
          throw new ServiceError(409, 'batch_conflict', 'Fixture batch changed');
        const row = prior ?? {
          userId,
          batchId: parsed.batchId,
          manifest: raw,
          parsed,
          token: id(`upload:${key}:${raw.sha256}`),
          status: 'pending',
          attempts: 0,
          updatedAt: stamp,
        };
        uploads.set(key, row);
        if (row.status === 'transcribed') return { status: 'accepted', receipt: row.receipt };
        if (row.bytes) return { status: 'uploaded' };
        return {
          status: 'upload',
          url: `${publicBase()}/fixture/uploads/${row.token}`,
          headers: {
            'Content-Type': 'application/json',
            'x-amz-checksum-sha256': Buffer.from(raw.sha256, 'hex').toString('base64'),
          },
          expiresAt: new Date(Date.now() + 900000).toISOString(),
        };
      },
      complete: async (userId: string, batchId: string) => {
        const row = uploads.get(`${userId}:${batchId}`);
        if (!row) throw missing();
        if (row.status === 'deleted') throw new ServiceError(410, 'batch_deleted', 'This batch was deleted.');
        if (row.receipt) return row.receipt;
        if (!row.bytes) throw new ServiceError(409, 'upload_incomplete', 'Upload the sealed JSON first');
        const batch = parseListeningBatch(JSON.parse(row.bytes.toString('utf8')), userId);
        const expected = row.manifest.batch;
        const manifest = {
          ...batch,
          items: batch.items.map(({ audio, ...item }) => ({
            ...item,
            audioBytes: Buffer.from(audio, 'base64').length,
          })),
        };
        if (
          deviceHash({ ...manifest, userId: undefined, contentHash: undefined }) !==
          deviceHash({ ...expected, userId: undefined, contentHash: undefined })
        )
          throw new ServiceError(409, 'batch_conflict', 'Metadata does not match uploaded bytes');
        const recordId = id(`uploaded:${userId}:${batchId}`);
        records.set(recordId, {
          userId,
          id: recordId,
          clientSegmentId: batch.items[0]!.segmentId,
          batchId,
          startedAt: batch.items[0]!.startedAt,
          endedAt: batch.items.at(-1)!.endedAt,
          status: 'transcribed',
          transcript:
            'Synthetic Echo upload received. This fixture verifies transport and does not transcribe real speech.',
          model: 'synthetic-development-fixture',
          error: null,
          segmentCount: batch.items.length,
          audioMilliseconds: batch.items.reduce(
            (total, item) => total + Date.parse(item.endedAt) - Date.parse(item.startedAt),
            0,
          ),
          location: null,
        });
        row.status = 'transcribed';
        row.receipt = { batchId, streamId: batch.streamId, sequence: batch.sequence, status: 'accepted' };
        return row.receipt;
      },
    },
    batches: {
      receipt: async (userId: string, batchId: string) => {
        const row = uploads.get(`${userId}:${batchId}`);
        return row ? { ...row, sequence: row.parsed.sequence, error: null } : undefined;
      },
    },
  };
  const server = createApiServer(repository, apiOptions as unknown as ApiOptions);
  const handler = server.listeners('request')[0]!;
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    const authorization = /^\/fixture\/authorize\/([^/]+)$/.exec(path),
      upload = /^\/fixture\/uploads\/([^/]+)$/.exec(path);
    if (authorization) {
      const auth = authorizations.get(authorization[1]!);
      if (!auth) {
        res.writeHead(404).end('Unknown development authorization');
        return;
      }
      if (req.method === 'POST') {
        connections.set(`${auth.userId}:${auth.toolkit}`, {
          status: 'connected',
          email: 'android-fixture@example.test',
        });
        authorizations.delete(authorization[1]!);
        res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(
            '<h1>Development connection ready</h1><p>Return to Impo and refresh. No external account was accessed.</p>',
          );
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(
          '<h1>Synthetic development authorization</h1><p>No real account or credentials are used.</p><form method="post"><button>Connect development account</button></form>',
        );
      return;
    }
    if (upload && req.method === 'PUT') {
      const row = [...uploads.values()].find((entry) => entry.token === upload[1]);
      if (!row || row.status === 'deleted' || req.headers.authorization) {
        res.writeHead(403).end();
        return;
      }
      void (async () => {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 1500000) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        if (
          bytes.length !== row.manifest.byteLength ||
          createHash('sha256').update(bytes).digest('hex') !== row.manifest.sha256
        ) {
          res.writeHead(422).end();
          return;
        }
        row.bytes = bytes;
        res.writeHead(200).end();
      })().catch(() => {
        if (!res.headersSent) res.writeHead(400);
        res.end();
      });
      return;
    }
    handler.call(server, req, res);
  });
  server.once('listening', () => {
    port = (server.address() as AddressInfo).port;
  });
  server.once('close', () => {
    for (const timer of timers) clearTimeout(timer);
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argument = (name: string) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  const port = Number(argument('--port') ?? '3011'),
    publicHost = argument('--public-host') ?? '127.0.0.1';
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    !['127.0.0.1', 'localhost', '10.0.2.2'].includes(publicHost)
  )
    throw new Error('Use a local port and loopback/emulator public host');
  const server = createAndroidFixture({ publicHost, files: process.argv.includes('--files') });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  console.log(
    JSON.stringify({
      event: 'android_fixture_ready',
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      auth: 'instant-dev-alice',
      synthetic: true,
    }),
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      server.closeAllConnections();
      server.close();
    });
}
