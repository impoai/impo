import { Client, Connection, WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/client';
import { backgroundWorkflowId } from './contract.js';
import { temporalTaskQueue, type TemporalOptions } from '../temporal/config.js';

export async function createBackgroundClient(config: TemporalOptions) {
  const connection = await Connection.connect({ address: config.address, ...(config.apiKey ? { tls: true, apiKey: config.apiKey } : {}), connectTimeout: '10 seconds' });
  const client = new Client({ connection, namespace: config.namespace });
  return {
    client,
    close: () => connection.close(),
    async ensure(userId: string) {
      await connection.withDeadline(Date.now() + 10000, () => client.workflow.start('userBackgroundWorkflow', {
        workflowId: backgroundWorkflowId(userId), taskQueue: config.taskQueue ?? temporalTaskQueue,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
        args: [{ userId }],
      }));
    },
  };
}
