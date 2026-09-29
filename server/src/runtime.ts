import type { loadConfig } from './config.js';
import type { Database } from './db/client.js';
import { RuntimeRepository } from './persistence/runtime-repository.js';
import { rebyteSandbox } from '@rebyteai/agent-sdk';
import { RebyteRepository } from './persistence/rebyte-repository.js';
import { RebyteGateway } from './rebyte/gateway.js';
import { mainInstructions, taskInstructions, promptVersion, mainPromptVersion } from './prompts/index.js';
import { deviceTools } from './tools/device-tools.js';
import { connectorToolRegistry } from './tools/connector-tools.js';
import { taskToolRegistry } from './tools/task-tools.js';
import { ToolRegistry } from './tools/registry.js';
import { ConnectorService } from './composio/connector-service.js';
import { memoryToolRegistry, type MemoryReader } from './tools/memory-tools.js';
import { and, eq } from 'drizzle-orm';
import { conversations, runtimeSubmissions, toolInvocations } from './db/schema.js';

export function createRuntimeRepository(db: Database, config: ReturnType<typeof loadConfig>, options: { memories?: MemoryReader } = {}): RuntimeRepository | RebyteRepository {
  if (!config.rebyte) return new RuntimeRepository(db);
  const connectors = config.composio ? connectorToolRegistry(new ConnectorService(db, config.composio)) : undefined;
  // instant_create_task needs the repository, which needs this registry: close over it and assign below.
  let repository!: RebyteRepository;
  const task = taskToolRegistry({ createTask: (userId, goal, invocationId) => repository.createTask(userId, goal, invocationId) });
  const memory = memoryToolRegistry(options.memories, async (userId, invocationId) => {
    const [caller] = await db.select({ kind: conversations.kind }).from(toolInvocations)
      .innerJoin(runtimeSubmissions, eq(runtimeSubmissions.id, toolInvocations.submissionId))
      .innerJoin(conversations, eq(conversations.id, runtimeSubmissions.conversationId))
      .where(and(eq(toolInvocations.id, invocationId), eq(toolInvocations.userId, userId), eq(conversations.userId, userId)));
    return caller?.kind === 'main';
  });
  const serverTools = ToolRegistry.merge(...(connectors ? [connectors] : []), task, memory);
  // Each Session gets a Rebyte Sandbox (shell, files, patches) with network access, plus live web search.
  // These are the full catalogs; each user's Session receives only the tools currently usable for them.
  const environment = rebyteSandbox({ network: { access: 'enabled' } });
  const webSearch = { type: 'web_search', context_size: 'medium', mode: 'live' };
  const agentConfig = {
    provider: 'rebyte', model: config.rebyte.model, baseURL: config.rebyte.baseURL, instructions: mainInstructions, promptVersion: mainPromptVersion, useSavedAgent: true,
    environment, tools: [...deviceTools, ...serverTools.functionDefinitions(), webSearch],
  };
  // A task never gets device Function tools (it may run with no foreground device) or
  // instant_create_task itself (no recursive task creation); connected apps stay available.
  const taskAgentConfig = {
    provider: 'rebyte', model: config.rebyte.model, baseURL: config.rebyte.baseURL, instructions: taskInstructions, promptVersion, useSavedAgent: false,
    environment, tools: [...(connectors ? connectors.functionDefinitions() : []), webSearch],
  };
  repository = new RebyteRepository(db, { provider: 'rebyte', serverTools, deviceToolTimeoutMs: config.deviceToolTimeoutMs, agentConfig, taskAgentConfig, history: new RebyteGateway(config.rebyte) });
  return repository;
}
