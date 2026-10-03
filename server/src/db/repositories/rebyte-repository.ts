import { attachmentIds } from '../../attachments/contract.js';
import { attachments, messageAttachments } from '../entities/attachments.js';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import type { UIMessage, UIMessageChunk } from 'ai';
import { currentBriefLocation } from '../../today/contract.js';
import { actions, agentConfigVersions, agentCreationAttempts, conversations, messages, messageItemBindings, outboxJobs, runtimeSubmissions, sessionBindings, sessionCreationAttempts, userAgents, devices, deviceCapabilities, deviceDispatches, toolInvocations, productEvents, todaySettings } from '../schema.js';
import { RuntimeRepository, type ClaimedJob, type Submission, type Transaction } from './runtime-repository.js';
import { historyContext, hydrateMessages } from './conversation-history.js';
import { normalizeAnswerText } from '../../rebyte/citations.js';
import type { FilePart } from '../../rebyte/files.js';
import { estimateContextTokens, mainHistoryContext, mainSessionPolicy, mainSessionRotation } from '../../persistence/main-session-policy.js';
import { turnSteps } from '../../rebyte/steps.js';
import type { AgentItem, AgentSession, RebyteAgent, Turn } from '../../rebyte/gateway.js';
import { toolResultPayload } from '../../rebyte/gateway.js';
import { canonicalJSON, deviceHash, isDeviceTool, jsonValue, validateDeviceInput } from '../../tools/device-tools.js';
import type { ToolResult } from '../../tools/registry.js';
import { ServiceError } from '../../errors.js';

/** Title kept for a task once its text is gone; the real title is the task's first message in Rebyte. */
export const taskTitlePlaceholder = '…';

/** Remote requests happen outside these transactions; every write checks the lease. */
export class RebyteRepository extends RuntimeRepository {
  /** The queue has one writer per conversation. Rotate only before any remote input intent. */
  async prepareMainSession(job: ClaimedJob): Promise<void> {
    await this.withLease(job, async (tx, submission) => {
      if (submission.status !== 'queued' || submission.inputStartedAt || submission.inputAcknowledged || submission.providerTurnId || submission.cancelRequested) return;
      // Serialize with message admission so new messages bind to the replacement too.
      const [conversation] = await tx.select().from(conversations)
        .where(and(eq(conversations.id, submission.conversationId), eq(conversations.userId, submission.userId))).for('update');
      if (conversation?.kind !== 'main') return;
      const [binding] = await tx.select().from(sessionBindings).where(eq(sessionBindings.id, submission.bindingId));
      if (!binding || binding.provider !== 'rebyte' || binding.status !== 'active' || !binding.isCurrent) return;
      const [activity] = await tx.select({ turns: sql<number>`count(*)::int`, lastCompletedAt: sql<Date | null>`max(${runtimeSubmissions.completedAt})`.mapWith(runtimeSubmissions.completedAt) })
        .from(runtimeSubmissions).where(and(eq(runtimeSubmissions.bindingId, binding.id), isNotNull(runtimeSubmissions.providerTurnId), inArray(runtimeSubmissions.status, ['completed', 'failed', 'cancelled'])));
      const [input] = await tx.select({ text: messages.text }).from(messages).where(eq(messages.id, submission.userMessageId));
      const reason = mainSessionRotation({ turns: activity!.turns, lastCompletedAt: activity!.lastCompletedAt,
        contextTokens: binding.contextTokenEstimate, inputTokens: estimateContextTokens({ text: input?.text, context: submission.clientContext }) });
      if (!reason) return;
      await tx.update(sessionBindings).set({ isCurrent: false, status: 'retired', updatedAt: new Date() }).where(eq(sessionBindings.id, binding.id));
      const [replacement] = await tx.insert(sessionBindings).values({ userId: submission.userId, conversationId: submission.conversationId,
        agentConfigVersionId: binding.agentConfigVersionId, provider: 'rebyte', status: 'creating' }).returning();
      // Queued messages were admitted against the old binding. None has a remote write or tool receipt yet.
      await tx.update(runtimeSubmissions).set({ bindingId: replacement!.id, updatedAt: new Date() }).where(and(
        eq(runtimeSubmissions.userId, submission.userId), eq(runtimeSubmissions.conversationId, submission.conversationId), eq(runtimeSubmissions.bindingId, binding.id),
        eq(runtimeSubmissions.status, 'queued'), isNull(runtimeSubmissions.inputStartedAt), eq(runtimeSubmissions.inputAcknowledged, false), isNull(runtimeSubmissions.providerTurnId)));
    });
  }

  async context(job: ClaimedJob) {
    return this.withLease(job, async (tx, submission) => {
      const [binding] = await tx.select().from(sessionBindings).where(eq(sessionBindings.id, submission.bindingId));
      const [input] = await tx.select().from(messages).where(eq(messages.id, submission.userMessageId));
      const [config] = await tx.select().from(agentConfigVersions).where(eq(agentConfigVersions.id, binding!.agentConfigVersionId));
      if (!binding || !input || !config || binding.provider !== 'rebyte') throw new Error('Invalid Rebyte binding');
      // The city Today already uses. Judged at submission time so a retried send is identical.
      const [settings] = await tx.select({ location: todaySettings.location }).from(todaySettings).where(eq(todaySettings.userId, submission.userId));
      const location = currentBriefLocation(settings?.location ?? null, submission.createdAt);
      const files = await tx.select({ id: attachments.id, name: attachments.name, mediaType: attachments.mediaType, sizeBytes: attachments.sizeBytes }).from(messageAttachments)
        .innerJoin(attachments, and(eq(attachments.id, messageAttachments.attachmentId), eq(attachments.userId, messageAttachments.userId)))
        .where(and(eq(messageAttachments.userId, submission.userId), eq(messageAttachments.messageId, input.id))).orderBy(asc(messageAttachments.position));
      return { submission, binding, input, config, location, files };
    });
  }

