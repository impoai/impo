import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@temporalio/client';
import { WorkflowIdReusePolicy } from '@temporalio/client';
import { temporalTaskQueue } from '../temporal/config.js';
import { EchoScheduleRepository, storedEchoSchedule } from '../db/repositories/echo-schedule-repository.js';
import { echoScheduleWorkflowId } from './schedule.js';

export function echoScheduleActivities(repository: EchoScheduleRepository) {
  return {
    planEchoReminder: (userId: string) => repository.plan(userId),
    sendEchoReminder: (userId: string, revision: string, scheduledAt: number) => repository.remind(userId, revision, scheduledAt),
  };
}
/** Discovers changed plans; Temporal owns the calendar timer and durable retries. */
export class EchoScheduleProvisioner {
  private readonly known = new Map<string, { revision: string; until: number }>();
  constructor(private readonly repository: EchoScheduleRepository, private readonly client: Client, private readonly taskQueue = temporalTaskQueue) {}
  async scan() {
    const seen = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const page = await this.repository.list(after);
      if (!page.length) break;
      for (const row of page) {
        seen.add(row.userId);
        const schedule = storedEchoSchedule(row.preferences.echoSchedule);
        if (!schedule.revision) continue;
        const cached = this.known.get(row.userId);
        if (cached?.revision === schedule.revision && cached.until > Date.now()) continue;
        await this.client.connection.withDeadline(Date.now() + 10_000, () => this.client.workflow.signalWithStart('echoScheduleWorkflow', {
          workflowId: echoScheduleWorkflowId(row.userId), taskQueue: this.taskQueue, args: [row.userId],
          signal: 'echoScheduleChanged', signalArgs: [schedule.revision], workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
        }));
        this.known.set(row.userId, { revision: schedule.revision, until: Date.now() + 6 * 3600_000 });
      }
      after = page.at(-1)!.userId;
    }
    for (const user of this.known.keys()) if (!seen.has(user)) this.known.delete(user);
  }
  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      try { await this.scan(); } catch { if (!signal.aborted) console.log(JSON.stringify({ event: 'echo.schedule_discovery_failed' })); }
      try { await delay(10_000, undefined, { signal }); } catch { if (!signal.aborted) throw new Error('echo_schedule_discovery_timer_failed'); }
    }
  }
}
