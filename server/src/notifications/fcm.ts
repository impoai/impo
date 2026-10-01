import { createPrivateKey, sign } from 'node:crypto';
import { notificationCopy, type NotificationCategory } from './contract.js';

export type FCMCredentials = { project_id: string; client_email: string; private_key: string; private_key_id: string };
export function parseFCMCredentials(raw: string): FCMCredentials {
  try {
    const value = JSON.parse(raw);
    if (value.type !== 'service_account' || !/^[a-z][a-z0-9-]{4,62}$/.test(value.project_id) || typeof value.client_email !== 'string'
      || !value.client_email.endsWith(`@${value.project_id}.iam.gserviceaccount.com`) || typeof value.private_key_id !== 'string'
      || value.token_uri !== 'https://oauth2.googleapis.com/token') throw Error();
    createPrivateKey(value.private_key);
    return value;
  } catch { throw new Error('FCM_SERVICE_ACCOUNT_JSON must contain a valid Firebase service-account key'); }
}
export type PushMessage = { token: string; platform: 'ios' | 'android'; registrationId: string; eventId: string; category: NotificationCategory; targetId: string; failed: boolean; expiresAt: Date };
export type PushResult = { status: 'sent' | 'pending' | 'failed'; messageId?: string; code?: string; invalidToken?: boolean; retryAfterMs?: number };
export interface PushSender { send(input: PushMessage): Promise<PushResult> }
export function fcmMessage(input: PushMessage, now = Date.now()) {
  const copy = notificationCopy(input.category, input.failed);
  const data = { version: '1', eventId: input.eventId, category: input.category, targetId: input.targetId, registrationId: input.registrationId, expiresAt: input.expiresAt.toISOString(), ...copy };
  return { token: input.token, data, ...(input.platform === 'ios' ? {
    apns: { headers: { 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(Math.floor(input.expiresAt.getTime() / 1000)), 'apns-collapse-id': input.eventId },
      payload: { aps: { alert: copy, sound: 'default', 'thread-id': `impo-${input.category}` } } },
  } : { android: { priority: 'high', ttl: `${Math.max(0, Math.floor((input.expiresAt.getTime() - now) / 1000))}s` } }) };
}

/** HTTP v1 with short-lived OAuth. No secret, device token or notification body is logged. */
export class FCMSender implements PushSender {
  private access?: { token: string; expiresAt: number };
  private refreshing?: Promise<string>;
  constructor(private readonly credentials: FCMCredentials, private readonly request: typeof fetch = fetch) {}
  private async token() {
    if (this.access && this.access.expiresAt > Date.now() + 60_000) return this.access.token;
    if (this.refreshing) return this.refreshing;
    const pending = (async () => {
      const now = Math.floor(Date.now() / 1000);
      const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
      const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: this.credentials.private_key_id })}.${encode({ iss: this.credentials.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
      const assertion = `${input}.${sign('RSA-SHA256', Buffer.from(input), this.credentials.private_key).toString('base64url')}`;
      const response = await this.request('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(10_000), body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
      const value = await response.json() as { access_token?: string; expires_in?: number };
      if (!response.ok || typeof value.access_token !== 'string') throw Error('fcm_oauth_failed');
      this.access = { token: value.access_token, expiresAt: Date.now() + Math.min(Number(value.expires_in) || 3600, 3600) * 1000 };
      return this.access.token;
    })();
    this.refreshing = pending;
    try { return await pending; } finally { if (this.refreshing === pending) this.refreshing = undefined; }
  }
  async send(input: PushMessage): Promise<PushResult> {
    try {
      if (input.expiresAt.getTime() <= Date.now()) return { status: 'failed', code: 'expired' };
      const access = await this.token();
      const response = await this.request(`https://fcm.googleapis.com/v1/projects/${this.credentials.project_id}/messages:send`, {
        method: 'POST', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: fcmMessage(input) }),
      });
      const value = await response.json() as { name?: string; error?: { details?: Array<{ '@type'?: string; errorCode?: string }> } };
      if (response.ok && value.name) return { status: 'sent', messageId: value.name };
      const code = value.error?.details?.find(d => d['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode;
      if (code === 'UNREGISTERED') return { status: 'failed', code, invalidToken: true };
      if (response.status === 401) this.access = undefined;
      const retry = response.status === 401 || response.status === 429 || response.status >= 500 || code === 'THIRD_PARTY_AUTH_ERROR';
      const after = response.headers.get('retry-after');
      const retryAfterMs = after ? (/^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now()) : 0;
      return { status: retry ? 'pending' : 'failed', code: ['INVALID_ARGUMENT', 'SENDER_ID_MISMATCH', 'THIRD_PARTY_AUTH_ERROR', 'QUOTA_EXCEEDED', 'UNAVAILABLE', 'INTERNAL'].includes(code ?? '') ? code : `http_${response.status}`,
        retryAfterMs: Math.max(response.status === 429 ? 60_000 : 5000, Number.isFinite(retryAfterMs) ? retryAfterMs : 0) };
    } catch { return { status: 'pending', code: 'provider_unavailable', retryAfterMs: 10_000 }; }
  }
}
