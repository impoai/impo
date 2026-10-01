import { proxyActivities, sleep } from '@temporalio/workflow';
import type { notificationActivities } from './worker.js';
const activities = proxyActivities<ReturnType<typeof notificationActivities>>({ startToCloseTimeout: '5 minutes', retry: { initialInterval: '5 seconds', maximumInterval: '1 minute' } });
export async function notificationWorkflow(eventId: string): Promise<void> {
  for (;;) {
    const result = await activities.deliverNotification(eventId);
    if (result.done) return;
    await sleep(result.retryAfterMs);
  }
}
