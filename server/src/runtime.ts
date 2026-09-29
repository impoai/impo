import type { loadConfig } from './config.js';
import type { Database } from './db/client.js';
import { RuntimeRepository } from './persistence/runtime-repository.js';
import { rebyteSandbox } from '@rebyteai/agent-sdk';
import { RebyteRepository } from './persistence/rebyte-repository.js';
import { RebyteGateway } from './rebyte/gateway.js';
import { mainInstructions, taskInstructions, promptVersion } from './prompts/index.js';
import { deviceTools } from './tools/device-tools.js';
import { gmailToolRegistry } from './tools/gmail-tools.js';
import { taskToolRegistry } from './tools/task-tools.js';
import { ToolRegistry } from './tools/registry.js';
import { GmailConnectorService } from './composio/gmail-service.js';

export function createRuntimeRepository(db: Database, config: ReturnType<typeof loadConfig>): RuntimeRepository | RebyteRepository {
  if (!config.rebyte) return new RuntimeRepository(db);
  const gmail = config.composio ? gmailToolRegistry(new GmailConnectorService(db, config.composio)) : undefined;
  // instant_create_task needs the repository, which needs this registry: close over it and assign below.
  let repository!: RebyteRepository;
  const task = taskToolRegistry({ createTask: (userId, goal, invocationId) => repository.createTask(userId, goal, invocationId) });
  const serverTools = gmail ? ToolRegistry.merge(gmail, task) : task;
  // Each Session gets a Rebyte Sandbox (shell, files, patches) with network access, plus live web search.
  // These are the full catalogs; each user's Session receives only the tools currently usable for them.
  const environment = rebyteSandbox({ network: { access: 'enabled' } });
  const webSearch = { type: 'web_search', context_size: 'medium', mode: 'live' };
  const agentConfig = {
    provider: 'rebyte', model: config.rebyte.model, baseURL: config.rebyte.baseURL, instructions: mainInstructions, promptVersion, useSavedAgent: true,
    environment, tools: [...deviceTools, ...serverTools.functionDefinitions(), webSearch],
  };
  // A task never gets device Function tools (it may run with no foreground device) or
  // instant_create_task itself (no recursive task creation); Gmail stays available.
  const taskAgentConfig = {
    provider: 'rebyte', model: config.rebyte.model, baseURL: config.rebyte.baseURL, instructions: taskInstructions, promptVersion, useSavedAgent: false,
    environment, tools: [...(gmail ? gmail.functionDefinitions() : []), webSearch],
  };
  repository = new RebyteRepository(db, { provider: 'rebyte', serverTools, deviceToolTimeoutMs: config.deviceToolTimeoutMs, agentConfig, taskAgentConfig, history: new RebyteGateway(config.rebyte) });
  return repository;
}
