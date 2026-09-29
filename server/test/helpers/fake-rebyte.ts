import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type JSONRecord = Record<string, any>;
export type FakeTurn = JSONRecord & { id: string; status: string; text: string; answer: string; assistant: JSONRecord; emitted: number };
export type FakeSession = JSONRecord & { id: string; turns: FakeTurn[]; items: JSONRecord[]; streams: Set<ServerResponse> };
export type PlannedTool = { name: string; arguments: JSONRecord };

/** A live-only Agents API double. It owns durable remote state independently of
 * the real Instant API/Worker child processes, and uses the installed SDK's wire
 * shapes. Passing these tests does not count as a real Rebyte/model acceptance. */
export class FakeRebyte {
  readonly sessions: FakeSession[] = [];
  readonly agents: JSONRecord[] = [];
  readonly requests: { method: string; path: string; key?: string; body?: JSONRecord }[] = [];
  readonly errors: string[] = [];
  readonly inputKeys = new Map<string, FakeTurn>();
  readonly cancelKeys = new Set<string>();
  readonly toolResults = new Map<string, JSONRecord>();
  nextTools: PlannedTool[] = [];
  /** Intermediate Items (commands, commentary...) added to the next Turn before its answer. */
  nextSteps: JSONRecord[] = [];
  answers: string[] = [];
  historyReads = 0;
  holdNextToolResult = false;
  holdNextAgentCreate = false;
  holdNextCreate = false;
  holdNextInput = false;
  holdNextTurn = false;
  holdCancellation = false;
  private heldAgentCreates: { response: ServerResponse; agent: JSONRecord }[] = [];
  private heldCreates: { response: ServerResponse; session: FakeSession }[] = [];
  private heldInputs: ServerResponse[] = [];
  private heldToolResults: ServerResponse[] = [];
  pendingCancellation?: { session: FakeSession; turn: FakeTurn; response: ServerResponse; key: string };
  private readonly timers = new Set<NodeJS.Timeout>();
  private eventNumber = 0;
  readonly server = createServer((request, response) => {
    void this.route(request, response).catch(error => {
      this.errors.push(String(error));
      if (!response.headersSent) this.json(response, 500, { error: { message: String(error), type: 'test_failure' } });
      else response.destroy();
    });
  });

