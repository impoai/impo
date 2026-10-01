import { proxyActivities, sleep } from '@temporalio/workflow';
import type { accountDeletionActivities } from './worker.js';

const activities = proxyActivities<ReturnType<typeof accountDeletionActivities>>({
  startToCloseTimeout: '10 minutes',
  retry: { initialInterval: '30 seconds', maximumInterval: '30 minutes' },
});

/** Arguments and history contain only the deletion request ID, never user content or credentials. */
export async function accountDeletionWorkflow(requestId: string): Promise<void> {
  const waitMs = await activities.cleanupAccount(requestId);
  if (waitMs > 0) await sleep(waitMs);
  // A second sweep removes uploads and provider creations already in flight at confirmation.
  await activities.cleanupAccount(requestId);
  await activities.finishAccountDeletion(requestId);
}