  /** Restore this conversation's admitted attachments into a new Session, retaining ownership and source IDs. */
  async conversationFiles(job: ClaimedJob) {
    return this.withLease(job, async (tx, submission) => {
      const [input] = await tx.select({ sequence: messages.sequence }).from(messages)
        .where(and(eq(messages.id, submission.userMessageId), eq(messages.userId, submission.userId)));
      if (!input) throw new Error('Submission input is missing');
      return tx.selectDistinct({
      id: attachments.id, name: attachments.name, mediaType: attachments.mediaType, sizeBytes: attachments.sizeBytes,
    }).from(messageAttachments)
      .innerJoin(attachments, and(eq(attachments.id, messageAttachments.attachmentId), eq(attachments.userId, submission.userId)))
      .innerJoin(messages, and(eq(messages.id, messageAttachments.messageId), eq(messages.userId, submission.userId)))
      .where(and(eq(messageAttachments.userId, submission.userId), eq(messages.conversationId, submission.conversationId),
        sql`${messages.sequence} <= ${input.sequence}`, eq(attachments.status, 'ready')));
    });
  }

  /** Mark uncertainty BEFORE the non-idempotent Agent creation request; reused across Sessions. */
  async ensureAgentIntent(job: ClaimedJob) {
    return this.withLease(job, async (tx, submission) => {
      let [userAgent] = await tx.select().from(userAgents).where(and(eq(userAgents.userId, submission.userId), eq(userAgents.kind, 'main')));
      if (!userAgent) {
        const [binding] = await tx.select().from(sessionBindings).where(eq(sessionBindings.id, submission.bindingId));
        if (!binding) throw new Error('Invalid Rebyte binding');
        await tx.insert(userAgents).values({ userId: submission.userId, kind: 'main', agentConfigVersionId: binding.agentConfigVersionId, provider: 'rebyte' })
          .onConflictDoNothing({ target: [userAgents.userId, userAgents.kind] });
        [userAgent] = await tx.select().from(userAgents).where(and(eq(userAgents.userId, submission.userId), eq(userAgents.kind, 'main')));
      }
      if (!userAgent) throw new Error('User Agent binding missing after insert');
      if (userAgent.status === 'active' && userAgent.providerAgentId) return { userAgent, attempt: undefined, mayCreate: false as const };
      const [existing] = await tx.select().from(agentCreationAttempts).where(and(eq(agentCreationAttempts.userAgentId, userAgent.id), ne(agentCreationAttempts.status, 'failed'))).orderBy(asc(agentCreationAttempts.createdAt)).limit(1);
      if (existing) return { userAgent, attempt: existing, mayCreate: false as const };
      const [attempt] = await tx.insert(agentCreationAttempts).values({
        userId: submission.userId, userAgentId: userAgent.id, status: 'unknown',
        requestHash: createHash('sha256').update(`${userAgent.id}/${submission.id}`).digest('hex'),
      }).returning();
      await tx.update(userAgents).set({ status: 'unknown', updatedAt: new Date() }).where(eq(userAgents.id, userAgent.id));
      return { userAgent, attempt: attempt!, mayCreate: true as const };
    });
  }

  async bindAgent(job: ClaimedJob, agent: RebyteAgent, attemptId: string): Promise<typeof userAgents.$inferSelect> {
    return this.withLease(job, async (tx, submission) => {
      const [userAgent] = await tx.select().from(userAgents).where(and(eq(userAgents.userId, submission.userId), eq(userAgents.kind, 'main')));
      if (!userAgent || (userAgent.providerAgentId && userAgent.providerAgentId !== agent.id)) throw new Error('Remote Agent identity changed');
      const [attempt] = await tx.select().from(agentCreationAttempts).where(and(eq(agentCreationAttempts.id, attemptId), eq(agentCreationAttempts.userAgentId, userAgent.id)));
      if (!attempt) throw new Error('Agent creation attempt missing');
      const [updated] = await tx.update(userAgents).set({ providerAgentId: agent.id, status: 'active', updatedAt: new Date() }).where(eq(userAgents.id, userAgent.id)).returning();
      await tx.update(agentCreationAttempts).set({ status: 'succeeded', providerAgentId: agent.id, updatedAt: new Date() }).where(eq(agentCreationAttempts.id, attempt.id));
      return updated!;
    });
  }