  async listen() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}/v1`;
  }
  async close() {
    for (const timer of this.timers) clearTimeout(timer);
    for (const session of this.sessions) for (const response of session.streams) response.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
  private json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }
  private sessionView(session: FakeSession) {
    const { turns: _turns, items: _items, streams: _streams, ...view } = session;
    return view;
  }
  private turnView(turn: FakeTurn) {
    const { text: _text, answer: _answer, assistant: _assistant, emitted: _emitted, ...view } = turn;
    return view;
  }
  private emit(session: FakeSession, payload: JSONRecord, duplicate = false) {
    const event: JSONRecord = { event_id: `evt_fake_${++this.eventNumber}`, session_id: session.id, ...payload };
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of session.streams) {
      response.write(frame);
      if (duplicate) response.write(frame);
    }
  }
  private page(response: ServerResponse, url: URL, values: JSONRecord[]) {
    const ordered = url.searchParams.get('order') === 'asc' ? [...values] : [...values].reverse();
    const after = url.searchParams.get('after');
    const start = after ? ordered.findIndex(value => value.id === after) + 1 : 0;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 100);
    const data = ordered.slice(start, start + limit);
    this.json(response, 200, { object: 'list', data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: start + data.length < ordered.length });
  }
  private async body(request: IncomingMessage): Promise<JSONRecord> {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    return JSON.parse(body || '{}');
  }
  private later(action: () => void) {
    const timer = setTimeout(() => { this.timers.delete(timer); action(); }, 40);
    this.timers.add(timer);
  }
  private beginTurn(session: FakeSession, parts: JSONRecord[]) {
    const text = parts.map(part => String(part.text ?? '')).join('\n\n');
    assert.equal(session.status, 'idle', 'main-session turns must run serially');
    const id = `turn_fake_${session.id}_${session.turns.length + 1}`;
    const answer = this.answers.shift() ?? `Context: ${[...session.turns.map(turn => turn.text), text].join(' | ')}`;
    const assistant = { id: `item_assistant_${id}`, type: 'message', role: 'assistant', phase: 'final_answer', status: 'in_progress', content: [], turn_id: id };
    const now = Math.floor(Date.now() / 1000);
    const turn: FakeTurn = { id, object: 'agent.session.turn', session_id: session.id, agent_id: 'agent_fake', status: 'in_progress', created_at: now, started_at: now, completed_at: null, subagent_id: null, error: null, usage: null, text, answer, assistant, emitted: 0 };
    session.turns.push(turn);
    session.items.push({ id: `item_user_${id}`, type: 'message', role: 'user', phase: null, status: 'completed', content: parts, turn_id: id }, assistant);
    session.status = 'in_progress';
    this.emit(session, { type: 'agent.session.turn.created', turn_id: id, turn: this.turnView(turn) });
    this.emit(session, { type: 'agent.session.turn.in_progress', turn_id: id, turn: this.turnView(turn) });
    this.emit(session, { type: 'agent.session.turn.item.added', turn_id: id, output_index: 0, item: assistant });
    for (const [index, step] of this.nextSteps.splice(0).entries()) {
      // Intermediate Items precede the final answer in stream order.
      session.items.splice(session.items.indexOf(assistant), 0, { id: `item_step_${id}_${index}`, turn_id: id, ...step });
    }
    if (this.nextTools.length) {
      const plan = this.nextTools.splice(0);
      turn.status = 'waiting';
      session.status = 'requires_action';
      session.required_actions = plan.map((tool, index) => {
        const call = { type: 'function_call', turn_id: id, call_id: `call_${id}_${index}`, name: tool.name, arguments: tool.arguments };
        session.items.push({ ...call, id: `item_${call.call_id}`, status: 'completed' });
        return call;
      });
      this.emit(session, { type: 'agent.session.requires_action', session: this.sessionView(session) });
    }
    return turn;
  }
  releaseAgentCreateResponses() {
    for (const { response, agent } of this.heldAgentCreates.splice(0)) {
      if (!response.destroyed) this.json(response, 200, agent);
    }
  }
  releaseCreateResponses() {
    for (const { response, session } of this.heldCreates.splice(0)) {
      if (!response.destroyed) this.json(response, 200, this.sessionView(session));
    }
  }
  releaseInputResponses() {
    for (const response of this.heldInputs.splice(0)) if (!response.destroyed) response.writeHead(204).end();
  }
  releaseToolResultResponses() {
    for (const response of this.heldToolResults.splice(0)) if (!response.destroyed) response.writeHead(204).end();
  }
  emitPrefix(session: FakeSession, turn: FakeTurn) {
    const target = Math.max(1, Math.floor(turn.answer.length / 2));
    const delta = turn.answer.slice(turn.emitted, target);
    if (!delta) return;
    turn.emitted = target;
    turn.assistant.content = [{ type: 'output_text', text: turn.answer.slice(0, target) }];
    this.emit(session, { type: 'agent.session.turn.output_text.delta', turn_id: turn.id, item_id: turn.assistant.id, output_index: 0, content_index: 0, delta }, true);
  }
  complete(session: FakeSession, turn: FakeTurn) {
    if (turn.status !== 'in_progress') return;
    this.emitPrefix(session, turn);
    const delta = turn.answer.slice(turn.emitted);
    turn.emitted = turn.answer.length;
    this.emit(session, { type: 'agent.session.turn.output_text.delta', turn_id: turn.id, item_id: turn.assistant.id, output_index: 0, content_index: 0, delta });
    turn.assistant.content = [{ type: 'output_text', text: turn.answer }];
    turn.assistant.status = 'completed';
    turn.status = 'completed';
    turn.completed_at = Math.floor(Date.now() / 1000);
    session.status = 'idle';
    this.emit(session, { type: 'agent.session.turn.output_text.done', turn_id: turn.id, item_id: turn.assistant.id, output_index: 0, content_index: 0, text: turn.answer });
    this.emit(session, { type: 'agent.session.turn.item.done', turn_id: turn.id, output_index: 0, item: turn.assistant });
    this.emit(session, { type: 'agent.session.turn.completed', turn_id: turn.id, turn: this.turnView(turn), usage: null });
    this.emit(session, { type: 'agent.session.idle', session: this.sessionView(session) });
  }
  releaseCancellation() {
    const pending = this.pendingCancellation;
    assert.ok(pending, 'a remote cancellation must be pending');
    this.pendingCancellation = undefined;
    this.holdCancellation = false;
    pending.turn.status = 'cancelled';
    pending.turn.completed_at = Math.floor(Date.now() / 1000);
    pending.turn.assistant.status = 'incomplete';
    pending.session.status = 'idle';
    pending.session.required_actions = [];
    this.cancelKeys.add(pending.key);
    this.emit(pending.session, { type: 'agent.session.turn.cancelled', turn_id: pending.turn.id, turn: this.turnView(pending.turn), usage: null });
    this.emit(pending.session, { type: 'agent.session.idle', session: this.sessionView(pending.session) });
    if (!pending.response.destroyed) pending.response.writeHead(204).end();
  }
  private async route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url!, 'http://127.0.0.1');
    assert.equal(request.headers.authorization, 'Bearer instant-fake-rebyte-key');
    assert.equal(request.headers['openai-beta'], 'agents=v1');
    const path = url.pathname.replace(/^\/v1/, '');
    const key = request.headers['idempotency-key'] as string | undefined;
    const body = request.method === 'POST' ? await this.body(request) : undefined;
    this.requests.push({ method: request.method!, path, key, body });
    if (path === '/agents' && request.method === 'POST') {
      assert.equal(typeof body?.model, 'string');
      assert.equal(typeof body?.instructions, 'string');
      assert.ok(body?.metadata && Object.keys(body.metadata).length, 'creation must carry recoverable Agent metadata');
      const now = Math.floor(Date.now() / 1000);
      const agent = {
        id: `agent_fake_${this.agents.length + 1}`, object: 'agent', created_at: now, updated_at: now,
        model: body.model, instructions: body.instructions, metadata: body.metadata, tools: body.tools ?? [],
        name: null, multi_agent: { enabled: false }, reasoning: { effort: null, summary: null }, service_tier: 'auto', text: { format: { type: 'text' }, verbosity: 'medium' },
      };
      this.agents.push(agent);
      if (this.holdNextAgentCreate) { this.holdNextAgentCreate = false; this.heldAgentCreates.push({ response, agent }); }
      else this.json(response, 200, agent);
      return;
    }
    if (path === '/agents' && request.method === 'GET') { this.page(response, url, this.agents); return; }
    if (path === '/agents/sessions' && request.method === 'POST') {
      // Chat and task Sessions run in a networked Rebyte Sandbox; background briefs need none.
      assert.deepEqual(body?.environment, ['main', 'task'].includes(body?.metadata?.instant_kind) ? { type: 'openai_hosted', network: { access: 'enabled' } } : { type: 'none' });
      assert.ok(body?.metadata && Object.keys(body.metadata).length, 'creation must carry recoverable binding metadata');
      let agentView: JSONRecord;
      if (body?.agent_id) {
        const savedAgent = this.agents.find(value => value.id === body.agent_id);
        assert.ok(savedAgent, 'session references an existing saved Agent');
        assert.ok(!body.agent || Object.keys(body.agent).every(key => ['model', 'instructions', 'tools'].includes(key)), 'a Session with agent_id may only override model/instructions/tools');
        agentView = { id: savedAgent.id, model: body.agent?.model ?? savedAgent.model, instructions: body.agent?.instructions ?? savedAgent.instructions, tools: body.agent?.tools ?? savedAgent.tools };
      } else {
        agentView = { id: 'agent_fake', ...body.agent };
      }
      const now = Math.floor(Date.now() / 1000);
      const session: FakeSession = {
        id: `sess_fake_${this.sessions.length + 1}`, object: 'agent.session', created_at: now, last_active_at: now,
        agent: agentView, environment: body.environment, metadata: body.metadata,
        error: null, required_actions: [], status: 'idle', usage: null, vault_ids: [], turns: [], items: [], streams: new Set(),
      };
      this.sessions.push(session);
      assert.ok(Array.isArray(body.input) && body.input.length === 1 && body.input[0].role === 'user', 'the creation request carries the first message');
      const turn = this.beginTurn(session, body.input[0].content);
      this.later(() => this.complete(session, turn));
      if (this.holdNextCreate) {
        this.holdNextCreate = false;
        this.heldCreates.push({ response, session });
      } else this.json(response, 200, this.sessionView(session));
      return;
    }
    if (path === '/agents/sessions' && request.method === 'GET') {
      this.page(response, url, this.sessions.map(session => this.sessionView(session))); return;
    }
    const route = /^\/agents\/sessions\/([^/]+)(?:\/(events|items|turns|history)(?:\/([^/]+))?)?$/.exec(path);
    const session = this.sessions.find(value => value.id === route?.[1]);
    if (!route || !session) { this.json(response, 404, { error: { message: 'Missing fake resource', type: 'not_found' } }); return; }
    if (!route[2] && request.method === 'GET') { this.json(response, 200, this.sessionView(session)); return; }
    if (route[2] === 'items' && request.method === 'GET') { this.page(response, url, session.items); return; }
    if (route[2] === 'history' && request.method === 'GET') {
      // Rebyte history: per Turn, the user input parts and the final answer only.
      this.historyReads++;
      this.page(response, url, session.turns.map(turn => ({ object: 'agent.session.history_entry', id: turn.id, status: turn.status, created_at: turn.created_at, completed_at: turn.completed_at, error: turn.error,
        input: (session.items.find(item => item.id === `item_user_${turn.id}`)?.content ?? []) as JSONRecord[],
        output_text: turn.status === 'completed' ? String((turn.assistant.content as JSONRecord[])?.[0]?.text ?? '') : null })));
      return;
    }
    if (route[2] === 'turns' && request.method === 'GET') {
      if (route[3]) {
        const turn = session.turns.find(value => value.id === route[3]);
        this.json(response, turn ? 200 : 404, turn ? this.turnView(turn) : { error: { message: 'Missing turn' } });
      } else this.page(response, url, session.turns.map(turn => this.turnView(turn)));
      return;
    }
    if (route[2] === 'events' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      response.flushHeaders();
      response.write(': live stream; history is only available via Items/Turns\n\n');
      session.streams.add(response);
      response.once('close', () => session.streams.delete(response));
      return;
    }
    if (route[2] === 'events' && request.method === 'POST') {
      assert.ok(key, 'event POST requires a stable Idempotency-Key');
      assert.equal(body?.events?.length, 1);
      const event = body.events[0];
      if (event.type === 'agent.session.input.message') {
        if (this.inputKeys.has(`${session.id}:${key}`)) { response.writeHead(204).end(); return; }
        assert.ok(session.streams.size, 'subscribe to live events before submitting input');
        const turn = this.beginTurn(session, event.input.flatMap((item: JSONRecord) => item.content));
        this.inputKeys.set(`${session.id}:${key}`, turn);
        const hold = this.holdNextTurn || this.holdNextInput;
        this.holdNextTurn = false;
        if (this.holdNextInput) { this.holdNextInput = false; this.heldInputs.push(response); }
        else response.writeHead(204).end();
        if (!hold) this.later(() => this.complete(session, turn));
        return;
      }
      if (event.type === 'agent.session.input.cancel') {
        if (this.cancelKeys.has(`${session.id}:${key}`)) { response.writeHead(204).end(); return; }
        const turn = session.turns.findLast(value => ['in_progress', 'waiting'].includes(value.status));
        assert.ok(turn, 'cancellation must target the still-active turn');
        this.pendingCancellation = { session, turn, response, key: `${session.id}:${key}` };
        if (!this.holdCancellation) this.releaseCancellation();
        return;
      }
      if (event.type === 'agent.session.input.tool_result') {
        const identity = `${session.id}:${key}`;
        const existing = this.toolResults.get(identity);
        if (existing) {
          assert.deepEqual(existing, event, 'tool result retries must keep the original result and key');
          response.writeHead(204).end(); return;
        }
        assert.equal(typeof event.success, 'boolean');
        const action = session.required_actions.find((action: JSONRecord) => action.call_id === event.call_id && action.turn_id === event.turn_id);
        assert.ok(action, 'a result must refer to an outstanding Function call');
        if (event.success) assert.equal(typeof event.output, 'string', 'device JSON results must be encoded as supported model-input text');
        else assert.equal(typeof event.error, 'string');
        this.toolResults.set(identity, event);
        session.items.push({ id: `output_${event.call_id}`, type: 'function_call_output', turn_id: event.turn_id, call_id: event.call_id, output: event.output ?? null, error: event.error ?? null, status: event.success ? 'completed' : 'failed' });
        session.required_actions = session.required_actions.filter((action: JSONRecord) => action.call_id !== event.call_id);
        if (session.required_actions.length === 0) {
          const turn = session.turns.find(value => value.id === event.turn_id)!;
          turn.status = 'in_progress';
          session.status = 'in_progress';
          turn.answer = [...this.toolResults.values()].filter(result => result.turn_id === turn.id)
            .map(result => result.success ? `Tool output: ${result.output}` : `Tool error: ${result.error}`).join('\n');
          this.later(() => this.complete(session, turn));
        }
        if (this.holdNextToolResult) { this.holdNextToolResult = false; this.heldToolResults.push(response); }
        else response.writeHead(204).end();
        return;
      }
    }
    this.json(response, 404, { error: { message: `Unimplemented fake route ${request.method} ${path}` } });
  }
}
