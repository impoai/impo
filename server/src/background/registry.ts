import type { BackgroundTick } from './contract.js';

export interface BackgroundStepContext extends BackgroundTick {
  /** Stable across retries. Side effects must use this key for durable deduplication. */
  idempotencyKey: string;
  signal: AbortSignal;
}
export interface BackgroundStep {
  /** Version the key when changing a step's contract, e.g. recent-review.v1. */
  key: string;
  run(context: BackgroundStepContext): Promise<void>;
}

/** Empty default for isolated framework tests. Production injects Today via worker-main.ts. */
export const backgroundSteps: readonly BackgroundStep[] = [];
