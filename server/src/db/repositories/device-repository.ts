import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql, isNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import { devices, deviceCapabilities, deviceDispatches, runtimeSubmissions, toolInvocations, users } from '../schema.js';
import { ServiceError } from '../../errors.js';
import { deviceHash, deviceCapabilityNames, isDeviceCapability, describeDeviceCapabilities, jsonValue } from '../../tools/device-tools.js';
import type { Transaction } from './runtime-repository.js';

const missing = () => new ServiceError(404, 'not_found', 'Resource not found');
const terminal = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);
export interface DeviceResult { deviceId: string; executionId: string; success: boolean; output?: unknown; error?: string }

/** Device authorization and immutable receipts, independent of HTTP subscriptions. */
export class DeviceRepository {
  constructor(private readonly db: Database) {}

  async register(userId: string, input: { installationId: string; tools: string[] }) {
    if (!input.installationId.trim() || input.installationId.length > 256 || input.installationId.includes('\0') || !Array.isArray(input.tools) || input.tools.length > deviceCapabilityNames.length || new Set(input.tools).size !== input.tools.length || input.tools.some(name => !isDeviceCapability(name))) {
      throw new ServiceError(400, 'invalid_request', 'Invalid installation ID or device tools');
    }
    return this.db.transaction(async tx => {
      // Serialize registration and capability replacement across retrying clients.
      const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      if (!user) throw missing();
      const [device] = await tx.insert(devices).values({ userId, installationId: input.installationId })
        .onConflictDoUpdate({ target: [devices.userId, devices.installationId], set: { lastSeenAt: new Date() } }).returning();
      await tx.delete(deviceCapabilities).where(eq(deviceCapabilities.deviceId, device!.id));
      if (input.tools.length) await tx.insert(deviceCapabilities).values(input.tools.map(toolName => ({ userId, deviceId: device!.id, toolName })));
      return { deviceId: device!.id, capabilities: describeDeviceCapabilities(input.tools) };
    });
  }

  async pending(userId: string, deviceId: string) {
    const [device] = await this.db.update(devices).set({ lastSeenAt: new Date() }).where(and(eq(devices.userId, userId), eq(devices.id, deviceId))).returning({ id: devices.id });
    if (!device) throw missing();
    const rows = await this.db.select({ dispatch: deviceDispatches, tool: toolInvocations }).from(deviceDispatches)
      .innerJoin(toolInvocations, eq(toolInvocations.id, deviceDispatches.invocationId))
      .innerJoin(deviceCapabilities, and(eq(deviceCapabilities.deviceId, deviceDispatches.deviceId), eq(deviceCapabilities.userId, deviceDispatches.userId), eq(deviceCapabilities.toolName, toolInvocations.toolName)))
      .innerJoin(runtimeSubmissions, eq(runtimeSubmissions.id, deviceDispatches.submissionId))
      .where(and(eq(deviceDispatches.userId, userId), eq(deviceDispatches.deviceId, deviceId), inArray(deviceDispatches.status, ['pending', 'claimed']),
        sql`${deviceDispatches.expiresAt} > now()`, eq(runtimeSubmissions.cancelRequested, false), inArray(runtimeSubmissions.status, ['running', 'waiting_device']), isNull(toolInvocations.result)))
      .orderBy(asc(deviceDispatches.createdAt)).limit(100);
    return { invocations: rows.map(({ dispatch, tool }) => ({ invocationId: tool.id, toolCallId: tool.callId, deviceId, expiresAt: dispatch.expiresAt.toISOString(), toolName: tool.toolName, input: tool.arguments })) };
  }

  private async locked<T>(userId: string, invocationId: string, deviceId: string, action: (tx: Transaction, row: typeof deviceDispatches.$inferSelect, submission: typeof runtimeSubmissions.$inferSelect) => Promise<T>) {
    return this.db.transaction(async tx => {
      const [candidate] = await tx.select().from(deviceDispatches).where(and(eq(deviceDispatches.userId, userId), eq(deviceDispatches.invocationId, invocationId), eq(deviceDispatches.deviceId, deviceId)));
      if (!candidate) throw missing();
      // All runtime/device mutations lock submission before invocation/dispatch.
      const [submission] = await tx.select().from(runtimeSubmissions).where(and(eq(runtimeSubmissions.userId, userId), eq(runtimeSubmissions.id, candidate.submissionId))).for('update');
      const [row] = await tx.select().from(deviceDispatches).where(eq(deviceDispatches.id, candidate.id)).for('update');
      if (!submission || !row) throw missing();
      return action(tx, row, submission);
    });
  }