  /** Delegated tasks get their own inline Session, never a Saved Agent (see runtime.ts). */
  async createTask(userId: string, goal: string, invocationId: string, fileIds: string[] = []): Promise<{ taskId: string }> {
    return this.db.transaction(async tx => {
      const [caller] = await tx.select({ kind: conversations.kind }).from(toolInvocations)
        .innerJoin(runtimeSubmissions, eq(runtimeSubmissions.id, toolInvocations.submissionId))
        .innerJoin(conversations, eq(conversations.id, runtimeSubmissions.conversationId))
        .where(and(eq(toolInvocations.id, invocationId), eq(toolInvocations.userId, userId)));
      if (!caller) throw new Error('Task creation invocation is missing');
      if (caller.kind !== 'main') throw new ServiceError(422, 'nested_task_not_supported', 'A task cannot create another task');
      const attachedIds = attachmentIds(fileIds);
      if (attachedIds.length) {
        const owned = await tx.select().from(attachments).where(and(eq(attachments.userId, userId), inArray(attachments.id, attachedIds), eq(attachments.status, 'ready')));
        if (owned.length !== attachedIds.length) throw new ServiceError(404, 'attachment_unavailable', 'One or more task attachments are unavailable.');
      }
      if (!this.runtime.taskAgentConfig) throw new Error('Task Agent configuration is missing');
      const config = await this.ensureAgentConfigVersion(tx, (await this.userAgentConfig(tx, userId, this.runtime.taskAgentConfig))!);

      const actionId = randomUUID(), conversationId = randomUUID(), bindingId = randomUUID();
      const messageId = randomUUID(), assistantMessageId = randomUUID(), submissionId = randomUUID();
      await tx.insert(actions).values({ id: actionId, userId, goal });
      await tx.insert(conversations).values({ id: conversationId, userId, kind: 'task', actionId, nextSequence: 3 });
      await tx.insert(sessionBindings).values({ id: bindingId, userId, conversationId, agentConfigVersionId: config.id, provider: 'rebyte', status: 'creating' });
      await tx.insert(messages).values([
        { id: messageId, userId, conversationId, sequence: 1, role: 'user', text: goal, parts: [{ type: 'text', text: goal }], status: 'completed' },
        { id: assistantMessageId, userId, conversationId, sequence: 2, role: 'assistant' },
      ]);
      if (attachedIds.length) await tx.insert(messageAttachments).values(attachedIds.map((attachmentId, position) => ({ userId, messageId, attachmentId, position })));
      const [submission] = await tx.insert(runtimeSubmissions).values({ id: submissionId, userId, conversationId, bindingId, userMessageId: messageId, assistantMessageId }).returning();
      await this.appendEvents(tx, submission!, [{ type: 'start', messageId: assistantMessageId }, this.statusChunk(submission!, 'queued')]);
      await tx.insert(outboxJobs).values({ userId, submissionId, type: 'rebyte.drive', dedupeKey: `${submissionId}:prepare` });
      return { taskId: actionId };
    });
  }

