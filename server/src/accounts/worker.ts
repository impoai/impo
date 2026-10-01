import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy, type Client } from '@temporalio/client';
import { AccountDeletionRepository } from '../db/repositories/account-deletion-repository.js';
import { deletionGraceMs, type DeletionManifest } from './contract.js';
import { temporalTaskQueue } from '../temporal/config.js';

export type AccountCleanup = Record<string, (userId: string, manifest: DeletionManifest) => Promise<void>>;
export function accountDeletionActivities(repository: AccountDeletionRepository, cleanup: AccountCleanup) {
  return {
    async cleanupAccount(id: string): Promise<number> {
      const row = await repository.work(id);
      if (!row) return 0;
      // Continue independent cleanup when one provider is unavailable. Never log provider exceptions.
      const failures: string[] = [];
      for (const [name, remove] of Object.entries(cleanup)) {
        try { await remove(row.userId, row.manifest!); } catch { failures.push(name); }
      }
      if (failures.length) {
        await repository.failure(id, failures.join(','));
        console.error(JSON.stringify({ event: 'account_deletion.cleanup_failed', requestId: id, providers: failures }));
        throw new Error('Account cleanup will retry');
      }
      return Math.max(0, row.requestedAt!.getTime() + deletionGraceMs - Date.now());
    },
    async finishAccountDeletion(id: string): Promise<void> {
      await repository.complete(id);
      console.log(JSON.stringify({ event: 'account_deletion.completed', requestId: id }));
    },
  };
}

export class AccountDeletionProvisioner {
  constructor(private readonly repository: AccountDeletionRepository, private readonly client: Client, private readonly taskQueue = temporalTaskQueue) {}
  async scan() {
    for (const row of await this.repository.pending()) await this.client.connection.withDeadline(Date.now() + 10_000, () =>
      this.client.workflow.start('accountDeletionWorkflow', { workflowId: `impo/account-deletion/${row.id}`, taskQueue: this.taskQueue, args: [row.id],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING, workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE }));
  }
  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      try { await this.scan(); } catch { if (!signal.aborted) console.error(JSON.stringify({ event: 'account_deletion.discovery_failed' })); }
      try { await delay(2000, undefined, { signal }); } catch { if (!signal.aborted) throw new Error('Account deletion discovery timer failed'); }
    }
  }
}
