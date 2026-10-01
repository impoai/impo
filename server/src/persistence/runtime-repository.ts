import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { Database } from '../db/client.js';
import { users, actions, conversations, messages, agentConfigVersions, sessionBindings, sessionCreationAttempts, runtimeSubmissions, toolInvocations, outboxJobs, productEvents, devices, deviceCapabilities, deviceDispatches, connectorConnections, todaySettings } from '../db/schema.js';
import { ServiceError, LeaseLostError } from '../errors.js';
import type { ToolResult, ToolRegistry } from '../tools/registry.js';
import { DeviceRepository } from './device-repository.js';
import { enqueueNotification } from '../notifications/repository.js';
import { clientContext, deviceHash, selectDeviceTools, type ClientContext } from '../tools/device-tools.js';
import { CONNECTOR_TOOL_NAMES } from '../tools/connector-tools.js';
import { hydrateMessages, taskTitles, type HistoryReader } from './conversation-history.js';

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Query = Database | Transaction;
export type Submission = typeof runtimeSubmissions.$inferSelect;
export interface RuntimeOptions { provider: 'development' | 'rebyte'; agentConfig?: Record<string, unknown>; taskAgentConfig?: Record<string, unknown>; deviceToolTimeoutMs?: number; serverTools?: ToolRegistry;
  /** Rebyte history: the source of finished chat text, which PostgreSQL does not keep. */
  history?: HistoryReader }
export type ClaimedJob = typeof outboxJobs.$inferSelect;
export interface SubmissionView {
  submissionId: string; messageId: string; status: Submission['status']; version: number;
  error: Submission['error']; resultCount: number; cancelRequested: boolean;
}
const terminalStates = ['completed', 'failed', 'cancelled'] as const;
const terminal = (status: string) => (terminalStates as readonly string[]).includes(status);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missing = () => new ServiceError(404, 'not_found', 'Resource not found');
const ownedSubmission = (userId: string, id: string) => and(eq(runtimeSubmissions.userId, userId), eq(runtimeSubmissions.id, id));

/** Durable commands, projections, leases and receipts, all scoped by user ownership. */
export class RuntimeRepository {
  readonly devices: DeviceRepository;
  constructor(readonly db: Database, readonly runtime: RuntimeOptions = { provider: 'development' }) { this.devices = new DeviceRepository(db); }

  async health(): Promise<void> {
    // Also detect an uninitialized schema instead of reporting a usable API.
    await this.db.select({ id: users.id }).from(users).limit(1);
    await this.db.select({ id: outboxJobs.id }).from(outboxJobs).limit(1);
    await this.db.select({ id: devices.id }).from(devices).limit(1);
    await this.db.select({ id: deviceDispatches.id }).from(deviceDispatches).limit(1);
  }

  async findUser(authSubject: 'alice' | 'bob'): Promise<{ id: string }> {
    const [user] = await this.db.select({ id: users.id }).from(users).where(and(eq(users.authProvider, 'local-dev'), eq(users.authSubject, authSubject)));
    if (!user) throw new ServiceError(503, 'development_user_missing', 'Run the development seed before starting the API');
    return user;
  }

  /** Just-in-time provisioning for a real auth provider: first verified sight creates the row. */
  async findOrCreateUser(authProvider: string, authSubject: string, name: string): Promise<{ id: string }> {
    return this.db.transaction(async tx => {
      const owned = and(eq(users.authProvider, authProvider), eq(users.authSubject, authSubject));
      const [existing] = await tx.select({ id: users.id }).from(users).where(owned);
      if (existing) return existing;
      // Concurrent first requests from the same new identity must not create two rows.
      await tx.insert(users).values({ authProvider, authSubject, name }).onConflictDoNothing({ target: [users.authProvider, users.authSubject] });
      const [user] = await tx.select({ id: users.id }).from(users).where(owned);
      if (!user) throw new Error('User row missing after insert');
      return user;
    });
  }

  /** Lock the identity to serialize first conversation creation and message IDs. */
  private async conversation(tx: Transaction, userId: string) {
    await this.lockUser(tx, userId);
    // Task conversations belong to the same user; only the main one is "the" conversation.
    const [existing] = await tx.select().from(conversations).where(and(eq(conversations.userId, userId), eq(conversations.kind, 'main'))).for('update');
    if (existing) return existing;
    const [created] = await tx.insert(conversations).values({ userId }).returning();
    return created!;
  }

  private async lockUser(tx: Transaction, userId: string) {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    if (!user) throw missing();
  }

