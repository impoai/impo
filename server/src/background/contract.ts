/** Workflow-safe values. No credentials, audio or user content belong in this state. */
export const backgroundIntervalMs = 60 * 60 * 1000;
export const backgroundTicksPerRun = 24;
export const backgroundWorkflowId = (userId: string) => `impo/background/${userId}`;
export interface BackgroundTick {
  userId: string;
  tickId: string;
  scheduledAt: number;
}
export interface BackgroundTickResult {
  tickId: string;
  scheduledAt: number;
  completedAt: number;
  status: 'empty' | 'completed' | 'failed';
  steps: number;
  failedSteps: number;
}
export interface BackgroundWorkflowState {
  userId: string;
  nextTickAt?: number;
  ticks?: number;
  lastTick?: BackgroundTickResult;
}
export interface BackgroundStatus {
  userId: string;
  phase: 'waiting' | 'running';
  nextTickAt: number;
  ticks: number;
  lastTick?: BackgroundTickResult;
}
