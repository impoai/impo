import { condition, continueAsNew, defineSignal, proxyActivities, setHandler, workflowInfo } from '@temporalio/workflow';
import type { scheduledTaskActivities } from './worker.js';

const changed = defineSignal<[string]>('taskScheduleChanged');
const activities = proxyActivities<ReturnType<typeof scheduledTaskActivities>>({
  startToCloseTimeout: '1 minute', retry: { initialInterval: '1 second', maximumInterval: '1 minute' },
});
export async function scheduledTaskWorkflow(userId: string, id: string): Promise<void> {
  let dirty = false;
  let revision: string | null = null;
  setHandler(changed, value => { if (value !== revision) dirty = true; });
  for (let turns = 0; ; turns++) {
    dirty = false;
    const plan = await activities.planScheduledTask(userId, id);
    if (dirty) continue;
    revision = plan.revision;
    if (plan.nextAt === null || !revision) return;
    if (!await condition(() => dirty, Math.max(1, plan.nextAt - Date.now()))) {
      await activities.startScheduledTask(userId, id, revision, plan.nextAt);
    }
    if (turns >= 30 || workflowInfo().continueAsNewSuggested) return continueAsNew<typeof scheduledTaskWorkflow>(userId, id);
  }
}
