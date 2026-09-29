import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { NativeConnection, Worker, type WorkerOptions } from '@temporalio/worker';
import { temporalTaskQueue, type TemporalOptions } from './config.js';

export async function createTemporalWorker(config: TemporalOptions, activities: WorkerOptions['activities']) {
  const connection = await NativeConnection.connect({ address: config.address, ...(config.apiKey ? { tls: true, apiKey: config.apiKey } : {}) });
  try {
    const worker = await Worker.create({ connection, namespace: config.namespace, taskQueue: config.taskQueue ?? temporalTaskQueue,
      identity: `impo-worker-${randomUUID()}`,
      workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)), activities,
      maxConcurrentActivityTaskExecutions: 4, maxTaskQueueActivitiesPerSecond: 2,
    });
    return { worker, close: () => connection.close() };
  } catch (error) { await connection.close(); throw error; }
}
