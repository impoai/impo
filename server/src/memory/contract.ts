/**
 * Memory consolidation contract. The pipeline follows Mem0's two phases
 * (https://arxiv.org/abs/2504.19413): extract salient facts from new evidence, then compare
 * each fact with the most similar existing memories and choose ADD / UPDATE / DELETE / NONE.
 * Existing memories are shown to the Agent under short aliases (m1..mN), never raw IDs, so
 * an invented identifier cannot touch a memory it was not shown.
 */
export const memoryConfigVersion = 'memory.v2';
/**
 * Mem0 Platform's 15 default categories (https://docs.mem0.ai/platform/features/custom-categories).
 * A memory carries one to three. Time-bound plans are marked by expiresAt, not a category.
 */
export const memoryCategories = ['personal_details', 'family', 'professional_details', 'sports', 'travel', 'food', 'music', 'health',
  'technology', 'hobbies', 'fashion', 'entertainment', 'milestones', 'user_preferences', 'misc'] as const;
export type MemoryCategory = typeof memoryCategories[number];

/** A (time, id) position in one source; evidence strictly after it is unread. */
export interface MemoryCursor { at: string; id: string }
/** A run reads (after, through] per source. Absent means the run reads nothing from it. */
export interface MemoryWindow {
  chat?: { after: MemoryCursor | null; through: MemoryCursor };
  echo?: { after: MemoryCursor | null; through: MemoryCursor };
}

export interface MemoryEvidence {
  /** chat:<submission ID> | echo:<batch or segment ID> */
  id: string; kind: 'chat' | 'echo'; occurredAt: string;
  /** Chat: the user's words. Echo: an ambient transcript, speakers unverified. */
  text: string;
  /** Chat only: the assistant's answer, context for resolving what the user meant. */
  reply?: string;
  location?: import('../listening/location.js').EchoLocationContext;
  truncated?: boolean;
}

export interface MemoryFact { text: string; categories: MemoryCategory[]; sourceIds: string[]; expiresAt: string | null }
export type MemoryOperation =
  | { op: 'add'; text: string; categories: MemoryCategory[]; sourceIds: string[]; expiresAt: string | null }
  | { op: 'update'; ref: string; text: string; categories: MemoryCategory[]; sourceIds: string[]; expiresAt: string | null }
  | { op: 'delete'; ref: string; reason: string };

export interface Memory {
  id: string; content: string; categories: MemoryCategory[]; sourceIds: string[];
  createdAt: string; updatedAt: string; expiresAt: string | null;
}

export const memoryLimits = {
  /** Evidence per run: bounded prompt size; a larger backlog drains over several runs. */
  runCharacters: 30_000, runItems: 60, chatCharacters: 2_000, replyCharacters: 800, echoCharacters: 4_000,
  facts: 30, memoryCharacters: 500, candidates: 60, neighbours: 5,
};

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function json(text: string): Record<string, unknown> {
  const raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!object(raw)) throw new Error('invalid_memory_output');
  return raw;
}
function str(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.trim() || Array.from(v).length > max) throw new Error('invalid_memory_output');
  return v.trim();
}
function categories(v: unknown): MemoryCategory[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 3 || v.some(c => !memoryCategories.includes(c as MemoryCategory))) throw new Error('invalid_memory_output');
  return [...new Set(v as MemoryCategory[])];
}
function sources(v: unknown, known: ReadonlySet<string>, required: boolean): string[] {
  const ids = v === undefined ? [] : v;
  if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== 'string' || !known.has(id)) || (required && !ids.length)) throw new Error('invalid_memory_output');
  return [...new Set(ids as string[])];
}
/**
 * Expiry is advisory: a time without an offset is read as UTC, and an unreadable value drops
 * the expiry instead of rejecting the whole batch (models often omit the offset).
 */
function expiry(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const naive = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(v);
  const at = Date.parse(naive ? (v.length === 10 ? `${v}T23:59:59Z` : `${v}Z`) : v);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** Phase 1 output: {"facts":[{text, categories, sourceIds, expiresAt}]}. Every fact cites evidence. */
export function parseFacts(text: string, evidenceIds: ReadonlySet<string>): MemoryFact[] {
  const raw = json(text);
  if (!Array.isArray(raw.facts) || raw.facts.length > memoryLimits.facts) throw new Error('invalid_memory_output');
  return raw.facts.map(fact => {
    if (!object(fact)) throw new Error('invalid_memory_output');
    return { text: str(fact.text, memoryLimits.memoryCharacters), categories: categories(fact.categories),
      sourceIds: sources(fact.sourceIds, evidenceIds, true), expiresAt: expiry(fact.expiresAt) };
  });
}

/**
 * Phase 2 output: {"operations":[...]}. NONE is accepted and dropped. A reference may be
 * changed by at most one operation, and only to a memory that was shown.
 */
export function parseOperations(text: string, refs: ReadonlySet<string>, evidenceIds: ReadonlySet<string>): MemoryOperation[] {
  const raw = json(text);
  if (!Array.isArray(raw.operations) || raw.operations.length > memoryLimits.facts + memoryLimits.candidates) throw new Error('invalid_memory_output');
  const touched = new Set<string>();
  const result: MemoryOperation[] = [];
  for (const op of raw.operations) {
    if (!object(op)) throw new Error('invalid_memory_output');
    const kind = String(op.op).toLowerCase();
    if (kind === 'none') continue;
    if (kind === 'add') {
      result.push({ op: 'add', text: str(op.text, memoryLimits.memoryCharacters), categories: categories(op.categories),
        sourceIds: sources(op.sourceIds, evidenceIds, true), expiresAt: expiry(op.expiresAt) });
      continue;
    }
    const ref = str(op.ref, 10);
    if (!refs.has(ref) || touched.has(ref)) throw new Error('invalid_memory_output');
    touched.add(ref);
    if (kind === 'update') result.push({ op: 'update', ref, text: str(op.text, memoryLimits.memoryCharacters), categories: categories(op.categories),
      sourceIds: sources(op.sourceIds, evidenceIds, true), expiresAt: expiry(op.expiresAt) });
    else if (kind === 'delete') result.push({ op: 'delete', ref, reason: str(op.reason, 300) });
    else throw new Error('invalid_memory_output');
  }
  return result;
}
