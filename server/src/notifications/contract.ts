import { ServiceError } from '../errors.js';

export const categories = ['chat', 'tasks', 'brief'] as const;
export type NotificationCategory = typeof categories[number];
export type NotificationSettings = Record<NotificationCategory, boolean>;
export const defaultNotificationSettings: NotificationSettings = { chat: true, tasks: true, brief: true };
export const presenceWindowMs = 60_000;
export const notificationLifetimeMs = 60 * 60_000;
export type Registration = { installationSecret: string; revision: number; registrationId: string; platform: 'ios' | 'android'; token: string | null; enabled: boolean; foreground: boolean };
export type Revocation = Pick<Registration, 'installationSecret' | 'revision' | 'registrationId'>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function registrationInput(value: Record<string, unknown>, revoke = false): Registration | Revocation {
  const fields = revoke ? ['installationSecret', 'revision', 'registrationId'] : ['installationSecret', 'revision', 'registrationId', 'platform', 'token', 'enabled', 'foreground'];
  const valid = Object.keys(value).every(k => fields.includes(k)) && fields.every(k => k in value)
    && typeof value.installationSecret === 'string' && uuidPattern.test(value.installationSecret)
    && typeof value.registrationId === 'string' && uuidPattern.test(value.registrationId)
    && Number.isSafeInteger(value.revision) && (value.revision as number) > 0
    && (revoke || ((value.platform === 'ios' || value.platform === 'android') && typeof value.enabled === 'boolean' && typeof value.foreground === 'boolean'
      && (value.token === null || (typeof value.token === 'string' && /^[\w:.-]{20,4096}$/.test(value.token)))));
  if (!valid) throw new ServiceError(400, 'invalid_request', 'Invalid notification registration');
  return value as Registration;
}
export function settingsInput(value: Record<string, unknown>): Partial<NotificationSettings> {
  if (!Object.keys(value).length || Object.entries(value).some(([k, v]) => !categories.includes(k as NotificationCategory) || typeof v !== 'boolean'))
    throw new ServiceError(400, 'invalid_request', 'Choose notification categories using boolean values');
  return value;
}
export function notificationCopy(category: NotificationCategory, failed: boolean) {
  if (category === 'brief') return { title: 'Your Brief is ready', body: 'Open Impo to read your latest Brief.' };
  if (category === 'tasks') return { title: failed ? 'A task needs attention' : 'Your task has an update', body: 'Open Impo to view your task.' };
  return { title: failed ? 'Your chat needs attention' : 'Your reply is ready', body: 'Open Impo to continue your conversation.' };
}
