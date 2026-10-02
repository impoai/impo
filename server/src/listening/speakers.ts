import type { Utterance } from '../db/entities/listening.js';
import { ServiceError } from '../errors.js';

export interface SpeakerReview {
  revision: number;
  status: 'unconfirmed' | 'confirmed' | 'not_present';
  selfSpeakerIds: string[];
  excludedUtteranceIds: string[];
}
export const emptySpeakerReview = (): SpeakerReview => ({ revision: 0, status: 'unconfirmed', selfSpeakerIds: [], excludedUtteranceIds: [] });
export type SpeakerUtterance = Utterance & { id: string };

/** IDs address immutable archived turns, never voices in another recording. */
export function speakerUtterances(utterances: Utterance[] = []): SpeakerUtterance[] {
  return utterances.map((utterance, index) => ({ ...utterance, id: `u${index + 1}` }));
}

export function parseSpeakerReview(raw: unknown, utterances: Utterance[]): SpeakerReview {
  const invalid = (): never => { throw new ServiceError(400, 'invalid_speaker_review', 'Choose speakers from this recording and try again.'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(k => !['revision', 'status', 'selfSpeakerIds', 'excludedUtteranceIds'].includes(k))
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || Number(value.revision) >= 2_147_483_647
    || !['unconfirmed', 'confirmed', 'not_present'].includes(String(value.status))) return invalid();
  const turns = speakerUtterances(utterances);
  const speakers = new Set(turns.flatMap(turn => turn.speaker ? [turn.speaker] : []));
  const ids = new Set(turns.map(turn => turn.id));
  const list = (v: unknown, allowed: Set<string>) => {
    if (!Array.isArray(v) || v.length > allowed.size || v.some(id => typeof id !== 'string' || !allowed.has(id)) || new Set(v).size !== v.length) return invalid();
    return v as string[];
  };
  const selfSpeakerIds = list(value.selfSpeakerIds, speakers);
  const excludedUtteranceIds = list(value.excludedUtteranceIds, ids);
  if ((value.status === 'confirmed') !== (selfSpeakerIds.length > 0)) return invalid();
  if (value.status !== 'confirmed' && excludedUtteranceIds.length) return invalid();
  return { revision: Number(value.revision), status: value.status as SpeakerReview['status'], selfSpeakerIds, excludedUtteranceIds };
}

/** The sole Echo text projection allowed into personal Memory and Brief. No fallback to full text. */
export function personalTranscript(record: { utterances?: Utterance[]; speakerReview?: SpeakerReview }): string {
  const review = record.speakerReview;
  if (!review || review.status !== 'confirmed' || review.revision < 1) return '';
  const speakers = new Set(review.selfSpeakerIds), excluded = new Set(review.excludedUtteranceIds);
  return speakerUtterances(record.utterances).filter(turn => turn.speaker !== null && speakers.has(turn.speaker) && !excluded.has(turn.id))
    .map(turn => turn.text).join('\n').trim();
}

export const echoSourceId = (id: string, review: SpeakerReview) => `echo:${id}:v${review.revision}`;
