import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Rebyte } from '@rebyteai/agent-sdk';
import { RebyteGateway, RebytePaginationLimitError, REBYTE_INSTRUCTIONS } from '../src/rebyte/gateway.js';
import { deviceTools } from '../src/tools/device-tools.js';

type Call = { url: URL; method: string; headers: Headers; body: unknown; signal: AbortSignal };
const signal = () => new AbortController().signal;
const session = (id: string, metadata: Record<string, string> = {}) => ({
  id, object: 'agent.session', metadata, status: 'idle', environment: { type: 'none' },
  agent: { id: 'agent-inline', model: 'gpt-5.6-luna', tools: [] }, required_actions: [], error: null,
});
const json = (value: unknown) => Response.json(value);

function fixture(t: TestContext, handle: (call: Call, index: number) => Response | Promise<Response>, timeoutMs?: number) {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)), method: init?.method ?? 'GET', headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, signal: init!.signal!,
    };
    calls.push(call);
    return handle(call, calls.length - 1);
  });
  const gateway = new RebyteGateway({ apiKey: 'test-only-key', baseURL: 'https://rebyte.test/v1', model: 'gpt-5.6-luna', timeoutMs });
  return { gateway, calls };
}

test('Rebyte creation advertises device Functions with first input and recovery metadata', async t => {
  const metadata = { instant_binding_id: 'binding-one', instant_attempt_id: 'attempt-one' };
  const { gateway, calls } = fixture(t, () => json(session('sess-one', metadata)));
  assert.equal((await gateway.createSession({ input: [{ type: 'input_text', text: '你好' }], metadata, agent: { model: 'gpt-5.6-luna', instructions: REBYTE_INSTRUCTIONS, tools: deviceTools } }, signal())).id, 'sess-one');
  assert.equal(calls[0].url.pathname, '/v1/agents/sessions');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer test-only-key');
  assert.equal(calls[0].headers.get('openai-beta'), 'agents=v1');
  assert.equal(calls[0].headers.get('idempotency-key'), null);
  const body = calls[0].body as { environment: unknown; agent: { model: string; instructions: string; tools: Array<{ type: string; name: string; parameters: Record<string, unknown> }> }; input: unknown; metadata: unknown };
  assert.deepEqual(body.environment, { type: 'none' });
  assert.equal(body.agent.model, 'gpt-5.6-luna'); assert.equal(body.agent.instructions, REBYTE_INSTRUCTIONS);
  assert.deepEqual(body.agent.tools.map(tool => tool.name).sort(), ['impo_create_reminder', 'impo_get_health_summary', 'impo_list_calendar_events', 'impo_list_reminders', 'impo_search_contacts', 'ios_get_health_summary', 'ios_list_calendar_events']);
  assert.ok(body.agent.tools.every(tool => tool.type === 'function' && tool.parameters.additionalProperties === false));
  assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }]); assert.deepEqual(body.metadata, metadata);
});

test('Rebyte Agent creation sends model/instructions/tools/metadata to the reusable Agent endpoint', async t => {
  const metadata = { instant_user: 'user-one', instant_agent_creation: 'attempt-one' };
  const agent = { id: 'agent-one', object: 'agent', model: 'gpt-5.6-luna', instructions: REBYTE_INSTRUCTIONS, metadata, tools: [] };
  const { gateway, calls } = fixture(t, () => json(agent));
  assert.equal((await gateway.createAgent({ model: 'gpt-5.6-luna', instructions: REBYTE_INSTRUCTIONS, tools: deviceTools, metadata }, signal())).id, 'agent-one');
  assert.equal(calls[0].url.pathname, '/v1/agents');
  assert.equal(calls[0].method, 'POST');
  const body = calls[0].body as { model: string; instructions: string; tools: unknown[]; metadata: unknown };
  assert.equal(body.model, 'gpt-5.6-luna'); assert.equal(body.instructions, REBYTE_INSTRUCTIONS);
  assert.equal(body.tools.length, deviceTools.length); assert.deepEqual(body.metadata, metadata);
});

