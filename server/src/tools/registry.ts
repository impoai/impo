import { ServiceError } from '../errors.js';

export type ToolFamily = 'device' | 'external' | 'internal';
export interface ToolContext { userId: string; invocationId: string; signal: AbortSignal }
export type ToolResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string; retryable: boolean } };
export interface ToolDefinition {
  name: string;
  version: number;
  family: ToolFamily;
  executionLocation: 'server' | 'device';
  description: string;
  parameters: Record<string, unknown>;
  timeoutMs: number;
  retry: 'read-only' | 'transactional' | 'never';
  validate(input: unknown): Record<string, unknown>;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/** Immutable code catalog; no user identity, credentials or execution state. */
export class ToolRegistry {
  private readonly definitions: readonly ToolDefinition[];
  constructor(definitions: readonly ToolDefinition[]) {
    if (new Set(definitions.map(tool => tool.name)).size !== definitions.length) throw new Error('Duplicate tool name');
    this.definitions = [...definitions];
  }
  get(name: string, version: number): ToolDefinition {
    const definition = this.definitions.find(tool => tool.name === name && tool.version === version);
    if (!definition) throw new ServiceError(422, 'unsupported_tool', 'Tool version is not available');
    return definition;
  }
  static merge(...registries: ToolRegistry[]): ToolRegistry {
    return new ToolRegistry(registries.flatMap(registry => registry.definitions));
  }
  functionDefinitions() {
    return this.definitions.map(tool => ({ type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.parameters }));
  }
}

/** Deterministic server-side tool for persistence qualification, not an AI agent. */
export function developmentToolRegistry(): ToolRegistry {
  return new ToolRegistry([{
    name: 'instant_dev_echo', version: 1, family: 'internal', executionLocation: 'server',
    description: 'Echo text to verify the local durable execution path.',
    parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 32768 } }, required: ['text'], additionalProperties: false },
    timeoutMs: 1000, retry: 'read-only',
    validate(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !('text' in input) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 32768) {
        throw new ServiceError(422, 'invalid_tool_arguments', 'Echo expects a nonempty text field');
      }
      return { text: input.text };
    },
    async execute(input, context) {
      context.signal.throwIfAborted();
      return { ok: true, data: { echo: input.text } };
    },
  }]);
}
