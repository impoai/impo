import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { ServiceError } from '../errors.js';
import { ConnectorRepository, type ConnectorConnection } from '../persistence/connector-repository.js';
import { jsonValue } from '../tools/device-tools.js';
import { ConnectorCatalog, TOOLKIT_PATTERN, type CatalogConnector } from './catalog.js';
import { ComposioProvider, type ComposioConfig, type ConnectedAccount } from './provider.js';

export type ConnectionStatus = 'disconnected' | 'pending' | 'connected' | 'expired';
export interface ConnectorStatus { status: ConnectionStatus; email?: string; expiresAt?: string }
export interface ConnectorSummary extends ConnectorStatus { toolkit: string; name: string; description?: string; logoURL?: string; featured: boolean }
export interface ConnectorAPI {
  list(userId: string): Promise<ConnectorSummary[]>;
  getStatus(userId: string, toolkit: string): Promise<ConnectorStatus>;
  connect(userId: string, toolkit: string): Promise<{ redirectURL: string; expiresAt: string }>;
  refresh(userId: string, toolkit: string): Promise<ConnectorStatus>;
  disconnect(userId: string, toolkit: string): Promise<void>;
}
export interface ConnectorExecutor {
  connected(userId: string): Promise<{ connector: string; name: string }[]>;
  execute(userId: string, toolkit: string, slug: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export const META_TOOLS = ['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'COMPOSIO_MULTI_EXECUTE_TOOL'] as const;
export type MetaTool = typeof META_TOOLS[number];
// The Tool Router Session is already pinned to one account; these keys would ask it to pick another.
const routingKeys = new Set(['account', 'accounts', 'connected_account_id', 'connectedAccountId', 'connected_accounts', 'connection_id', 'connectionId', 'entity_id', 'entityId', 'user_id', 'userId', 'auth_config_id', 'auth_configs', 'toolkits']);
const secretKeys = new Set(['access_token', 'refresh_token', 'client_secret', 'api_key', 'apikey', 'authorization', 'x-api-key']);

function rejectRoutingOverrides(value: Record<string, unknown>): void {
  if (Object.keys(value).some(key => routingKeys.has(key))) throw new ServiceError(400, 'invalid_tool_arguments', 'The connected account is selected by Impo');
}
function safeResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeResult);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKeys.has(key.toLowerCase())).map(([key, child]) => [key, safeResult(child)]));
  return value;
}
function view(connection: ConnectorConnection | undefined): ConnectorStatus {
  if (!connection) return { status: 'disconnected' };
  const status = connection.disconnectRequested || (connection.status === 'pending' && connection.expiresAt && connection.expiresAt.getTime() <= Date.now()) ? 'expired' : connection.status;
  return { status, ...(connection.email ? { email: connection.email } : {}), ...(status === 'pending' && connection.expiresAt ? { expiresAt: connection.expiresAt.toISOString() } : {}) };
}
function toolkitName(toolkit: string): string {
  if (!TOOLKIT_PATTERN.test(toolkit)) throw new ServiceError(404, 'connector_not_found', 'This connector is not available');
  return toolkit;
}

/**
 * User-owned Composio connections, one per toolkit, independent of a chat Session or an
 * iPhone lifetime. Mirrors Rebyte: every Connection owns one Tool Router Session, and the
 * agent reaches all of them through the same fixed search/schema/execute meta-tools.
 */
export class ConnectorService implements ConnectorAPI, ConnectorExecutor {
  private readonly repository: ConnectorRepository;
  private readonly provider: ComposioProvider;
  private readonly catalog: ConnectorCatalog;
  constructor(db: Database, config: ComposioConfig) {
    this.repository = new ConnectorRepository(db);
    this.provider = new ComposioProvider(config);
    this.catalog = new ConnectorCatalog(this.provider);
  }

  /** The directory takes a few seconds to load; fetch it before the first Connections screen does. */
  warm(): void { void this.catalog.list().catch(() => undefined); }

