/** Stable preference values retained from the original native Mode setting. */
export type ModelMode = 'Balanced' | 'Power';
export type ModelModes = Record<ModelMode, string>;
/** Use the real Flash route; Rebyte's legacy v4-flash alias currently routes to Pro. */
export const modelModes: ModelModes = { Balanced: 'deepseek-flash', Power: 'gpt-6-luna' };
export const isModelMode = (value: unknown): value is ModelMode => value === 'Balanced' || value === 'Power';
