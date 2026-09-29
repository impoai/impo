import { setTimeout as delay } from 'node:timers/promises';
import { backgroundLog } from './activities.js';
import type { BackgroundUsers } from './repository.js';

/** Discovery only: Temporal, not this polling loop, owns the hourly schedule. */
export class BackgroundProvisioner {
  private readonly ensuredUntil = new Map<string, number>();
  constructor(private readonly users: BackgroundUsers, private readonly starter: { ensure(userId: string): Promise<void> }) {}

  async scan(signal: AbortSignal): Promise<void> {
    const seen = new Set<string>();
    let after: string | undefined;
    let ensured = 0;
    let failed = 0;
    while (!signal.aborted) {
      const page = await this.users.list(after, 100);
      if (!page.length) break;
      for (let offset = 0; offset < page.length && !signal.aborted; offset += 4) {
        await Promise.all(page.slice(offset, offset + 4).map(async ({ id }) => {
          seen.add(id);
          if ((this.ensuredUntil.get(id) ?? 0) > Date.now()) return;
          try {
            await this.starter.ensure(id);
            // A restart rechecks everyone; periodic reconciliation also repairs unexpectedly closed workflows.
            this.ensuredUntil.set(id, Date.now() + 6 * 60 * 60 * 1000);
            ensured++;
          } catch { failed++; backgroundLog('ensure_failed', { userId: id }); }
        }));
      }
      after = page.at(-1)!.id;
    }
    if (!signal.aborted) for (const id of this.ensuredUntil.keys()) if (!seen.has(id)) this.ensuredUntil.delete(id);
    if (ensured || failed) backgroundLog('provisioned', { users: seen.size, ensured, failed });
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.scan(signal); }
      catch { if (!signal.aborted) backgroundLog('discovery_failed'); }
      try { await delay(60000, undefined, { signal }); }
      catch { if (!signal.aborted) throw new Error('Background discovery timer failed'); }
    }
  }
}
