import { ServiceError } from '../errors.js';
import { parseScheduledTask, type ScheduledTaskInput } from '../scheduling/contract.js';
import { ToolRegistry } from './registry.js';

export function scheduledTaskToolRegistry(create: (userId: string, invocationId: string, input: ScheduledTaskInput) => Promise<unknown>): ToolRegistry {
  return new ToolRegistry([{
    name: 'instant_schedule_task', version: 1, family: 'internal', executionLocation: 'server',
    description: 'Schedule a self-contained task once in the future, daily, or weekly. Each occurrence runs independently with web and connected apps, without device tools or main-chat history. Use an explicit IANA time zone and local clock time for repeats. Never invent a missing time. Returns the saved schedule and next run, not a completed result. Users manage schedules in Tasks > Scheduled.',
    parameters: { type: 'object', additionalProperties: false, required: ['title', 'goal', 'schedule'], properties: {
      title: { type: 'string', minLength: 1, maxLength: 120 }, goal: { type: 'string', minLength: 1, maxLength: 4000 },
      schedule: { type: 'object', additionalProperties: false, required: ['frequency', 'timeZone', 'runAt', 'time', 'weekdays'], properties: {
        frequency: { type: 'string', enum: ['once', 'daily', 'weekly'] }, timeZone: { type: 'string', description: 'IANA time zone, such as Asia/Shanghai.' },
        runAt: { type: ['string', 'null'], description: 'Once only: future ISO 8601 timestamp with UTC offset. Otherwise null.' },
        time: { type: ['string', 'null'], description: 'Repeats only: local HH:mm. Otherwise null.' },
        weekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, description: 'Weekly only: ISO weekdays, Monday 1 to Sunday 7. Otherwise empty.' },
      } },
    } }, timeoutMs: 10_000, retry: 'transactional',
    validate(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['title', 'goal', 'schedule'].includes(k)))
        throw new ServiceError(422, 'invalid_tool_arguments', 'Provide a title, goal and schedule.');
      return { ...parseScheduledTask({ ...input, enabled: true }) };
    },
    async execute(input, context) {
      context.signal.throwIfAborted();
      return { ok: true, data: { schedule: await create(context.userId, context.invocationId, parseScheduledTask(input)), status: 'scheduled' } };
    },
  }]);
}
