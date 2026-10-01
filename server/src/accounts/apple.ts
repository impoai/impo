import { createPrivateKey, sign } from 'node:crypto';
import { ServiceError } from '../errors.js';

export interface AppleSignInConfig { teamId: string; keyId: string; privateKey: string; nativeClientId: string; webClientId: string }
export function parseAppleSignInConfig(raw: string): AppleSignInConfig {
  const v = JSON.parse(raw) as AppleSignInConfig;
  if (!/^[A-Z0-9]{10}$/.test(v.teamId) || !/^[A-Z0-9]{10}$/.test(v.keyId) ||
      !v.nativeClientId || !v.webClientId || createPrivateKey(v.privateKey).asymmetricKeyType !== 'ec') throw new Error('Invalid Apple sign-in configuration');
  return v;
}
/** Apple grants are exchanged and revoked on the server; no token is persisted or logged. */
export class AppleGrantRevoker {
  constructor(readonly config: AppleSignInConfig, private readonly request: typeof fetch = fetch) {}
  private secret(clientId: string) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const input = `${encode({ alg: 'ES256', kid: this.config.keyId })}.${encode({ iss: this.config.teamId, sub: clientId, aud: 'https://appleid.apple.com', iat: now, exp: now + 300 })}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key: this.config.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  }
  private async post(path: 'token' | 'revoke', clientId: string, params: Record<string, string>) {
    const response = await this.request(`https://appleid.apple.com/auth/${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: this.secret(clientId), ...params }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Apple authorization could not be revoked'); }
    return response;
  }
  async revokeCode(code: string, expectedSubject: string): Promise<void> {
    const response = await this.post('token', this.config.nativeClientId, { grant_type: 'authorization_code', code });
    const tokens = await response.json() as { id_token: string; refresh_token: string };
    // This ID token comes directly from Apple's authenticated token endpoint, never from the client.
    const identity = JSON.parse(Buffer.from(tokens.id_token.split('.')[1]!, 'base64url').toString()) as { sub?: string; aud?: string; iss?: string; exp?: number };
    if (identity.sub !== expectedSubject || identity.aud !== this.config.nativeClientId || identity.iss !== 'https://appleid.apple.com' || !identity.exp || identity.exp * 1000 < Date.now())
      throw new ServiceError(403, 'apple_account_mismatch', 'Use the Apple Account linked to this Impo account.');
    if (!tokens.refresh_token) throw new Error('Apple did not return a revocable token');
    await this.revokeToken(tokens.refresh_token, this.config.nativeClientId, 'refresh_token');
  }
  async revokeToken(token: string, clientId = this.config.webClientId, type = 'access_token'): Promise<void> {
    const response = await this.post('revoke', clientId, { token, token_type_hint: type });
    await response.body?.cancel();
  }
}
