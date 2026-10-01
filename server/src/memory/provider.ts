import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ServiceError } from '../errors.js';

export interface MemoryDatabaseLocation { url: string }
/** Creates (or finds) one database by a stable name; must be safe to repeat. */
export interface MemoryDatabaseProvider {
  ensure(name: string, signal?: AbortSignal): Promise<MemoryDatabaseLocation>;
  /** libSQL auth token for every database this provider creates. */
  readonly authToken?: string;
}

export interface TursoConfig {
  apiToken: string; organization: string; group: string;
  /** A group token (`turso group tokens create`) authorizes every database in the group. */
  databaseAuthToken: string;
  baseURL: string; timeoutMs: number;
}

/** Turso Platform API: unlimited databases in one group, one per user. */
export class TursoProvider implements MemoryDatabaseProvider {
  readonly authToken: string;
  constructor(private readonly config: TursoConfig) { this.authToken = config.databaseAuthToken; }

  async delete(name: string): Promise<void> {
    const url = `${this.config.baseURL}/v1/organizations/${encodeURIComponent(this.config.organization)}/databases/${encodeURIComponent(name)}`;
    const response = await this.request(url, { method: 'DELETE' });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) throw new Error('memory_delete_failed');
  }

  async ensure(name: string, signal?: AbortSignal): Promise<MemoryDatabaseLocation> {
    const base = `${this.config.baseURL}/v1/organizations/${encodeURIComponent(this.config.organization)}/databases`;
    const created = await this.request(base, { method: 'POST', body: JSON.stringify({ name, group: this.config.group }) }, signal);
    // A lost response or a concurrent first request leaves the database already there.
    const response = created.status === 409 ? await this.request(`${base}/${encodeURIComponent(name)}`, { method: 'GET' }, signal) : created;
    if (!response.ok) throw new ServiceError(502, 'memory_provision_failed', 'The memory database could not be created', response.status >= 500 || response.status === 429);
    const body = await response.json() as { database?: { Hostname?: unknown } };
    const hostname = body.database?.Hostname;
    if (typeof hostname !== 'string' || !/^[a-z0-9.-]+$/.test(hostname)) throw new ServiceError(502, 'memory_provision_failed', 'The memory database returned no address', true);
    return { url: `libsql://${hostname}` };
  }

  private request(url: string, init: RequestInit, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    return fetch(url, { ...init, headers: { authorization: `Bearer ${this.config.apiToken}`, 'content-type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  }
}

/** One SQLite file per user; development and tests only. */
export class LocalFileProvider implements MemoryDatabaseProvider {
  constructor(private readonly directory: string) {}
  async delete(name: string): Promise<void> {
    if (!/^impo-mem-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid memory database name');
    for (const suffix of ['.db', '.db-shm', '.db-wal']) await rm(resolve(this.directory, `${name}${suffix}`), { force: true });
  }
  async ensure(name: string): Promise<MemoryDatabaseLocation> {
    const directory = resolve(this.directory);
    await mkdir(directory, { recursive: true });
    return { url: pathToFileURL(resolve(directory, `${name}.db`)).href };
  }
}