  async renew(job: ClaimedJob, leaseMs: number): Promise<void> {
    await this.withLease(job, async tx => {
      await tx.update(outboxJobs).set({ leaseUntil: sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'` }).where(eq(outboxJobs.id, job.id));
    });
  }

  /** Recover an existing intent without depending on another history read. */
  async existingCreationAttempt(job: ClaimedJob) {
    return this.withLease(job, async (tx, submission) => {
      const [attempt] = await tx.select().from(sessionCreationAttempts).where(eq(sessionCreationAttempts.bindingId, submission.bindingId)).orderBy(asc(sessionCreationAttempts.createdAt)).limit(1);
      return attempt;
    });
  }

  /** Mark uncertainty BEFORE the non-idempotent Session creation request. */
  async creationIntent(job: ClaimedJob) {
    return this.withLease(job, async (tx, submission) => {
      const [existing] = await tx.select().from(sessionCreationAttempts).where(eq(sessionCreationAttempts.bindingId, submission.bindingId)).orderBy(asc(sessionCreationAttempts.createdAt)).limit(1);
      if (existing) return { attempt: existing, mayCreate: false };
      const [attempt] = await tx.insert(sessionCreationAttempts).values({
        userId: submission.userId, bindingId: submission.bindingId, status: 'unknown',
        requestHash: createHash('sha256').update(submission.id).digest('hex'),
      }).returning();
      await tx.update(sessionBindings).set({ status: 'unknown', updatedAt: new Date() }).where(eq(sessionBindings.id, submission.bindingId));
      await tx.update(runtimeSubmissions).set({ inputStartedAt: new Date(), status: 'running', updatedAt: new Date() }).where(eq(runtimeSubmissions.id, submission.id));
      await tx.update(messages).set({ status: 'streaming', updatedAt: new Date() }).where(eq(messages.id, submission.assistantMessageId));
      await this.appendEvents(tx, submission, [this.statusChunk(submission, 'running')]);
      return { attempt: attempt!, mayCreate: true };
    });
  }

  async bindSession(job: ClaimedJob, session: AgentSession, attemptId: string): Promise<void> {
    await this.withLease(job, async (tx, submission) => {
      const [binding] = await tx.select().from(sessionBindings).where(eq(sessionBindings.id, submission.bindingId));
      if (!binding || (binding.providerSessionId && binding.providerSessionId !== session.id)) throw new Error('Remote Session identity changed');
      const [attempt] = await tx.select().from(sessionCreationAttempts).where(and(eq(sessionCreationAttempts.id, attemptId), eq(sessionCreationAttempts.bindingId, binding.id)));
      if (!attempt) throw new Error('Session creation attempt missing');
      await tx.update(sessionBindings).set({ providerSessionId: session.id, status: 'active', updatedAt: new Date() }).where(eq(sessionBindings.id, binding.id));
      await tx.update(sessionCreationAttempts).set({ status: 'succeeded', providerSessionId: session.id, updatedAt: new Date() }).where(eq(sessionCreationAttempts.id, attempt.id));
      // File uploads finish before a deferred initial input is admitted. Older
      // creation intents already included input and must never resubmit it.
      const deferred = session.metadata?.instant_input_mode === 'deferred';
      await tx.update(runtimeSubmissions).set({ inputAcknowledged: !deferred,
        ...(deferred ? { inputStartedAt: null } : {}), error: null, updatedAt: new Date() }).where(eq(runtimeSubmissions.id, submission.id));
    });
  }

  async beginInput(job: ClaimedJob, previousTurnIds: string[]): Promise<void> {
    await this.withLease(job, async (tx, submission) => {
      if (submission.inputStartedAt) return;
      await tx.update(runtimeSubmissions).set({ inputStartedAt: new Date(), baselineTurnIds: previousTurnIds, status: 'running', updatedAt: new Date() }).where(eq(runtimeSubmissions.id, submission.id));
      await tx.update(messages).set({ status: 'streaming', updatedAt: new Date() }).where(eq(messages.id, submission.assistantMessageId));
      await this.appendEvents(tx, submission, [this.statusChunk(submission, 'running')]);
    });
  }

  async acknowledge(job: ClaimedJob, kind: 'input' | 'cancel'): Promise<void> {
    await this.withLease(job, async (tx, submission) => {
      await tx.update(runtimeSubmissions).set({ ...(kind === 'input' ? { inputAcknowledged: true } : { cancelAcknowledged: true }), error: null, updatedAt: new Date() }).where(eq(runtimeSubmissions.id, submission.id));
    });
  }

  /** Persist requests and immutable outputs before any client/provider network call. */
  async synchronizeDeviceTools(job: ClaimedJob, turn: Turn, actions: AgentSession['required_actions'], items: AgentItem[]) {
    return this.withLease(job, async (tx, submission) => {
      if (submission.providerTurnId && submission.providerTurnId !== turn.id) throw new Error('Remote Turn identity changed');
      const final = ['completed', 'failed', 'cancelled'].includes(turn.status);
      const chunks: UIMessageChunk[] = [];
      const [message] = await tx.select().from(messages).where(eq(messages.id, submission.assistantMessageId));
      if (!message) throw new Error('Assistant projection missing');
      let parts = [...message.parts];
      if (submission.deviceId) await tx.select({ id: devices.id }).from(devices).where(eq(devices.id, submission.deviceId)).for('share');
      const capabilities = submission.deviceId ? (await tx.select({ name: deviceCapabilities.toolName }).from(deviceCapabilities).where(and(eq(deviceCapabilities.userId, submission.userId), eq(deviceCapabilities.deviceId, submission.deviceId)))).map(row => row.name) : [];
      if (!submission.cancelRequested && !final) for (const action of actions) {
        if (action.type !== 'function_call') throw new Error('Unsupported remote required action');
        if (action.turn_id !== turn.id) throw new Error('Required action belongs to another Turn');
        let input: unknown = action.arguments;
        try { if (typeof input === 'string') input = JSON.parse(input); } catch { /* becomes a frozen argument error below */ }
        let args: Record<string, unknown> = {};
        let failure: { code: string; message: string } | undefined;
        try {
          jsonValue(input);
          args = isDeviceTool(action.name) ? validateDeviceInput(action.name, input) : this.runtime.serverTools ? this.runtime.serverTools.get(action.name, 1).validate(input) : (() => { throw new ServiceError(422, 'unsupported_tool', 'This tool is unavailable'); })();
        } catch (error) {
          failure = { code: 'invalid_tool_arguments', message: error instanceof ServiceError ? error.message : 'Invalid device tool arguments' };
          // Preserve valid JSON objects for diagnosis, never persist malformed/NUL data.
          try { jsonValue(input); if (input && typeof input === 'object' && !Array.isArray(input)) args = input as Record<string, unknown>; } catch { /* retain empty object */ }
        }
        const isDevice = isDeviceTool(action.name);
        if (isDevice && !failure && !submission.deviceId) failure = { code: 'device_unavailable', message: 'This message has no associated device' };
        else if (isDevice && !failure && (!submission.deviceTools.includes(action.name) || !capabilities.includes(action.name))) failure = { code: 'device_capability_unavailable', message: 'This device did not enable the requested capability' };
        const argumentsHash = deviceHash(action.arguments);
        let [invocation] = await tx.select().from(toolInvocations).where(and(eq(toolInvocations.bindingId, submission.bindingId), eq(toolInvocations.turnId, turn.id), eq(toolInvocations.callId, action.call_id)));
        if (invocation) {
          if (invocation.submissionId !== submission.id || invocation.argumentsHash !== argumentsHash || invocation.toolName !== action.name) throw new Error('Remote function identity changed');
          continue;
        }
        const expiresAt = new Date(Date.now() + (this.runtime.deviceToolTimeoutMs ?? 300_000));
        [invocation] = await tx.insert(toolInvocations).values({ userId: submission.userId, submissionId: submission.id, bindingId: submission.bindingId, turnId: turn.id, callId: action.call_id, toolName: action.name, arguments: args, argumentsHash, executionLocation: isDevice ? 'device' : 'server', expiresAt: isDevice ? expiresAt : null,
          ...(failure ? { status: 'result_saved' as const, result: { ok: false, error: failure } } : {}),
        }).returning();
        chunks.push({ type: 'tool-input-available', toolCallId: action.call_id, toolName: action.name, input: args, dynamic: true });
        parts.push({ type: 'dynamic-tool', toolCallId: action.call_id, toolName: action.name, input: args, state: 'input-available' });
        if (!failure && isDevice) {
          await tx.insert(deviceDispatches).values({ userId: submission.userId, submissionId: submission.id, invocationId: invocation!.id, deviceId: submission.deviceId!, expiresAt });
          chunks.push({ type: 'data-instant-device-request', data: { schemaVersion: 1, invocationId: invocation!.id, toolCallId: action.call_id, deviceId: submission.deviceId!, expiresAt: expiresAt.toISOString() } });
        }
      }
      // A saved receipt is never replaced by a later deadline or capability change.
      if (!submission.cancelRequested && !final) {
        const outstanding = await tx.select({ dispatch: deviceDispatches, tool: toolInvocations }).from(deviceDispatches).innerJoin(toolInvocations, eq(toolInvocations.id, deviceDispatches.invocationId)).where(and(eq(deviceDispatches.submissionId, submission.id), inArray(deviceDispatches.status, ['pending', 'claimed'])));
        for (const { dispatch, tool } of outstanding) {
          const expired = dispatch.expiresAt.getTime() <= Date.now() || (tool.expiresAt?.getTime() ?? Infinity) <= Date.now();
          const disabled = !capabilities.includes(tool.toolName);
          if (!expired && !disabled) continue;
          const error = expired ? { code: 'device_timeout', message: 'The device did not return this tool result before its deadline' } : { code: 'permission_revoked', message: 'The device disabled this capability before returning a result' };
          await tx.update(toolInvocations).set({ status: 'result_saved', result: { ok: false, error }, updatedAt: new Date() }).where(eq(toolInvocations.id, tool.id));
          await tx.update(deviceDispatches).set({ status: expired ? 'expired' : 'revoked', completedAt: new Date() }).where(eq(deviceDispatches.id, dispatch.id));
        }
      }
      const invocations = await tx.select().from(toolInvocations).where(eq(toolInvocations.submissionId, submission.id)).orderBy(asc(toolInvocations.createdAt));
      const ready: Array<{ id: string; turnId: string; callId: string; result: Record<string, unknown> }> = [];
      for (const invocation of invocations) {
        if (!invocation.result) continue;
        const payload = toolResultPayload(invocation.result);
        const remote = items.find(item => item.type === 'function_call_output' && item.turn_id === invocation.turnId && item.call_id === invocation.callId);
        if (remote?.type === 'function_call_output') {
          const matching = payload.success ? remote.status === 'completed' && remote.output === payload.output : remote.status === 'failed' && remote.error === payload.error;
          if (!matching) throw new Error('Remote tool result differs from the frozen receipt');
          if (invocation.status !== 'submitted') await tx.update(toolInvocations).set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() }).where(eq(toolInvocations.id, invocation.id));
        } else if (invocation.status === 'result_saved' && !submission.cancelRequested && !final) {
          ready.push({ id: invocation.id, turnId: invocation.turnId, callId: invocation.callId, result: invocation.result });
        }
        if (!invocation.resultProjected) {
          if (payload.success) chunks.push({ type: 'tool-output-available', toolCallId: invocation.callId, output: invocation.result.data, dynamic: true });
          else chunks.push({ type: 'tool-output-error', toolCallId: invocation.callId, errorText: payload.error, dynamic: true });
          const part: UIMessage['parts'][number] = payload.success
            ? { type: 'dynamic-tool', toolCallId: invocation.callId, toolName: invocation.toolName, input: invocation.arguments, state: 'output-available', output: invocation.result.data }
            : { type: 'dynamic-tool', toolCallId: invocation.callId, toolName: invocation.toolName, input: invocation.arguments, state: 'output-error', errorText: payload.error };
          parts = parts.map(existing => existing.type === 'dynamic-tool' && existing.toolCallId === invocation.callId ? part : existing);
          await tx.update(toolInvocations).set({ resultProjected: true }).where(eq(toolInvocations.id, invocation.id));
        }
      }
      if (!final && !submission.cancelRequested) {
        const waiting = invocations.some(invocation => invocation.executionLocation === 'device' && ['received', 'running'].includes(invocation.status));
        const status = waiting ? 'waiting_device' : 'running';
        if (submission.status !== status) {
          await tx.update(runtimeSubmissions).set({ status, updatedAt: new Date() }).where(eq(runtimeSubmissions.id, submission.id));
          chunks.push(this.statusChunk(submission, status));
        }
      }
      await tx.update(runtimeSubmissions).set({ providerTurnId: turn.id }).where(eq(runtimeSubmissions.id, submission.id));
      if (chunks.length) {
        await tx.update(messages).set({ parts, updatedAt: new Date() }).where(eq(messages.id, message.id));
        await this.appendEvents(tx, submission, chunks);
      }
      return ready;
    });
  }

