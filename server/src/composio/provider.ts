import { ServiceError } from '../errors.js';

export interface ComposioConfig { apiKey: string; authConfigId: string; baseURL?: string; requestTimeoutMs?: number }
export interface ConnectedAccount {
  id: string; entityId: string; authConfigId: string; toolkit: string; status: string; disabled: boolean; authConfigDisabled: boolean;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError(502, 'composio_invalid_response', 'Composio returned an invalid response', true);
  return value as Record<string, unknown>;
};
const required = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw new ServiceError(502, 'composio_invalid_response', 'Composio returned an invalid identifier', true);
  return value;
};

/** Composio v3.1 adapter. No auto-retries: ambiguous writes are owned by durable callers. */
export class ComposioProvider {
  private readonly baseURL: string;
  constructor(private readonly config: ComposioConfig) {
    const url = new URL(config.baseURL ?? 'https://backend.composio.dev');
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Invalid Composio endpoint');
    this.baseURL = url.toString().replace(/\/$/, '');
  }

  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs ?? 20_000);
    let response: Response;
    try {
      response = await fetch(`${this.baseURL}${path}`, { method, headers: { 'x-api-key': this.config.apiKey, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ServiceError(502, 'composio_unavailable', 'Composio did not acknowledge the request', true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new ServiceError(response.status === 404 ? 404 : 502, response.status === 404 ? 'composio_not_found' : 'composio_request_failed', `Composio request failed (HTTP ${response.status})`, response.status === 429 || response.status >= 500);
      Object.assign(error, { providerStatus: response.status });
      throw error;
    }
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 256 * 1024) { await reader.cancel(); throw new ServiceError(502, 'connector_response_too_large', 'Gmail returned too much data; request fewer messages or narrower fields'); }
        chunks.push(next.value);
      }
    } catch (error) {
      if (signal?.aborted || error instanceof ServiceError) throw error;
      throw new ServiceError(502, 'composio_unavailable', 'Composio did not finish returning the request result', true);
    } finally { reader.releaseLock(); }
    if (!bytes) return undefined;
    const combined = Buffer.concat(chunks, bytes);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined)); }
    catch { throw new ServiceError(502, 'composio_invalid_response', 'Composio returned invalid JSON', true); }
  }

  async createLink(entityId: string, signal?: AbortSignal, authConfigId = this.config.authConfigId): Promise<{ redirectURL: string }> {
    const data = object(await this.request('POST', '/api/v3.1/connected_accounts/link', { auth_config_id: authConfigId, user_id: entityId }, signal));
    const redirectURL = required(data.redirect_url ?? data.redirect_uri ?? data.link_url ?? data.url);
    const url = new URL(redirectURL);
    if (url.protocol !== 'https:' || url.username || url.password) throw new ServiceError(502, 'composio_invalid_response', 'Composio returned an invalid authorization URL');
    return { redirectURL };
  }

  async account(id: string, signal?: AbortSignal): Promise<ConnectedAccount> {
    const data = object(await this.request('GET', `/api/v3.1/connected_accounts/${encodeURIComponent(id)}`, undefined, signal));
    const auth = object(data.auth_config), toolkit = object(data.toolkit);
    if (data.id !== id) throw new ServiceError(502, 'composio_invalid_response', 'Composio returned a different account identity');
    if (typeof data.is_disabled !== 'boolean' || typeof auth.is_disabled !== 'boolean') throw new ServiceError(502, 'composio_invalid_response', 'Composio account status is incomplete');
    return { id: required(data.id), entityId: required(data.user_id), authConfigId: required(auth.id), toolkit: required(toolkit.slug), status: required(data.status), disabled: data.is_disabled, authConfigDisabled: auth.is_disabled };
  }

  async accounts(entityId: string, authConfigId: string, signal?: AbortSignal): Promise<string[]> {
    const query = new URLSearchParams({ user_ids: entityId, auth_config_ids: authConfigId, limit: '100' });
    const data = object(await this.request('GET', `/api/v3.1/connected_accounts?${query}`, undefined, signal));
    if (!Array.isArray(data.items) || data.items.length >= 100 || data.next_cursor) throw new ServiceError(502, 'composio_account_ambiguous', 'Unable to resolve a unique Gmail connection');
    return data.items.map(value => required(object(value).id));
  }

  async createRouter(entityId: string, accountId: string, authConfigId: string, signal?: AbortSignal): Promise<string> {
    const data = object(await this.request('POST', '/api/v3.1/tool_router/session', {
      user_id: entityId, toolkits: { enable: ['gmail'] }, auth_configs: { gmail: authConfigId }, connected_accounts: { gmail: [accountId] },
      manage_connections: { enable: false, enable_wait_for_connections: false, enable_connection_removal: false },
      workbench: { enable: false, enable_proxy_execution: false }, execute: { enable_multi_execute: true },
    }, signal));
    return required(data.session_id);
  }

  async execute(routerId: string, slug: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    return this.request('POST', `/api/v3.1/tool_router/session/${encodeURIComponent(routerId)}/execute`, { tool_slug: slug, arguments: args }, signal);
  }

  async revoke(id: string): Promise<void> {
    for (const [method, suffix] of [['POST', '/revoke'], ['DELETE', '']] as const) {
      try { await this.request(method, `/api/v3.1/connected_accounts/${encodeURIComponent(id)}${suffix}`); }
      catch (error) {
        const status = (error as { providerStatus?: number }).providerStatus;
        if (status !== 404 && !(method === 'POST' && status === 409)) throw error;
      }
    }
  }

  async deleteRouter(id: string): Promise<void> {
    try { await this.request('DELETE', `/api/v3.1/tool_router/session/${encodeURIComponent(id)}`); }
    catch (error) { if ((error as { providerStatus?: number }).providerStatus !== 404) throw error; }
  }
}