test('Rebyte Agent recovery paginates and exactly matches every metadata field', async t => {
  const metadata = { instant_user: 'user-one', instant_agent_creation: 'attempt-one' };
  const agent = (id: string, agentMetadata: Record<string, string> = {}) => ({ id, object: 'agent', model: 'gpt-5.6-luna', instructions: null, metadata: agentMetadata, tools: [] });
  const { gateway, calls } = fixture(t, (_call, index) => json(index === 0
    ? { data: [agent('agent-other', { ...metadata, instant_agent_creation: 'attempt-other' }), agent('agent-boundary')], has_more: true }
    : { data: [agent('agent-match', metadata), agent('agent-wrong-owner', { ...metadata, instant_user: 'other' })], has_more: false }));
  assert.deepEqual((await gateway.findAgents(metadata, signal())).map(value => value.id), ['agent-match']);
  assert.equal(calls[0].url.pathname, '/v1/agents');
  assert.equal(calls[0].url.searchParams.get('limit'), '100');
  assert.equal(calls[1].url.searchParams.get('after'), 'agent-boundary');
});

test('Rebyte Session creation with agentId sends agent_id and only overrides instructions/tools', async t => {
  const metadata = { instant_binding: 'binding-one' };
  const { gateway, calls } = fixture(t, () => json(session('sess-one', metadata)));
  await gateway.createSession({ input: [{ type: 'input_text', text: '你好' }], metadata, agentId: 'agent-one', agent: { instructions: 'extra context', tools: deviceTools } }, signal());
  const body = calls[0].body as { agent_id: string; model?: string; agent: Record<string, unknown> };
  assert.equal(body.agent_id, 'agent-one');
  assert.equal(body.model, undefined, 'model is not part of the override and is inherited from the saved Agent');
  assert.deepEqual(body.agent, { instructions: 'extra context', tools: deviceTools });
});

test('Rebyte Session creation with agentId and no override omits agent entirely, inheriting the saved Agent', async t => {
  const { gateway, calls } = fixture(t, () => json(session('sess-one')));
  await gateway.createSession({ input: [{ type: 'input_text', text: '你好' }], metadata: {}, agentId: 'agent-one' }, signal());
  const body = calls[0].body as { agent_id: string; agent?: unknown };
  assert.equal(body.agent_id, 'agent-one');
  assert.equal('agent' in body, false);
});

test('Rebyte recovery paginates and exactly matches every metadata field', async t => {
  const metadata = { instant_binding_id: 'binding-one', instant_attempt_id: 'attempt-one' };
  const { gateway, calls } = fixture(t, (_call, index) => json(index === 0
    ? { data: [session('sess-other', { ...metadata, instant_attempt_id: 'attempt-one-other' }), session('sess-boundary')], has_more: true }
    : { data: [session('sess-match', metadata), session('sess-wrong-owner', { ...metadata, instant_binding_id: 'other' })], has_more: false }));
  assert.deepEqual((await gateway.findSessions(metadata, signal())).map(value => value.id), ['sess-match']);
  assert.equal(calls[0].url.searchParams.get('limit'), '100');
  assert.equal(calls[0].url.searchParams.get('order'), 'desc');
  assert.equal(calls[1].url.searchParams.get('after'), 'sess-boundary');
});

test('Rebyte history methods collect ordered pages and retain persisted Item shapes', async t => {
  const { gateway, calls } = fixture(t, (call, index) => {
    if (call.url.pathname.endsWith('/sess-one')) return json(session('sess-one'));
    if (call.url.pathname.endsWith('/turns')) return json({ data: [{ id: 'turn-one', status: 'completed' }], has_more: false });
    return json(index === 2
      ? { data: [{ id: 'item-user', type: 'message', role: 'user', turn_id: 'turn-one', content: [{ type: 'input_text', text: 'Hello' }] }], has_more: true }
      : { data: [{ id: 'item-answer', type: 'message', role: 'assistant', status: 'completed', turn_id: 'turn-one', content: [{ type: 'output_text', text: '你好' }] }], has_more: false });
  });
  assert.equal((await gateway.retrieve('sess-one', signal())).id, 'sess-one');
  assert.equal((await gateway.turns('sess-one', signal()))[0].status, 'completed');
  const items = await gateway.items('sess-one', signal());
  assert.deepEqual(items.map(item => item.id), ['item-user', 'item-answer']);
  assert.equal(calls[2].url.searchParams.get('order'), 'asc');
  assert.equal(calls[3].url.searchParams.get('after'), 'item-user');
});

