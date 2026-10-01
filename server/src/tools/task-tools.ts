import { ServiceError } from '../errors.js';
import { ToolRegistry } from './registry.js';

export interface TaskCreator {
  createTask(userId: string, goal: string, invocationId: string): Promise<{ taskId: string }>;
}

/** Delegates a goal to its own isolated conversation; never advertised to a task's own Agent. */
export function taskToolRegistry(creator: TaskCreator): ToolRegistry {
  return new ToolRegistry([{
    name: 'instant_create_task', version: 1, family: 'internal', executionLocation: 'server',
    description: 'Delegate a self-contained goal to a new, independent task with its own conversation, so this chat is not blocked while it works. Use this for something that takes real, possibly slow effort to produce (a plan, a draft, a multi-step lookup), not for a short direct answer. There is no result yet when this returns. This starts immediately. For a future or recurring task, use instant_schedule_task if available.',
    parameters: { type: 'object', properties: { goal: { type: 'string', minLength: 1, maxLength: 4000, description: 'A self-contained goal with relevant facts, constraints, and the expected result. Include dates and time zone when needed; the task cannot read main chat.' } }, required: ['goal'], additionalProperties: false },
    timeoutMs: 10_000,
    // Creating this task is not safe to retry blindly: an unknown outcome could otherwise create a duplicate task.
    retry: 'never',
    validate(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof (input as Record<string, unknown>).goal !== 'string') {
        throw new ServiceError(422, 'invalid_tool_arguments', 'A task needs exactly one goal field');
      }
      const goal = (input as Record<string, unknown>).goal as string;
      if (!goal.trim() || goal.length > 4000) throw new ServiceError(422, 'invalid_tool_arguments', 'A task needs a nonempty goal up to 4000 characters');
      return { goal: goal.trim() };
    },
    async execute(input, context) {
      const { taskId } = await creator.createTask(context.userId, input.goal as string, context.invocationId);
      return { ok: true, data: { task_id: taskId, status: 'queued' } };
    },
  }]);
}
