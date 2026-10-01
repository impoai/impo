import { setTimeout as delay } from 'node:timers/promises';
import type { BackgroundStep } from '../background/registry.js';
import { RebyteGateway } from '../rebyte/gateway.js';
import { briefConfigVersion, briefInstructions, parseBriefContent } from './contract.js';
import { TodayRepository } from '../db/repositories/today-repository.js';
import { appendDynamicContext } from '../prompts/index.js';
import { todayRepairPrompt } from '../prompts/today.js';

export const todayLog = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event: `today.${event}`, at: new Date().toISOString(), ...fields }));

/** Uses a real isolated Rebyte Agent Session. All retries reconcile the same durable edition. */
export function todayStep(repository: TodayRepository, gateway: RebyteGateway, model: string, pollMs = 2000): BackgroundStep {
  return { key: 'today.v1', async run(context) {
    await repository.ensureDue(context.userId);
    let row = await repository.claim(context.userId);
    if (!row) { todayLog('skipped', { userId: context.userId, reason: 'no_due_brief' }); return; }
    const original = row;
    const abort = new AbortController();
    const signal = AbortSignal.any([context.signal, abort.signal]);
    const heartbeat = setInterval(() => { void repository.renew(original).catch(() => abort.abort()); }, 15000);
    heartbeat.unref();
    todayLog('started', { userId: row.userId, briefId: row.id, kind: row.slotId, attempt: row.attempts });
    try {
      const input = await repository.input(row);
      row = { ...row, input };
      const metadata = { instant_app: 'instant', instant_kind: 'today', instant_user: row.userId, instant_brief: row.id };
      if (!row.providerSessionId) {
        let session;
        if (!row.creationStartedAt) {
          row = await repository.patch(row, { creationStartedAt: new Date(), model, configVersion: briefConfigVersion });
          // The durable intent precedes the network request. Unknown outcomes must be found, never blindly re-created.
          const instructions = appendDynamicContext(briefInstructions, {
            profile: input.profile, locale: input.locale, localDate: input.localDate, timeZone: input.timeZone,
            trigger: { kind: input.kind, label: input.label, cutoff: input.cutoff },
          });
          session = await gateway.createSession({ input: [{ type: 'input_text', text: JSON.stringify(input) }], metadata, agent: { model, instructions, tools: [{ type: 'web_search', context_size: 'low', mode: 'live' }] } }, signal);
        } else {
          const matches = await gateway.findSessions(metadata, signal);
          if (matches.length !== 1) throw new Error('today_creation_reconciliation_pending');
          session = matches[0]!;
        }
        row = await repository.patch(row, { providerSessionId: session.id });
      }
      const deadline = Date.now() + 8 * 60_000;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const turns = await gateway.turns(row.providerSessionId!, signal);
        if (row.repairCount > 0 && turns.length < 2) {
          const subscription = new AbortController();
          const events = await gateway.events(row.providerSessionId!, AbortSignal.any([signal, subscription.signal]));
          const drain = (async () => { try { for await (const _event of events) { /* Durable Items remain the source of truth. */ } } catch { /* Polling recovers a disconnected stream. */ } })();
          try { await gateway.sendMessage(row.providerSessionId!, [{ type: 'input_text', text: todayRepairPrompt }], `${row.id}/repair/1`, signal); }
          finally { subscription.abort(); await drain; }
          await delay(pollMs, undefined, { signal }); continue;
        }
        const turn = turns.at(-1);
        if (turn?.status === 'completed') {
          const items = await gateway.items(row.providerSessionId!, signal);
          const item = items.filter(i => i.type === 'message' && i.role === 'assistant' && i.turn_id === turn.id && i.status === 'completed').at(-1);
          if (!item || item.type !== 'message' || !item.id) throw new Error('today_output_not_ready');
          const text = item.content.map(p => p.type === 'output_text' ? p.text : '').join('');
          let content;
          try { content = parseBriefContent(text, input.sources, items.some(i => i.type === 'web_search_call' && i.status === 'completed')); }
          catch {
            if (!row.repairCount) { row = await repository.patch(row, { repairCount: 1 }); continue; }
            await repository.fail(row, 'invalid_output'); todayLog('failed', { briefId: row.id, code: 'invalid_output' }); return;
          }
          await repository.complete(row, content, { providerAgentId: turn.agent_id, providerTurnId: turn.id, providerItemId: item.id });
          todayLog('completed', { userId: row.userId, briefId: row.id, kind: row.slotId, sources: input.sources.length, cards: content.cards.length });
          return;
        }
        if (turn && ['failed', 'cancelled'].includes(turn.status)) { await repository.fail(row, 'agent_failed'); return; }
        await delay(pollMs, undefined, { signal });
      }
      throw new Error('today_execution_pending');
    } catch (error) {
      todayLog('reconcile_pending', { briefId: original.id, attempt: original.attempts });
      throw error;
    } finally { clearInterval(heartbeat); await repository.release(original); }
  } };
}
