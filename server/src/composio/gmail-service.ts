import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { ServiceError } from '../errors.js';
import { ConnectorRepository, type ConnectorConnection } from '../persistence/connector-repository.js';
import { GMAIL_ALLOWED_TOOL_SLUGS } from '../tools/gmail-tools.js';
import { jsonValue } from '../tools/device-tools.js';
import { ComposioProvider, type ComposioConfig, type ConnectedAccount } from './provider.js';

export interface GmailStatus { status: 'disconnected' | 'pending' | 'connected' | 'expired'; email?: string; expiresAt?: string }
export interface GmailConnectorAPI {
  getStatus(userId: string): Promise<GmailStatus>;
  connect(userId: string): Promise<{ redirectURL: string; expiresAt: string }>;
  refresh(userId: string): Promise<GmailStatus>;
  disconnect(userId: string): Promise<void>;
}
const metaTools = ['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'COMPOSIO_MULTI_EXECUTE_TOOL'];
const routingKeys = new Set(['account', 'accounts', 'connected_account_id', 'connectedAccountId', 'connected_accounts', 'connection_id', 'connectionId', 'entity_id', 'entityId', 'userId', 'auth_config_id', 'auth_configs', 'toolkits']);
const secretKeys = new Set(['access_token', 'refresh_token', 'client_secret', 'api_key', 'apikey', 'authorization', 'x-api-key']);

/** Arguments choose an operation, never a provider identity or credential. */
function rejectRoutingOverrides(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(rejectRoutingOverrides); return; }
  for (const [key, child] of Object.entries(value)) {
    if (routingKeys.has(key) || (key === 'user_id' && child !== 'me')) throw new ServiceError(400, 'invalid_tool_arguments', 'Gmail account routing is selected by Impo');
    rejectRoutingOverrides(child);
  }
}
function safeResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeResult);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKeys.has(key.toLowerCase())).map(([key, child]) => [key, safeResult(child)]));
  return value;
}
function view(connection: ConnectorConnection | undefined): GmailStatus {
  if (!connection) return { status: 'disconnected' };
  const status = connection.disconnectRequested || (connection.status === 'pending' && connection.expiresAt && connection.expiresAt.getTime() <= Date.now()) ? 'expired' : connection.status;
  return { status, ...(connection.email ? { email: connection.email } : {}), ...(status === 'pending' && connection.expiresAt ? { expiresAt: connection.expiresAt.toISOString() } : {}) };
}

/** User-owned Gmail connection, independent of a chat Session or an iPhone lifetime. */
export class GmailConnectorService implements GmailConnectorAPI {
  private readonly repository: ConnectorRepository;
  private readonly provider: ComposioProvider;
  constructor(db: Database, private readonly config: ComposioConfig) {
    this.repository = new ConnectorRepository(db);
    this.provider = new ComposioProvider(config);
  }

  async getStatus(userId: string): Promise<GmailStatus> { return view(await this.repository.get(userId)); }

  private owned(connection: ConnectorConnection, account: ConnectedAccount, requirePinned = true): void {
    if (account.entityId !== connection.entityId || account.authConfigId !== connection.authConfigId || account.toolkit !== 'gmail' || (requirePinned && connection.connectedAccountId && account.id !== connection.connectedAccountId)) throw new ServiceError(409, 'gmail_account_mismatch', 'Composio account does not belong to this Gmail connection');
  }

  async connect(userId: string): Promise<{ redirectURL: string; expiresAt: string }> {
    let connection = await this.repository.reserve(userId, this.config.authConfigId);
    try {
      if (connection.disconnectRequested) throw new ServiceError(409, 'gmail_disconnect_pending', 'Finish disconnecting the previous Gmail account first', true);
      if (connection.status === 'connected') throw new ServiceError(409, 'gmail_already_connected', 'Gmail is already connected');
      if (view(connection).status === 'expired') {
        connection = await this.repository.update(connection, { disconnectRequested: true });
        await this.cleanup(connection);
        connection = await this.repository.update(connection, { status: 'disconnected', connectedAccountId: null, routerSessionId: null, redirectURL: null, expiresAt: null, email: null, disconnectRequested: false });
      }
      if (connection.status === 'pending' && connection.redirectURL && connection.expiresAt) return { redirectURL: connection.redirectURL, expiresAt: connection.expiresAt.toISOString() };
      if (connection.status === 'disconnected') {
        const generation = randomUUID();
        connection = await this.repository.update(connection, { generation, entityId: `instant:development:${userId}:${generation}`, authConfigId: this.config.authConfigId, status: 'pending', expiresAt: new Date(Date.now() + 20 * 60_000), verifiedAt: null });
      }
      // A lost link response retains the same entity; refresh can still discover
      // only accounts created by this attempt. Never borrow an existing Rebyte account.
      const link = await this.provider.createLink(connection.entityId, undefined, connection.authConfigId);
      connection = await this.repository.update(connection, { redirectURL: link.redirectURL });
      return { redirectURL: link.redirectURL, expiresAt: connection.expiresAt!.toISOString() };
    } finally { await this.repository.release(connection); }
  }