  async list(userId: string): Promise<ConnectorSummary[]> {
    const [catalog, connections] = await Promise.all([this.catalog.list(), this.repository.list(userId)]);
    const rows = new Map(connections.map(connection => [connection.toolkit, connection]));
    const summary = (connector: Pick<CatalogConnector, 'toolkit' | 'name' | 'description' | 'logoURL' | 'featured'>): ConnectorSummary => ({
      toolkit: connector.toolkit, name: connector.name, ...(connector.description ? { description: connector.description } : {}), ...(connector.logoURL ? { logoURL: connector.logoURL } : {}), featured: connector.featured, ...view(rows.get(connector.toolkit)),
    });
    const listed = catalog.map(summary);
    // A connection whose connector left the shelf must stay visible so it can be disconnected.
    for (const connection of connections) {
      if (!catalog.some(item => item.toolkit === connection.toolkit) && (connection.status !== 'disconnected' || connection.disconnectRequested)) listed.push(summary({ toolkit: connection.toolkit, name: connection.toolkit, featured: false }));
    }
    return listed;
  }

  async getStatus(userId: string, toolkit: string): Promise<ConnectorStatus> {
    const connection = await this.repository.get(userId, toolkitName(toolkit));
    if (!connection) await this.catalog.get(toolkit);
    return view(connection);
  }

  private async reserve(userId: string, toolkit: string): Promise<ConnectorConnection> {
    const existing = await this.repository.get(userId, toolkitName(toolkit));
    return this.repository.reserve(userId, toolkit, existing?.authConfigId ?? (await this.catalog.get(toolkit)).authConfigId);
  }

  private owned(connection: ConnectorConnection, account: ConnectedAccount, requirePinned = true): void {
    if (account.entityId !== connection.entityId || account.authConfigId !== connection.authConfigId || account.toolkit !== connection.toolkit || (requirePinned && connection.connectedAccountId && account.id !== connection.connectedAccountId)) throw new ServiceError(409, 'connector_account_mismatch', 'Composio account does not belong to this connection');
  }

  async connect(userId: string, toolkit: string): Promise<{ redirectURL: string; expiresAt: string }> {
    const shelf = await this.catalog.get(toolkitName(toolkit));
    let connection = await this.repository.reserve(userId, toolkit, shelf.authConfigId);
    try {
      if (connection.disconnectRequested) throw new ServiceError(409, 'connector_disconnect_pending', 'Finish disconnecting the previous account first', true);
      if (connection.status === 'connected') throw new ServiceError(409, 'connector_already_connected', `${shelf.name} is already connected`);
      if (view(connection).status === 'expired') {
        connection = await this.repository.update(connection, { disconnectRequested: true });
        await this.cleanup(connection);
        connection = await this.repository.update(connection, { status: 'disconnected', connectedAccountId: null, routerSessionId: null, redirectURL: null, expiresAt: null, email: null, disconnectRequested: false });
      }
      if (connection.status === 'pending' && connection.redirectURL && connection.expiresAt) return { redirectURL: connection.redirectURL, expiresAt: connection.expiresAt.toISOString() };
      if (connection.status === 'disconnected') {
        const generation = randomUUID();
        connection = await this.repository.update(connection, { generation, entityId: `instant:development:${userId}:${generation}`, authConfigId: shelf.authConfigId, status: 'pending', expiresAt: new Date(Date.now() + 20 * 60_000), verifiedAt: null });
      }
      // A lost link response retains the same entity; refresh can still discover
      // only accounts created by this attempt. Never borrow an existing Rebyte account.
      const link = await this.provider.createLink(connection.entityId, connection.authConfigId);
      connection = await this.repository.update(connection, { redirectURL: link.redirectURL });
      return { redirectURL: link.redirectURL, expiresAt: connection.expiresAt!.toISOString() };
    } finally { await this.repository.release(connection); }
  }