  /** Claim under the conversation lease; an interrupted mutation is never replayed. */
  async beginServerTool(job: ClaimedJob) {
    return this.withLease(job, async (tx, submission) => {
      if (submission.cancelRequested || ['completed', 'failed', 'cancelled'].includes(submission.status)) return;
      const [invocation] = await tx.select().from(toolInvocations).where(and(eq(toolInvocations.submissionId, submission.id), eq(toolInvocations.executionLocation, 'server'), inArray(toolInvocations.status, ['received', 'running']))).orderBy(asc(toolInvocations.createdAt)).limit(1);
      if (!invocation) return;
      const definition = this.runtime.serverTools?.get(invocation.toolName, invocation.toolVersion);
      if (!definition) throw new Error('Stored server tool is no longer registered');
      if (invocation.status === 'running' && definition.retry === 'never') {
        await tx.update(toolInvocations).set({ status: 'result_saved', result: { ok: false, error: { code: 'execution_outcome_unknown', message: 'The previous connected-app request may have completed before interruption. Do not repeat it; ask the user to check the app first.', retryable: false } }, updatedAt: new Date() }).where(eq(toolInvocations.id, invocation.id));
        return;
      }
      await tx.update(toolInvocations).set({ status: 'running', updatedAt: new Date() }).where(eq(toolInvocations.id, invocation.id));
      return invocation;
    });
  }