  async refresh(userId: string): Promise<GmailStatus> {
    let connection = await this.repository.reserve(userId, this.config.authConfigId);
    try {
      if (connection.disconnectRequested || connection.status === 'disconnected') return view(connection);
      if (connection.status === 'connected' || connection.status === 'expired') {
        if (!connection.connectedAccountId) return view(connection);
        const account = await this.provider.account(connection.connectedAccountId);
        this.owned(connection, account);
        const healthy = account.status === 'ACTIVE' && !account.disabled && !account.authConfigDisabled;
        connection = await this.repository.update(connection, { status: healthy && connection.routerSessionId ? 'connected' : 'expired', verifiedAt: new Date() });
        return view(connection);
      }
      if (connection.expiresAt!.getTime() <= Date.now()) {
        connection = await this.repository.update(connection, { status: 'expired' });
        return view(connection);
      }
      const ids = await this.provider.accounts(connection.entityId, connection.authConfigId);
      if (ids.length > 5) throw new ServiceError(409, 'gmail_account_ambiguous', 'Multiple Gmail authorization attempts need to be disconnected');
      const accounts: ConnectedAccount[] = [];
      for (const id of ids) {
        const account = await this.provider.account(id);
        this.owned(connection, account);
        if (account.status === 'ACTIVE' && !account.disabled && !account.authConfigDisabled) accounts.push(account);
      }
      if (!accounts.length) return view(connection);
      if (accounts.length !== 1) throw new ServiceError(409, 'gmail_account_ambiguous', 'More than one account completed this Gmail authorization');
      connection = await this.repository.update(connection, { connectedAccountId: accounts[0]!.id });
      const routerSessionId = connection.routerSessionId ?? await this.provider.createRouter(connection.entityId, connection.connectedAccountId!, connection.authConfigId);
      connection = await this.repository.update(connection, { status: 'connected', routerSessionId, redirectURL: null, expiresAt: null, verifiedAt: new Date() });
      return view(connection);
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'composio_not_found' && connection.connectedAccountId) {
        connection = await this.repository.update(connection, { status: 'expired', verifiedAt: new Date() });
        return view(connection);
      }
      throw error;
    } finally { await this.repository.release(connection); }
  }

  private async cleanup(connection: ConnectorConnection): Promise<void> {
    const ids = [...new Set([...(connection.connectedAccountId ? [connection.connectedAccountId] : []), ...await this.provider.accounts(connection.entityId, connection.authConfigId)])];
    if (ids.length > 5) throw new ServiceError(409, 'gmail_account_ambiguous', 'Too many pending Gmail accounts to disconnect automatically');
    for (const id of ids) {
      let account: ConnectedAccount;
      try { account = await this.provider.account(id); }
      catch (error) { if (error instanceof ServiceError && error.code === 'composio_not_found') continue; throw error; }
      this.owned(connection, account, false);
      await this.provider.revoke(id);
    }
    if (connection.routerSessionId) await this.provider.deleteRouter(connection.routerSessionId);
  }

  async disconnect(userId: string): Promise<void> {
    let connection = await this.repository.reserve(userId, this.config.authConfigId);
    try {
      if (connection.status === 'disconnected' && !connection.disconnectRequested) return;
      // Block new tool execution before provider revocation. Keep handles until
      // revocation succeeds, so a timeout can be retried without losing ownership.
      connection = await this.repository.update(connection, { disconnectRequested: true });
      await this.cleanup(connection);
      connection = await this.repository.update(connection, { status: 'disconnected', connectedAccountId: null, routerSessionId: null, redirectURL: null, expiresAt: null, email: null, verifiedAt: null, disconnectRequested: false });
    } finally { await this.repository.release(connection); }
  }

  async execute(userId: string, slug: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (!metaTools.includes(slug)) throw new ServiceError(400, 'unsupported_tool', 'Unsupported Gmail meta tool');
    jsonValue(args);
    rejectRoutingOverrides(args);
    const allowed = GMAIL_ALLOWED_TOOL_SLUGS as readonly string[];
    if (slug === 'COMPOSIO_GET_TOOL_SCHEMAS' && (!Array.isArray(args.tool_slugs) || !args.tool_slugs.length || args.tool_slugs.some(value => typeof value !== 'string' || !allowed.includes(value)))) throw new ServiceError(400, 'unsupported_tool', 'Only enabled Gmail tools can be inspected');
    if (slug === 'COMPOSIO_MULTI_EXECUTE_TOOL' && (!Array.isArray(args.tools) || args.tools.length !== 1 || args.tools.some(value => !value || typeof value !== 'object' || !allowed.includes((value as { tool_slug: string }).tool_slug)))) throw new ServiceError(400, 'unsupported_tool', 'Execute one enabled Gmail action at a time');
    const connection = await this.repository.get(userId);
    if (!connection || connection.status !== 'connected' || connection.disconnectRequested || !connection.connectedAccountId || !connection.routerSessionId) throw new ServiceError(409, 'gmail_connection_required', 'Connect Gmail before using its tools');
    let account: ConnectedAccount;
    try { account = await this.provider.account(connection.connectedAccountId, signal); }
    catch (error) {
      if (error instanceof ServiceError && error.code === 'composio_not_found') { await this.repository.expire(connection); throw new ServiceError(409, 'gmail_connection_expired', 'Reconnect Gmail before using its tools'); }
      throw error;
    }
    this.owned(connection, account);
    if (account.status !== 'ACTIVE' || account.disabled || account.authConfigDisabled) {
      await this.repository.expire(connection);
      throw new ServiceError(409, 'gmail_connection_expired', 'Reconnect Gmail before using its tools');
    }
    await this.repository.assertCurrent(connection);
    try {
      // Preserve Composio's per-action success/error envelope for the agent.
      const result = await this.provider.execute(connection.routerSessionId, slug, args, signal);
      jsonValue(result);
      return safeResult(result);
    } catch (error) {
      if (signal.aborted) throw error;
      const providerStatus = (error as { providerStatus?: number }).providerStatus;
      if (slug === 'COMPOSIO_MULTI_EXECUTE_TOOL' && (providerStatus === undefined || providerStatus >= 500)) {
        throw new ServiceError(502, 'execution_outcome_unknown', 'Gmail may have completed this action before its response was lost. Do not repeat draft creation; check Gmail drafts first.', false);
      }
      throw error;
    }
  }
}
