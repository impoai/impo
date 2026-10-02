import type { MemoryChange } from './contract.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { BackgroundStep } from '../background/registry.js';
import { appendDynamicContext } from '../prompts/index.js';
import { memoryInstructions } from '../prompts/memory.js';
import type { RebyteGateway } from '../rebyte/gateway.js';
import { memoryConfigVersion, memoryLimits, parseFacts, parseOperations, type MemoryFact } from './contract.js';
import { defaultMemoryPolicy, planMemoryTick, type MemoryPolicy } from './planner.js';
import type { MemoryRepository, MemoryRunRow } from '../db/repositories/memory-repository.js';
import { memoryId, type MemoryStore } from './store.js';

export const memoryLog = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event: `memory.${event}`, at: new Date().toISOString(), ...fields }));
/** Neighbours further than this are unrelated for the decide phase. */
const neighbourDistance = 0.5;
const normalized = (text: string) => text.toLowerCase().replace(/[\s\p{P}]+/gu, '');

export interface MemoryWorkerOptions { model: string; pollMs?: number; policy?: MemoryPolicy; now?: () => Date }

/**
 * One consolidation run, resumable at every step. Durable progress is the run row (phase,
 * Session ID, candidate IDs) plus the Rebyte Session itself, whose Turns hold both Agent
 * outputs. A retry re-reads them instead of asking again; store changes carry stable keys.
 */
export class MemoryConsolidator {
  private readonly pollMs: number;
  constructor(private readonly repository: MemoryRepository, private readonly store: MemoryStore, private readonly gateway: RebyteGateway,
    private readonly options: MemoryWorkerOptions) { this.pollMs = options.pollMs ?? 2000; }