test('Rebyte message/cancel commands put retry keys in HTTP headers, not JSON', async t => {
  const { gateway, calls } = fixture(t, () => new Response(null, { status: 204 }));
  await gateway.sendMessage('sess-one', [{ type: 'input_text', text: '接着说' }], 'message-one', signal());
  await gateway.cancel('sess-one', 'cancel-one', signal());
  assert.equal(calls[0].headers.get('idempotency-key'), 'message-one');
  assert.deepEqual(calls[0].body, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: '接着说' }] }] }] });
  assert.equal(calls[1].headers.get('idempotency-key'), 'cancel-one');
  assert.deepEqual(calls[1].body, { events: [{ type: 'agent.session.input.cancel' }] });
  assert.ok(calls.every(call => call.url.pathname === '/v1/agents/sessions/sess-one/events' && call.method === 'POST'));
});

test('Rebyte device receipts preserve stable retry keys and the SDK success/error envelope', async t => {
  const { gateway, calls } = fixture(t, () => new Response(null, { status: 204 }));
  await gateway.submitToolResult('sess-one', { turnId: 'turn-one', callId: 'calendar-one', result: { ok: true, data: { test_data: true, events: [] } } }, 'receipt-calendar', signal());
  await gateway.submitToolResult('sess-one', { turnId: 'turn-one', callId: 'health-one', result: { ok: false, error: { code: 'device_tool_failed', message: 'health_permission_denied' } } }, 'receipt-health', signal());
  assert.equal(calls[0].headers.get('idempotency-key'), 'receipt-calendar');
  const success = (calls[0].body as { events: Array<Record<string, unknown>> }).events[0];
  const { output, ...envelope } = success;
  assert.deepEqual(envelope, { type: 'agent.session.input.tool_result', turn_id: 'turn-one', call_id: 'calendar-one', success: true });
  assert.equal(typeof output, 'string'); assert.deepEqual(JSON.parse(output as string), { test_data: true, events: [] });
  assert.equal(calls[1].headers.get('idempotency-key'), 'receipt-health');
  const event = (calls[1].body as { events: Array<Record<string, unknown>> }).events[0];
  assert.equal(event.type, 'agent.session.input.tool_result'); assert.equal(event.turn_id, 'turn-one'); assert.equal(event.call_id, 'health-one');
  assert.equal(event.success, false); assert.equal(typeof event.error, 'string'); assert.match(event.error as string, /health_permission_denied/);
  assert.equal('output' in event, false);
  assert.ok(calls.every(call => call.url.pathname === '/v1/agents/sessions/sess-one/events' && call.method === 'POST'));
});

test('Rebyte events establishes a live SSE subscription and caller abort closes its request', async t => {
  const event = { type: 'agent.session.turn.output_text.delta', event_id: 'event-one', session_id: 'sess-one', turn_id: 'turn-one', item_id: 'item-one', output_index: 0, content_index: 0, delta: '你好' };
  const { gateway, calls } = fixture(t, () => new Response(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
  const controller = new AbortController();
  const stream = await gateway.events('sess-one', controller.signal);
  assert.equal(calls.length, 1, 'Subscription must be established before the caller submits input');
  assert.equal(calls[0].headers.get('accept'), 'text/event-stream');
  assert.equal(calls[0].headers.get('last-event-id'), null);
  for await (const value of stream) { assert.deepEqual(value, event); break; }
  controller.abort();
  assert.equal(calls[0].signal.aborted, true);
});

test('Rebyte mutations do not automatically retry; pre-aborted work never sends requests', async t => {
  const { gateway, calls } = fixture(t, () => Response.json({ error: { message: 'temporary upstream error', type: 'server_error' } }, { status: 500 }));
  await assert.rejects(gateway.createSession({ input: [{ type: 'input_text', text: 'hello' }], metadata: {} }, signal()), error => error instanceof Rebyte.APIError && error.status === 500);
  assert.equal(calls.length, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(gateway.sendMessage('sess-one', [{ type: 'input_text', text: 'hello' }], 'one', controller.signal), { name: 'AbortError' });
  assert.equal(calls.length, 1);
});

test('Rebyte HTTP timeout aborts the transport without automatic retry', async t => {
  const { gateway, calls } = fixture(t, call => new Promise((_resolve, reject) => {
    call.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }), 20);
  await assert.rejects(gateway.retrieve('sess-one', signal()), error => error instanceof Rebyte.APIConnectionTimeoutError);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true);
});

test('Rebyte recovery refuses a truncated scan instead of reporting no matching Session', async t => {
  const { gateway, calls } = fixture(t, (_call, index) => json({ data: [session(`sess-${index}`)], has_more: true }));
  await assert.rejects(gateway.findSessions({ instant_attempt_id: 'not-found' }, signal()), RebytePaginationLimitError);
  assert.equal(calls.length, 100);
});
