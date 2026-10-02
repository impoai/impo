import { Rebyte } from '@rebyteai/agent-sdk';
import type { Agent, AgentSession, AgentSessionEvent, AgentSessionItem, AgentToolParam, EnvironmentParam } from '@rebyteai/agent-sdk/resources/beta/agents';
import type { Turn } from '@rebyteai/agent-sdk/resources/beta/agents/sessions/turns';
import type { SessionArtifact } from '@rebyteai/agent-sdk/resources/beta/agents/sessions/artifacts';
import { mainInstructions } from '../prompts/index.js';

export type { AgentSession, AgentSessionEvent, SessionArtifact, Turn };
export type AgentItem = AgentSessionItem;
export type RebyteAgent = Agent;
export type { AgentToolParam, EnvironmentParam };

// Existing consumers may retain these names; prompt ownership lives in prompts/.
export { mainInstructions as REBYTE_INSTRUCTIONS, taskInstructions as TASK_INSTRUCTIONS } from '../prompts/index.js';

export function toolResultPayload(result: Record<string, unknown>): { success: true; output: string } | { success: false; error: string } {
  if (result.ok === true) return { success: true, output: JSON.stringify(result.data) };
  const error = result.error as { code?: string; message?: string } | undefined;
  if (result.ok !== false || typeof error?.message !== 'string') throw new Error('Invalid frozen tool result');
  return { success: false, error: `${error.code ?? 'device_tool_failed'}: ${error.message}` };
}

/** These HTTP responses prove creation was rejected before a resource was accepted. */
export class RebyteCreationRejectedError extends Error {
  constructor(readonly status: number, readonly providerCode?: string) {
    super('Rebyte rejected resource creation');
    this.name = 'RebyteCreationRejectedError';
  }
}
async function creation<T>(request: () => Promise<T>): Promise<T> {
  try { return await request(); }
  catch (error) {
    if (error instanceof Rebyte.APIError && error.status && [400, 401, 403, 404, 422].includes(error.status)) {
      const code = (error.error as { code?: unknown } | undefined)?.code;
      throw new RebyteCreationRejectedError(error.status, typeof code === 'string' && /^[a-z0-9_]{1,80}$/i.test(code) ? code : undefined);
    }
    throw error;
  }
}

/** User input content parts; Instant sends device context and the user's own text as separate parts. */
export type InputParts = Array<{ type: 'input_text'; text: string }>;

/** One Turn of Rebyte conversation history: what the user sent and the final answer. */
export interface HistoryEntry {
  id: string; status: 'queued' | 'in_progress' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  created_at: number; completed_at: number | null;
  input: Array<{ type: string; text?: string }>; output_text: string | null;
}
export interface HistoryPage { data: HistoryEntry[]; has_more: boolean; last_id: string | null }

export interface RebyteGatewayConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs?: number;
}

type Page<T> = { data: T[]; hasNextPage(): boolean; getNextPage(): Promise<Page<T>> };
const pageLimit = 100;

/** A truncated organization/history scan must never look like a definitive absence. */
export class RebytePaginationLimitError extends Error {
  constructor() {
    super('Rebyte pagination exceeded the supported 100-page scan');
    this.name = 'RebytePaginationLimitError';
  }
}

async function collect<T>(firstPage: PromiseLike<Page<T>>, signal: AbortSignal): Promise<T[]> {
  const result: T[] = [];
  let page = await firstPage;
  for (let index = 0; index < pageLimit; index++) {
    signal.throwIfAborted();
    result.push(...page.data);
    if (!page.hasNextPage()) return result;
    if (index + 1 === pageLimit) throw new RebytePaginationLimitError();
    page = await page.getNextPage();
  }
  throw new RebytePaginationLimitError();
}

/** Wire adapter only: durable ownership, retries and recovery belong to the worker. */
export class RebyteGateway {
  private readonly client: Rebyte;
  private readonly model: string;

