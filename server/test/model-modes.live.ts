import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Rebyte, rebyteSandbox } from '@rebyteai/agent-sdk';
import { modelModes } from '../src/model-modes.js';
import { RebyteGateway } from '../src/rebyte/gateway.js';

/** Explicit synthetic acceptance: never runs in the offline suite or uses user content. */
for (const [mode, model] of Object.entries(modelModes)) {
  test(`real Rebyte completes ${mode} with ${model}`, { timeout: 210_000 }, async t => {
    const apiKey = process.env.REBYTE_API_KEY;
    assert.ok(apiKey, 'REBYTE_API_KEY is required; live acceptance never skips');
    const config = { apiKey, baseURL: process.env.REBYTE_BASE_URL ?? 'https://api.rebyte.ai/v1', model, timeoutMs: 15_000 };
    const gateway = new RebyteGateway(config);
    const client = new Rebyte({ apiKey, baseURL: config.baseURL, timeout: 15_000, maxRetries: 0, logLevel: 'off' });
    const metadata = { impo_test: 'model-modes', impo_probe: randomUUID() };
    let sessionId: string | undefined;
    let uncertain = false;
    t.after(async () => {
      const ids = sessionId ? [sessionId] : uncertain ? (await gateway.findSessions(metadata, AbortSignal.timeout(15_000))).map(session => session.id) : [];
      for (const id of ids) await client.beta.agents.sessions.delete(id);
    });
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(180_000)]);
    try {
      uncertain = true;
      const session = await gateway.createSession({ input: [{ type: 'input_text', text: 'Reply exactly MODE_OK. Do not call tools.' }], metadata,
        agent: { model, instructions: 'This is an isolated model availability check.', tools: [{ type: 'web_search', context_size: 'medium', mode: 'live' }] },
        environment: rebyteSandbox({ network: { access: 'enabled' } }),
      }, signal);
      sessionId = session.id; uncertain = false;
      while (true) {
        const turns = await gateway.turns(session.id, signal);
        const turn = turns.at(-1);
        if (turn && ['completed', 'failed', 'cancelled'].includes(turn.status)) {
          assert.equal(turn.status, 'completed', `${mode} execution failed: ${turn.error?.code ?? turn.status}`);
          const items = await gateway.items(session.id, signal);
          assert.ok(items.some(item => item.type === 'message' && item.role === 'assistant' && item.content.some(part => part.type === 'output_text' && part.text.includes('MODE_OK'))));
          return;
        }
        await delay(1000, undefined, { signal });
      }
    } catch (error) {
      // Keep SDK headers, request bodies and credentials out of test output.
      const status = error instanceof Rebyte.APIError ? error.status : undefined;
      if (status && status < 500) uncertain = false;
      throw new Error(status ? `${mode} (${model}) unavailable: HTTP ${status}` : `${mode} (${model}) did not complete the bounded acceptance check`);
    }
  });
}
