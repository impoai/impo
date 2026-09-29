import { ServiceError } from '../errors.js';

/** Resolved on the recording device. No raw coordinates cross the API boundary. */
export interface EchoLocationSpan {
  from: string; to: string; capturedAt: string; accuracyMeters: number;
  source: 'device'; granularity: 'city' | 'district'; city: string; country: string; district?: string;
}
export interface EchoLocationContext { label?: string; source?: 'manual'; spans: EchoLocationSpan[]; truncated?: boolean }
export const locationFreshnessMs = 120_000;
const timestamp = (v: unknown): number => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) ? Date.parse(v) : NaN;
const place = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 100 && !/[\u0000-\u001f\u007f]/.test(v);

export function parseEchoLocations(raw: unknown, start: number, end: number): EchoLocationSpan[] | undefined {
  if (raw === undefined) return;
  const invalid = (): never => { throw new ServiceError(400, 'invalid_location', 'Invalid recording location context.'); };
  if (!Array.isArray(raw) || raw.length > 16) return invalid();
  let previousEnd = start;
  return raw.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some(k => !['from','to','capturedAt','accuracyMeters','source','granularity','city','country','district'].includes(k))) return invalid();
    const from = timestamp(v.from), to = timestamp(v.to), captured = timestamp(v.capturedAt);
    if (![from,to,captured].every(Number.isFinite) || from < previousEnd || from < start || to > end || to <= from
      || captured > from || to - captured > locationFreshnessMs || typeof v.accuracyMeters !== 'number'
      || !Number.isFinite(v.accuracyMeters) || v.accuracyMeters < 0 || v.accuracyMeters > 5000
      || v.source !== 'device' || !['city','district'].includes(String(v.granularity))
      || !place(v.city) || !place(v.country)
      || (v.granularity === 'district' ? !place(v.district) || v.accuracyMeters > 500 : v.district !== undefined)) return invalid();
    previousEnd = to;
    return { from:new Date(from).toISOString(),to:new Date(to).toISOString(),capturedAt:new Date(captured).toISOString(),
      accuracyMeters:v.accuracyMeters,source:'device',granularity:v.granularity as 'city'|'district',city:v.city.trim(),country:v.country.trim(),
      ...(v.granularity === 'district' ? {district:(v.district as string).trim()} : {}) };
  });
}

export function parseLocationLabel(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ServiceError(400, 'invalid_location_label', 'Use a location name of 80 characters or fewer.');
  }
  return value.trim() || null;
}

export function echoLocationContext(row: { locationLabel?: string | null; segments?: Array<{ locations?: EchoLocationSpan[] }> }, maxSpans = 256): EchoLocationContext | undefined {
  const spans = row.segments?.flatMap(segment => segment.locations ?? []) ?? [];
  if (!row.locationLabel && !spans.length) return;
  return { ...(row.locationLabel ? {label:row.locationLabel,source:'manual' as const} : {}),spans:spans.slice(0,maxSpans),...(spans.length > maxSpans ? {truncated:true} : {}) };
}

/** Keep the internal segment list out of public history responses. */
export function withEchoLocation<T extends { locationLabel?: string | null; segments?: Array<{ locations?: EchoLocationSpan[] }> }>(row: T) {
  const { segments: _segments, locationLabel: _label, ...rest } = row;
  return { ...rest, location:echoLocationContext(row) ?? null };
}