  constructor(config: RebyteGatewayConfig) {
    this.model = config.model;
    this.client = new Rebyte({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeoutMs ?? 30_000,
      maxRetries: 0,
      // Upstream exception bodies and credentials must not reach SDK debug logs.
      logLevel: 'off',
    });
  }

  /** Not idempotent upstream: an uncertain response requires metadata reconciliation. */
  async createSession(input: { input: InputParts; metadata: Record<string, string>; agentId?: string; agent?: { model?: string; instructions?: string; tools?: AgentToolParam[] }; environment?: EnvironmentParam }, signal: AbortSignal): Promise<AgentSession> {
    signal.throwIfAborted();
    // With agentId, only pass explicit overrides; omitted fields inherit the saved Agent unchanged.
    const override = input.agentId ? {
      // Model-dependent defaults from a Saved Agent must not leak into another model.
      ...(input.agent?.model !== undefined ? { model: input.agent.model, reasoning: null, service_tier: null, text: null } : {}),
      ...(input.agent?.instructions !== undefined ? { instructions: input.agent.instructions } : {}),
      ...(input.agent?.tools !== undefined ? { tools: input.agent.tools } : {}),
    } : undefined;
    const agent = input.agentId
      ? (Object.keys(override!).length ? override : undefined)
      : { model: input.agent?.model ?? this.model, instructions: input.agent?.instructions ?? mainInstructions, tools: input.agent?.tools ?? [] };
    return creation(() => this.client.beta.agents.sessions.create({
      environment: input.environment ?? { type: 'none' },
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      ...(agent ? { agent } : {}),
      input: [{ role: 'user', content: input.input }],
      metadata: input.metadata,
    }, { signal }));
  }

  /** Not idempotent upstream: an uncertain response requires metadata reconciliation. */
  async createAgent(input: { model: string; instructions: string; tools: AgentToolParam[]; metadata: Record<string, string> }, signal: AbortSignal): Promise<Agent> {
    signal.throwIfAborted();
    return creation(() => this.client.beta.agents.create({ model: input.model, instructions: input.instructions, tools: input.tools, metadata: input.metadata }, { signal }));
  }

  async findAgents(metadata: Record<string, string>, signal: AbortSignal): Promise<Agent[]> {
    signal.throwIfAborted();
    const agents = await collect(this.client.beta.agents.list({ order: 'desc', limit: 100 }, { signal }), signal);
    return agents.filter(agent => Object.entries(metadata).every(([key, value]) => agent.metadata?.[key] === value));
  }

  async findSessions(metadata: Record<string, string>, signal: AbortSignal): Promise<AgentSession[]> {
    signal.throwIfAborted();
    const sessions = await collect(this.client.beta.agents.sessions.list({ order: 'desc', limit: 100 }, { signal }), signal);
    return sessions.filter(session => Object.entries(metadata).every(([key, value]) => session.metadata?.[key] === value));
  }

  /** Includes uncertain creations whose provider IDs never reached PostgreSQL. */
  async deleteAccountResources(userId: string, conversationIds: string[], knownSessions: string[], knownAgents: string[], signal: AbortSignal): Promise<void> {
    const sessions = await collect(this.client.beta.agents.sessions.list({ order: 'desc', limit: 100 }, { signal }), signal);
    const conversations = new Set(conversationIds);
    const ownedSessions = sessions.filter(s => s.metadata?.instant_app === 'instant' &&
      (s.metadata?.instant_user === userId || conversations.has(s.metadata?.instant_conversation ?? '')));
    const remove = async (operation: () => Promise<unknown>) => {
      try { await operation(); } catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    };
    for (const id of new Set([...knownSessions, ...ownedSessions.map(s => s.id)]))
      await remove(() => this.client.beta.agents.sessions.delete(id, { signal }));
    const agents = await this.findAgents({ instant_app: 'instant', instant_user: userId }, signal);
    for (const id of new Set([...knownAgents, ...agents.map(a => a.id)]))
      await remove(() => this.client.beta.agents.delete(id, { signal }));
  }

