import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowIdReusePolicy, type Client } from '@temporalio/client';
import type { ScheduledTaskRepository } from '../db/repositories/scheduled-task-repository.js';
import { temporalTaskQueue } from '../temporal/config.js';
import { scheduledTaskWorkflowId } from './contract.js';

export function scheduledTaskActivities(repository: ScheduledTaskRepository) {
  return { planScheduledTask: (userId: string, id: string) => repository.plan(userId, id),
    startScheduledTask: (userId: string, id: string, revision: string, at: number) => repository.fire(userId, id, revision, at) };
}
export class ScheduledTaskProvisioner {
  private readonly known = new Map<string, { revision: string; until: number }>();
  constructor(private readonly repository: ScheduledTaskRepository, private readonly client: Client, private readonly taskQueue = temporalTaskQueue) {}
  async scan() {
    const seen = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const rows = await this.repository.discover(after);
      if (!rows.length) break;
      for (const row of rows) {
        seen.add(row.id);
        const cached = this.known.get(row.id);
        if (cached?.revision === row.revision && cached.until > Date.now()) continue;
        await this.client.connection.withDeadline(Date.now() + 10_000, () => this.client.workflow.signalWithStart('scheduledTaskWorkflow', {
          workflowId: scheduledTaskWorkflowId(row.userId, row.id), taskQueue: this.taskQueue, args: [row.userId, row.id],
          signal: 'taskScheduleChanged', signalArgs: [row.revision], workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
        }));
        this.known.set(row.id, { revision: row.revision, until: Date.now() + 6 * 3600_000 });
      }
      after = rows.at(-1)!.id;
    }
    for (const id of this.known.keys()) if (!seen.has(id)) this.known.delete(id);
  }
  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      try { await this.scan(); } catch { if (!signal.aborted) console.log(JSON.stringify({ event: 'task_schedule.discovery_failed' })); }
      try { await delay(2000, undefined, { signal }); } catch { if (!signal.aborted) throw new Error('Task schedule discovery timer failed'); }
    }
  }
}
