import { ServiceError } from '../errors.js';

export interface EchoSchedule {
  enabled: boolean;
  /** ISO weekdays: Monday = 1, Sunday = 7. */
  weekdays: number[];
  reminderTime: string;
  stopTime: string;
  autoStop: boolean;
  timeZone: string;
  revision: string | null;
}
export const echoScheduleWorkflowId = (userId: string) => `impo/echo-schedule/${userId}`;
export const echoReminderLifetimeMs = 15 * 60_000;
export const defaultEchoSchedule = (): EchoSchedule => ({ enabled: false, weekdays: [1, 2, 3, 4, 5], reminderTime: '09:00', stopTime: '18:00', autoStop: true, timeZone: 'UTC', revision: null });
const keys = ['enabled', 'weekdays', 'reminderTime', 'stopTime', 'autoStop', 'timeZone', 'revision'];
const clock = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
export function parseEchoSchedule(input: unknown): EchoSchedule {
  const bad = () => new ServiceError(400, 'invalid_echo_schedule', 'Choose at least one day, a time zone, and a stop time after the reminder.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value)) ||
      typeof value.enabled !== 'boolean' || typeof value.autoStop !== 'boolean' ||
      !Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.length > 7 ||
      value.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(value.weekdays).size !== value.weekdays.length ||
      typeof value.reminderTime !== 'string' || !clock.test(value.reminderTime) || typeof value.stopTime !== 'string' || !clock.test(value.stopTime) ||
      (value.autoStop && value.stopTime <= value.reminderTime) || typeof value.timeZone !== 'string' || value.timeZone.length > 100 ||
      !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value.timeZone) ||
      !(value.revision === null || (typeof value.revision === 'string' && /^[0-9a-f-]{36}$/.test(value.revision)))) throw bad();
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); } catch { throw bad(); }
  return { enabled: value.enabled, autoStop: value.autoStop, weekdays: [...value.weekdays].sort((a, b) => a - b),
    reminderTime: value.reminderTime, stopTime: value.stopTime, timeZone: value.timeZone, revision: value.revision as string | null };
}

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
function parts(format: Intl.DateTimeFormat, at: number) {
  const fields = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]));
  return { year: Number(fields.year), month: Number(fields.month), day: Number(fields.day), hour: Number(fields.hour), minute: Number(fields.minute) };
}
function stamp(value: ReturnType<typeof parts>) { return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute); }
export function echoLocalDate(at: Date, timeZone: string): string {
  const value = parts(formatter(timeZone), at.getTime());
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

/** A missing DST clock time shifts by the gap; a repeated clock time uses its first occurrence. */
export function nextEchoOccurrence(schedule: EchoSchedule, kind: 'reminderTime' | 'stopTime', after: Date): Date | null {
  if (!schedule.enabled || (kind === 'stopTime' && !schedule.autoStop)) return null;
  const format = formatter(schedule.timeZone);
  const local = parts(format, after.getTime());
  const [hour, minute] = schedule[kind].split(':').map(Number);
  for (let day = 0; day <= 8; day++) {
    const nominal = Date.UTC(local.year, local.month - 1, local.day + day, hour!, minute!);
    const date = new Date(nominal);
    if (!schedule.weekdays.includes(date.getUTCDay() || 7)) continue;
    // Sample both sides of a transition, then validate each possible offset.
    const offsets = new Set([-36, -12, 0, 12, 36].map(hours => {
      const sample = nominal + hours * 3600_000;
      return stamp(parts(format, sample)) - sample;
    }));
    const candidates = [...offsets].map(offset => nominal - offset).filter(at => {
      const actual = parts(format, at);
      return actual.year === date.getUTCFullYear() && actual.month === date.getUTCMonth() + 1 && actual.day === date.getUTCDate() && stamp(actual) >= nominal;
    }).sort((a, b) => stamp(parts(format, a)) - stamp(parts(format, b)) || a - b);
    const first = candidates[0];
    // Do not offer the second occurrence after the first one has already passed.
    if (first !== undefined && first > after.getTime()) return new Date(first);
  }
  return null;
}
