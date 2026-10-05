import { ServiceError } from '../errors.js';
import type { GadgetControl } from '../gadgets/gateway.js';
import { jsonValue } from './device-tools.js';
import { ToolRegistry } from './registry.js';

export const gadgetInstructions = `## Gadgets
- The user may own gadgets: small hardware with a screen, speaker or motors, paired to their account. When they ask to do something on a gadget, call impo_list_gadgets first, then impo_gadget_command with a command that gadget lists and exactly the parameters it describes.
- Pick the gadget the user names. With one gadget, use it. If several could match, ask which.
- Only say something happened on a gadget after the command returned ok. If a gadget is offline or the command fails, say so plainly.
- A gadget fetches URLs itself, so give it public URLs only and follow each command's own format limits.`;

const invalid = (message: string): never => { throw new ServiceError(422, 'invalid_tool_arguments', message); };

/**
 * The gadget route comes from the durable invocation's owner, never from model
 * arguments, so one account cannot reach another's gadgets.
 */
export function gadgetToolRegistry(gadgets: GadgetControl, subjectOf: (userId: string) => Promise<string | undefined>): ToolRegistry {
  const subject = async (userId: string) => await subjectOf(userId) ?? invalid('Gadgets are not available for this account.');
  return new ToolRegistry([{
    name: 'impo_list_gadgets', version: 1, family: 'external', executionLocation: 'server', timeoutMs: 15_000, retry: 'read-only',
    description: "List the user's gadgets: name, whether each is online, and the commands each accepts with their parameters. Call before impo_gadget_command.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    validate(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) invalid('This tool takes no arguments.');
      return {};
    },
    async execute(_input, context) {
      const found = await gadgets.commands(await subject(context.userId));
      return { ok: true, data: { gadgets: found.map(({ pairingId: _, nodeId, ...gadget }) => ({ gadget_id: nodeId, ...gadget })) } };
    },
  }, {
    name: 'impo_gadget_command', version: 1, family: 'external', executionLocation: 'server', timeoutMs: 45_000,
    // A command moves, shows or plays something; repeating one whose outcome is unknown could do it twice.
    retry: 'never',
    description: 'Run one command on one of the user\'s gadgets, such as showing text or an image, playing a sound or moving. Use a gadget_id and a command returned by impo_list_gadgets, with the parameters that command describes.',
    parameters: { type: 'object', properties: {
      gadget_id: { type: 'string', description: 'gadget_id from impo_list_gadgets.' },
      command: { type: 'string', description: 'A command name that gadget lists.' },
      params: { type: 'object', description: 'The command\'s parameters. Omit when it takes none.' },
    }, required: ['gadget_id', 'command'], additionalProperties: false },
    validate(input) {
      jsonValue(input);
      if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Provide a gadget_id and a command.');
      const value = input as Record<string, unknown>;
      if (Object.keys(value).some(key => !['gadget_id', 'command', 'params'].includes(key))
        || typeof value.gadget_id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value.gadget_id)
        || typeof value.command !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value.command)
        || (value.params !== undefined && (value.params === null || typeof value.params !== 'object' || Array.isArray(value.params)))) {
        invalid('Provide a gadget_id and command from impo_list_gadgets, and params as an object.');
      }
      return { gadget_id: value.gadget_id, command: value.command, params: value.params ?? {} };
    },
    async execute(input, context) {
      const owner = await subject(context.userId);
      // The gateway runs whatever it is sent, so the command must be one this gadget offers the agent.
      const gadget = (await gadgets.commands(owner)).find(candidate => candidate.nodeId === input.gadget_id);
      if (!gadget) return { ok: false, error: { code: 'gadget_not_found', message: 'No gadget with that gadget_id is paired to this account.', retryable: false } };
      if (!gadget.commands.some(command => command.name === input.command)) {
        return { ok: false, error: { code: 'gadget_command_unknown', message: 'That gadget does not offer this command.', retryable: false } };
      }
      if (!gadget.online) return { ok: false, error: { code: 'gadget_offline', message: `${gadget.name} is offline.`, retryable: true } };
      const result = await gadgets.invoke(owner, gadget.nodeId, input.command as string, input.params as Record<string, unknown>, 30_000);
      if (!result.ok) return { ok: false, error: { code: 'gadget_command_failed', message: `${gadget.name} did not complete the command${result.error ? ` (${result.error})` : ''}.`, retryable: false } };
      return { ok: true, data: { gadget: gadget.name, command: input.command, ...(result.payload !== undefined ? { result: result.payload } : {}) } };
    },
  }]);
}