  /** Freeze a server receipt before delivering it upstream; cancellation cannot un-send a request. */
  async completeServerTool(job: ClaimedJob, id: string, result: ToolResult): Promise<void> {
    jsonValue(result);
    await this.withLease(job, async (tx, submission) => {
      await tx.update(toolInvocations).set({ result, status: 'result_saved', updatedAt: new Date() }).where(and(eq(toolInvocations.id, id), eq(toolInvocations.submissionId, submission.id), eq(toolInvocations.executionLocation, 'server'), inArray(toolInvocations.status, ['running', 'cancelled'])));
    });
  }

  async acknowledgeToolResult(job: ClaimedJob, id: string): Promise<void> {
    await this.withLease(job, async (tx, submission) => {
      await tx.update(toolInvocations).set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() }).where(and(eq(toolInvocations.id, id), eq(toolInvocations.submissionId, submission.id), eq(toolInvocations.status, 'result_saved')));
    });
  }

  /** Re-read active Items by ID: an existing in-progress Item can grow in place. */
  async reconcile(job: ClaimedJob, turn: Turn, items: AgentItem[], agent: AgentSession['agent'], files: FilePart[] = []): Promise<boolean> {
    return this.withLease(job, async (tx, submission) => {
      if (submission.providerTurnId && submission.providerTurnId !== turn.id) throw new Error('Remote Turn identity changed');
      const selected = items.filter(item => item.turn_id === turn.id && item.type === 'message');
      // Interim commentary streams as a step; the answer text is the final answer only, matching history.
      const final = ['completed', 'failed', 'cancelled'].includes(turn.status);
      // Source markers become links; an open marker is withheld, keeping the stream append-only.
      const answer = normalizeAnswerText(selected.filter(item => item.type === 'message' && item.role === 'assistant' && (item as { phase?: unknown }).phase !== 'commentary').map(item => {
        if (item.type !== 'message') return '';
        return item.content.map(part => part.type === 'output_text' ? part.text : '').join('');
      }).join('\n'), { final });
      const [message] = await tx.select().from(messages).where(eq(messages.id, submission.assistantMessageId));
      if (!message) throw new Error('Assistant projection missing');
      // Never append duplicate text after reconnection or stale concurrent reads.
      if (!answer.startsWith(message.text)) {
        if (!final && message.text.startsWith(answer)) return false;
        throw new Error('Remote text changed outside the append-only stream contract');
      }
      const chunks: UIMessageChunk[] = [];
      // Live intermediate steps (commands, searches, tools, reasoning): streamed as transient
      // data parts, re-sent only when changed, never stored with the message.
      const ownTools = new Set([...(this.runtime.serverTools?.functionDefinitions().map(tool => tool.name) ?? [])]);
      const steps = turnSteps(items, turn.id, name => isDeviceTool(name) || ownTools.has(name));
      if (steps.length) {
        const sent = new Map<string, string>();
        for (const row of await tx.select({ chunk: productEvents.chunk }).from(productEvents)
          .where(and(eq(productEvents.submissionId, submission.id), sql`${productEvents.chunk}->>'type' = 'data-instant-step'`))) {
          const chunk = row.chunk as { id?: string; data?: unknown };
          // jsonb reorders keys: compare canonical JSON.
          if (chunk.id) sent.set(chunk.id, canonicalJSON(chunk.data));
        }
        for (const step of steps) {
          if (sent.get(step.id) !== canonicalJSON(step.data)) chunks.push({ type: 'data-instant-step', id: step.id, data: step.data, transient: true });
        }
      }
      const partId = `text-${submission.id}`;
      const hadText = message.parts.some(part => part.type === 'text');
      if (answer.length && !hadText) chunks.push({ type: 'text-start', id: partId });
      if (answer.length > message.text.length) chunks.push({ type: 'text-delta', id: partId, delta: answer.slice(message.text.length) });
      for (const item of selected) {
        if (item.type !== 'message') continue;
        if (!item.id) throw new Error('Stored remote message has no Item ID');
        const messageId = item.role === 'user' ? submission.userMessageId : item.role === 'assistant' ? submission.assistantMessageId : undefined;
        if (messageId) await tx.insert(messageItemBindings).values({ userId: submission.userId, conversationId: submission.conversationId, bindingId: submission.bindingId, messageId, providerItemId: item.id }).onConflictDoNothing();
      }
      await tx.update(runtimeSubmissions).set({ providerTurnId: turn.id, error: null, updatedAt: new Date() }).where(eq(runtimeSubmissions.id, submission.id));
      const parts: UIMessage['parts'] = message.parts.filter(part => part.type !== 'text');
      if (answer.length || hadText) parts.push({ type: 'text', text: answer });
      await tx.update(messages).set({ text: answer, status: 'streaming', parts, updatedAt: new Date() }).where(eq(messages.id, message.id));
      if (final) {
        await tx.update(sessionBindings).set({ contextTokenEstimate: estimateContextTokens({ instructions: agent.instructions, tools: agent.tools, items }), updatedAt: new Date() })
          .where(eq(sessionBindings.id, submission.bindingId));
        if (answer.length || hadText) chunks.push({ type: 'text-end', id: partId });
        // Delivered files follow the answer; history rebuilds the same parts from Rebyte.
        if (turn.status === 'completed' && !submission.cancelRequested) chunks.push(...files);
        const status = submission.cancelRequested || turn.status === 'cancelled' ? 'cancelled' : turn.status === 'failed' ? 'failed' : 'completed';
        if (status === 'cancelled') chunks.push({ type: 'abort' });
        if (status === 'failed') chunks.push({ type: 'error', errorText: 'rebyte_turn_failed' });
        await this.finish(tx, submission, status, chunks, status === 'failed' ? { code: 'rebyte_turn_failed', message: 'The assistant could not complete this reply', retryable: false } : undefined);
        await this.completeJob(tx, job);
      } else if (chunks.length) await this.appendEvents(tx, submission, chunks);
      return final;
    });
  }

  async cancelUnsent(job: ClaimedJob): Promise<boolean> {
    return this.withLease(job, async (tx, submission) => {
      if (!submission.cancelRequested || submission.inputStartedAt) return false;
      await this.finish(tx, submission, 'cancelled', [{ type: 'abort' }]);
      await this.completeJob(tx, job);
      return true;
    });
  }

  /** A definite provider rejection has no remote side effect to reconcile. */
  async rejectCreation(job: ClaimedJob): Promise<void> {
    await this.withLease(job, async (tx, submission) => {
      const error = { code: 'rebyte_creation_rejected', message: 'The assistant could not start this reply. Please try again.', retryable: false };
      const [binding] = await tx.select().from(sessionBindings).where(eq(sessionBindings.id, submission.bindingId));
      if (!binding || binding.providerSessionId || submission.inputAcknowledged || submission.providerTurnId) throw new Error('Creation rejection cannot change accepted work');
      await tx.update(sessionCreationAttempts).set({ status: 'failed', error, updatedAt: new Date() })
        .where(and(eq(sessionCreationAttempts.bindingId, binding.id), eq(sessionCreationAttempts.status, 'unknown')));
      const [agent] = await tx.select().from(userAgents).where(eq(userAgents.userId, submission.userId));
      if (agent && !agent.providerAgentId) {
        await tx.update(agentCreationAttempts).set({ status: 'failed', error, updatedAt: new Date() })
          .where(and(eq(agentCreationAttempts.userAgentId, agent.id), eq(agentCreationAttempts.status, 'unknown')));
        await tx.update(userAgents).set({ status: 'failed', updatedAt: new Date() }).where(eq(userAgents.id, agent.id));
      }
      await tx.update(sessionBindings).set({ status: 'failed', isCurrent: false, updatedAt: new Date() }).where(eq(sessionBindings.id, binding.id));
      await this.finish(tx, submission, 'failed', [{ type: 'error', errorText: error.message }], error);
      await this.completeJob(tx, job);
    });
  }

  async failSession(job: ClaimedJob): Promise<void> {
    await this.withLease(job, async (tx, submission) => {
      await tx.update(sessionBindings).set({ status: 'failed', updatedAt: new Date() }).where(eq(sessionBindings.id, submission.bindingId));
      await this.finish(tx, submission, 'failed', [{ type: 'error', errorText: 'rebyte_session_failed' }], { code: 'rebyte_session_failed', message: 'The assistant session failed', retryable: false });
      await this.completeJob(tx, job);
    });
  }

  /** Preserve uncertain remote writes for reconciliation, never recreate/resubmit blindly. */
  async defer(job: ClaimedJob, code: string, delayMs: number): Promise<void> {
    await this.withLease(job, async (tx, submission) => {
      const error = { code, message: 'Waiting to confirm the assistant reply', retryable: true };
      await tx.update(runtimeSubmissions).set({ error, updatedAt: new Date() }).where(eq(runtimeSubmissions.id, submission.id));
      await tx.update(outboxJobs).set({ status: 'pending', leaseToken: null, leaseUntil: null, availableAt: new Date(Date.now() + delayMs), error, updatedAt: new Date() }).where(eq(outboxJobs.id, job.id));
    });
  }

  /**
   * After remote acceptance, a finished run keeps no chat content: Rebyte holds the conversation. Messages keep IDs,
   * order and status; tool receipts keep hashes, status and outcome; a task keeps a placeholder title.
   * Stream events stay briefly for viewers still reading the tail (see sweepStreamEvents).
   */
  protected override async finish(tx: Transaction, submission: Submission, status: 'completed' | 'failed' | 'cancelled', chunks: UIMessageChunk[], error?: Submission['error']) {
    await super.finish(tx, submission, status, chunks, error);
    const [binding] = await tx.select({ sessionId: sessionBindings.providerSessionId }).from(sessionBindings).where(eq(sessionBindings.id, submission.bindingId));
    // Before remote acceptance, PostgreSQL holds the only copy of the user's input.
    const projected = binding?.sessionId ? [submission.userMessageId, submission.assistantMessageId] : [submission.assistantMessageId];
    await tx.update(messages).set({ text: '', parts: [], updatedAt: new Date() }).where(inArray(messages.id, projected));
    // Keep only the outcome (ok and error code): no arguments, data or provider messages.
    await tx.update(toolInvocations).set({ arguments: {}, updatedAt: new Date(), result: sql`CASE WHEN ${toolInvocations.result} IS NULL THEN NULL
        ELSE jsonb_strip_nulls(jsonb_build_object('ok', ${toolInvocations.result}->'ok', 'error', CASE WHEN ${toolInvocations.result} ? 'error' THEN jsonb_build_object('code', ${toolInvocations.result}->'error'->'code') END)) END` })
      .where(eq(toolInvocations.submissionId, submission.id));
    await tx.update(actions).set({ goal: taskTitlePlaceholder, updatedAt: new Date() })
      .where(inArray(actions.id, tx.select({ id: conversations.actionId }).from(conversations).where(and(eq(conversations.id, submission.conversationId), eq(conversations.kind, 'task')))));
  }

  /** Delete stream chunks of runs finished longer ago than `graceMs`; returns the number removed. */
  async sweepStreamEvents(graceMs = 10 * 60_000): Promise<number> {
    const finished = this.db.select({ id: runtimeSubmissions.id }).from(runtimeSubmissions)
      .where(and(inArray(runtimeSubmissions.status, ['completed', 'failed', 'cancelled']), lt(runtimeSubmissions.completedAt, new Date(Date.now() - graceMs))));
    return (await this.db.delete(productEvents).where(inArray(productEvents.submissionId, finished)).returning({ id: productEvents.id })).length;
  }

  /**
   * History for a Session that replaces an earlier one in the same conversation, read from
   * Rebyte (never stored). Null for a conversation's first Session.
   */
  async rotationHistory(job: ClaimedJob, signal?: AbortSignal): Promise<string | null> {
    const { submission, input, earlier, conversation } = await this.withLease(job, async (tx, submission) => {
      const [input] = await tx.select({ sequence: messages.sequence }).from(messages).where(eq(messages.id, submission.userMessageId));
      const [earlier] = await tx.select({ id: sessionBindings.id }).from(sessionBindings)
        .where(and(eq(sessionBindings.conversationId, submission.conversationId), ne(sessionBindings.id, submission.bindingId))).limit(1);
      const [conversation] = await tx.select({ kind: conversations.kind }).from(conversations).where(eq(conversations.id, submission.conversationId));
      return { submission, input, earlier, conversation };
    });
    if (!earlier || !input) return null;
    if (conversation?.kind === 'main') {
      const turns = await this.db.select({ userMessageId: runtimeSubmissions.userMessageId, assistantMessageId: runtimeSubmissions.assistantMessageId })
        .from(runtimeSubmissions).innerJoin(messages, eq(messages.id, runtimeSubmissions.userMessageId))
        .where(and(eq(runtimeSubmissions.userId, submission.userId), eq(runtimeSubmissions.conversationId, submission.conversationId),
          eq(runtimeSubmissions.status, 'completed'), lt(messages.sequence, input.sequence)))
        .orderBy(desc(messages.sequence)).limit(mainSessionPolicy.carryTurns);
      if (!turns.length) return null;
      const rows = await this.db.select().from(messages).where(and(eq(messages.userId, submission.userId),
        inArray(messages.id, turns.flatMap(turn => [turn.userMessageId, turn.assistantMessageId])))).orderBy(desc(messages.sequence));
      return mainHistoryContext(await hydrateMessages(this.db, this.runtime.history, submission.userId, rows, signal));
    }
    const rows = await this.db.select({ id: messages.id, role: messages.role, status: messages.status, text: messages.text, parts: messages.parts }).from(messages)
      .where(and(eq(messages.userId, submission.userId), eq(messages.conversationId, submission.conversationId), eq(messages.status, 'completed'), lt(messages.sequence, input.sequence)))
      .orderBy(desc(messages.sequence)).limit(41);
    return historyContext(await hydrateMessages(this.db, this.runtime.history, submission.userId, rows, signal));
  }
}
