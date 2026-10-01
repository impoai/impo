import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy, type Client } from '@temporalio/client';
import { temporalTaskQueue } from '../temporal/config.js';
import { NotificationRepository } from '../db/repositories/notification-repository.js';
import type { PushSender } from './fcm.js';

export function notificationActivities(repository: NotificationRepository, sender: PushSender) {
  return { async deliverNotification(eventId: string) {
    let retryAfterMs = 5000;
    for (const row of await repository.deliveries(eventId)) {
      const claim = await repository.claim(row.id);
      if (!claim) continue;
      const { event, delivery, installation } = claim;
      const result = await sender.send({ token: installation.token!, platform: installation.platform, registrationId: installation.registrationId,
        eventId: event.id, category: event.category, targetId: event.targetId, failed: event.failed, expiresAt: event.expiresAt });
      await repository.finish(delivery.id, delivery.leaseToken, result);
      retryAfterMs = Math.max(retryAfterMs, result.retryAfterMs ?? 0);
      console.log(JSON.stringify({ event: 'notification.delivery', eventId, deliveryId: delivery.id, status: result.status, code: result.code }));
    }
    return { done: await repository.completeIfFinished(eventId), retryAfterMs: Math.min(retryAfterMs, 3600_000) };
  } };
}

/** Outbox discovery only; Temporal owns delivery retries and timers. */
export class NotificationProvisioner {
  constructor(private readonly repository: NotificationRepository, private readonly client: Client, private readonly taskQueue = temporalTaskQueue) {}
  async scan() {
    for (const row of await this.repository.pending()) {
      await this.client.connection.withDeadline(Date.now() + 10_000, () => this.client.workflow.start('notificationWorkflow', {
        workflowId: `impo/notification/${row.id}`, taskQueue: this.taskQueue, args: [row.id],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING, workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      }));
      await this.repository.scheduled(row.id);
    }
  }
  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      try { await this.scan(); } catch { if (!signal.aborted) console.log(JSON.stringify({ event: 'notification.discovery_failed' })); }
      try { await delay(2000, undefined, { signal }); } catch { if (!signal.aborted) throw Error('notification_discovery_timer_failed'); }
    }
  }
}
