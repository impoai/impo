import type { ConnectorAPI } from '../composio/connector-service.js';
import type { BriefInput } from './contract.js';
import { localClock } from './contract.js';
import { topicBlocked, topicCooldown, type BriefContext, type BriefGuidance, type BriefPreferences, type BriefTopics } from './content.js';

export interface BriefContextProvider {
  connectors?: Pick<ConnectorAPI, 'list' | 'getStatus' | 'refresh'>;
  schedulingEnabled?: boolean;
}
export interface BriefUsage { scheduledTasks: boolean; echoSchedule: boolean; echoSpeakers: boolean }

// Dates are lunar month 8, day 15, not the following Hong Kong public holiday.
// Sources: https://www.hko.gov.hk/en/gts/astron2026/files/2026cal09.pdf
// and https://www.hko.gov.hk/en/gts/astron2027/files/2027cal09.pdf.
const midAutumnDates = ['2026-09-25', '2027-09-15'];

export function occasionContexts(input: Pick<BriefInput, 'localDate' | 'timeZone' | 'cutoff'>, preferences: BriefPreferences): BriefContext[] {
  if (!preferences.categories.occasion || preferences.occasionCalendar === 'none') return [];
  const tomorrow = new Date(Date.parse(`${input.localDate}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  const dates = [input.localDate, tomorrow];
  const occasions = dates.filter(d => d.endsWith('-01-01')).map(date => ({ date, id: 'new-year', title: 'New Year', url: 'https://www.hko.gov.hk/en/gts/time/Calendar.htm' }));
  if (preferences.occasionCalendar === 'chinese') for (const date of midAutumnDates.filter(d => dates.includes(d))) {
    occasions.push({ date, id: 'mid-autumn', title: 'Mid-Autumn Festival', url: `https://www.hko.gov.hk/en/gts/astron${date.slice(0, 4)}/files/${date.slice(0, 4)}cal09.pdf` });
  }
  return occasions.map(o => {
    // Bound the card to the end of the occasion in the user's actual time zone.
    let end = new Date(Date.parse(input.cutoff));
    while (localClock(end, input.timeZone).date <= o.date) end = new Date(end.getTime() + 3600000);
    while (localClock(new Date(end.getTime() - 60000), input.timeZone).date > o.date) end = new Date(end.getTime() - 60000);
    end.setUTCSeconds(0, 0);
    return { id: `occasion:${o.id}:${o.date}`, kind: 'occasion', topicKey: `occasion:${o.id}:${o.date}`, target: o.id,
      title: o.title, detail: `${o.title} is ${o.date === input.localDate ? 'today' : 'tomorrow'}, ${o.date}, in ${input.timeZone}. The user selected this calendar. Do not assume celebration plans.`,
      capturedAt: input.cutoff, expiresAt: end.toISOString(), url: o.url };
  });
}

/** Provider failures omit opportunities; they never become disconnected facts. */
export async function buildBriefGuidance(userId: string, input: BriefInput, editionId: string, preferences: BriefPreferences,
  topics: BriefTopics, clientVersion: number, usage: BriefUsage, provider: BriefContextProvider): Promise<BriefGuidance> {
  const now = new Date(input.cutoff); const expiresAt = new Date(now.getTime() + 86400_000).toISOString();
  const contexts: BriefContext[] = occasionContexts(input, preferences);
  const guidance: BriefGuidance = { version: 2, editionId, preferences, contexts,
    actions: [{ id: 'chat', kind: 'chat_draft', target: 'chat', contextIds: [] }],
    blockedTopics: Object.entries(topics).filter(([key, topic]) => topicBlocked(topic, now, topicCooldown(key))).map(([key]) => key) };
  for (const source of input.sources.filter(s => s.kind === 'task')) guidance.actions.push({ id: `task:${source.recordId}`, kind: 'open_resource', target: source.recordId, contextIds: [] });
  if (clientVersion >= 2 && provider.schedulingEnabled) {
    const features = [
      { id: 'scheduled-tasks', used: usage.scheduledTasks, title: 'Scheduled tasks', detail: 'Set a task to run once, daily or weekly. Each run has its own result.' },
      { id: 'echo-schedule', used: usage.echoSchedule, title: 'Echo reminders', detail: 'Choose when to be reminded to start Echo. Recording always starts with a user tap.' },
      { id: 'echo-speakers', used: usage.echoSpeakers, title: 'Choose your Echo voice', detail: 'Review an Echo recording and select your anonymous speaker before it informs Memory and Brief.' },
    ];
    if (preferences.categories.feature) for (const feature of features.filter(f => !f.used)) {
      const id = `feature:${feature.id}`;
      contexts.push({ id, kind: 'feature', topicKey: id, target: feature.id, title: feature.title,
        detail: `${feature.detail} No adoption is recorded; do not claim this is newly released or that the user has never tried it.`, capturedAt: input.cutoff, expiresAt });
      guidance.actions.push({ id, kind: 'open_feature', target: feature.id, contextIds: [id] });
    }
  }
  if (clientVersion >= 2 && provider.connectors && (preferences.categories.connect || preferences.categories.suggestion)) {
    try {
      const shelf = (await provider.connectors.list(userId)).filter(c => ['gmail', 'googlecalendar', 'googledrive', 'outlook'].includes(c.toolkit));
      for (const item of shelf) {
        try {
          const current = item.status === 'connected' ? await provider.connectors.refresh(userId, item.toolkit) : await provider.connectors.getStatus(userId, item.toolkit);
          if (current.status === 'pending') continue;
          const id = `connection:${item.toolkit}:${current.status}`;
          if (current.status === 'connected' && !preferences.categories.suggestion) continue;
          if (current.status !== 'connected' && !preferences.categories.connect) continue;
          contexts.push({ id, kind: 'connection', topicKey: `connection:${item.toolkit}`, target: item.toolkit, state: current.status,
            title: item.name, detail: current.status === 'connected'
              ? `${item.name} is connected. Offer to check available tools and review information in Chat. No inbox, file or calendar contents have been read for this Brief; never claim new items, counts or events. Actual tool permissions are checked when used.`
              : `${item.name} is ${current.status}. Offer a specific benefit of connecting it. Google or Apple sign-in does not connect external apps.`,
            capturedAt: input.cutoff, expiresAt });
          guidance.actions.push({ id: `${current.status === 'connected' ? 'review' : 'connect'}:${item.toolkit}`,
            kind: current.status === 'connected' ? 'chat_draft' : 'connect', target: item.toolkit, contextIds: [id] });
        } catch { /* Unknown state produces no card. */ }
      }
    } catch { /* A missing connector catalog is not evidence of disconnection. */ }
  }
  guidance.contexts = contexts.filter(c => !guidance.blockedTopics.includes(c.topicKey));
  guidance.actions = guidance.actions.filter(a => a.contextIds.every(id => guidance.contexts.some(c => c.id === id)));
  return guidance;
}
