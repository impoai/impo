import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { Rebyte } from '@rebyteai/agent-sdk';
import { RebyteGateway } from '../src/rebyte/gateway.js';
import { modelModes } from '../src/model-modes.js';
import { todayGuidanceInstructions } from '../src/prompts/today.js';
import { buildBriefGuidance } from '../src/today/context.js';
import { defaultBriefPreferences, parseBriefContentV2 } from '../src/today/content.js';
import type { BriefInput } from '../src/today/contract.js';

for (const scenario of ['next-step', 'connect', 'inbox-offer', 'occasion'] as const) {
  test(`real Brief generation: ${scenario}`, { timeout: 180_000 }, async t => {
    const apiKey = process.env.REBYTE_API_KEY;
    assert.ok(apiKey, 'REBYTE_API_KEY is required; live checks never skip');
    const model = ['next-step', 'connect'].includes(scenario) ? modelModes.Balanced : modelModes.Power;
    const baseURL = process.env.REBYTE_BASE_URL ?? 'https://api.rebyte.ai/v1';
    const gateway = new RebyteGateway({ apiKey, baseURL, model, timeoutMs: 15000 });
    const client = new Rebyte({ apiKey, baseURL, timeout: 15000, maxRetries: 0, logLevel: 'off' });
    const metadata = { impo_test: 'brief-guidance', impo_probe: randomUUID() };
    let id: string | undefined; let uncertain = false;
    t.after(async () => {
      const ids = id ? [id] : uncertain ? (await gateway.findSessions(metadata, AbortSignal.timeout(15000))).map(s => s.id) : [];
      for (const value of ids) await client.beta.agents.sessions.delete(value);
    });
    const input: BriefInput = { localDate: '2027-09-14', cutoff: '2027-09-14T12:00:00Z', timeZone: 'Asia/Shanghai', locale: 'en', kind: 'evening', label: 'Evening Brief', profile: { displayName: 'Synthetic test user', location: null }, truncated: false,
      sources: scenario === 'next-step' ? [{ id: 'message:talk', kind: 'message', recordId: 'talk', title: 'Your message', version: 'v1', occurredAt: '2027-09-14T11:00:00Z', occurredLocalDate: '2027-09-14', text: 'Tomorrow I am giving a ten-minute talk on post-training. I have the reading notes but no outline yet. I want to explain supervised fine-tuning and preference optimization clearly.' }] : [] };
    const status = scenario === 'inbox-offer' ? 'connected' as const : 'disconnected' as const;
    input.guidance = await buildBriefGuidance('synthetic', input, metadata.impo_probe,
      { ...defaultBriefPreferences, occasionCalendar: scenario === 'occasion' ? 'chinese' : 'none' }, {}, 2,
      { scheduledTasks: true, echoSchedule: true, echoSpeakers: true }, ['connect', 'inbox-offer'].includes(scenario) ? { connectors: {
        list: async () => [{ toolkit: 'gmail', name: 'Gmail', featured: true, status }], getStatus: async () => ({ status }), refresh: async () => ({ status }),
      } } : {});
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(150000)]);
    try {
      uncertain = true;
      const session = await gateway.createSession({ metadata, agent: { model, instructions: todayGuidanceInstructions, tools: [] }, input: [{ type: 'input_text', text: JSON.stringify(input) }] }, signal);
      id = session.id; uncertain = false;
      while (true) {
        const turn = (await gateway.turns(id, signal)).at(-1);
        if (turn && ['completed', 'failed', 'cancelled'].includes(turn.status)) {
          assert.equal(turn.status, 'completed');
          const item = (await gateway.items(id, signal)).filter(v => v.type === 'message' && v.role === 'assistant' && v.turn_id === turn.id).at(-1);
          assert.ok(item?.type === 'message');
          const content = parseBriefContentV2(item.content.map(p => p.type === 'output_text' ? p.text : '').join(''), input);
          assert.ok(content.cards.length > 0, 'the synthetic scenario has a concrete eligible opportunity');
          const expected = scenario === 'connect' ? 'connect' : scenario === 'occasion' ? 'occasion' : 'suggestion';
          assert.equal(content.cards[0]!.type, expected);
          if (scenario === 'inbox-offer') assert.doesNotMatch(JSON.stringify(content), /\b\d+\s+(?:unread|new|urgent)\s+(?:emails|messages)\b/i);
          await mkdir('.local/brief-guidance', { recursive: true, mode: 0o700 });
          await writeFile(`.local/brief-guidance/${scenario}.json`, JSON.stringify({ model, content }, null, 2), { mode: 0o600 });
          t.diagnostic(`${model}: ${content.cards.map(c => `${c.type}: ${c.title}`).join('; ')}`);
          return;
        }
        await delay(1000, undefined, { signal });
      }
    } catch (error) {
      if (error instanceof Rebyte.APIError) {
        if (error.status && error.status < 500) uncertain = false;
        throw new Error(`Brief availability check failed: HTTP ${error.status}`);
      }
      throw error instanceof assert.AssertionError ? error : new Error(`Brief ${scenario} did not complete valid output`);
    }
  });
}
