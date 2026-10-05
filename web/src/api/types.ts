export type ObjectValue = Record<string, unknown>;
export type Part = {
  type: string;
  id?: string;
  data?: unknown;
  [key: string]: unknown;
};
export interface Profile {
  onboarded: boolean;
  mode: "Balanced" | "Power";
  assistantName?: string;
  displayName?: string;
  avatarIndex?: number;
}
export interface Message {
  id: string;
  role: string;
  sequence: number;
  text: string;
  status: string;
  createdAt: string;
  parts?: Part[];
}
export interface ActiveSubmission {
  submissionId: string;
  messageId: string;
  status: string;
}
export interface Conversation {
  conversationId: string;
  taskId?: string;
  title?: string;
  messages: Message[];
  activeSubmissions: ActiveSubmission[];
  hasMore: boolean;
  nextAfterSequence: number;
}
export interface Receipt {
  messageId: string;
  submissionId: string;
  taskId?: string;
  conversationId?: string;
  text?: string;
}
export interface Task {
  taskId: string;
  conversationId: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  lastRunStartedAt?: string;
  lastRunCompletedAt?: string;
}
export interface Schedule {
  frequency: "once" | "daily" | "weekly";
  timeZone: string;
  runAt: string | null;
  time: string | null;
  weekdays: number[];
}
export interface ScheduledTask {
  id: string;
  title: string;
  goal: string;
  schedule: Schedule;
  enabled: boolean;
  revision: string;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ScheduledRun {
  id: string;
  taskId: string | null;
  scheduledAt: string;
  status: string;
}
export interface Memory {
  id: string;
  content: string;
  categories: string[];
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}
export interface SpeakerReview {
  revision: number;
  status: "unconfirmed" | "confirmed" | "not_present";
  selfSpeakerIds: string[];
  excludedUtteranceIds: string[];
}
export interface Recording {
  id: string;
  startedAt: string;
  endedAt: string;
  status: string;
  transcript: string | null;
  error?: string;
  utterances?: {
    id: string;
    speaker: string | null;
    startMs: number;
    endMs: number;
    text: string;
  }[];
  speakerReview?: SpeakerReview;
  location?: { label?: string; spans?: { city?: string; country?: string }[] };
}
export interface Connector {
  toolkit: string;
  name: string;
  description?: string;
  logoURL?: string;
  featured?: boolean;
  status: string;
  email?: string;
  expiresAt?: string;
}
export interface FeedAction {
  id: string;
  kind: string;
  target: string;
  label: string;
  prompt?: string;
}
export interface FeedCard {
  id?: string;
  type?: string;
  style: string;
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
  sourceIds: string[];
  links: { title: string; url: string }[];
  action?: FeedAction;
}
export interface Brief {
  id: string;
  localDate: string;
  label: string;
  status: string;
  createdAt: string;
  content?: { title: string; summary: string; cards: FeedCard[] };
  sources: {
    id: string;
    kind: string;
    recordId: string;
    title: string;
    occurredAt: string;
    text?: string;
  }[];
  errorCode?: string;
}
export interface TodaySettings {
  timeZone: string;
  locale: string;
  displayName: string;
  location?: {
    city: string;
    country: string;
    capturedAt: string;
    source?: string;
  };
  slots: { id: string; label: string; hour: number; enabled: boolean }[];
  contentPreferences?: {
    categories: Record<string, boolean>;
    occasionCalendar: string;
  };
}
export interface EchoSchedule {
  enabled: boolean;
  weekdays: number[];
  reminderTime: string;
  stopTime: string;
  autoStop: boolean;
  timeZone: string;
  revision: string | null;
}
export interface Product {
  id: string;
  title: string;
  merchant: string;
  url: string;
  imageURL?: string;
  description?: string;
  price?: { amount: string; currency: string; formatted: string };
  available?: boolean;
  options: { name: string; values: string[] }[];
}
export interface ProductSelection {
  schemaVersion: 1;
  selectionId: string;
  productIds: string[];
  query?: string;
}
export interface DeliveredFile {
  schemaVersion: 1;
  fileId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
}
export const record = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
export const terminal = (status: string) =>
  ["completed", "failed", "cancelled"].includes(status);
