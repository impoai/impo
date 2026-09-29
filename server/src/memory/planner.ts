import type { PendingEvidence } from './repository.js';

/**
 * Decides what memory work an hourly tick does. Pure: it sees only counts and times, so the
 * policy can change (or be tested) without touching the Workflow, the sources or the store.
 */
export interface MemoryPlanInput {
  now: Date;
  /** An unfinished run exists; it must finish before a new window starts. */
  openRun: boolean;
  /** The user has a memory database (so there is something to sweep). */
  storeExists: boolean;
  sweptAt: Date | null;
  pending: PendingEvidence;
}
export interface MemoryPolicy {
  /** Consolidate once the newest unread item is this old: the conversation has settled. */
  quietMs: number;
  /** ...or once the oldest unread item is this old, even if the user is still active. */
  maxDelayMs: number;
  /** ...or once this many items are waiting. */
  backlogItems: number;
  sweepEveryMs: number;
  /** Consolidation runs per tick; a larger backlog continues next hour. */
  maxRunsPerTick: number;
}
export const defaultMemoryPolicy: MemoryPolicy = {
  quietMs: 20 * 60_000, maxDelayMs: 6 * 3600_000, backlogItems: 20, sweepEveryMs: 24 * 3600_000, maxRunsPerTick: 3,
};

export type MemoryTask =
  | { kind: 'consolidate'; reason: 'resume' | 'quiet' | 'overdue' | 'backlog' }
  | { kind: 'sweep' };

export function planMemoryTick(input: MemoryPlanInput, policy: MemoryPolicy = defaultMemoryPolicy): MemoryTask[] {
  const tasks: MemoryTask[] = [];
  const { now, pending } = input;
  if (input.openRun) tasks.push({ kind: 'consolidate', reason: 'resume' });
  else if (pending.count > 0) {
    if (pending.count >= policy.backlogItems) tasks.push({ kind: 'consolidate', reason: 'backlog' });
    else if (pending.newestAt && now.getTime() - pending.newestAt.getTime() >= policy.quietMs) tasks.push({ kind: 'consolidate', reason: 'quiet' });
    else if (pending.oldestAt && now.getTime() - pending.oldestAt.getTime() >= policy.maxDelayMs) tasks.push({ kind: 'consolidate', reason: 'overdue' });
  }
  // Sweep after consolidation, so a run that just set an expiry sees it applied next day at the latest.
  if (input.storeExists && (!input.sweptAt || now.getTime() - input.sweptAt.getTime() >= policy.sweepEveryMs)) tasks.push({ kind: 'sweep' });
  return tasks;
}
