import { ServiceError } from '../errors.js';
import { nextEchoOccurrence } from '../echo/schedule.js';

export interface TaskSchedule {
  frequency: 'once' | 'daily' | 'weekly';
  timeZone: string;
  runAt: string | null;
  time: string | null;
  weekdays: number[];
}
export interface ScheduledTaskInput { title: string; goal: string; schedule: TaskSchedule; enabled: boolean }
export const scheduledTaskWorkflowId = (userId: string, id: string) => `impo/task-schedule/${userId}/${id}`;
const invalid = () => new ServiceError(400, 'invalid_task_schedule', 'Choose a task, a valid time zone and a complete schedule.');
export function parseTaskSchedule(input: unknown): TaskSchedule {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const value = input as Record<string, unknown>;
  const keys = ['frequency', 'timeZone', 'runAt', 'time', 'weekdays'];
  if (keys.some(k => !(k in value)) || Object.keys(value).some(k => !keys.includes(k)) ||
      !['once', 'daily', 'weekly'].includes(value.frequency as string) || typeof value.timeZone !== 'string' ||
      value.timeZone.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value.timeZone) ||
      !Array.isArray(value.weekdays) || value.weekdays.length > 7 ||
      value.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(value.weekdays).size !== value.weekdays.length) throw invalid();
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); } catch { throw invalid(); }
  if (value.frequency === 'once') {
    if (typeof value.runAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value.runAt) ||
        !Number.isFinite(Date.parse(value.runAt)) || value.time !== null || value.weekdays.length) throw invalid();
    const datePart = value.runAt.slice(0, 10);
    if (new Date(`${datePart}T00:00:00Z`).toISOString().slice(0, 10) !== datePart) throw invalid();
  } else if (value.runAt !== null || typeof value.time !== 'string' || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value.time) ||
      (value.frequency === 'weekly' ? !value.weekdays.length : value.weekdays.length !== 0)) throw invalid();
  return { frequency: value.frequency as TaskSchedule['frequency'], timeZone: value.timeZone,
    runAt: value.frequency === 'once' ? new Date(value.runAt as string).toISOString() : null,
    time: value.time as string | null, weekdays: [...value.weekdays].sort((a, b) => a - b) };
}
export function parseScheduledTask(input: Record<string, unknown>): ScheduledTaskInput {
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.includes('\0') || input.title.trim().length > 120 ||
      typeof input.goal !== 'string' || !input.goal.trim() || input.goal.includes('\0') || input.goal.trim().length > 4000 || typeof input.enabled !== 'boolean') throw invalid();
  return { title: input.title.trim(), goal: input.goal.trim(), schedule: parseTaskSchedule(input.schedule), enabled: input.enabled };
}
export function nextTaskOccurrence(schedule: TaskSchedule, after: Date): Date | null {
  if (schedule.frequency === 'once') return Date.parse(schedule.runAt!) > after.getTime() ? new Date(schedule.runAt!) : null;
  // Use the same calendar policy as Echo: shift DST gaps and use the first repeated time.
  return nextEchoOccurrence({ enabled: true, weekdays: schedule.frequency === 'daily' ? [1, 2, 3, 4, 5, 6, 7] : schedule.weekdays,
    reminderTime: schedule.time!, stopTime: '23:59', autoStop: false, timeZone: schedule.timeZone, revision: null }, 'reminderTime', after);
}
