import { continueAsNew, defineQuery, isCancellation, log, proxyActivities, setHandler, sleep, workflowInfo } from '@temporalio/workflow';
import { backgroundIntervalMs, backgroundTicksPerRun, type BackgroundStatus, type BackgroundTickResult, type BackgroundWorkflowState } from './contract.js';
import type { BackgroundActivities } from './activities.js';

export const backgroundState = defineQuery<BackgroundStatus>('backgroundState');
const metadata = proxyActivities<Pick<BackgroundActivities, 'planBackgroundTick' | 'recordBackgroundTick'>>({
  startToCloseTimeout: '30 seconds', scheduleToCloseTimeout: '5 minutes',
  retry: { initialInterval: '1 second', maximumInterval: '30 seconds', maximumAttempts: 5 },
});
const steps = proxyActivities<Pick<BackgroundActivities, 'executeBackgroundStep'>>({
  startToCloseTimeout: '10 minutes', scheduleToCloseTimeout: '30 minutes', heartbeatTimeout: '30 seconds',
  retry: { initialInterval: '10 seconds', maximumInterval: '1 minute', maximumAttempts: 3 },
});

/** One logical lifetime per user; Continue-As-New carries only a bounded checkpoint. */
export async function userBackgroundWorkflow(input: BackgroundWorkflowState): Promise<void> {
  const state: BackgroundStatus = {
    userId: input.userId, phase: 'waiting', nextTickAt: input.nextTickAt ?? Date.now() + backgroundIntervalMs,
    ticks: input.ticks ?? 0, lastTick: input.lastTick,
  };
  setHandler(backgroundState, () => state);
  log.info('background.waiting', { userId: state.userId, nextTickAt: state.nextTickAt, ticks: state.ticks });
  let runTicks = 0;
  while (true) {
    await sleep(Math.max(1, state.nextTickAt - Date.now()));
    state.phase = 'running';
    const tick = { userId: state.userId, scheduledAt: state.nextTickAt, tickId: `${workflowInfo().workflowId}/${state.nextTickAt}` };
    let count = 0;
    let failed = 0;
    let planningFailed = false;
    try {
      const plan = await metadata.planBackgroundTick(tick);
      if (!plan.userExists) {
        log.info('background.user_removed', { userId: state.userId });
        return;
      }
      count = plan.steps.length;
      for (const key of plan.steps) {
        try { await steps.executeBackgroundStep(tick, key); }
        catch (error) {
          if (isCancellation(error)) throw error;
          failed++;
          log.warn('background.step_exhausted', { userId: state.userId, tickId: tick.tickId, step: key });
        }
      }
    } catch (error) {
      if (isCancellation(error)) throw error;
      planningFailed = true;
      log.warn('background.plan_failed', { userId: state.userId, tickId: tick.tickId });
    }
    const result: BackgroundTickResult = {
      tickId: tick.tickId, scheduledAt: tick.scheduledAt, completedAt: Date.now(),
      status: planningFailed || failed ? 'failed' : count ? 'completed' : 'empty', steps: count, failedSteps: failed,
    };
    // Preserve the hourly cadence; coalesce missed hours instead of replaying a backlog of empty ticks.
    const next = tick.scheduledAt + backgroundIntervalMs;
    state.nextTickAt = next > Date.now() ? next : next + (Math.floor((Date.now() - next) / backgroundIntervalMs) + 1) * backgroundIntervalMs;
    try { await metadata.recordBackgroundTick(state.userId, result, state.nextTickAt); }
    catch (error) {
      if (isCancellation(error)) throw error;
      log.warn('background.tick_log_failed', { userId: state.userId, tickId: tick.tickId });
    }
    state.lastTick = result;
    state.ticks++;
    state.phase = 'waiting';
    runTicks++;
    if (runTicks >= backgroundTicksPerRun || workflowInfo().continueAsNewSuggested || workflowInfo().historyLength >= 10000) {
      log.info('background.continue_as_new', { userId: state.userId, ticks: state.ticks, nextTickAt: state.nextTickAt });
      return continueAsNew<typeof userBackgroundWorkflow>({ userId: state.userId, nextTickAt: state.nextTickAt, ticks: state.ticks, lastTick: state.lastTick });
    }
  }
}
