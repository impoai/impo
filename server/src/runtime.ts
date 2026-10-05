import { clientActionToolRegistry } from './tools/client-actions.js';
import { catalogInstructions } from './commerce/catalog.js';
import { catalogToolRegistry } from './tools/catalog-tools.js';
import { modelModes } from './model-modes.js';
import { ScheduledTaskRepository } from './db/repositories/scheduled-task-repository.js';
import { scheduledTaskToolRegistry } from './tools/scheduled-task-tools.js';
import { ServiceError } from './errors.js';
import type { loadConfig } from './config.js';
import type { Database } from './db/client.js';
import { RuntimeRepository } from './db/repositories/runtime-repository.js';
import { rebyteSandbox } from '@rebyteai/agent-sdk';
import { RebyteRepository } from './db/repositories/rebyte-repository.js';
import { RebyteGateway } from './rebyte/gateway.js';
import { mainInstructions, taskInstructions, promptVersion, mainPromptVersion } from './prompts/index.js';
import { deviceTools } from './tools/device-tools.js';
import { connectorToolRegistry } from './tools/connector-tools.js';
import { taskToolRegistry } from './tools/task-tools.js';
import { ToolRegistry } from './tools/registry.js';
import { ConnectorService } from './composio/connector-service.js';
import { ConnectorRepository } from './db/repositories/connector-repository.js';
import { memoryToolRegistry, type MemoryReader } from './tools/memory-tools.js';
import { GadgetGateway } from './gadgets/gateway.js';
import { gadgetInstructions, gadgetToolRegistry } from './tools/gadget-tools.js';

export function createRuntimeRepository(db: Database, config: ReturnType<typeof loadConfig>, options: { memories?: MemoryReader } = {}): RuntimeRepository | RebyteRepository {
  if (!config.rebyte) return new RuntimeRepository(db);
  const connectors = config.composio ? connectorToolRegistry(new ConnectorService(new ConnectorRepository(db), config.composio)) : undefined;
  // instant_create_task needs the repository, which needs this registry: close over it and assign below.
  let repository!: RebyteRepository;
  const task = taskToolRegistry({ createTask: (userId, goal, invocationId, fileIds) => repository.createTask(userId, goal, invocationId, fileIds) });
  const memory = memoryToolRegistry(options.memories, (userId, invocationId) => repository.isMainConversationInvocation(userId, invocationId));
  const scheduling = config.temporal ? scheduledTaskToolRegistry(async (userId, invocationId, input) => {
    if (!await repository.isMainConversationInvocation(userId, invocationId)) throw new ServiceError(403, 'main_chat_required', 'Create schedules from the main chat.');
    return new ScheduledTaskRepository(db, repository.runtime).create(userId, invocationId, input);
  }) : undefined;
  const catalog = catalogToolRegistry();
  // A gadget route is the account's identity-provider subject; local fixture identities have none.
  const gadgets = config.gadgetGatewayAdmin ? gadgetToolRegistry(new GadgetGateway(config.gadgetGatewayAdmin), userId => repository.identitySubject(userId, 'clerk')) : undefined;
  const serverTools = ToolRegistry.merge(...(connectors ? [connectors] : []), task, memory, clientActionToolRegistry(), catalog, ...(gadgets ? [gadgets] : []), ...(scheduling ? [scheduling] : []));
  // Each Session gets a Rebyte Sandbox (shell, files, patches) with network access, plus live web search.
  // These are the full catalogs; each user's Session receives only the tools currently usable for them.
  const environment = rebyteSandbox({ network: { access: 'enabled' } });
  const webSearch = { type: 'web_search', context_size: 'medium', mode: 'live' };
  const agentConfig = {
    provider: 'rebyte', model: config.rebyte.model, baseURL: config.rebyte.baseURL, instructions: `${mainInstructions}\n\n${catalogInstructions}${gadgets ? `\n\n${gadgetInstructions}` : ''}`, promptVersion: mainPromptVersion, useSavedAgent: true,
    environment, tools: [...deviceTools, ...serverTools.functionDefinitions(), webSearch],
  };
  // A task never gets device Function tools (it may run with no foreground device) or
  // instant_create_task itself (no recursive task creation); connected apps stay available.
  const taskAgentConfig = {
    provider: 'rebyte', model: config.rebyte.model, baseURL: config.rebyte.baseURL, instructions: `${taskInstructions}\n\n${catalogInstructions}`, promptVersion, useSavedAgent: false,
    environment, tools: [...(connectors ? connectors.functionDefinitions() : []), ...catalog.functionDefinitions(), webSearch],
  };
  repository = new RebyteRepository(db, { provider: 'rebyte', modelModes, serverTools, deviceToolTimeoutMs: config.deviceToolTimeoutMs, agentConfig, taskAgentConfig, history: new RebyteGateway(config.rebyte) });
  return repository;
}
