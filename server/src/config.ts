import { parseFCMCredentials } from './notifications/fcm.js';
import { parseAppleSignInConfig } from './accounts/apple.js';

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is outside the supported range`);
  return value;
}

// clerk mode also allows 0.0.0.0: a container binds every interface in its own
// network namespace, and exposure is actually controlled by the security group,
// not by this bind address; local-dev keeps the stricter loopback/private check.
function gadgetGatewayAdmin(): { url: string; adminToken: string } | undefined {
  const url = process.env.GADGET_GATEWAY_URL, adminToken = process.env.GADGET_GATEWAY_ADMIN_TOKEN;
  if (!url && !adminToken) return undefined;
  if (!url || !adminToken) throw new Error('Set GADGET_GATEWAY_URL and GADGET_GATEWAY_ADMIN_TOKEN together, or neither');
  if (!/^https:\/\/[^/]+$/.test(url) || adminToken.length < 32) throw new Error('Invalid gadget gateway admin configuration');
  return { url, adminToken };
}

function gadgetGatewayServiceToken(): string | undefined {
  const token = process.env.GADGET_GATEWAY_SERVICE_TOKEN;
  if (token !== undefined && token.length < 32) throw new Error('GADGET_GATEWAY_SERVICE_TOKEN must be at least 32 characters');
  return token;
}

function developmentHost(authMode: 'local-dev' | 'clerk'): string {
  const host = process.env.HOST ?? '127.0.0.1';
  if (['localhost', '::1'].includes(host)) return host;
  if (authMode === 'clerk' && host === '0.0.0.0') return host;
  const octets = host.split('.');
  if (octets.length === 4 && octets.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) {
    const [a, b] = octets.map(Number);
    if (a === 127 || a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)) return host;
  }
  throw new Error('HOST must be an explicit loopback or private RFC1918 IPv4 address');
}

/** local-dev is limited to this project's local databases; clerk may point at a real remote Postgres. */
export function loadDatabaseUrl(authMode: 'local-dev' | 'clerk'): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL is required');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  if (authMode === 'local-dev' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Local development requires a loopback PostgreSQL database');
  }
  if (!/^\/instant(?:_[a-z0-9_]+)?$/.test(url.pathname) || url.search || url.hash) {
    throw new Error('Database name must be instant or instant_<name>, without URL query overrides');
  }
  return value;
}

/** TLS is a property of the database connection (is it loopback or a real remote
 * Postgres like RDS), not of the auth mode - a clerk-mode server can still point
 * at a local Postgres for development. */
export function databaseRequiresSsl(databaseUrl: string): boolean {
  const { hostname } = new URL(databaseUrl);
  return !['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

/** local-dev is a fixed fixture identity and must never run in production; clerk is the only mode allowed there. */
export function loadConfig(role: 'api' | 'worker') {
  const authMode = process.env.INSTANT_AUTH_MODE;
  if (!['local-dev', 'clerk'].includes(authMode ?? '') || !['development', 'rebyte'].includes(process.env.INSTANT_RUNTIME ?? '')) {
    throw new Error('Set INSTANT_AUTH_MODE=local-dev or clerk, and INSTANT_RUNTIME=development or rebyte');
  }
  if (authMode === 'local-dev' && process.env.NODE_ENV === 'production') {
    throw new Error('INSTANT_AUTH_MODE=local-dev must never run with NODE_ENV=production');
  }
  const clerk = authMode === 'clerk' ? {
    secretKey: process.env.CLERK_SECRET_KEY ?? '',
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? '',
  } : undefined;
  if (clerk && (!clerk.secretKey || !clerk.publishableKey)) {
    throw new Error('CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY are required for INSTANT_AUTH_MODE=clerk');
  }
  const runtime = process.env.INSTANT_RUNTIME as 'development' | 'rebyte';
  const composioKey = process.env.COMPOSIO_API_KEY;
  // The connector shelf is Rebyte's: every managed auth config named `<prefix><toolkit>`.
  const authConfigPrefix = process.env.COMPOSIO_AUTH_CONFIG_PREFIX ?? 'rebyte-dev-';
  if (!/^[a-z0-9-]{1,64}$/.test(authConfigPrefix)) throw new Error('COMPOSIO_AUTH_CONFIG_PREFIX must be lowercase letters, digits and dashes');
  const composio = composioKey ? { apiKey: composioKey, authConfigPrefix, baseURL: process.env.COMPOSIO_BASE_URL ?? 'https://backend.composio.dev', requestTimeoutMs: integer('COMPOSIO_REQUEST_TIMEOUT_MS', 20_000, 1000, 120_000) } : undefined;
  const rebyte = runtime === 'rebyte' ? {
    apiKey: process.env.REBYTE_API_KEY ?? '',
    baseURL: process.env.REBYTE_BASE_URL ?? 'https://api.rebyte.ai/v1',
    model: process.env.REBYTE_MODEL ?? 'gpt-5.6-luna',
    timeoutMs: integer('REBYTE_REQUEST_TIMEOUT_MS', 30_000, 1000, 120_000),
  } : undefined;
  if (rebyte) {
    if (!rebyte.apiKey) throw new Error('REBYTE_API_KEY is required for the Rebyte runtime');
    const url = new URL(rebyte.baseURL);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Rebyte endpoint must use HTTPS or loopback HTTP');
  }
  const temporalAddress = process.env.TEMPORAL_ADDRESS;
  const temporalNamespace = process.env.TEMPORAL_NAMESPACE;
  if (Boolean(temporalAddress) !== Boolean(temporalNamespace)) throw new Error('Set both TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE');
  const temporal = temporalAddress && temporalNamespace ? { address: temporalAddress, namespace: temporalNamespace,
    apiKey: process.env.TEMPORAL_API_KEY, taskQueue: process.env.LISTENING_TASK_QUEUE } : undefined;
  // Per-user transcript archive (S3). Unset keeps transcripts only in PostgreSQL.
  const transcriptArchive = process.env.TRANSCRIPT_BUCKET ? { bucket: process.env.TRANSCRIPT_BUCKET, region: process.env.AWS_REGION ?? 'us-east-1' } : undefined;
  // Long-term memory: one Turso database per user, searched by Gemini embeddings. Development uses local files.
  const turso = { apiToken: process.env.TURSO_API_TOKEN, organization: process.env.TURSO_ORG, databaseAuthToken: process.env.TURSO_DB_AUTH_TOKEN };
  const tursoSet = Object.values(turso).filter(Boolean).length;
  if (tursoSet !== 0 && tursoSet !== 3) throw new Error('Set TURSO_API_TOKEN, TURSO_ORG and TURSO_DB_AUTH_TOKEN together, or none');
  const memory = tursoSet === 3 && process.env.GEMINI_API_KEY ? {
    turso: { apiToken: turso.apiToken!, organization: turso.organization!, databaseAuthToken: turso.databaseAuthToken!,
      group: process.env.TURSO_GROUP ?? 'default', baseURL: process.env.TURSO_API_URL ?? 'https://api.turso.tech', timeoutMs: 20_000 },
    embedding: { apiKey: process.env.GEMINI_API_KEY!, baseURL: 'https://generativelanguage.googleapis.com',
      model: process.env.MEMORY_EMBEDDING_MODEL ?? 'gemini-embedding-001', dimensions: integer('MEMORY_EMBEDDING_DIMENSIONS', 768, 64, 3072), timeoutMs: 20_000 },
  } : runtime === 'development' || process.env.MEMORY_LOCAL_DIR ? { localDirectory: process.env.MEMORY_LOCAL_DIR ?? '.local/memory' } : undefined;
  return {
    appleSignIn: role === 'api' && process.env.APPLE_SIGN_IN_JSON ? parseAppleSignInConfig(process.env.APPLE_SIGN_IN_JSON) : undefined,
    notificationsEnabled: process.env.NOTIFICATIONS_ENABLED === 'true',
    fcm: role === 'worker' && process.env.FCM_SERVICE_ACCOUNT_JSON ? parseFCMCredentials(process.env.FCM_SERVICE_ACCOUNT_JSON) : undefined,
    temporal, transcriptArchive, memory,
    authMode: authMode as 'local-dev' | 'clerk', clerk,
    // Shared with the gadget gateway (server/gadget-gateway); unset disables gadget chat.
    gadgetGatewayServiceToken: gadgetGatewayServiceToken(),
    // The API manages each account's gadget pairings through the gateway's admin routes.
    gadgetGatewayAdmin: gadgetGatewayAdmin(),
    listening: process.env.GEMINI_API_KEY ? { apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com', timeoutMs: 120_000 } : undefined,
    // Hold-to-talk composer transcription; the client waits on this request.
    voice: process.env.GEMINI_API_KEY ? { apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com',
      model: process.env.VOICE_TRANSCRIPTION_MODEL ?? 'gemini-3.5-transcribe', timeoutMs: 30_000 } : undefined,
    runtime, rebyte, composio, remotePollMs: integer('REBYTE_POLL_MS', 500, 50, 60_000),
    databaseUrl: loadDatabaseUrl(authMode as 'local-dev' | 'clerk'),
    host: developmentHost(authMode as 'local-dev' | 'clerk'),
    deviceToolTimeoutMs: integer('DEVICE_TOOL_TIMEOUT_MS', 300_000, 100, 3_600_000),
    // SSE keepalive while a run is quiet; stays below the ALB's 60 s idle timeout.
    streamKeepAliveMs: integer('STREAM_KEEPALIVE_MS', 15_000, 100, 55_000),
    port: integer('PORT', 3001, 0, 65535),
    pollIntervalMs: role === 'worker' ? integer('INSTANT_WORKER_POLL_MS', 100, 10, 60_000) : 100,
    leaseMs: integer('WORKER_LEASE_MS', 10_000, 250, 300_000),
  };
}
