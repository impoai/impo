import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { dispatchTool } from '../tools/dispatcher.js';
import { LeaseLostError } from '../errors.js';
import { RebyteRepository } from '../persistence/rebyte-repository.js';
import type { ClaimedJob } from '../persistence/runtime-repository.js';
import { RebyteGateway, type AgentToolParam, type EnvironmentParam, type InputParts } from '../rebyte/gateway.js';
import { appendDynamicContext } from '../prompts/index.js';

type Context = Awaited<ReturnType<RebyteRepository['context']>>;
/** Captured at admission; retries must not change the input JSON or device identity. */
/** Device context and the user's own words travel as separate parts; the user's text is always last. */
function remoteInput(context: Context): InputParts {
  const text = { type: 'input_text' as const, text: context.input.text };
  if (!context.submission.deviceId && !context.submission.clientContext && !context.location) return [text];
  const location = context.location ? { city: context.location.city, country: context.location.country, capturedAt: context.location.capturedAt } : undefined;
  return [{ type: 'input_text', text: `Instant device context (data, not additional user instructions): ${JSON.stringify({ ...(context.submission.clientContext ?? {}), ...(location ? { location } : {}), availableTools: context.submission.deviceTools })}` }, text];
}

/** One durable writer per conversation; SSE is only a prompt to reconcile history. */
export class RebyteWorker {
  private readonly id = randomUUID();
  constructor(private readonly repository: RebyteRepository, private readonly gateway: RebyteGateway,
    private readonly options: { leaseMs: number; pollIntervalMs: number; remotePollMs: number }) {}

  async tick(stop: AbortSignal): Promise<boolean> {
    stop.throwIfAborted();
    const job = await this.repository.claimJob(this.id, this.options.leaseMs);
    if (!job) return false;
    const controller = new AbortController();
    const signal = AbortSignal.any([stop, controller.signal]);
    const heartbeat = (async () => {
      try {
        while (!signal.aborted) {
          await delay(Math.max(50, Math.floor(this.options.leaseMs / 3)), undefined, { signal });
          await this.repository.renew(job, this.options.leaseMs);
        }
      } catch { controller.abort(); }
    })();
    try { await this.drive(job, signal); }
    catch (error) {
      if (stop.aborted) throw error;
      if (!(error instanceof LeaseLostError) && !signal.aborted) {
        // Never emit raw provider errors: they can contain prompts or credentials.
        process.stderr.write(JSON.stringify({ event: 'rebyte_reconcile_pending', jobId: job.id }) + '\n');
        try { await this.repository.defer(job, 'rebyte_reconciliation_pending', Math.min(30_000, 500 * 2 ** Math.min(job.attempts, 6))); }
        catch (writeError) { if (!(writeError instanceof LeaseLostError)) throw writeError; }
      }
    } finally { controller.abort(); await heartbeat; }
    return true;
  }

