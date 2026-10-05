import { attachmentIds, attachmentTypes, maxAttachmentBytes, maxAttachments } from '../attachments/contract.js';
import { catalogProfile, readCatalog } from '../commerce/catalog.js';
import type { AttachmentService } from '../attachments/service.js';
import type { ScheduledTaskRepository } from '../db/repositories/scheduled-task-repository.js';
import { parseScheduledTask } from '../scheduling/contract.js';
import { ListeningBatchRepository } from '../db/repositories/listening-batch-repository.js';
import type { ListeningUploadService } from '../listening/audio-upload.js';
import type { TodayRepository } from '../db/repositories/today-repository.js';
import type { MemoryStore } from '../memory/store.js';
import { memoryCategories, type MemoryCategory } from '../memory/contract.js';
import type { ListeningBatchService } from '../listening/temporal/client.js';
import { parseListeningBatch } from '../listening/batch-input.js';
import { maxBatchBytes } from '../listening/batch-contract.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { setTimeout as delay } from 'node:timers/promises';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageChunk } from 'ai';
import { verifyToken } from '@clerk/backend';
import { ServiceError } from '../errors.js';
import { boundedFileBytes, contentDisposition, type FileDownloads } from '../rebyte/files.js';
import type { RuntimeRepository } from '../db/repositories/runtime-repository.js';
import { clientContext } from '../tools/device-tools.js';
import type { ConnectorAPI } from '../composio/connector-service.js';
import type { ProfileRepository } from '../db/repositories/profile-repository.js';
import { ListeningRepository, maxAudioBytes } from '../db/repositories/listening-repository.js';
import { integerQuery, onlyFields, readBody, readJSON, requiredString, sendJSON, uuid } from './request.js';
import { dictationAudio, maxDictationBytes, transcribeRequest, type Dictation } from '../voice/dictation.js';
import type { NotificationRepository } from '../db/repositories/notification-repository.js';
import { registrationInput, settingsInput, type Registration, type Revocation } from '../notifications/contract.js';
import type { AccountDeletionRepository } from '../db/repositories/account-deletion-repository.js';
import type { EchoScheduleRepository } from '../db/repositories/echo-schedule-repository.js';

export type ApiRepository = Pick<RuntimeRepository,
  'health' | 'findUser' | 'findOrCreateUser' | 'acceptMessage' | 'getConversation' | 'getSubmission' | 'cancelSubmission' | 'readEvents'>
  & Partial<Pick<RuntimeRepository, 'devices' | 'listTasks' | 'createUserTask' | 'getTaskConversation' | 'acceptTaskMessage' | 'findUserMessage' | 'productSelection'>>;

export interface ApiOptions {
  attachments?: AttachmentService;
  scheduledTasks?: Pick<ScheduledTaskRepository, 'list' | 'get' | 'create' | 'update' | 'remove' | 'runs'>;
  echoSchedules?: Pick<EchoScheduleRepository, 'get' | 'save'>;
  accounts?: Pick<AccountDeletionRepository, 'closedIdentity' | 'status' | 'prepare' | 'confirm'>;
  accountDeletionEnabled?: boolean;
  notifications?: Pick<NotificationRepository, 'settings' | 'updateSettings' | 'register' | 'revoke'>;
  today?: TodayRepository;
  /** Read and forget the user's long-term memories; the hourly pipeline is the only writer. */
  memories?: MemoryStore;
  connectors?: ConnectorAPI;
  profiles?: Pick<ProfileRepository, 'get' | 'update'>;
  listening?: ListeningRepository;
  listeningEnabled?: boolean;
  batches?: ListeningBatchRepository;
  batchService?: ListeningBatchService;
  uploads?: ListeningUploadService;
  /** Hold-to-talk speech to text for the composer. */
  dictation?: Dictation;
  /** Files delivered by Agent replies, streamed from Rebyte. */
  files?: Pick<FileDownloads, 'open'>;
  runtime?: 'development' | 'rebyte';
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  /** Idle interval before an SSE keepalive comment; must stay below proxy idle timeouts. */
  streamKeepAliveMs?: number;
  /** local-dev is the fixed fixture identity; clerk verifies a real Bearer session token. */
  auth?: { mode: 'local-dev' } | { mode: 'clerk'; secretKey: string };
  /** Lets the gadget gateway act for the account a gadget is paired to, on chat routes only. */
  gadgetGateway?: { serviceToken: string };
}

function messageInput(data: Record<string, unknown>, maxLength: number) {
  const ids = attachmentIds(data.attachmentIds);
  const text = data.text === undefined && ids.length ? '' : data.text;
  if (typeof text !== 'string' || text.includes('\0') || text.length > maxLength || (!text.trim() && !ids.length)) throw new ServiceError(400, 'invalid_request', 'Enter a message or attach a file.');
  return { text, ...(ids.length ? { attachmentIds: ids } : {}) };
}

/** Base64 audio plus a few small fields. */
const voiceBodyBytes = Math.ceil(maxDictationBytes / 3) * 4 + 16 * 1024;

/** Aborts provider work when the client goes away before the response is written. */
function requestSignal(res: ServerResponse): AbortSignal {
  // IncomingMessage also emits 'close' once its body is read; only the response's close means the client left.
  const controller = new AbortController();
  res.once('close', () => { if (!res.writableFinished) controller.abort(); });
  return controller.signal;
}

const terminal = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);

