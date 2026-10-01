import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LeaseLostError } from '../errors.js';
import { RuntimeRepository } from '../db/repositories/runtime-repository.js';
import { dispatchTool } from '../tools/dispatcher.js';
import { developmentToolRegistry, type ToolRegistry } from '../tools/registry.js';

export class DevelopmentWorker {
  private readonly id = randomUUID();
  constructor(private readonly repository: RuntimeRepository, private readonly options: { leaseMs: number; pollIntervalMs: number }, private readonly registry: ToolRegistry = developmentToolRegistry()) {}

  /** Run one claimed stage; interruption leaves a lease that another process can reclaim. */
  async tick(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const job = await this.repository.claimJob(this.id, this.options.leaseMs);
    if (!job) return false;
    try {
      switch (job.type) {
        case 'submission.prepare': await this.repository.prepareSubmission(job); break;
        case 'tool.execute': {
          const invocation = await this.repository.getToolForJob(job);
          const result = await dispatchTool(this.registry, invocation, signal);
          await this.repository.saveToolResult(job, result);
          break;
        }
        case 'submission.complete': await this.repository.completeSubmission(job); break;
        default: throw new Error('Unsupported durable job type');
      }
    } catch (error) {
      if (error instanceof LeaseLostError) return true;
      if (signal.aborted) throw error;
      // Do not expose database query text or tool data in operational logs/results.
      process.stderr.write(JSON.stringify({ event: 'job_failed', jobId: job.id, type: job.type }) + '\n');
      try { await this.repository.releaseJob(job, { code: 'worker_error', message: 'Development worker could not complete this stage', retryable: true }); }
      catch (releaseError) { if (!(releaseError instanceof LeaseLostError)) throw releaseError; }
    }
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!await this.tick(signal)) await delay(this.options.pollIntervalMs, undefined, { signal });
    }
  }
}