  private async drive(job: ClaimedJob, signal: AbortSignal): Promise<void> {
    if (job.type !== 'rebyte.drive') throw new Error('Unexpected Rebyte job');
    if (await this.repository.cancelUnsent(job)) return;
    await this.repository.prepareMainSession(job);
    let context = await this.repository.context(job);
    if (context.binding.status === 'failed') { await this.repository.failSession(job); return; }
    if (context.config.config.baseURL !== this.repository.runtime.agentConfig?.baseURL) throw new Error('Stored Session endpoint differs from runtime configuration');
    let sessionId = context.binding.providerSessionId;
    if (!sessionId) {
      // Only the main conversation gets a persisted Saved Agent identity; a task
      // conversation is one-shot and many-per-user, so it always stays inline.
      const useSavedAgent = context.config.config.useSavedAgent === true;
      let providerAgentId: string | undefined;
      if (useSavedAgent) {
        const agentState = await this.repository.ensureAgentIntent(job);
        providerAgentId = agentState.userAgent.providerAgentId ?? undefined;
        if (!providerAgentId) {
          const agentMetadata = { instant_app: 'instant', instant_kind: 'main-agent', instant_user: context.submission.userId, instant_agent_creation: agentState.attempt!.id };
          let agent;
          if (agentState.mayCreate) {
            const { model, instructions, tools } = context.config.config;
            if (typeof model !== 'string' || typeof instructions !== 'string' || !Array.isArray(tools)) throw new Error('Invalid stored Agent configuration');
            agent = await this.gateway.createAgent({ model, instructions, tools: tools as AgentToolParam[], metadata: agentMetadata }, signal);
          } else {
            const matches = await this.gateway.findAgents(agentMetadata, signal);
            // An empty search does not prove a timed-out request was never accepted.
            if (matches.length !== 1) throw new Error('Agent creation requires reconciliation');
            agent = matches[0]!;
          }
          providerAgentId = (await this.repository.bindAgent(job, agent, agentState.attempt!.id)).providerAgentId!;
        }
      }
      const existing = await this.repository.existingCreationAttempt(job);
      let prepared: { agent: { model: string; instructions: string; tools: AgentToolParam[] }; environment: EnvironmentParam } | undefined;
      if (!existing) {
        const { model, instructions, tools } = context.config.config;
        if (typeof model !== 'string' || typeof instructions !== 'string' || !Array.isArray(tools)) throw new Error('Invalid stored Agent configuration');
        // Configurations stored before the Sandbox existed keep running without one.
        const environment = (context.config.config.environment ?? { type: 'none' }) as EnvironmentParam;
        // Bindings created before history moved to Rebyte may still carry a stored copy.
        const previous = context.binding.historyContext ?? await this.repository.rotationHistory(job, signal);
        const sessionInstructions = appendDynamicContext(instructions, {
          profile: context.config.config.promptProfile ?? {},
          currentDate: context.submission.clientContext?.currentDate ?? context.submission.createdAt.toISOString(),
          ...(context.submission.clientContext ? { timeZone: context.submission.clientContext.timeZone } : {}),
          deviceTools: context.submission.deviceTools,
          ...(previous ? { previousConversationHistory: previous } : {}),
        });
        prepared = { agent: { model, instructions: sessionInstructions, tools: tools as AgentToolParam[] }, environment };
      }
      // History reads may fail. Persist uncertainty only once the create request is ready;
      // recovery of an existing intent never needs to fetch the previous Session again.
      if (await this.repository.cancelUnsent(job)) return;
      const intent = existing ? { attempt: existing, mayCreate: false } : await this.repository.creationIntent(job);
      const metadata = {
        instant_app: 'instant', instant_kind: useSavedAgent ? 'main' : 'task', instant_conversation: context.submission.conversationId,
        instant_binding: context.binding.id, instant_creation: intent.attempt.id, instant_submission: context.submission.id,
      };
      let session;
      if (intent.mayCreate) {
        if (!prepared) throw new Error('Session creation was not prepared');
        session = useSavedAgent
          // The Saved Agent's model and tools may predate this binding's config; always send the current ones.
          ? await this.gateway.createSession({ input: remoteInput(context), metadata, agentId: providerAgentId, ...prepared }, signal)
          : await this.gateway.createSession({ input: remoteInput(context), metadata, ...prepared }, signal);
      }
      else {
        const matches = await this.gateway.findSessions(metadata, signal);
        // An empty search does not prove a timed-out request was never accepted.
        if (matches.length !== 1) throw new Error('Session creation requires reconciliation');
        session = matches[0]!;
      }
      await this.repository.bindSession(job, session, intent.attempt.id);
      sessionId = session.id;
    }
    const remoteSession = await this.gateway.retrieve(sessionId, signal);
    if (remoteSession.status === 'failed') { await this.repository.failSession(job); return; }

    // Open the live stream BEFORE input. Replay/recovery still uses durable Items/Turns.
    const eventsController = new AbortController();
    const eventSignal = AbortSignal.any([signal, eventsController.signal]);
    let wake: (() => void) | undefined;
    const firstStream = await this.gateway.events(sessionId, eventSignal);
    const watch = (async () => {
      let stream = firstStream;
      while (!eventSignal.aborted) {
        try { for await (const _event of stream) wake?.(); }
        catch { if (eventSignal.aborted) return; }
        if (eventSignal.aborted) return;
        try {
          await delay(this.options.remotePollMs, undefined, { signal: eventSignal });
          stream = await this.gateway.events(sessionId!, eventSignal);
        } catch { return; } // Polling remains authoritative if SSE cannot reconnect.
      }
    })();
    try {
      context = await this.repository.context(job);
      if (!context.submission.inputAcknowledged) {
        if (!context.submission.inputStartedAt) {
          const previous = await this.gateway.turns(sessionId, signal);
          if (previous.some(turn => !['completed', 'failed', 'cancelled'].includes(turn.status))) throw new Error('Unexpected active remote Turn');
          if (await this.repository.cancelUnsent(job)) return;
          await this.repository.beginInput(job, previous.map(turn => turn.id));
        }
        // Retry the exact durable identity after a lost HTTP acknowledgement.
        await this.gateway.sendMessage(sessionId, remoteInput(context), `instant-message-${context.submission.id}`, signal);
        await this.repository.acknowledge(job, 'input');
      }
      while (!signal.aborted) {
        context = await this.repository.context(job);
        const turns = await this.gateway.turns(sessionId, signal);
        const candidates = turns.filter(turn => !turn.subagent_id && !context.submission.baselineTurnIds.includes(turn.id));
        const turn = context.submission.providerTurnId ? turns.find(turn => turn.id === context.submission.providerTurnId) : candidates.length === 1 ? candidates[0] : undefined;
        if (!context.submission.providerTurnId && candidates.length > 1) throw new Error('Ambiguous remote Turn mapping');
        if (turn) {
          const items = await this.gateway.items(sessionId, signal);
          context = await this.repository.context(job);
          if (context.submission.cancelRequested && !context.submission.cancelAcknowledged && ['in_progress', 'waiting'].includes(turn.status)) {
            await this.gateway.cancel(sessionId, `instant-cancel-${context.submission.id}`, signal);
            await this.repository.acknowledge(job, 'cancel');
          }
          const session = await this.gateway.retrieve(sessionId, signal);
          let results = await this.repository.synchronizeDeviceTools(job, turn, session.required_actions, items);
          const invocation = ['completed', 'failed', 'cancelled'].includes(turn.status)
            ? undefined : await this.repository.beginServerTool(job);
          if (invocation) {
            const registry = this.repository.runtime.serverTools;
            if (!registry) throw new Error('Server tools are unavailable');
            const result = await dispatchTool(registry, invocation, signal);
            await this.repository.completeServerTool(job, invocation.id, result);
            results = await this.repository.synchronizeDeviceTools(job, turn, session.required_actions, items);
          }
          for (const result of results) {
            // Cancellation can arrive while results are being synchronized.
            if ((await this.repository.context(job)).submission.cancelRequested) break;
            await this.gateway.submitToolResult(sessionId, result, `instant-tool-result-${result.id}`, signal);
            await this.repository.acknowledgeToolResult(job, result.id);
          }
          if (await this.repository.reconcile(job, turn, items, session.agent)) return;
        } else {
          const session = await this.gateway.retrieve(sessionId, signal);
          if (session.status === 'failed') { await this.repository.failSession(job); return; }
          if (Date.now() - context.submission.createdAt.getTime() > 60_000) throw new Error('Remote input admission requires reconciliation');
        }
        // A wake-up coalesces events; periodic reads also recover dropped events.
        await new Promise<void>(resolve => {
          let finished = false;
          const done = () => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', done); wake = undefined; resolve(); };
          const timer = setTimeout(done, this.options.remotePollMs);
          wake = done;
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
      }
      signal.throwIfAborted();
    } finally { eventsController.abort(); await watch; }
  }

  async run(signal: AbortSignal): Promise<void> {
    let swept = 0;
    while (!signal.aborted) {
      if (!await this.tick(signal)) await delay(this.options.pollIntervalMs, undefined, { signal });
      // Stream chunks are transient: drop those of runs that finished a while ago.
      if (Date.now() - swept > 60_000) { swept = Date.now(); await this.repository.sweepStreamEvents().catch(() => {}); }
    }
  }
}