  private available(row: typeof deviceDispatches.$inferSelect, submission: typeof runtimeSubmissions.$inferSelect) {
    if (submission.cancelRequested || submission.status === 'cancelled' || row.status === 'cancelled') throw new ServiceError(410, 'invocation_cancelled', 'Device invocation was cancelled');
    if (row.status === 'revoked') throw new ServiceError(410, 'permission_revoked', 'This device capability was disconnected');
    if (terminal(submission.status) || row.expiresAt.getTime() <= Date.now() || row.status === 'expired' || row.status === 'result_saved') throw new ServiceError(410, 'invocation_expired', 'Device invocation is no longer pending');
  }

  private async requireCapability(tx: Transaction, row: typeof deviceDispatches.$inferSelect) {
    // Registration updates this device before replacing capabilities. The shared row
    // lock orders receipt acceptance against a completed disconnect transaction.
    await tx.select({ id: devices.id }).from(devices).where(eq(devices.id, row.deviceId)).for('share');
    const [allowed] = await tx.select({ name: deviceCapabilities.toolName }).from(toolInvocations)
      .innerJoin(deviceCapabilities, and(eq(deviceCapabilities.deviceId, row.deviceId), eq(deviceCapabilities.userId, row.userId), eq(deviceCapabilities.toolName, toolInvocations.toolName)))
      .where(eq(toolInvocations.id, row.invocationId)).limit(1);
    if (!allowed) throw new ServiceError(410, 'permission_revoked', 'This device capability was disconnected');
  }

  async claim(userId: string, invocationId: string, deviceId: string) {
    return this.locked(userId, invocationId, deviceId, async (tx, row, submission) => {
      this.available(row, submission);
      await this.requireCapability(tx, row);
      const executionId = row.executionId ?? randomUUID();
      if (!row.executionId) {
        await tx.update(deviceDispatches).set({ executionId, status: 'claimed', claimedAt: new Date() }).where(eq(deviceDispatches.id, row.id));
        await tx.update(toolInvocations).set({ status: 'running', updatedAt: new Date() }).where(eq(toolInvocations.id, invocationId));
      }
      return { executionId, expiresAt: row.expiresAt.toISOString() };
    });
  }

  async result(userId: string, invocationId: string, input: DeviceResult) {
    if (typeof input.success !== 'boolean' || (input.success ? !('output' in input) || input.error !== undefined : input.output !== undefined || typeof input.error !== 'string' || !input.error.trim() || input.error.length > 4096)) throw new ServiceError(400, 'invalid_request', 'Tool results need either success with output or failure with error');
    jsonValue(input.success ? input.output : input.error);
    const result = input.success ? { ok: true, data: input.output } : { ok: false, error: { code: 'device_tool_failed', message: input.error } };
    const resultHash = deviceHash(result);
    return this.locked(userId, invocationId, input.deviceId, async (tx, row, submission) => {
      if (!row.executionId) throw new ServiceError(409, 'invocation_not_claimed', 'Claim this invocation before returning a result');
      if (row.executionId !== input.executionId) throw new ServiceError(409, 'execution_mismatch', 'Execution receipt does not match the claim');
      // Replayed accepted receipts survive deadlines and Turn completion.
      if (row.resultHash) {
        if (row.resultHash !== resultHash) throw new ServiceError(409, 'idempotency_conflict', 'Invocation already has a different result');
        return { accepted: true, duplicate: true };
      }
      this.available(row, submission);
      await this.requireCapability(tx, row);
      await tx.update(toolInvocations).set({ result, status: 'result_saved', updatedAt: new Date() }).where(eq(toolInvocations.id, invocationId));
      await tx.update(deviceDispatches).set({ status: 'result_saved', resultHash, completedAt: new Date() }).where(eq(deviceDispatches.id, row.id));
      return { accepted: true, duplicate: false };
    });
  }
}