  async run(userId: string, signal: AbortSignal): Promise<'finished' | 'busy'> {
    let row = await this.repository.claim(userId);
    if (!row) return 'busy';
    const original = row;
    const abort = new AbortController();
    const scoped = AbortSignal.any([signal, abort.signal]);
    const heartbeat = setInterval(() => { void this.repository.renew(original).catch(() => abort.abort()); }, 15000);
    heartbeat.unref();
    try {
      if (row.attempts > 5) { await this.repository.finish(row, { status: 'failed', errorCode: 'attempts_exhausted' }); memoryLog('failed', { userId, runId: row.id, code: 'attempts_exhausted' }); return 'finished'; }
      const evidence = await this.repository.evidence(userId, row.window);
      const evidenceIds = new Set(evidence.map(item => item.id));
      if (!evidence.some(item => item.text.trim())) { await this.repository.finish(row, { status: 'completed', facts: 0, added: 0, updated: 0, deleted: 0 }); return 'finished'; }
      row = await this.ensureSession(row, evidence.map(({ cursor: _, ...item }) => item), scoped);

      const extracted = await this.output(row, 0, scoped);
      if (extracted.status !== 'completed') return await this.fail(row, extracted.status === 'failed' ? 'agent_failed' : 'agent_pending');
      let facts: MemoryFact[];
      try { facts = parseFacts(extracted.text, evidenceIds); } catch { return await this.fail(row, 'invalid_facts'); }
      if (!facts.length) {
        await this.repository.finish(row, { status: 'completed', facts: 0, added: 0, updated: 0, deleted: 0 });
        memoryLog('completed', { userId, runId: row.id, evidence: evidence.length, facts: 0 });
        return 'finished';
      }

      if (row.phase === 'extract') {
        // Mem0 retrieval: each new fact's nearest existing memories. A small store is shown whole.
        const total = await this.store.count(userId, scoped);
        const shown = total <= memoryLimits.candidates ? await this.store.list(userId, memoryLimits.candidates, scoped)
          : await this.store.similar(userId, facts.map(fact => fact.text), memoryLimits.neighbours, neighbourDistance, scoped);
        row = await this.repository.patch(row, { phase: 'decide', facts: facts.length, candidates: shown.slice(0, memoryLimits.candidates).map(memory => memory.id) });
      }
      const candidateIds = row.candidates ?? [];
      const existing = await this.store.get(userId, candidateIds, scoped);
      const refs = new Map<string, string>(candidateIds.map((id, index) => [`m${index + 1}`, id] as [string, string]).filter(([, id]) => existing.has(id)));
      const turns = await this.gateway.turns(row.providerSessionId!, scoped);
      if (turns.length < 2) {
        const decide = { phase: 'decide', facts: facts.map((fact, index) => ({ id: `f${index + 1}`, ...fact })),
          existing: [...refs].map(([ref, id]) => { const m = existing.get(id)!; return { ref, text: m.content, categories: m.categories, updatedAt: m.updatedAt, expiresAt: m.expiresAt }; }) };
        await this.send(row, JSON.stringify(decide), `${row.id}/decide`, scoped);
      }
      const decided = await this.output(row, 1, scoped);
      if (decided.status !== 'completed') return await this.fail(row, decided.status === 'failed' ? 'agent_failed' : 'agent_pending');
      let operations;
      try { operations = parseOperations(decided.text, new Set(refs.keys()), evidenceIds); } catch { return await this.fail(row, 'invalid_operations'); }

      if (row.phase !== 'apply') row = await this.repository.patch(row, { phase: 'apply' });
      // An edited speaker choice must not apply output from an older Agent input.
      const currentEvidence = await this.repository.evidence(userId, row.window);
      if (JSON.stringify(currentEvidence) !== JSON.stringify(evidence)) return await this.fail(row, 'evidence_changed');
      const known = new Set([...existing.values()].map(memory => normalized(memory.content)));
      const changes: MemoryChange[] = [];
      const runId = row.id;
      operations.forEach((op, index) => {
        const key = `${runId}/${index}`;
        if (op.op === 'add') {
          // NONE in disguise: an ADD that restates a shown memory word for word.
          if (known.has(normalized(op.text))) return;
          changes.push({ key, event: 'ADD', id: memoryId(key), content: op.text, categories: op.categories, sourceIds: op.sourceIds, expiresAt: op.expiresAt });
        } else if (op.op === 'update') changes.push({ key, event: 'UPDATE', id: refs.get(op.ref)!, content: op.text, categories: op.categories, sourceIds: op.sourceIds, expiresAt: op.expiresAt });
        else changes.push({ key, event: 'DELETE', id: refs.get(op.ref)!, reason: op.reason });
      });
      const counts = await this.store.apply(userId, changes, scoped);
      await this.repository.finish(row, { status: 'completed', facts: facts.length, ...counts });
      memoryLog('completed', { userId, runId: row.id, evidence: evidence.length, facts: facts.length, candidates: refs.size, ...counts });
      return 'finished';
    } catch (error) {
      memoryLog('reconcile_pending', { userId, runId: original.id, attempt: original.attempts });
      throw error;
    } finally { clearInterval(heartbeat); await this.repository.release(original); }
  }

  private async fail(row: MemoryRunRow, code: string): Promise<'finished'> {
    // A Turn still running is not a failure: leave the run open and resume next attempt.
    if (code === 'agent_pending') throw new Error('memory_execution_pending');
    await this.repository.finish(row, { status: 'failed', errorCode: code });
    memoryLog('failed', { userId: row.userId, runId: row.id, code });
    return 'finished';
  }

  private async ensureSession(row: MemoryRunRow, evidence: unknown[], signal: AbortSignal): Promise<MemoryRunRow> {
    if (row.providerSessionId) return row;
    const metadata = { instant_app: 'instant', instant_kind: 'memory', instant_user: row.userId, instant_memory_run: row.id };
    let session;
    if (!row.creationStartedAt) {
      row = await this.repository.patch(row, { creationStartedAt: new Date(), model: this.options.model, configVersion: memoryConfigVersion });
      // The durable intent precedes the network request. Unknown outcomes must be found, never blindly re-created.
      const profile = await this.repository.profile(row.userId);
      const instructions = appendDynamicContext(memoryInstructions, { now: (this.options.now?.() ?? new Date()).toISOString(), timeZone: profile.timeZone, locale: profile.locale });
      session = await this.gateway.createSession({ input: [{ type: 'input_text', text: JSON.stringify({ phase: 'extract', evidence }) }], metadata,
        agent: { model: this.options.model, instructions, tools: [] } }, signal);
    } else {
      const matches = await this.gateway.findSessions(metadata, signal);
      if (matches.length !== 1) throw new Error('memory_creation_reconciliation_pending');
      session = matches[0]!;
    }
    return this.repository.patch(row, { providerSessionId: session.id });
  }

