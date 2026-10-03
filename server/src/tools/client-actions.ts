import { ServiceError } from '../errors.js';
import { ToolRegistry } from './registry.js';

/** Shared intent, with native adapters chosen by the client rather than the model. */
export const clientActionCatalog = [
  { name: 'impo_open_link', intent: 'open_link', version: 1, execution: 'device', interaction: 'tap',
    effect: 'handoff', icon: 'link', platforms: ['ios', 'android'],
    implementations: { ios: 'universal_link', android: 'app_link' } },
  { name: 'impo_navigate', intent: 'navigate', version: 1, execution: 'device', interaction: 'tap',
    effect: 'handoff', icon: 'navigation', platforms: ['ios', 'android'],
    implementations: { ios: 'apple_maps', android: 'google_maps' } },
] as const;
export const clientActionNames = clientActionCatalog.map(action => action.name);
export const isClientAction = (name: string) => clientActionNames.some(candidate => candidate === name);
const invalid = () => new ServiceError(422, 'invalid_action_arguments', 'Action arguments do not match the supported capability');

export function validateClientAction(name: string, value: unknown): Record<string, unknown> {
  if (!isClientAction(name) || !value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const args = value as Record<string, unknown>;
  const keys = name === 'impo_open_link' ? ['url'] : ['destination', 'mode'];
  if (Object.keys(args).some(key => !keys.includes(key)) || keys.some(key => !(key in args))) throw invalid();
  if (name === 'impo_open_link') {
    if (typeof args.url !== 'string' || args.url.length > 4096 || /[\s\u0000-\u001f\u007f\\]/u.test(args.url)) throw invalid();
    let url: URL;
    try { url = new URL(args.url); } catch { throw invalid(); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw invalid();
    return { url: url.href };
  }
  if (typeof args.destination !== 'string' || !args.destination.trim() || args.destination.length > 300 || /[\u0000-\u001f\u007f]/u.test(args.destination)
      || !['driving', 'walking', 'transit'].includes(args.mode as string)) throw invalid();
  return { destination: args.destination.trim(), mode: args.mode };
}

/** Preparation is a server tool; its result is a proposal, never an execution receipt. */
export function clientActionToolRegistry(): ToolRegistry {
  return new ToolRegistry(clientActionCatalog.map(capability => ({
    name: capability.name, version: capability.version, family: 'internal', executionLocation: 'server',
    description: (capability.intent === 'open_link'
      ? 'Prepare a button to open an HTTPS link in its installed app or browser. Use for videos such as YouTube and other external pages.'
      : 'Prepare a directions button. Supply an unambiguous destination address or coordinates and a travel mode. The client chooses its supported maps adapter.')
      + ' This returns a ready action for the user to tap, not proof that anything opened. Finish your reply without waiting for a tap. Never say the action already happened. No arbitrary URL schemes or system commands.',
    parameters: capability.intent === 'open_link'
      ? { type: 'object', properties: { url: { type: 'string', maxLength: 4096 } }, required: ['url'], additionalProperties: false }
      : { type: 'object', properties: { destination: { type: 'string', minLength: 1, maxLength: 300 }, mode: { type: 'string', enum: ['driving', 'walking', 'transit'] } }, required: ['destination', 'mode'], additionalProperties: false },
    timeoutMs: 1000, retry: 'read-only',
    validate: input => validateClientAction(capability.name, input),
    async execute(input, context) {
      context.signal.throwIfAborted();
      return { ok: true, data: { kind: 'client_action', schemaVersion: 1, actionId: context.invocationId,
        capability: capability.name, execution: capability.execution, interaction: capability.interaction,
        status: 'ready', parameters: validateClientAction(capability.name, input) } };
    },
  })));
}
