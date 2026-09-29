import { ServiceError } from '../errors.js';
import type { ToolContext, ToolRegistry, ToolResult } from './registry.js';

/** Execute an already-authorized durable invocation; the repository owns receipts. */
export async function dispatchTool(registry: ToolRegistry, invocation: {
  userId: string; id: string; toolName: string; toolVersion: number; arguments: unknown;
}, signal: AbortSignal): Promise<ToolResult> {
  try {
    const tool = registry.get(invocation.toolName, invocation.toolVersion);
    if (tool.executionLocation !== 'server') throw new ServiceError(422, 'device_dispatch_not_implemented', 'Device tools are not part of stage 1A');
    const input = tool.validate(invocation.arguments);
    const context: ToolContext = { userId: invocation.userId, invocationId: invocation.id, signal: AbortSignal.any([signal, AbortSignal.timeout(tool.timeoutMs)]) };
    return await tool.execute(input, context);
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ServiceError) return { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable } };
    throw error;
  }
}
