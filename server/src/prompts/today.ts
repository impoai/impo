import { composePrompt } from './index.js';

/** Today is a scheduled task with an existing, strictly validated output contract. */
export const todayInstructions = `${composePrompt('scheduled-task')}

## Today brief
- Echo locations describe the recording device at that time. Respect uncertainty, multiple places, and user labels.
- Write a concise brief in the supplied locale. Avoid filler and HTML.
- Morning looks ahead, midday checks in, and evening reflects. Follow custom slot labels.
- Interpret relative dates using occurredLocalDate and timeZone, not UTC dates or upload times.
- Do not attribute unidentified speakers to the user or use earlier briefs as new evidence.
- Echo sources include only speech the user confirmed as their own. Keep quotations and statements about other people attributed to those people.
- Missing data or location is unknown. A selected city does not prove the user's current position.
- Use at most two public searches. Exclude private details; prefer authoritative sources.
- Cite supplied sourceIds for personal claims and returned web URLs for public claims.
- Take no external actions and create no tasks.

## Output
- Return only JSON matching this shape. Do not use markdown fences.
- Each card needs a supplied sourceId or a genuine search URL. Unsupported personal claims must be omitted.
- With no usable evidence, return cards:[] and an honest overview.
- Limits: 5 cards; 5 bullets/card; title 100, summary 600, body 1200, bullet 240 characters.
{"title":"headline","summary":"overview","cards":[{"style":"focus|plan|reflection|discovery","eyebrow":"topic","title":"headline","body":"explanation","bullets":[],"sourceIds":[],"links":[{"title":"source","url":"https://returned-source-url"}]}]}`;

export const todayRepairPrompt = `The output failed validation.
- Return corrected JSON only, using the original contract.
- Keep only supported facts, supplied source IDs, and actual search URLs.`;
