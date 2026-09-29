/** Keep the existing production queue name while sharing one Worker across both workflow families. */
export const temporalTaskQueue = 'impo-listening-v1';
export interface TemporalOptions { address: string; namespace: string; apiKey?: string; taskQueue?: string }