/** Local-development HTTP adapter. Entry-point configuration gates development identities. */
export function createApiServer(repository: ApiRepository, options: ApiOptions = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const streamKeepAliveMs = options.streamKeepAliveMs ?? 15_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60_000) {
    throw new Error('Invalid API poll interval');
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
    throw new Error('Invalid API request timeout');
  }
  // Connection metrics only: durable execution and deduplication always live in PostgreSQL.
  const subscriberCounts = new Map<string, number>();

  const server = createServer((req, res) => {
    const requestId = randomUUID();
    const started = Date.now();
    // Record only route templates: never query values, user content, or credentials.
    const requestPath = (req.url ?? '').split('?')[0]!.replace(/^\/instant(?=\/)/, '');
    const area = requestPath.startsWith('/api/v1/today/') ? 'today' : requestPath.startsWith('/api/v1/listening/') ? 'listening' : requestPath.startsWith('/api/v1/memories') ? 'memories' : undefined;
    const routeName = area === 'memories' ? (requestPath === '/api/v1/memories' ? 'list' : requestPath === '/api/v1/memories/summary' ? 'summary' : 'memory')
      : area === 'today'
      ? requestPath === '/api/v1/today/settings' ? 'settings'
        : requestPath === '/api/v1/today/briefs' ? 'briefs'
          : /^\/api\/v1\/today\/briefs\/[^/]+\/sources\/[^/]+$/.test(requestPath) ? 'source'
            : /^\/api\/v1\/today\/briefs\/[^/]+$/.test(requestPath) ? 'brief' : 'unknown'
      : undefined;
    if (area) res.once('finish', () => console.log(JSON.stringify({event:`${area}.http`,at:new Date().toISOString(),requestId,route:routeName,method:req.method,status:res.statusCode,ms:Date.now()-started})));
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    void route(req, res).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const safe = error instanceof ServiceError ? error : new ServiceError(500, 'internal_error', 'Impo server error', true);
      if (area) console.log(JSON.stringify({event:`${area}.request_failed`,at:new Date().toISOString(),requestId,route:routeName,code:safe.code,status:safe.status,
        ...(safe.code === 'request_timeout' ? {receivedBytes:(safe as ServiceError & {receivedBytes?:number}).receivedBytes} : {})}));
      if (safe.status === 429) res.setHeader('Retry-After', '30');
      // Do not keep a socket open with a rejected, incomplete request body.
      if (!req.complete) res.setHeader('Connection', 'close');
      sendJSON(res, safe.status, { error: { code: safe.code, message: safe.message, retryable: safe.retryable }, requestId });
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = requestTimeoutMs + 5_000;
  server.keepAliveTimeout = 5_000;
  const auth = options.auth ?? { mode: 'local-dev' as const };

  /** local-dev matches a fixed fixture header; clerk verifies a real Bearer session token. */
  async function authenticate(req: IncomingMessage, allowDeleted = false): Promise<{ id: string }> {
    const header = req.headers.authorization;
    if (auth.mode === 'local-dev') {
      const subject = header === 'Bearer instant-dev-alice' ? 'alice' : header === 'Bearer instant-dev-bob' ? 'bob' : undefined;
      if (!subject) throw new ServiceError(401, 'unauthorized', 'Local development identity required');
      const deleted = await options.accounts?.closedIdentity('local-dev', subject);
      if (deleted) {
        if (allowDeleted) return { id: deleted.userId };
        throw new ServiceError(410, 'account_deleted', 'This account has been deleted.');
      }
      return repository.findUser(subject);
    }
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) { throw new ServiceError(401, 'unauthorized', 'A session token is required'); }
    let claims;
    try { claims = await verifyToken(token, { secretKey: auth.secretKey }); }
    catch (error) { throw new ServiceError(401, 'unauthorized', 'Invalid or expired session token'); }
    const deleted = await options.accounts?.closedIdentity('clerk', claims.sub);
    if (deleted) {
      if (allowDeleted) return { id: deleted.userId };
      throw new ServiceError(410, 'account_deleted', 'This account has been deleted.');
    }
    return repository.findOrCreateUser('clerk', claims.sub, 'Impo user');
  }

  /**
   * The gadget gateway vouches for the account subject a gadget is paired to. It may
   * only post chat and voice messages and read their submissions; every other route
   * still requires the user's own session.
   */
  async function gadgetGatewayUser(req: IncomingMessage, path: string, method: string): Promise<{ id: string } | undefined> {
    const subject = req.headers['x-impo-gadget-subject'];
    if (subject === undefined) return undefined;
    const presented = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice('Bearer '.length) : '';
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!options.gadgetGateway || !presented || !timingSafeEqual(digest(presented), digest(options.gadgetGateway.serviceToken))) {
      throw new ServiceError(401, 'unauthorized', 'Gadget gateway credential required');
    }
    const allowed = (method === 'POST' && ['/api/v1/conversation/messages', '/api/v1/conversation/voice-messages'].includes(path))
      || (method === 'GET' && /^\/api\/v1\/submissions\/[^/]+(?:\/stream)?$/.test(path));
    if (!allowed) throw new ServiceError(403, 'forbidden', 'The gadget gateway cannot use this route');
    if (typeof subject !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(subject)) throw new ServiceError(400, 'invalid_request', 'Invalid gadget subject');
    if (auth.mode === 'local-dev') {
      if (subject !== 'alice' && subject !== 'bob') throw new ServiceError(401, 'unauthorized', 'Local development identity required');
      return repository.findUser(subject);
    }
    if (await options.accounts?.closedIdentity('clerk', subject)) throw new ServiceError(410, 'account_deleted', 'This account has been deleted.');
    return repository.findOrCreateUser('clerk', subject, 'Impo user');
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
    catch { throw new ServiceError(400, 'invalid_request', 'Invalid request URL'); }
    // The ALB forwards /instant/* without stripping the prefix (path-based
    // routing shares the existing port-443 listener/cert with other services
    // on the same load balancer; a dedicated port was blocked on some networks).
    if (url.pathname === '/instant') url.pathname = '/';
    else if (url.pathname.startsWith('/instant/')) url.pathname = url.pathname.slice('/instant'.length);
    const method = req.method;
    if (url.pathname === '/.well-known/ucp' && method === 'GET') {
      // UCP discovery requires a cacheable public profile; user product responses remain private.
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      res.end(JSON.stringify(catalogProfile)); return;
    }
    if (url.pathname === '/health' && method === 'GET') {
      sendJSON(res, 200, { status: 'ok', mode: 'development', runtime: options.runtime === 'rebyte' ? 'rebyte' : 'deterministic' }); return;
    }
    if (url.pathname === '/ready' && method === 'GET') {
      try { await repository.health(); }
      catch { throw new ServiceError(503, 'database_unavailable', 'Database is unavailable', true); }
      sendJSON(res, 200, { status: 'ready' }); return;
    }
    const path = url.pathname;
    const receiptPath = path.match(/^\/api\/v1\/account\/deletions\/([0-9a-f-]{36})$/i);
    if (receiptPath && method === 'GET' && options.accounts) {
      if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      sendJSON(res, 200, await options.accounts.status(uuid(receiptPath[1]), token)); return;
    }
    const user = await gadgetGatewayUser(req, path, method ?? '') ?? await authenticate(req, path === '/api/v1/account' && method === 'DELETE');
    const productsPath = /^\/api\/v1\/messages\/([^/]+)\/products$/.exec(path);
    if (productsPath && method === 'GET') {
      if (!repository.productSelection) throw new ServiceError(503, 'catalog_unavailable', 'Product information is temporarily unavailable.', true);
      if ([...url.searchParams.keys()].some(key => !['selectionId', 'productId'].includes(key))) throw new ServiceError(400, 'invalid_request', 'Unsupported product parameter');
      const selectionId = url.searchParams.get('selectionId');
      if (!selectionId || !/^[A-Za-z0-9_-]{1,200}$/.test(selectionId)) throw new ServiceError(400, 'invalid_request', 'A product selection is required');
      const signal = requestSignal(res);
      const selection = await repository.productSelection(user.id, uuid(productsPath[1]), selectionId, signal);
      res.setHeader('Cache-Control', 'no-store');
      sendJSON(res, 200, await readCatalog(selection, url.searchParams.get('productId') ?? undefined, signal)); return;
    }
    if (path === '/api/v1/account/deletion-challenge' || path === '/api/v1/account') {
      if (!options.accounts || !options.accountDeletionEnabled) throw new ServiceError(503, 'account_deletion_unavailable', 'Account deletion is temporarily unavailable. Please try again.', true);
      if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
      if (path.endsWith('/deletion-challenge') && method === 'POST') {
        onlyFields(await readJSON(req, requestTimeoutMs), []);
        sendJSON(res, 200, await options.accounts.prepare(user.id)); return;
      }
      if (path === '/api/v1/account' && method === 'DELETE') {
        sendJSON(res, 202, await options.accounts.confirm(user.id, await readJSON(req, requestTimeoutMs))); return;
      }
      throw new ServiceError(404, 'not_found', 'Account route not found');
    }
    const schedulePath = /^\/api\/v1\/scheduled-tasks(?:\/([^/]+)(\/runs)?)?$/.exec(path);
    if (schedulePath) {
      if (!options.scheduledTasks) throw new ServiceError(503, 'schedules_unavailable', 'Scheduled tasks are temporarily unavailable.', true);
      const id = schedulePath[1] ? uuid(schedulePath[1]) : undefined;
      if (schedulePath[2] && id && method === 'GET') {
        if ([...url.searchParams.keys()].some(key => key !== 'before')) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
        sendJSON(res, 200, await options.scheduledTasks.runs(user.id, id, url.searchParams.get('before') ?? undefined)); return;
      }
      if (url.search || schedulePath[2]) throw new ServiceError(400, 'invalid_request', 'Unsupported schedule request');
      if (method === 'GET') { sendJSON(res, 200, id ? await options.scheduledTasks.get(user.id, id) : await options.scheduledTasks.list(user.id)); return; }
      if (!id && method === 'POST') {
        const input = await readJSON(req, requestTimeoutMs);
        onlyFields(input, ['clientRequestId', 'title', 'goal', 'schedule', 'enabled']);
        sendJSON(res, 201, await options.scheduledTasks.create(user.id, uuid(requiredString(input, 'clientRequestId', 36)), parseScheduledTask(input))); return;
      }
      if (id && method === 'PUT') {
        const input = await readJSON(req, requestTimeoutMs);
        onlyFields(input, ['revision', 'title', 'goal', 'schedule', 'enabled']);
        sendJSON(res, 200, await options.scheduledTasks.update(user.id, id, uuid(requiredString(input, 'revision', 36)), parseScheduledTask(input))); return;
      }
      if (id && method === 'DELETE') {
        const input = await readJSON(req, requestTimeoutMs); onlyFields(input, ['revision']);
        sendJSON(res, 200, await options.scheduledTasks.remove(user.id, id, uuid(requiredString(input, 'revision', 36)))); return;
      }
      throw new ServiceError(405, 'method_not_allowed', 'Unsupported schedule operation');
    }
    if (path === '/api/v1/echo/schedule') {
      if (!options.echoSchedules) throw new ServiceError(503, 'echo_schedule_unavailable', 'Echo schedules are not configured.', true);
      if (method === 'GET') { sendJSON(res, 200, await options.echoSchedules.get(user.id)); return; }
      if (method === 'PUT') { sendJSON(res, 200, await options.echoSchedules.save(user.id, await readJSON(req, requestTimeoutMs))); return; }
      throw new ServiceError(405, 'method_not_allowed', 'Use GET or PUT for Echo schedules.');
    }
    if (path.startsWith('/api/v1/notifications/')) {
      if (!options.notifications) throw new ServiceError(503, 'notifications_unavailable', 'Notifications are not configured', true);
      if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
      if (path === '/api/v1/notifications/settings') {
        if (method === 'GET') { sendJSON(res, 200, await options.notifications.settings(user.id)); return; }
        if (method === 'PATCH') { sendJSON(res, 200, await options.notifications.updateSettings(user.id, settingsInput(await readJSON(req, requestTimeoutMs)))); return; }
      }
      const installation = /^\/api\/v1\/notifications\/installations\/([^/]+)$/.exec(path);
      if (installation && (method === 'PUT' || method === 'DELETE')) {
        const id = uuid(installation[1]);
        const input = registrationInput(await readJSON(req, requestTimeoutMs), method === 'DELETE');
        sendJSON(res, 200, method === 'PUT' ? await options.notifications.register(user.id, id, input as Registration) : await options.notifications.revoke(user.id, id, input as Revocation)); return;
      }
      throw new ServiceError(404, 'not_found', 'Notification route not found');
    }
    if (path === '/api/v1/profile') {
      if (!options.profiles) throw new ServiceError(503, 'profile_unavailable', 'Profile is temporarily unavailable', true);
      if (url.search) throw new ServiceError(400, 'invalid_request', 'Profile does not accept query parameters');
      const catalogCurrent = req.headers['x-impo-model-catalog'] === '2';
      const profileView = (profile: Awaited<ReturnType<typeof options.profiles.get>>) => {
        if (catalogCurrent) return profile;
        const { mode: _, ...legacy } = profile; return legacy;
      };
      if (method === 'GET') { sendJSON(res, 200, profileView(await options.profiles.get(user.id))); return; }
      if (method === 'PATCH') {
        const body = await readJSON(req, requestTimeoutMs);
        if (body.mode !== undefined && !catalogCurrent) throw new ServiceError(409, 'model_catalog_upgrade_required', 'Update Impo to choose a model');
        sendJSON(res, 200, profileView(await options.profiles.update(user.id, body))); return;
      }
    }
    if (path.startsWith('/api/v1/today/')) {
      if (!options.today) throw new ServiceError(503, 'today_unavailable', 'Today is temporarily unavailable', true);
      if (path === '/api/v1/today/client' && method === 'POST') {
        sendJSON(res, 200, await options.today.registerClient(user.id, await readJSON(req, requestTimeoutMs))); return;
      }
      if (path === '/api/v1/today/settings' && method === 'GET') {
        sendJSON(res, 200, { settings: await options.today.settings(user.id) }); return;
      }
      if (path === '/api/v1/today/settings' && method === 'PUT') {
        sendJSON(res, 200, { settings: await options.today.configure(user.id, await readJSON(req, requestTimeoutMs)) }); return;
      }
      if (path === '/api/v1/today/topics/reset' && method === 'POST') {
        const body = await readJSON(req, requestTimeoutMs);
        if (Object.keys(body).length) throw new ServiceError(400, 'invalid_request', 'Expected an empty request');
        sendJSON(res, 200, await options.today.resetTopics(user.id)); return;
      }
      const cardRoute = /^\/api\/v1\/today\/briefs\/([^/]+)\/cards\/([a-f0-9]{24})\/(action|feedback)$/.exec(path);
      if (cardRoute && method === 'POST') {
        const body = await readJSON(req, requestTimeoutMs); const id = uuid(cardRoute[1]);
        if (cardRoute[3] === 'action') {
          if (Object.keys(body).length) throw new ServiceError(400, 'invalid_request', 'Expected an empty request');
          sendJSON(res, 200, await options.today.cardAction(user.id, id, cardRoute[2]!));
        } else sendJSON(res, 200, await options.today.feedback(user.id, id, cardRoute[2]!, body));
        return;
      }
      if (path === '/api/v1/today/briefs' && method === 'GET') {
        if ([...url.searchParams.keys()].some(k => !['limit', 'cursor', 'date'].includes(k))
          || ['limit', 'cursor', 'date'].some(k => url.searchParams.getAll(k).length > 1)) throw new ServiceError(400, 'invalid_request', 'Invalid brief history query');
        const date = url.searchParams.get('date') ?? undefined;
        if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new ServiceError(400, 'invalid_request', 'Invalid calendar date');
        sendJSON(res, 200, await options.today.list(user.id, integerQuery(url, 'limit', 10, 1, 30), url.searchParams.get('cursor') ?? undefined, date)); return;
      }
      const briefRoute = /^\/api\/v1\/today\/briefs\/([^/]+)(?:\/sources\/([^/]+))?$/.exec(path);
      if (briefRoute) {
        const id = uuid(briefRoute[1]);
        if (method === 'DELETE' && !briefRoute[2]) { await options.today.delete(user.id, id); sendJSON(res, 200, { status: 'deleted' }); return; }
        if (method === 'GET') {
          const row = await options.today.owned(user.id, id);
          const view = await options.today.view(row);
          if (!briefRoute[2]) { sendJSON(res, 200, view); return; }
          const source = view.sources.find(s => s.recordId === briefRoute[2]);
          const current = source && await options.today.currentSource(user.id, source);
          if (!current) throw new ServiceError(404, 'not_found', 'Source is no longer available');
          sendJSON(res, 200, current); return;
        }
      }
      throw new ServiceError(404, 'not_found', 'Today route not found');
    }
    if (path === '/api/v1/memories' || path.startsWith('/api/v1/memories/')) {
      if (!options.memories) throw new ServiceError(503, 'memories_unavailable', 'Memories are temporarily unavailable', true);
      if (path === '/api/v1/memories/summary' && method === 'GET') { sendJSON(res, 200, await options.memories.summary(user.id)); return; }
      if (path === '/api/v1/memories' && method === 'GET') {
        if ([...url.searchParams.keys()].some(k => !['limit', 'cursor', 'category'].includes(k))
          || ['limit', 'cursor', 'category'].some(k => url.searchParams.getAll(k).length > 1)) throw new ServiceError(400, 'invalid_request', 'Invalid memory query');
        const category = url.searchParams.get('category') ?? undefined;
        if (category !== undefined && !memoryCategories.includes(category as MemoryCategory)) throw new ServiceError(400, 'invalid_request', 'Unknown memory category');
        sendJSON(res, 200, await options.memories.page(user.id, { category: category as MemoryCategory | undefined, limit: integerQuery(url, 'limit', 30, 1, 100), cursor: url.searchParams.get('cursor') ?? undefined })); return;
      }
      const memoryRoute = /^\/api\/v1\/memories\/([^/]+)$/.exec(path);
      if (memoryRoute && method === 'DELETE') {
        if (!await options.memories.forget(user.id, uuid(memoryRoute[1]))) throw new ServiceError(404, 'not_found', 'Memory not found');
        sendJSON(res, 200, { status: 'deleted' }); return;
      }
      throw new ServiceError(404, 'not_found', 'Memory route not found');
    }
    if (path === '/api/v1/listening/uploads' && method === 'POST') {
      if (!options.uploads) throw new ServiceError(503, 'upload_unavailable', 'Direct audio upload is not configured.', true);
      if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
      // A full batch can carry 256 bounded place-name spans, but no audio bytes.
      sendJSON(res, 200, await options.uploads.prepare(user.id, await readJSON(req, requestTimeoutMs, 384 * 1024))); return;
    }
    const completeUpload = /^\/api\/v1\/listening\/uploads\/([^/]+)\/complete$/.exec(path);
    if (completeUpload && method === 'POST') {
      if (!options.uploads) throw new ServiceError(503, 'upload_unavailable', 'Direct audio upload is not configured.', true);
      onlyFields(await readJSON(req, requestTimeoutMs), []);
      sendJSON(res, 202, await options.uploads.complete(user.id, uuid(completeUpload[1]))); return;
    }
    if (path === '/api/v1/listening/batches' && method === 'POST') {
      if (!options.batchService || !options.listeningEnabled) throw new ServiceError(503, 'listening_unavailable', 'Batch listening is temporarily unavailable.', true);
      if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
      const batch = parseListeningBatch(await readJSON(req, requestTimeoutMs, maxBatchBytes), user.id);
      const requestId = res.getHeader('X-Request-Id');
      console.log(JSON.stringify({event:'listening.batch_received',at:new Date().toISOString(),requestId,batchId:batch.batchId,streamId:batch.streamId,sequence:batch.sequence,segments:batch.items.length}));
      const receipt = await options.batchService.submit(batch);
      console.log(JSON.stringify({event:'listening.batch_accepted',at:new Date().toISOString(),requestId,batchId:batch.batchId,sequence:batch.sequence}));
      sendJSON(res, 202, receipt); return;
    }
    const batchRoute = /^\/api\/v1\/listening\/batches\/([^/]+)(?:\/(retry))?$/.exec(path);
    if (batchRoute && options.batches) {
      const batchId = uuid(batchRoute[1]);
      const batch = await options.batches.receipt(user.id, batchId);
      if (!batch) throw new ServiceError(404, 'not_found', 'Batch not found');
      if (batchRoute[2] === 'retry' && method === 'POST') {
        if (!options.batchService) throw new ServiceError(503, 'listening_unavailable', 'Retry is temporarily unavailable.', true);
        await options.batchService.retry(user.id, batchId);
        sendJSON(res, 202, {status:'retry_requested'}); return;
      }
      if (!batchRoute[2] && method === 'GET') {
        sendJSON(res, 200, {batchId, sequence:batch.sequence, status:batch.status, attempts:batch.attempts, error:batch.error, updatedAt:batch.updatedAt}); return;
      }
    }
    if (['/api/v1/listening/calendar', '/api/v1/listening/timeline'].includes(path) && method === 'GET') {
      if (!options.listening) throw new ServiceError(503, 'listening_unavailable', 'Echo is not available on this server');
      const zone = url.searchParams.get('timeZone');
      if ([...url.searchParams.keys()].some(k => k !== 'timeZone') || url.searchParams.getAll('timeZone').length !== 1
        || !zone || zone.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(zone)) throw new ServiceError(400, 'invalid_request', 'A valid time zone is required');
      let timeZone: string;
      try { timeZone = new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone; }
      catch { throw new ServiceError(400, 'invalid_request', 'A valid time zone is required'); }
      sendJSON(res, 200, path.endsWith('/timeline')
        ? await options.listening.timeline(user.id, timeZone)
        : await options.listening.calendar(user.id, timeZone)); return;
    }
    if (path === '/api/v1/listening/segments'  || path.startsWith('/api/v1/listening/segments/')) {
      if (!options.listening) throw new ServiceError(503, 'listening_unavailable', 'Listening is not available on this server');
      const timestamp = (value: string | null): Date => {
        if (!value || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
          throw new ServiceError(400, 'invalid_request', 'A timestamp with a time zone is required');
        }
        return new Date(value);
      };
      if (path === '/api/v1/listening/segments' && method === 'POST') {
        if (!options.listeningEnabled) throw new ServiceError(503, 'listening_not_configured', 'Transcription is not configured on this server', true);
        if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
        const header = (name: string) => typeof req.headers[name] === 'string' ? req.headers[name] as string : null;
        const clientSegmentId = uuid(header('x-client-segment-id') ?? '');
        const startedAt = timestamp(header('x-recording-started-at'));
        const endedAt = timestamp(header('x-recording-ended-at'));
        const duration = endedAt.getTime() - startedAt.getTime();
        if (duration <= 0 || duration > 600_000 || endedAt.getTime() > Date.now() + 300_000) {
          throw new ServiceError(400, 'invalid_request', 'Recordings must be between zero and ten minutes long and cannot be in the future');
        }
        const mimeType = header('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
        if (!['audio/mp4', 'audio/m4a', 'audio/wav', 'audio/mpeg', 'audio/aac'].includes(mimeType)) {
          throw new ServiceError(415, 'unsupported_audio', 'Upload an M4A, AAC, WAV or MP3 recording');
        }
        const audio = await readBody(req, maxAudioBytes, requestTimeoutMs, 'Audio exceeds 8 MiB');
        if (!audio.length) throw new ServiceError(400, 'invalid_request', 'Audio cannot be empty');
        sendJSON(res, 202, await options.listening.upload(user.id, { clientSegmentId, startedAt, endedAt, mimeType, audio })); return;
      }
      if (path === '/api/v1/listening/segments' && method === 'GET') {
        if (url.searchParams.has('ids')) {
          const ids = (url.searchParams.get('ids') ?? '').split(',');
          if ([...url.searchParams.keys()].some(k => k !== 'ids') || url.searchParams.getAll('ids').length !== 1 || ids.length > 180) throw new ServiceError(400, 'invalid_request', 'Specify at most 180 recording IDs');
          sendJSON(res, 200, await options.listening.records(user.id, [...new Set(ids.map(uuid))])); return;
        }
        if (!url.searchParams.has('from') && !url.searchParams.has('to')) {
          const allowed = ['limit', 'cursor', 'before', 'direction'];
          const direction = url.searchParams.get('direction') ?? 'older';
          if ([...url.searchParams.keys()].some(key => !allowed.includes(key))
            || allowed.some(key => url.searchParams.getAll(key).length > 1)
            || !['older', 'newer'].includes(direction) || (url.searchParams.has('cursor') && url.searchParams.has('before'))
            || (direction === 'newer' && !url.searchParams.has('cursor'))) {
            throw new ServiceError(400, 'invalid_request', 'Invalid history page parameters');
          }
          const limit = integerQuery(url, 'limit', 30, 1, 100);
          const before = url.searchParams.has('before') ? timestamp(url.searchParams.get('before')) : undefined;
          sendJSON(res, 200, await options.listening.history(user.id, limit, url.searchParams.get('cursor') ?? undefined, before, direction as 'older' | 'newer')); return;
        }
        if ([...url.searchParams.keys()].some(key => !['from', 'to'].includes(key))
          || url.searchParams.getAll('from').length !== 1 || url.searchParams.getAll('to').length !== 1) {
          throw new ServiceError(400, 'invalid_request', 'Specify from and to exactly once');
        }
        const from = timestamp(url.searchParams.get('from')); const to = timestamp(url.searchParams.get('to'));
        if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > 26 * 3600_000) {
          throw new ServiceError(400, 'invalid_request', 'Request one calendar day at a time');
        }
        sendJSON(res, 200, { segments: await options.listening.list(user.id, from, to) }); return;
      }
      const locationRoute = /^\/api\/v1\/listening\/segments\/([^/]+)\/location$/.exec(path);
      const speakerRoute = /^\/api\/v1\/listening\/segments\/([^/]+)\/speakers$/.exec(path);
      if (speakerRoute && method === 'PATCH') {
        if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
        sendJSON(res, 200, await options.listening.reviewSpeakers(user.id, uuid(speakerRoute[1]), await readJSON(req, requestTimeoutMs))); return;
      }
      if (locationRoute && method === 'PATCH') {
        if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
        const input = await readJSON(req, requestTimeoutMs);
        onlyFields(input, ['label']);
        sendJSON(res, 200, await options.listening.labelLocation(user.id, uuid(locationRoute[1]), input.label)); return;
      }
      const segment = /^\/api\/v1\/listening\/segments\/([^/]+)$/.exec(path);
      if (segment && method === 'DELETE') {
        if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
        const batchId = await options.listening.delete(user.id, uuid(segment[1]));
        if (batchId) await options.uploads?.cleanupDeleted(user.id, batchId);
        if (batchId) await options.batchService?.retry(user.id, batchId);
        sendJSON(res, 200, { status: 'deleted' }); return;
      }
    }
    const connector = /^\/api\/v1\/connectors(?:\/([a-z0-9_]{1,64})(?:\/(connect|refresh))?)?$/.exec(path);
    if (connector) {
      if (!options.connectors) throw new ServiceError(503, 'connectors_not_configured', 'Connectors are not configured on this Impo server');
      if (url.search) throw new ServiceError(400, 'invalid_request', 'Connector routes do not accept query parameters');
      const [, toolkit, action] = connector;
      if (!toolkit && method === 'GET') { sendJSON(res, 200, { connectors: await options.connectors.list(user.id) }); return; }
      if (toolkit && !action && method === 'GET') { sendJSON(res, 200, await options.connectors.getStatus(user.id, toolkit)); return; }
      if (toolkit && !action && method === 'DELETE') {
        if (Number(req.headers['content-length'] ?? '0') > 0 || req.headers['transfer-encoding'] !== undefined) onlyFields(await readJSON(req, requestTimeoutMs), []);
        await options.connectors.disconnect(user.id, toolkit); sendJSON(res, 200, { status: 'disconnected' }); return;
      }
      if (toolkit && action && method === 'POST') {
        onlyFields(await readJSON(req, requestTimeoutMs), []);
        sendJSON(res, 200, action === 'connect' ? await options.connectors.connect(user.id, toolkit) : await options.connectors.refresh(user.id, toolkit)); return;
      }
    }
    if (path === '/api/v1/attachments' && method === 'GET') {
      if (!options.attachments) throw new ServiceError(503, 'attachments_unavailable', 'File uploads are unavailable.');
      sendJSON(res, 200, { maxBytes: maxAttachmentBytes, maxFiles: maxAttachments, formats: attachmentTypes }); return;
    }
    if (path === '/api/v1/attachments/prepare' && method === 'POST') {
      if (!options.attachments) throw new ServiceError(503, 'attachments_unavailable', 'File uploads are unavailable.');
      sendJSON(res, 200, await options.attachments.prepare(user.id, await readJSON(req, requestTimeoutMs))); return;
    }
    const attachment = /^\/api\/v1\/attachments\/([^/]+)\/complete$/.exec(path);
    if (attachment && method === 'POST') {
      if (!options.attachments) throw new ServiceError(503, 'attachments_unavailable', 'File uploads are unavailable.');
      onlyFields(await readJSON(req, requestTimeoutMs), []);
      sendJSON(res, 200, await options.attachments.complete(user.id, uuid(attachment[1]))); return;
    }
    const uploadedFile = /^\/api\/v1\/files\/upload_([^/]+)$/.exec(path);
    if (uploadedFile && method === 'GET') {
      if (!options.attachments) throw new ServiceError(404, 'not_found', 'File not found.');
      const { file, bytes } = await options.attachments.load(user.id, uuid(uploadedFile[1]), requestSignal(res));
      res.writeHead(200, { 'Content-Type': file.mediaType, 'Content-Length': bytes.length, 'Content-Disposition': contentDisposition(file.name), 'Cache-Control': 'private, no-store' });
      res.end(bytes); return;
    }
    if (path === '/api/v1/conversation/messages' && method === 'POST') {
      const data = await readJSON(req, requestTimeoutMs);
      onlyFields(data, ['clientMessageId', 'text', 'deviceId', 'clientContext', 'attachmentIds']);
      const receipt = await repository.acceptMessage(user.id, {
        clientMessageId: requiredString(data, 'clientMessageId', 256),
        ...messageInput(data, 32_768),
        ...(data.deviceId === undefined ? {} : { deviceId: uuid(requiredString(data, 'deviceId', 36)) }),
        ...(data.clientContext === undefined ? {} : { clientContext: clientContext(data.clientContext) }),
      });
      sendJSON(res, 202, receipt); return;
    }
    if (path === '/api/v1/conversation/voice-messages' && method === 'POST') {
      if (!options.dictation || !repository.findUserMessage) throw new ServiceError(503, 'voice_unavailable', 'Voice input is not configured.', true);
      if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
      const data = await readJSON(req, requestTimeoutMs, voiceBodyBytes);
      onlyFields(data, ['clientMessageId', 'audio', 'mimeType', 'deviceId', 'clientContext']);
      const clip = dictationAudio(data.audio, data.mimeType);
      const input = {
        clientMessageId: requiredString(data, 'clientMessageId', 256),
        ...(data.deviceId === undefined ? {} : { deviceId: uuid(requiredString(data, 'deviceId', 36)) }),
        ...(data.clientContext === undefined ? {} : { clientContext: clientContext(data.clientContext) }),
      };
      // A retry after a lost response replays the stored text; it is never transcribed twice.
      const accepted = async (text: string) => ({ ...await repository.acceptMessage(user.id, { ...input, text }), text });
      const existing = await repository.findUserMessage(user.id, input.clientMessageId);
      if (existing) { sendJSON(res, 202, await accepted(existing.text)); return; }
      const text = await transcribeRequest(options.dictation, clip, requestSignal(res));
      try { sendJSON(res, 202, await accepted(text)); }
      catch (error) {
        // A concurrent retry may have accepted its own transcript first.
        const winner = error instanceof ServiceError && error.code === 'idempotency_conflict' ? await repository.findUserMessage(user.id, input.clientMessageId) : undefined;
        if (!winner) throw error;
        sendJSON(res, 202, await accepted(winner.text));
      }
      return;
    }
    if (path === '/api/v1/voice/transcriptions' && method === 'POST') {
      if (!options.dictation) throw new ServiceError(503, 'voice_unavailable', 'Voice input is not configured.', true);
      if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
      const data = await readJSON(req, requestTimeoutMs, voiceBodyBytes);
      onlyFields(data, ['audio', 'mimeType']);
      sendJSON(res, 200, { text: await transcribeRequest(options.dictation, dictationAudio(data.audio, data.mimeType), requestSignal(res)) }); return;
    }
    if (path.startsWith('/api/v1/devices/') || path.startsWith('/api/v1/device-tool-invocations/')) {
      if (!repository.devices) throw new ServiceError(404, 'not_found', 'Device routes are unavailable');
      if (path === '/api/v1/devices/register' && method === 'POST') {
        if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
        const data = await readJSON(req, requestTimeoutMs);
        onlyFields(data, ['installationId', 'tools']);
        if (!Array.isArray(data.tools) || data.tools.some(tool => typeof tool !== 'string')) throw new ServiceError(400, 'invalid_request', 'tools must be a string array');
        sendJSON(res, 200, await repository.devices.register(user.id, { installationId: requiredString(data, 'installationId', 256), tools: data.tools as string[] })); return;
      }
      const pending = /^\/api\/v1\/devices\/([^/]+)\/tool-invocations$/.exec(path);
      if (pending && method === 'GET') {
        if ([...url.searchParams.keys()].some(key => key !== 'status') || url.searchParams.getAll('status').length > 1 || (url.searchParams.has('status') && url.searchParams.get('status') !== 'pending')) throw new ServiceError(400, 'invalid_request', 'Only pending invocations can be requested');
        sendJSON(res, 200, await repository.devices.pending(user.id, uuid(pending[1]))); return;
      }
      const invocation = /^\/api\/v1\/device-tool-invocations\/([^/]+)\/(claim|result)$/.exec(path);
      if (invocation && method === 'POST') {
        if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
        const id = uuid(invocation[1]);
        const data = await readJSON(req, requestTimeoutMs);
        onlyFields(data, invocation[2] === 'claim' ? ['deviceId'] : ['deviceId', 'executionId', 'success', 'output', 'error']);
        const deviceId = uuid(requiredString(data, 'deviceId', 36));
        if (invocation[2] === 'claim') { sendJSON(res, 200, await repository.devices.claim(user.id, id, deviceId)); return; }
        if (typeof data.success !== 'boolean') throw new ServiceError(400, 'invalid_request', 'success must be a boolean');
        sendJSON(res, 200, await repository.devices.result(user.id, id, {
          deviceId, executionId: uuid(requiredString(data, 'executionId', 36)), success: data.success,
          ...('output' in data ? { output: data.output } : {}),
          ...('error' in data ? { error: requiredString(data, 'error', 4096) } : {}),
        })); return;
      }
    }
    if (path === '/api/v1/conversation' && method === 'GET') {
      for (const key of url.searchParams.keys()) {
        if (key !== 'afterSequence' && key !== 'limit') throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
      }
      const after = integerQuery(url, 'afterSequence', 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = integerQuery(url, 'limit', 50, 1, 100);
      sendJSON(res, 200, await repository.getConversation(user.id, after, limit)); return;
    }
    if (path === '/api/v1/tasks' || path.startsWith('/api/v1/tasks/')) {
      const { listTasks, createUserTask, getTaskConversation, acceptTaskMessage } = repository;
      if (!listTasks || !createUserTask || !getTaskConversation || !acceptTaskMessage) throw new ServiceError(404, 'not_found', 'Task routes are unavailable');
      if (path === '/api/v1/tasks' && method === 'GET') {
        if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
        sendJSON(res, 200, await listTasks.call(repository, user.id)); return;
      }
      if (path === '/api/v1/tasks' && method === 'POST') {
        const data = await readJSON(req, requestTimeoutMs);
        onlyFields(data, ['clientMessageId', 'text', 'clientContext', 'attachmentIds']);
        sendJSON(res, 202, await createUserTask.call(repository, user.id, {
          clientMessageId: requiredString(data, 'clientMessageId', 256),
          ...messageInput(data, 4000),
          ...(data.clientContext === undefined ? {} : { clientContext: clientContext(data.clientContext) }),
        })); return;
      }
      const task = /^\/api\/v1\/tasks\/([^/]+)\/(conversation|messages)$/.exec(path);
      if (task?.[2] === 'conversation' && method === 'GET') {
        for (const key of url.searchParams.keys()) {
          if (key !== 'afterSequence' && key !== 'limit') throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
        }
        sendJSON(res, 200, await getTaskConversation.call(repository, user.id, uuid(task[1]),
          integerQuery(url, 'afterSequence', 0, 0, Number.MAX_SAFE_INTEGER), integerQuery(url, 'limit', 50, 1, 100))); return;
      }
      if (task?.[2] === 'messages' && method === 'POST') {
        if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
        const data = await readJSON(req, requestTimeoutMs);
        onlyFields(data, ['clientMessageId', 'text', 'clientContext', 'attachmentIds']);
        sendJSON(res, 202, await acceptTaskMessage.call(repository, user.id, uuid(task[1]), {
          clientMessageId: requiredString(data, 'clientMessageId', 256),
          ...messageInput(data, 32_768),
          ...(data.clientContext === undefined ? {} : { clientContext: clientContext(data.clientContext) }),
        })); return;
      }
    }
    const file = /^\/api\/v1\/files\/([^/]{1,256})$/.exec(path);
    if (file && method === 'GET') {
      if (!options.files) throw new ServiceError(404, 'not_found', 'File not found');
      if (url.search) throw new ServiceError(400, 'invalid_request', 'Unsupported query parameter');
      const signal = requestSignal(res);
      const delivered = await options.files.open(user.id, file[1]!, signal);
      res.writeHead(200, {
        'Content-Type': delivered.mediaType, 'Content-Length': String(delivered.sizeBytes), 'Content-Disposition': contentDisposition(delivered.name),
        // Native clients own an account-scoped file cache; shared HTTP caches must not retain bytes.
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      });
      await pipeline(Readable.from(boundedFileBytes(delivered.body, delivered.sizeBytes)), res, { signal }).catch(() => { res.destroy(); });
      return;
    }
    const match = /^\/api\/v1\/submissions\/([^/]+)(?:\/(stream|cancel))?$/.exec(path);
    if (match) {
      const id = uuid(match[1]);
      if (url.search.length) throw new ServiceError(400, 'invalid_request', 'Submission routes do not accept query parameters');
      if (!match[2] && method === 'GET') {
        const submission = await repository.getSubmission(user.id, id);
        sendJSON(res, 200, { ...submission, subscriberCount: subscriberCounts.get(id) ?? 0 }); return;
      }
      if (match[2] === 'cancel' && method === 'POST') {
        onlyFields(await readJSON(req, requestTimeoutMs), []);
        const submission = await repository.cancelSubmission(user.id, id);
        sendJSON(res, 200, { ...submission, subscriberCount: subscriberCounts.get(id) ?? 0 }); return;
      }
      if (match[2] === 'stream' && method === 'GET') { await stream(user.id, id, res); return; }
    }
    throw new ServiceError(404, 'not_found', 'Route not found');
  }

  async function stream(userId: string, id: string, res: ServerResponse): Promise<void> {
    // Authorization and the initial database read happen before sending SSE headers.
    const first = await repository.readEvents(userId, id, 0);
    if (res.destroyed) return;
    const controller = new AbortController();
    let releaseBatch: (() => void) | undefined;
    const disconnect = () => { controller.abort(); releaseBatch?.(); };
    res.once('close', disconnect);
    subscriberCounts.set(id, (subscriberCounts.get(id) ?? 0) + 1);
    let written = 0;
    let forwarded = 0;
    const output = createUIMessageStream({
      execute: async ({ writer }) => {
        let cursor = 0;
        let batch = first;
        try {
          while (!controller.signal.aborted) {
            let finished = false;
            for (const event of batch.events) {
              if (!Number.isSafeInteger(event.sequence) || event.sequence <= cursor) throw new Error('Invalid event order');
              cursor = event.sequence;
              writer.write(event.chunk);
              written += 1;
              if (event.chunk.type === 'finish') finished = true;
            }
            // The persisted finish, not a disconnected subscriber, closes this UI message.
            if (finished) return;
            if (terminal(batch.submission.status) && batch.events.length === 0) {
              throw new Error('Terminal submission is missing its finish event');
            }
            // Bound SDK buffering to one repository batch when the HTTP reader is slow.
            if (forwarded < written) {
              await new Promise<void>(resolve => { releaseBatch = resolve; });
              releaseBatch = undefined;
            }
            if (controller.signal.aborted) return;
            await delay(pollIntervalMs, undefined, { signal: controller.signal });
            if (controller.signal.aborted) return;
            batch = await repository.readEvents(userId, id, cursor);
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        }
      },
      onError: () => 'stream_unavailable',
    });
    const bounded = output.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, downstream) {
        downstream.enqueue(chunk);
        forwarded += 1;
        if (forwarded >= written) releaseBatch?.();
      },
    }));
    let keepAlive: NodeJS.Timeout | undefined;
    try {
      const response = createUIMessageStreamResponse({ stream: bounded, headers: { 'Cache-Control': 'no-store' } });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.flushHeaders();
      // A run can go minutes without output (sandbox commands, reasoning). Proxies such as the
      // ALB close idle connections after 60 s, so send an SSE comment while nothing else flows.
      // Each chunk is a complete SSE event, so a comment between chunks never splits one.
      let lastWrite = Date.now();
      const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
      body.on('data', () => { lastWrite = Date.now(); });
      keepAlive = setInterval(() => {
        if (Date.now() - lastWrite >= streamKeepAliveMs && !res.writableEnded) { res.write(': keepalive\n\n'); lastWrite = Date.now(); }
      }, Math.min(5_000, streamKeepAliveMs));
      await pipeline(body, res);
    } finally {
      clearInterval(keepAlive);
      disconnect();
      res.off('close', disconnect);
      const count = (subscriberCounts.get(id) ?? 1) - 1;
      if (count) subscriberCounts.set(id, count);
      else subscriberCounts.delete(id);
    }
  }

  return server;
}