  private async taskConversation(tx: Transaction, userId: string, taskId: string) {
    await this.lockUser(tx, userId);
    const [task] = await tx.select().from(conversations).where(and(eq(conversations.userId, userId), eq(conversations.kind, 'task'), eq(conversations.actionId, taskId))).for('update');
    if (!task) throw missing();
    return task;
  }

  /**
   * Narrow a runtime catalog to the tools this user can use now: native tools enabled
   * on the attached device, and connector tools while at least one app is connected.
   * The four connector tools
   * are fixed, so connecting a second or third app does not rotate the Session.
   */
  protected async userAgentConfig(tx: Transaction, userId: string, config: Record<string, unknown> | undefined, capabilities: readonly string[] = []) {
    if (!config || !Array.isArray(config.tools)) return config;
    const [connected] = await tx.select({ id: connectorConnections.id }).from(connectorConnections)
      .where(and(eq(connectorConnections.userId, userId), eq(connectorConnections.status, 'connected'), eq(connectorConnections.disconnectRequested, false))).limit(1);
    const tools = selectDeviceTools(config.tools as Array<{ name?: unknown }>, capabilities).filter(tool => {
      if (typeof tool.name !== 'string') return true;
      if ((CONNECTOR_TOOL_NAMES as readonly string[]).includes(tool.name)) return Boolean(connected);
      return true;
    });
    // Only existing, user-owned profile fields enter the prompt snapshot. Dates stay per-message
    // so ordinary turns do not rotate the Session merely because the clock changed.
    const [profile] = await tx.select({ name: users.name, displayName: todaySettings.displayName, locale: todaySettings.locale, timeZone: todaySettings.timeZone })
      .from(users).leftJoin(todaySettings, eq(todaySettings.userId, users.id)).where(eq(users.id, userId));
    const promptProfile = {
      displayName: (profile?.displayName || profile?.name || '').slice(0, 100),
      ...(profile?.locale ? { locale: profile.locale } : {}),
      ...(profile?.timeZone ? { timeZone: profile.timeZone } : {}),
    };
    return { ...config, tools, promptProfile };
  }

  /** Dedupe by content hash under a global lock; callers pass any provider-specific config shape. */
  protected async ensureAgentConfigVersion(tx: Transaction, agentConfig: Record<string, unknown>) {
    const configHash = hash(agentConfig);
    // Different users/conversations may create their first matching version concurrently.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('instant:agent-config'))`);
    let [config] = await tx.select().from(agentConfigVersions).where(eq(agentConfigVersions.hash, configHash));
    if (!config) {
      const [version] = await tx.select({ value: sql<number>`coalesce(max(${agentConfigVersions.version}), 0)::int + 1` }).from(agentConfigVersions);
      [config] = await tx.insert(agentConfigVersions).values({ version: version!.value, hash: configHash, config: agentConfig }).returning();
    }
    return config!;
  }

  /** Accept input and create its durable job in the same transaction. */
  async acceptMessage(userId: string, input: { clientMessageId: string; text: string; deviceId?: string; clientContext?: ClientContext }) {
    const prepared = this.prepareInput(input, 32_768);
    return this.db.transaction(async tx => this.accept(tx, userId, await this.conversation(tx, userId), input, prepared));
  }

  /** An already accepted user input, so a retried voice message is not transcribed twice. */
  async findUserMessage(userId: string, clientMessageId: string): Promise<{ text: string } | undefined> {
    const [row] = await this.db.select({ text: messages.text }).from(messages).where(and(eq(messages.userId, userId), eq(messages.clientMessageId, clientMessageId)));
    return row;
  }

  /** A user-started task: its own Action and conversation, then the same durable acceptance as chat. */
  async createUserTask(userId: string, input: { clientMessageId: string; text: string; clientContext?: ClientContext }) {
    // A task never gets device Function tools (it may run with no foreground device), so no deviceId.
    const prepared = this.prepareInput({ ...input, text: input.text.trim() }, 4000);
    return this.db.transaction(async tx => {
      await this.lockUser(tx, userId);
      const [existing] = await tx.select({ conversationId: messages.conversationId }).from(messages).where(and(eq(messages.userId, userId), eq(messages.clientMessageId, input.clientMessageId)));
      let conversation: typeof conversations.$inferSelect | undefined;
      if (existing) {
        [conversation] = await tx.select().from(conversations).where(and(eq(conversations.userId, userId), eq(conversations.id, existing.conversationId), eq(conversations.kind, 'task')));
        if (!conversation) throw new ServiceError(409, 'idempotency_conflict', 'Message ID already has different content');
      } else {
        const actionId = randomUUID();
        await tx.insert(actions).values({ id: actionId, userId, goal: input.text.trim() });
        [conversation] = await tx.insert(conversations).values({ userId, kind: 'task', actionId }).returning();
      }
      const receipt = await this.accept(tx, userId, conversation!, { ...input, text: input.text.trim() }, prepared);
      return { taskId: conversation!.actionId!, conversationId: conversation!.id, ...receipt };
    });
  }

