import { ServiceError } from '../errors.js';
import type { ComposioProvider } from './provider.js';

export interface CatalogConnector { toolkit: string; name: string; description?: string; logoURL?: string; featured: boolean; authConfigId: string }

// Rebyte's product-curated featured order (cctools rank_featured_composio_toolkits).
const FEATURED = ['gmail', 'googledrive', 'googlesheets', 'googlecalendar', 'outlook', 'notion', 'microsoft_teams', 'github', 'one_drive', 'excel', 'google_analytics', 'hubspot'];
const TTL_MS = 10 * 60_000;
export const TOOLKIT_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * The shelf is the Rebyte Composio shelf: every enabled managed auth config named
 * `<prefix><toolkit>` in the shared Composio project. Composio owns the OAuth apps;
 * Impo keeps only a short-lived in-memory copy of the directory.
 */
export class ConnectorCatalog {
  private cached?: { at: number; connectors: CatalogConnector[] };
  private loading?: Promise<CatalogConnector[]>;
  constructor(private readonly provider: ComposioProvider) {}

  async list(): Promise<CatalogConnector[]> {
    if (this.cached && Date.now() - this.cached.at < TTL_MS) return this.cached.connectors;
    this.loading ??= this.load().finally(() => { this.loading = undefined; });
    try { return await this.loading; }
    catch (error) { if (this.cached) return this.cached.connectors; throw error; }
  }

  async get(toolkit: string): Promise<CatalogConnector> {
    const connector = (await this.list()).find(item => item.toolkit === toolkit);
    if (!connector) throw new ServiceError(404, 'connector_not_found', 'This connector is not available');
    return connector;
  }

  private async load(): Promise<CatalogConnector[]> {
    const [configs, toolkits] = await Promise.all([this.provider.authConfigs(), this.provider.toolkits()]);
    const directory = new Map(toolkits.map(toolkit => [toolkit.slug, toolkit]));
    const byToolkit = new Map<string, CatalogConnector>();
    // Duplicate auth configs for one toolkit are ambiguous; keep the shelf deterministic.
    const counts = new Map<string, number>();
    for (const config of configs) counts.set(config.toolkit, (counts.get(config.toolkit) ?? 0) + 1);
    for (const config of configs) {
      if (!TOOLKIT_PATTERN.test(config.toolkit) || counts.get(config.toolkit) !== 1) continue;
      const meta = directory.get(config.toolkit);
      const logoURL = meta?.logoURL ?? config.logoURL;
      byToolkit.set(config.toolkit, { toolkit: config.toolkit, name: meta?.name ?? config.toolkit, ...(meta?.description ? { description: meta.description } : {}), ...(logoURL ? { logoURL } : {}), featured: FEATURED.includes(config.toolkit), authConfigId: config.id });
    }
    const rank = (toolkit: string) => { const index = FEATURED.indexOf(toolkit); return index < 0 ? FEATURED.length : index; };
    const connectors = [...byToolkit.values()].sort((a, b) => rank(a.toolkit) - rank(b.toolkit) || a.name.localeCompare(b.name));
    this.cached = { at: Date.now(), connectors };
    return connectors;
  }
}