  async retrieve(sessionId: string, signal: AbortSignal): Promise<AgentSession> {
    signal.throwIfAborted();
    return this.client.beta.agents.sessions.retrieve(sessionId, { signal });
  }

  async turns(sessionId: string, signal: AbortSignal): Promise<Turn[]> {
    signal.throwIfAborted();
    return collect(this.client.beta.agents.sessions.turns.list(sessionId, { order: 'asc', limit: 100 }, { signal }), signal);
  }

  /** Existing Items can change in place; callers reconcile by item ID, not append only. */
  async items(sessionId: string, signal: AbortSignal): Promise<AgentItem[]> {
    signal.throwIfAborted();
    return collect(this.client.beta.agents.sessions.items.list(sessionId, { order: 'asc', limit: 100 }, { signal }), signal);
  }

  async sendMessage(sessionId: string, input: InputParts, idempotencyKey: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.client.beta.agents.sessions.events.create(sessionId, {
      'Idempotency-Key': idempotencyKey,
      events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: input }] }],
    }, { signal });
  }

  /** Rebyte conversation history (user input and final answer per Turn); the only copy of chat text. */
  async history(sessionId: string, query: { order: 'asc' | 'desc'; limit: number; after?: string }, signal?: AbortSignal): Promise<HistoryPage> {
    signal?.throwIfAborted();
    return this.client.get(`/agents/sessions/${encodeURIComponent(sessionId)}/history`, {
      query: { order: query.order, limit: query.limit, ...(query.after ? { after: query.after } : {}) },
      headers: { 'OpenAI-Beta': 'agents=v1' }, ...(signal ? { signal } : {}),
    }) as Promise<HistoryPage>;
  }

  async submitToolResult(sessionId: string, input: { turnId: string; callId: string; result: Record<string, unknown> }, idempotencyKey: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.client.beta.agents.sessions.events.create(sessionId, {
      'Idempotency-Key': idempotencyKey,
      events: [{ type: 'agent.session.input.tool_result', turn_id: input.turnId, call_id: input.callId, ...toolResultPayload(input.result) }],
    }, { signal });
  }

  /** Immutable files published by completed Turns; they outlive the Sandbox. */
  async artifacts(sessionId: string, signal?: AbortSignal): Promise<SessionArtifact[]> {
    const scan = signal ?? new AbortController().signal;
    scan.throwIfAborted();
    return collect(this.client.beta.agents.sessions.artifacts.list(sessionId, { order: 'asc', limit: 100 }, { signal: scan }), scan);
  }

  /** Rebyte checks that the artifact belongs to the Session. */
  async artifact(sessionId: string, artifactId: string, signal: AbortSignal): Promise<SessionArtifact> {
    signal.throwIfAborted();
    return this.client.beta.agents.sessions.artifacts.retrieve(artifactId, { session_id: sessionId }, { signal });
  }

  /** The artifact's bytes as a stream; Rebyte labels every artifact application/octet-stream. */
  async artifactContent(sessionId: string, artifactId: string, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    return this.client.beta.agents.sessions.artifacts.content(artifactId, { session_id: sessionId }, { signal });
  }

  /** Cancels the currently active Turn; the worker must serialize this with new inputs. */
  async cancel(sessionId: string, key: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.client.beta.agents.sessions.events.create(sessionId, {
      'Idempotency-Key': key,
      events: [{ type: 'agent.session.input.cancel' }],
    }, { signal });
  }

  /** Establish the live subscription before sending input; abort never cancels a Turn. */
  async events(sessionId: string, signal: AbortSignal): Promise<AsyncIterable<AgentSessionEvent>> {
    signal.throwIfAborted();
    return this.client.beta.agents.sessions.events.stream(sessionId, { signal });
  }
}