  async acceptTaskMessage(userId: string, taskId: string, input: { clientMessageId: string; text: string; clientContext?: ClientContext }) {
    const prepared = this.prepareInput(input, 32_768);
    return this.db.transaction(async tx => this.accept(tx, userId, await this.taskConversation(tx, userId, taskId), input, prepared));
  }

  private prepareInput(input: { clientMessageId: string; text: string; deviceId?: string; clientContext?: ClientContext }, maxText: number) {
    if (!input.clientMessageId.trim() || input.clientMessageId.length > 256 || !input.text.trim() || input.text.length > maxText) {
      throw new ServiceError(400, 'invalid_request', 'Invalid message ID or text length');
    }
    const context = clientContext(input.clientContext);
    const inputHash = hash({ text: input.text, ...(input.deviceId ? { deviceId: input.deviceId } : {}), ...(context ? { clientContext: context } : {}) });
    return { context, inputHash };
  }

  private async accept(tx: Transaction, userId: string, conversation: typeof conversations.$inferSelect,
    input: { clientMessageId: string; text: string; deviceId?: string }, { context, inputHash }: { context: ClientContext | undefined; inputHash: string }) {
    const [existing] = await tx.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.clientMessageId, input.clientMessageId)));
    if (existing) {
      if (existing.inputHash !== inputHash || existing.conversationId !== conversation.id) throw new ServiceError(409, 'idempotency_conflict', 'Message ID already has different content');
      const [submission] = await tx.select().from(runtimeSubmissions).where(and(eq(runtimeSubmissions.userId, userId), eq(runtimeSubmissions.userMessageId, existing.id)));
      if (!submission) throw new Error('Accepted message has no submission');
      return { messageId: existing.id, submissionId: submission.id };
    }
    let capabilities: string[] = [];
    if (input.deviceId) {
      const [device] = await tx.select().from(devices).where(and(eq(devices.userId, userId), eq(devices.id, input.deviceId)));
      if (!device) throw missing();
      capabilities = (await tx.select({ name: deviceCapabilities.toolName }).from(deviceCapabilities).where(eq(deviceCapabilities.deviceId, device.id))).map(row => row.name).sort();
    }
    // Tools are fixed per Session, so changing the attached device can rotate an idle Session.
    const agentConfig = await this.userAgentConfig(tx, userId, conversation.kind === 'task' ? this.runtime.taskAgentConfig : this.runtime.agentConfig, capabilities);
    let binding: typeof sessionBindings.$inferSelect | undefined = (await tx.select().from(sessionBindings).where(and(eq(sessionBindings.userId, userId), eq(sessionBindings.conversationId, conversation.id), eq(sessionBindings.isCurrent, true))))[0];
    if (binding?.provider === 'rebyte' && this.runtime.provider === 'rebyte' && agentConfig) {
      const [previous] = await tx.select().from(agentConfigVersions).where(eq(agentConfigVersions.id, binding.agentConfigVersionId));
      // Tools, instructions, model and Sandbox are fixed per Session.
      // jsonb reorders object keys; compare canonical JSON, not wire property order.
      if (deviceHash(previous?.config ?? null) !== deviceHash(agentConfig)) {
        const [active] = await tx.select({ id: runtimeSubmissions.id }).from(runtimeSubmissions).where(and(eq(runtimeSubmissions.conversationId, conversation.id), inArray(runtimeSubmissions.status, ['queued', 'running', 'waiting_device']))).limit(1);
        if (active) throw new ServiceError(409, 'config_upgrade_pending', 'Wait for the current reply before updating assistant tools', true);
        // Rebyte 0.2.4 cannot update inline Session tools. Preserve product history
        // and perform this configuration change only after the old queue ends.
        await tx.update(sessionBindings).set({ isCurrent: false, status: 'retired', updatedAt: new Date() }).where(eq(sessionBindings.id, binding.id));
        binding = undefined;
      }
    }
    if (binding && binding.provider !== this.runtime.provider) {
      const [active] = await tx.select({ id: runtimeSubmissions.id }).from(runtimeSubmissions).where(and(eq(runtimeSubmissions.conversationId, conversation.id), inArray(runtimeSubmissions.status, ['queued', 'running', 'waiting_device']))).limit(1);
      if (active || binding.provider !== 'development') throw new ServiceError(409, 'runtime_mismatch', 'The current conversation uses another runtime');
      // Preserve fixture-era history when first enabling the real provider.
      await tx.update(sessionBindings).set({ isCurrent: false, status: 'retired', updatedAt: new Date() }).where(eq(sessionBindings.id, binding.id));
      binding = undefined;
    }
    if (!binding) {
      let config: typeof agentConfigVersions.$inferSelect | undefined;
      if (this.runtime.provider === 'rebyte') {
        if (!agentConfig) throw new Error(conversation.kind === 'task' ? 'Task Agent configuration is missing' : 'Rebyte Agent configuration is missing');
        config = await this.ensureAgentConfigVersion(tx, agentConfig);
      } else {
        [config] = await tx.select().from(agentConfigVersions).where(eq(agentConfigVersions.version, 1));
      }
      if (!config || config.config.provider !== this.runtime.provider) throw new ServiceError(503, 'runtime_config_missing', 'Initialize the runtime configuration');
      const bindingId = randomUUID();
      const local = this.runtime.provider === 'development';
      // Rebyte holds the conversation: the Worker builds history for a new Session from it and
      // never stores a copy here.
      [binding] = await tx.insert(sessionBindings).values({ id: bindingId, userId, conversationId: conversation.id, agentConfigVersionId: config.id, provider: this.runtime.provider, providerSessionId: local ? `development:${bindingId}` : null, status: local ? 'active' : 'creating' }).returning();
      if (local) await tx.insert(sessionCreationAttempts).values({ userId, bindingId, status: 'succeeded', requestHash: hash({ provider: 'development', configHash: config.hash }), providerSessionId: binding!.providerSessionId });
    }
    if (binding!.status === 'failed' || binding!.status === 'retired') throw new ServiceError(409, 'runtime_unavailable', 'The current session binding is unavailable');
    const messageId = randomUUID(), assistantMessageId = randomUUID(), submissionId = randomUUID();
    await tx.insert(messages).values([
      { id: messageId, userId, conversationId: conversation.id, sequence: conversation.nextSequence, role: 'user', clientMessageId: input.clientMessageId, inputHash, text: input.text, parts: [{ type: 'text', text: input.text }], status: 'completed' },
      { id: assistantMessageId, userId, conversationId: conversation.id, sequence: conversation.nextSequence + 1, role: 'assistant' },
    ]);
    await tx.update(conversations).set({ nextSequence: conversation.nextSequence + 2, updatedAt: new Date() }).where(eq(conversations.id, conversation.id));
    const [submission] = await tx.insert(runtimeSubmissions).values({ id: submissionId, userId, conversationId: conversation.id, bindingId: binding!.id, userMessageId: messageId, assistantMessageId, deviceId: input.deviceId, deviceTools: capabilities, clientContext: context }).returning();
    await this.appendEvents(tx, submission!, [
      { type: 'start', messageId: assistantMessageId }, this.statusChunk(submission!, 'queued'),
    ]);
    await tx.insert(outboxJobs).values({ userId, submissionId, type: this.runtime.provider === 'rebyte' ? 'rebyte.drive' : 'submission.prepare', dedupeKey: `${submissionId}:prepare` });
    return { messageId, submissionId };
  }

  async getConversation(userId: string, afterSequence = 0, limit = 50) {
    // Initialize separately: the read snapshot must not mix message/worker commits.
    const identity = await this.db.transaction(tx => this.conversation(tx, userId));
    return this.readConversation(userId, identity.id, afterSequence, limit);
  }

  async getTaskConversation(userId: string, taskId: string, afterSequence = 0, limit = 50) {
    const [task] = await this.db.select({ id: conversations.id, goal: actions.goal }).from(conversations)
      .innerJoin(actions, eq(actions.id, conversations.actionId))
      .where(and(eq(conversations.userId, userId), eq(conversations.kind, 'task'), eq(conversations.actionId, taskId)));
    if (!task) throw missing();
    const title = (await taskTitles(this.db, this.runtime.history, userId, [task.id])).get(task.id) ?? task.goal;
    return { taskId, title, ...(await this.readConversation(userId, task.id, afterSequence, limit)) };
  }

  /** Most recently modified first; activity includes follow-ups and run progress. */
  async listTasks(userId: string, limit = 100) {
    const activity = this.db.select({ conversationId: runtimeSubmissions.conversationId,
      updatedAt: sql<Date>`max(${runtimeSubmissions.updatedAt})`.mapWith(runtimeSubmissions.updatedAt).as('last_activity_at'),
    }).from(runtimeSubmissions).where(eq(runtimeSubmissions.userId, userId))
      .groupBy(runtimeSubmissions.conversationId).as('task_activity');
    const updatedAt = sql<Date>`greatest(${actions.updatedAt}, ${conversations.updatedAt}, ${activity.updatedAt})`.mapWith(actions.updatedAt);
    const rows = await this.db.select({ taskId: actions.id, goal: actions.goal, conversationId: conversations.id, createdAt: actions.createdAt, updatedAt })
      .from(actions).innerJoin(conversations, eq(conversations.actionId, actions.id))
      .leftJoin(activity, eq(activity.conversationId, conversations.id))
      .where(and(eq(actions.userId, userId), eq(conversations.kind, 'task'))).orderBy(desc(updatedAt), desc(actions.createdAt)).limit(limit);
    if (!rows.length) return { tasks: [] };
    const runs = await this.db.select({ conversationId: runtimeSubmissions.conversationId, status: runtimeSubmissions.status, createdAt: runtimeSubmissions.createdAt, completedAt: runtimeSubmissions.completedAt })
      .from(runtimeSubmissions)
      .where(and(eq(runtimeSubmissions.userId, userId), inArray(runtimeSubmissions.conversationId, rows.map(row => row.conversationId))))
      .orderBy(desc(runtimeSubmissions.createdAt));
    const titles = await taskTitles(this.db, this.runtime.history, userId, rows.map(row => row.conversationId));
    const latest = new Map<string, (typeof runs)[number]>();
    for (const run of runs) if (!latest.has(run.conversationId)) latest.set(run.conversationId, run);
    return {
      tasks: rows.map(row => {
        const run = latest.get(row.conversationId);
        const status = !run ? 'queued' : terminal(run.status) ? run.status : run.status === 'queued' ? 'queued' : 'in_progress';
        return {
          taskId: row.taskId, conversationId: row.conversationId, title: titles.get(row.conversationId) ?? row.goal, status, createdAt: row.createdAt, updatedAt: row.updatedAt,
          lastRunStartedAt: run?.createdAt ?? null, lastRunCompletedAt: run?.completedAt ?? null,
        };
      }),
    };
  }

  private async readConversation(userId: string, conversationId: string, afterSequence: number, limit: number) {
    // Read ordering/status in one snapshot, then fill finished text from Rebyte outside the transaction.
    const view = await this.readConversationRows(userId, conversationId, afterSequence, limit);
    return { ...view, messages: await hydrateMessages(this.db, this.runtime.history, userId, view.messages) };
  }

  private async readConversationRows(userId: string, conversationId: string, afterSequence: number, limit: number) {
    return this.db.transaction(async tx => {
      const [conversation] = await tx.select().from(conversations).where(and(eq(conversations.userId, userId), eq(conversations.id, conversationId)));
      if (!conversation) throw missing();
      const page = await tx.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.conversationId, conversation.id), gt(messages.sequence, afterSequence))).orderBy(asc(messages.sequence)).limit(limit + 1);
      const active = await tx.select({ submissionId: runtimeSubmissions.id, status: runtimeSubmissions.status, messageId: runtimeSubmissions.assistantMessageId }).from(runtimeSubmissions).where(and(eq(runtimeSubmissions.userId, userId), eq(runtimeSubmissions.conversationId, conversation.id), inArray(runtimeSubmissions.status, ['queued', 'running', 'waiting_device'])));
      return { conversationId: conversation.id, messages: page.slice(0, limit).map(message => ({ id: message.id, role: message.role, sequence: message.sequence, text: message.text, parts: message.parts, status: message.status, createdAt: message.createdAt })), activeSubmissions: active, hasMore: page.length > limit, nextAfterSequence: page.slice(0, limit).at(-1)?.sequence ?? afterSequence };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  private async view(query: Query, submission: Submission): Promise<SubmissionView> {
    const [row] = await query.select({ count: sql<number>`count(*)::int` }).from(toolInvocations).where(and(eq(toolInvocations.userId, submission.userId), eq(toolInvocations.submissionId, submission.id), sql`${toolInvocations.result} IS NOT NULL`));
    return { submissionId: submission.id, messageId: submission.assistantMessageId, status: submission.status, version: submission.nextEventSequence - 1, error: submission.error, resultCount: row!.count, cancelRequested: submission.cancelRequested };
  }

  async getSubmission(userId: string, id: string): Promise<SubmissionView> {
    return this.db.transaction(async tx => {
      const [submission] = await tx.select().from(runtimeSubmissions).where(ownedSubmission(userId, id));
      if (!submission) throw missing();
      return this.view(tx, submission);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  /** A consistent status/event snapshot; later polls close the subscription gap. */
  async readEvents(userId: string, id: string, afterSequence: number) {
    return this.db.transaction(async tx => {
      const [submission] = await tx.select().from(runtimeSubmissions).where(ownedSubmission(userId, id));
      if (!submission) throw missing();
      const events = await tx.select({ sequence: productEvents.sequence, chunk: productEvents.chunk }).from(productEvents).where(and(eq(productEvents.userId, userId), eq(productEvents.submissionId, id), gt(productEvents.sequence, afterSequence))).orderBy(asc(productEvents.sequence)).limit(100);
      return { submission: await this.view(tx, submission), events };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  /** Cancellation fences workers under the same submission-first lock ordering. */
  async cancelSubmission(userId: string, id: string): Promise<SubmissionView> {
    await this.db.transaction(async tx => {
      const [submission] = await tx.select().from(runtimeSubmissions).where(ownedSubmission(userId, id)).for('update');
      if (!submission) throw missing();
      if (terminal(submission.status)) return;
      await tx.update(deviceDispatches).set({ status: 'cancelled', completedAt: new Date() }).where(and(eq(deviceDispatches.submissionId, id), inArray(deviceDispatches.status, ['pending', 'claimed'])));
      await tx.update(toolInvocations).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(toolInvocations.submissionId, id), inArray(toolInvocations.status, ['received', 'running'])));
      const [binding] = await tx.select().from(sessionBindings).where(eq(sessionBindings.id, submission.bindingId));
      if (binding?.provider === 'rebyte') {
        // Hold the conversation queue until the remote Turn is terminal.
        await tx.update(runtimeSubmissions).set({ cancelRequested: true, updatedAt: new Date() }).where(eq(runtimeSubmissions.id, id));
        return;
      }
      await this.finish(tx, submission, 'cancelled', [{ type: 'abort' }]);
      await tx.update(outboxJobs).set({ status: 'cancelled', leaseToken: null, leaseUntil: null, completedAt: new Date(), updatedAt: new Date() }).where(and(eq(outboxJobs.userId, userId), eq(outboxJobs.submissionId, id), inArray(outboxJobs.status, ['pending', 'running'])));
      await tx.update(toolInvocations).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(toolInvocations.userId, userId), eq(toolInvocations.submissionId, id), inArray(toolInvocations.status, ['received', 'running', 'result_saved'])));
    });
    return this.getSubmission(userId, id);
  }

  /** Claim one job atomically, preserving conversation order across workers. */
  async claimJob(_workerId: string, leaseMs: number): Promise<ClaimedJob | undefined> {
    return this.db.transaction(async tx => {
      const [job] = await tx.select().from(outboxJobs).where(sql`
        ((${outboxJobs.status} = 'pending' AND ${outboxJobs.availableAt} <= now())
          OR (${outboxJobs.status} = 'running' AND ${outboxJobs.leaseUntil} < now()))
        AND EXISTS (
          SELECT 1 FROM runtime_submissions current_run JOIN messages current_message ON current_message.id = current_run.user_message_id
          WHERE current_run.id = ${outboxJobs.submissionId}
            AND EXISTS (SELECT 1 FROM session_bindings runtime_binding WHERE runtime_binding.id = current_run.binding_id AND runtime_binding.provider = ${this.runtime.provider})
            AND current_run.status NOT IN ('completed','failed','cancelled')
            AND NOT EXISTS (
              SELECT 1 FROM runtime_submissions previous_run JOIN messages previous_message ON previous_message.id = previous_run.user_message_id
              WHERE previous_run.conversation_id = current_run.conversation_id
                AND previous_run.status NOT IN ('completed','failed','cancelled')
                AND previous_message.sequence < current_message.sequence
            )
        )
      `).orderBy(asc(outboxJobs.createdAt), asc(outboxJobs.id)).limit(1).for('update', { skipLocked: true });
      if (!job) return undefined;
      const [claimed] = await tx.update(outboxJobs).set({ status: 'running', leaseToken: randomUUID(), leaseUntil: sql`now() + ${leaseMs} * interval '1 millisecond'`, attempts: job.attempts + 1, updatedAt: new Date() }).where(eq(outboxJobs.id, job.id)).returning();
      return claimed;
    });
  }

  protected async withLease<T>(job: ClaimedJob, action: (tx: Transaction, submission: Submission) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      const [submission] = await tx.select().from(runtimeSubmissions).where(ownedSubmission(job.userId, job.submissionId)).for('update');
      const [current] = await tx.select().from(outboxJobs).where(and(eq(outboxJobs.id, job.id), eq(outboxJobs.userId, job.userId), eq(outboxJobs.status, 'running'), eq(outboxJobs.leaseToken, job.leaseToken!), sql`${outboxJobs.leaseUntil} > clock_timestamp()`)).for('update');
      if (!submission || terminal(submission.status) || !current || current.submissionId !== job.submissionId) throw new LeaseLostError();
      return action(tx, submission);
    });
  }

  /** Development runtime requests one deterministic server tool, atomically. */
  async prepareSubmission(job: ClaimedJob): Promise<void> {
    await this.withLease(job, async (tx, submission) => {
      const [message] = await tx.select().from(messages).where(and(eq(messages.userId, submission.userId), eq(messages.id, submission.userMessageId)));
      if (!message) throw new Error('Submission input is missing');
      const turnId = `development:${submission.id}`, callId = `echo:${submission.id}`, invocationId = randomUUID();
      const args = { text: message.text };
      await tx.insert(toolInvocations).values({ id: invocationId, userId: submission.userId, submissionId: submission.id, bindingId: submission.bindingId, turnId, callId, toolName: 'instant_dev_echo', arguments: args, argumentsHash: hash(args), executionLocation: 'server' });
      await tx.update(runtimeSubmissions).set({ status: 'running', providerTurnId: turnId, updatedAt: new Date() }).where(eq(runtimeSubmissions.id, submission.id));
      await tx.update(messages).set({ status: 'streaming', parts: [{ type: 'dynamic-tool', toolCallId: callId, toolName: 'instant_dev_echo', state: 'input-available', input: args }], updatedAt: new Date() }).where(eq(messages.id, submission.assistantMessageId));
      await this.appendEvents(tx, submission, [this.statusChunk(submission, 'running'), { type: 'tool-input-available', toolCallId: callId, toolName: 'instant_dev_echo', input: args, dynamic: true }]);
      await tx.insert(outboxJobs).values({ userId: submission.userId, submissionId: submission.id, invocationId, type: 'tool.execute', dedupeKey: `${submission.id}:execute` });
      await this.completeJob(tx, job);
    });
  }

  async getToolForJob(job: ClaimedJob) {
    return this.withLease(job, async tx => {
      if (!job.invocationId) throw new Error('Tool job has no invocation');
      const [invocation] = await tx.select().from(toolInvocations).where(and(eq(toolInvocations.id, job.invocationId), eq(toolInvocations.userId, job.userId), eq(toolInvocations.submissionId, job.submissionId)));
      if (!invocation) throw new Error('Tool invocation is missing');
      return invocation;
    });
  }

  /** Save the frozen result and its continuation together; replay never reruns it. */
  async saveToolResult(job: ClaimedJob, result: ToolResult): Promise<void> {
    await this.withLease(job, async (tx, submission) => {
      if (!job.invocationId) throw new Error('Tool job has no invocation');
      const [invocation] = await tx.select().from(toolInvocations).where(and(eq(toolInvocations.id, job.invocationId), eq(toolInvocations.userId, job.userId))).for('update');
      if (!invocation || invocation.status !== 'received') throw new Error('Invocation is not awaiting execution');
      await tx.update(toolInvocations).set({ status: 'result_saved', result, updatedAt: new Date() }).where(eq(toolInvocations.id, invocation.id));
      const chunk: UIMessageChunk = result.ok
        ? { type: 'tool-output-available', toolCallId: invocation.callId, output: result, dynamic: true }
        : { type: 'tool-output-error', toolCallId: invocation.callId, errorText: result.error.code, dynamic: true };
      const parts: UIMessage['parts'] = result.ok
        ? [{ type: 'dynamic-tool', toolCallId: invocation.callId, toolName: invocation.toolName, state: 'output-available', input: invocation.arguments, output: result }]
        : [{ type: 'dynamic-tool', toolCallId: invocation.callId, toolName: invocation.toolName, state: 'output-error', input: invocation.arguments, errorText: result.error.code }];
      await tx.update(messages).set({ parts, updatedAt: new Date() }).where(eq(messages.id, submission.assistantMessageId));
      await this.appendEvents(tx, submission, [chunk]);
      await tx.insert(outboxJobs).values({ userId: job.userId, submissionId: job.submissionId, invocationId: invocation.id, type: 'submission.complete', dedupeKey: `${submission.id}:complete` });
      await this.completeJob(tx, job);
    });
  }

  /** Development continuation consumes a saved receipt, with no provider call. */
  async completeSubmission(job: ClaimedJob): Promise<void> {
    await this.withLease(job, async (tx, submission) => {
      if (!job.invocationId) throw new Error('Continuation job has no invocation');
      const [invocation] = await tx.select().from(toolInvocations).where(and(eq(toolInvocations.id, job.invocationId), eq(toolInvocations.userId, job.userId)));
      if (!invocation || invocation.status !== 'result_saved' || !invocation.result) throw new Error('Continuation needs a saved tool result');
      const result = invocation.result;
      let text: string;
      if (result.ok === true && result.data && typeof result.data === 'object' && 'echo' in result.data && typeof result.data.echo === 'string') text = `开发回声：${result.data.echo}`;
      else if (result.ok === false) text = '开发工具未能完成，请检查工具状态。';
      else throw new Error('Stored development result has an invalid schema');
      const [assistant] = await tx.select().from(messages).where(eq(messages.id, submission.assistantMessageId));
      if (!assistant) throw new Error('Assistant message is missing');
      await tx.update(messages).set({ text, parts: [...assistant.parts, { type: 'text', text }], updatedAt: new Date() }).where(eq(messages.id, assistant.id));
      // submitted means consumed by the configured development runtime, not Rebyte.
      await tx.update(toolInvocations).set({ status: 'submitted', submittedAt: new Date() }).where(eq(toolInvocations.id, invocation.id));
      const partId = `text-${submission.id}`;
      await this.finish(tx, submission, 'completed', [{ type: 'text-start', id: partId }, { type: 'text-delta', id: partId, delta: text }, { type: 'text-end', id: partId }]);
      await this.completeJob(tx, job);
    });
  }

  /** Bound transient retries; unexpected errors cannot leave an eternal running row. */
  async releaseJob(job: ClaimedJob, error: { code: string; message: string; retryable: boolean }): Promise<void> {
    await this.withLease(job, async (tx, submission) => {
      const retry = error.retryable && job.attempts < 3;
      await tx.update(outboxJobs).set({ status: retry ? 'pending' : 'failed', leaseToken: null, leaseUntil: null, availableAt: new Date(Date.now() + 250 * job.attempts), error, completedAt: retry ? null : new Date(), updatedAt: new Date() }).where(eq(outboxJobs.id, job.id));
      if (!retry) {
        if (job.invocationId) await tx.update(toolInvocations).set({ status: 'failed', error, updatedAt: new Date() }).where(eq(toolInvocations.id, job.invocationId));
        await this.finish(tx, submission, 'failed', [{ type: 'error', errorText: error.code }], error);
      }
    });
  }

  protected statusChunk(submission: Submission, status: Submission['status']): UIMessageChunk {
    return { type: 'data-instant-submission', data: { schemaVersion: 1, submissionId: submission.id, status } };
  }

  /** Caller holds the submission lock; insert event sequence and waterline atomically. */
  protected async appendEvents(tx: Transaction, submission: Submission, chunks: UIMessageChunk[]): Promise<void> {
    await tx.insert(productEvents).values(chunks.map((chunk, index) => ({ userId: submission.userId, submissionId: submission.id, sequence: submission.nextEventSequence + index, chunk })));
    await tx.update(runtimeSubmissions).set({ nextEventSequence: submission.nextEventSequence + chunks.length, updatedAt: new Date() }).where(eq(runtimeSubmissions.id, submission.id));
  }

  protected async finish(tx: Transaction, submission: Submission, status: 'completed' | 'failed' | 'cancelled', chunks: UIMessageChunk[], error?: Submission['error']) {
    await tx.update(deviceDispatches).set({ status: 'cancelled', completedAt: new Date() }).where(and(eq(deviceDispatches.submissionId, submission.id), inArray(deviceDispatches.status, ['pending', 'claimed'])));
    await tx.update(toolInvocations).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(toolInvocations.submissionId, submission.id), inArray(toolInvocations.status, ['received', 'running'])));
    await tx.update(runtimeSubmissions).set({ status, error: error ?? null, completedAt: new Date(), updatedAt: new Date() }).where(eq(runtimeSubmissions.id, submission.id));
    await tx.update(messages).set({ status, updatedAt: new Date() }).where(eq(messages.id, submission.assistantMessageId));
    if (status === 'completed' || status === 'failed') {
      const [conversation] = await tx.select().from(conversations).where(and(eq(conversations.userId, submission.userId), eq(conversations.id, submission.conversationId)));
      if (conversation) await enqueueNotification(tx, { userId: submission.userId, sourceKey: `turn/${submission.id}`, category: conversation.kind === 'task' ? 'tasks' : 'chat',
        targetId: conversation.actionId ?? conversation.id, failed: status === 'failed' });
    }
    await this.appendEvents(tx, submission, [...chunks, this.statusChunk(submission, status), { type: 'finish', finishReason: status === 'completed' ? 'stop' : 'other' }]);
  }

  protected async completeJob(tx: Transaction, job: ClaimedJob): Promise<void> {
    await tx.update(outboxJobs).set({ status: 'completed', leaseToken: null, leaseUntil: null, completedAt: new Date(), updatedAt: new Date() }).where(eq(outboxJobs.id, job.id));
  }
}