  private async send(row: MemoryRunRow, text: string, key: string, signal: AbortSignal) {
    // Subscribe before sending input; durable Turns/Items remain the source of truth.
    const subscription = new AbortController();
    const events = await this.gateway.events(row.providerSessionId!, AbortSignal.any([signal, subscription.signal]));
    const drain = (async () => { try { for await (const _event of events) { /* polling below reads the result */ } } catch { /* disconnected streams are recovered by polling */ } })();
    try { await this.gateway.sendMessage(row.providerSessionId!, [{ type: 'input_text', text }], key, signal); }
    finally { subscription.abort(); await drain; }
  }

  /** The final assistant text of the Session's n-th Turn, waiting up to 4 minutes for it. */
  private async output(row: MemoryRunRow, index: number, signal: AbortSignal): Promise<{ status: 'completed'; text: string } | { status: 'failed' | 'pending' }> {
    const deadline = Date.now() + 4 * 60_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const turn = (await this.gateway.turns(row.providerSessionId!, signal))[index];
      if (turn?.status === 'completed') {
        const items = await this.gateway.items(row.providerSessionId!, signal);
        const item = items.filter(i => i.type === 'message' && i.role === 'assistant' && i.turn_id === turn.id && i.status === 'completed').at(-1);
        if (!item || item.type !== 'message') return { status: 'failed' };
        return { status: 'completed', text: item.content.map(p => (p.type === 'output_text' ? p.text : '')).join('') };
      }
      if (turn && ['failed', 'cancelled'].includes(turn.status)) return { status: 'failed' };
      await delay(this.pollMs, undefined, { signal });
    }
    return { status: 'pending' };
  }
}

/**
 * The hourly hook. The planner decides what this tick does; this step only carries it out:
 * resume or start consolidation runs (each over one bounded window), then sweep expired
 * memories. An interrupted run stays open and is resumed by the next attempt or tick.
 */
export function memoryStep(repository: MemoryRepository, store: MemoryStore, gateway: RebyteGateway, options: MemoryWorkerOptions): BackgroundStep {
  const consolidator = new MemoryConsolidator(repository, store, gateway, options);
  const policy = options.policy ?? defaultMemoryPolicy;
  const now = () => options.now?.() ?? new Date();
  const plan = async (userId: string) => {
    const [state, open, pending, storeExists] = await Promise.all([repository.state(userId), repository.openRun(userId), repository.pending(userId, now()), store.exists(userId)]);
    return planMemoryTick({ now: now(), openRun: !!open, storeExists, sweptAt: state.sweptAt, pending }, policy);
  };
  return { key: 'memory.v1', async run(context) {
    const { userId, signal } = context;
    await store.reconcileSources(userId, signal);
    // The Activity allows 10 minutes; a run can take up to 8. Later runs wait for the next tick.
    const startNewUntil = Date.now() + 90_000;
    let tasks = await plan(userId);
    memoryLog('planned', { userId, tickId: context.tickId, tasks: tasks.map(task => task.kind === 'consolidate' ? `consolidate:${task.reason}` : task.kind) });
    for (let runs = 0; runs < policy.maxRunsPerTick && tasks[0]?.kind === 'consolidate'; runs++) {
      if (!await repository.openRun(userId)) {
        if (runs > 0 && Date.now() > startNewUntil) break;
        const window = await repository.nextWindow(userId, now());
        if (!window) break;
        await repository.createRun(userId, window);
      }
      if (await consolidator.run(userId, signal) === 'busy') { memoryLog('skipped', { userId, reason: 'run_leased' }); return; }
      tasks = await plan(userId);
    }
    if (tasks.some(task => task.kind === 'sweep')) {
      const expired = await store.sweep(userId, now(), signal);
      await repository.markSwept(userId, now());
      memoryLog('swept', { userId, expired });
    }
  } };
}
