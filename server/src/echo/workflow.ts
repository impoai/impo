import { condition, continueAsNew, defineSignal, proxyActivities, setHandler, workflowInfo } from '@temporalio/workflow';
import type { echoScheduleActivities } from './worker.js';

export const echoScheduleChanged = defineSignal<[string]>('echoScheduleChanged');
const activities = proxyActivities<ReturnType<typeof echoScheduleActivities>>({
  startToCloseTimeout: '30 seconds', retry: { initialInterval: '1 second', maximumInterval: '1 minute' },
});
/** Only sends reminders. A workflow never starts or stops a device's microphone. */
export async function echoScheduleWorkflow(userId: string): Promise<void> {
  let changed = false;
  let currentRevision: string | null = null;
  setHandler(echoScheduleChanged, revision => { if (revision !== currentRevision) changed = true; });
  for (let turns = 0; ; turns++) {
    changed = false;
    const plan = await activities.planEchoReminder(userId);
    if (changed) continue;
    currentRevision = plan.revision;
    if (plan.nextAt === null || !plan.revision) return;
    if (!await condition(() => changed, Math.max(1, plan.nextAt - Date.now()))) {
      await activities.sendEchoReminder(userId, plan.revision, plan.nextAt);
    }
    if (turns >= 30 || workflowInfo().continueAsNewSuggested) return continueAsNew<typeof echoScheduleWorkflow>(userId);
  }
}
