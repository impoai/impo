import { setTimeout as delay } from 'node:timers/promises';
import { ListeningRepository } from './repository.js';
import { TranscriptionError, type Transcriber } from './transcriber.js';

export class ListeningWorker {
  constructor(private readonly repository: ListeningRepository, private readonly transcriber: Transcriber,
    private readonly options = { leaseMs: 60_000, pollIntervalMs: 1000 }) {}

  async tick(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const job = await this.repository.claim(this.options.leaseMs);
    if (!job) return false;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(300_000)]);
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.repository.renew(job, this.options.leaseMs).then(owned => {
        if (!owned) controller.abort();
      }).catch(() => controller.abort()).finally(() => { renewing = false; });
    }, Math.max(50, Math.floor(this.options.leaseMs / 3)));
    heartbeat.unref();
    try {
      if (job.attempts > 5 || !job.audio) { await this.repository.fail(job, false); return true; }
      const result = await this.transcriber.transcribe(job.audio, job.mimeType, combined);
      combined.throwIfAborted();
      await this.repository.complete(job, result);
    } catch (error) {
      // Shutdown/lease loss leaves the durable claim for recovery; deletion cannot be undone.
      if (signal.aborted || controller.signal.aborted) return true;
      await this.repository.fail(job, error instanceof TranscriptionError ? error.retryable : true);
    } finally { clearInterval(heartbeat); }
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!await this.tick(signal)) await delay(this.options.pollIntervalMs, undefined, { signal });
    }
  }
}
