import { Context, heartbeat } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { BackgroundTick, BackgroundTickResult } from './contract.js';
import { backgroundSteps, type BackgroundStep } from './registry.js';
import type { BackgroundUsers } from './repository.js';

export const backgroundLog = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event: `background.${event}`, at: new Date().toISOString(), ...fields }));

export function createBackgroundActivities(users: BackgroundUsers, steps: readonly BackgroundStep[] = backgroundSteps) {
  const registry = new Map(steps.map(step => [step.key, step]));
  if (registry.size !== steps.length || steps.some(step => !/^[a-z][a-z0-9.-]{0,79}$/.test(step.key))) {
    throw new Error('Background step keys must be unique, stable and versioned');
  }
  return {
    async planBackgroundTick(tick: BackgroundTick): Promise<{ userExists: boolean; steps: string[] }> {
      const userExists = await users.exists(tick.userId);
      const keys = userExists ? [...registry.keys()] : [];
      backgroundLog('tick_started', { ...tick, userExists, steps: keys.length });
      return { userExists, steps: keys };
    },
    async executeBackgroundStep(tick: BackgroundTick, key: string): Promise<void> {
      const step = registry.get(key);
      if (!step) throw ApplicationFailure.nonRetryable('Background step is unavailable', 'background_step_unavailable');
      if (!await users.exists(tick.userId)) throw ApplicationFailure.nonRetryable('User no longer exists', 'background_user_missing');
      const context = Context.current();
      const fields = { ...tick, step: key, attempt: context.info.attempt };
      const timer = setInterval(() => heartbeat({ tickId: tick.tickId, step: key }), 5000);
      timer.unref();
      backgroundLog('step_started', fields);
      try {
        await step.run({ ...tick, idempotencyKey: `${tick.tickId}/${key}`, signal: context.cancellationSignal });
        context.cancellationSignal.throwIfAborted();
        backgroundLog('step_completed', fields);
      } catch (error) {
        backgroundLog('step_failed', fields);
        // Do not log a provider response, prompt or arbitrary exception text.
        if (context.cancellationSignal.aborted) throw error;
        throw ApplicationFailure.retryable('Background step failed', 'background_step_failed');
      } finally { clearInterval(timer); }
    },
    async recordBackgroundTick(userId: string, result: BackgroundTickResult, nextTickAt: number): Promise<void> {
      backgroundLog('tick_completed', { userId, ...result, nextTickAt });
    },
  };
}
export type BackgroundActivities = ReturnType<typeof createBackgroundActivities>;