  async refresh(userId: string, toolkit: string): Promise<ConnectorStatus> {
    let connection = await this.reserve(userId, toolkit);
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
      if (ids.length > 5) throw new ServiceError(409, 'connector_account_ambiguous', 'Multiple authorization attempts need to be disconnected');
      const accounts: ConnectedAccount[] = [];
      for (const id of ids) {
        const account = await this.provider.account(id);
        this.owned(connection, account);
        if (account.status === 'ACTIVE' && !account.disabled && !account.authConfigDisabled) accounts.push(account);
      }
      if (!accounts.length) return view(connection);
      if (accounts.length !== 1) throw new ServiceError(409, 'connector_account_ambiguous', 'More than one account completed this authorization');
      connection = await this.repository.update(connection, { connectedAccountId: accounts[0]!.id });
      const routerSessionId = connection.routerSessionId ?? await this.provider.createRouter(connection.entityId, connection.toolkit, connection.connectedAccountId!, connection.authConfigId);
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
    if (ids.length > 5) throw new ServiceError(409, 'connector_account_ambiguous', 'Too many pending accounts to disconnect automatically');
    for (const id of ids) {
      let account: ConnectedAccount;
      try { account = await this.provider.account(id); }
      catch (error) { if (error instanceof ServiceError && error.code === 'composio_not_found') continue; throw error; }
      this.owned(connection, account, false);
      await this.provider.revoke(id);
    }
    if (connection.routerSessionId) await this.provider.deleteRouter(connection.routerSessionId);
  }

  async disconnect(userId: string, toolkit: string): Promise<void> {
    if (!await this.repository.get(userId, toolkitName(toolkit))) return;
    let connection = await this.reserve(userId, toolkit);
    try {
      if (connection.status === 'disconnected' && !connection.disconnectRequested) return;
      // Block new tool execution before provider revocation. Keep handles until
      // revocation succeeds, so a timeout can be retried without losing ownership.
      connection = await this.repository.update(connection, { disconnectRequested: true });
      await this.cleanup(connection);
      connection = await this.repository.update(connection, { status: 'disconnected', connectedAccountId: null, routerSessionId: null, redirectURL: null, expiresAt: null, email: null, verifiedAt: null, disconnectRequested: false });
    } finally { await this.repository.release(connection); }
  }

  /** Connected accounts the agent may use. Names come from the shelf when it is reachable. */
  async connected(userId: string): Promise<{ connector: string; name: string }[]> {
    const connections = (await this.repository.list(userId)).filter(connection => connection.status === 'connected' && !connection.disconnectRequested);
    if (!connections.length) return [];
    const names = new Map<string, string>();
    try { for (const item of await this.catalog.list()) names.set(item.toolkit, item.name); } catch { /* slugs are still usable */ }
    return connections.map(connection => ({ connector: connection.toolkit, name: names.get(connection.toolkit) ?? connection.toolkit })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(userId: string, toolkit: string, slug: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (!(META_TOOLS as readonly string[]).includes(slug)) throw new ServiceError(400, 'unsupported_tool', 'Unsupported connector meta tool');
    jsonValue(args);
    rejectRoutingOverrides(args);
    const connection = await this.repository.get(userId, toolkitName(toolkit));
    if (!connection || connection.status !== 'connected' || connection.disconnectRequested || !connection.connectedAccountId || !connection.routerSessionId) throw new ServiceError(409, 'connector_connection_required', `${toolkit} is not connected. Call instant_list_connectors, or ask the user to connect it in Library → Connections.`);
    // Like Rebyte, every tool the app's Composio toolkit offers is available. The Session
    // enables only this toolkit and this account, so a slug from another app cannot run.
    if (slug === 'COMPOSIO_MULTI_EXECUTE_TOOL') for (const item of args.tools as Record<string, unknown>[]) rejectRoutingOverrides(item);
    let account: ConnectedAccount;
    try { account = await this.provider.account(connection.connectedAccountId, signal); }
    catch (error) {
      if (error instanceof ServiceError && error.code === 'composio_not_found') { await this.repository.expire(connection); throw new ServiceError(409, 'connector_connection_expired', `Reconnect ${toolkit} before using its tools`); }
      throw error;
    }
    this.owned(connection, account);
    if (account.status !== 'ACTIVE' || account.disabled || account.authConfigDisabled) {
      await this.repository.expire(connection);
      throw new ServiceError(409, 'connector_connection_expired', `Reconnect ${toolkit} before using its tools`);
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
        throw new ServiceError(502, 'execution_outcome_unknown', `${toolkit} may have completed this action before its response was lost. Do not repeat a write; check the app first.`, false);
      }
      throw error;
    }
  }
}
