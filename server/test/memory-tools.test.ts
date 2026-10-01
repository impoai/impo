import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryToolRegistry, MEMORY_SEARCH_TOOL } from '../src/tools/memory-tools.js';
import { composePrompt, promptVersion, mainPromptVersion } from '../src/prompts/index.js';

const context = () => ({ userId: 'owned-user', invocationId: 'owned-call', signal: new AbortController().signal });
const tool = (store: Parameters<typeof memoryToolRegistry>[0], authorize = async () => true) => memoryToolRegistry(store, authorize).get(MEMORY_SEARCH_TOOL, 1);

test('memory lookup takes its owner from the invocation and rejects model-supplied identity', async () => {
  const calls: unknown[] = [];
  const lookup = tool({ exists: async userId => { calls.push(userId); return true; }, search: async (userId, query, limit) => {
    calls.push({ userId, query, limit });
    return [{ id: 'm1', content: 'Prefers tea', categories: ['food'], sourceIds: ['chat:a'], createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', expiresAt: null, distance: 0.1 }];
  } });
  for (const input of [{ query: 'tea', userId: 'someone-else' }, { query: '' }, { query: '\0' }, { query: 'tea', limit: 13 }, { query: 'tea', limit: 1.5 }]) assert.throws(() => lookup.validate(input));
  const result = await lookup.execute(lookup.validate({ query: ' tea ' }), context());
  assert.deepEqual(calls, ['owned-user', { userId: 'owned-user', query: 'tea', limit: 8 }]);
  assert.equal(result.ok, true); assert.ok(!JSON.stringify(result).includes('distance'));
});

test('new users return no memories without provisioning, and task callers cannot reach storage', async () => {
  let reads = 0;
  const store = { exists: async () => { reads++; return false; }, search: async () => { assert.fail('No search without an existing database'); } };
  const result = await tool(store).execute({ query: 'hello', limit: 8 }, context());
  assert.deepEqual(result, { ok: true, data: { source: 'impo.memory', memories: [] } });
  const denied = await tool(store, async () => false).execute({ query: 'hello', limit: 8 }, context());
  assert.equal(denied.ok, false); assert.equal(reads, 1);
});

test('unconfigured, failed and timed-out retrieval produce a safe result so chat can continue', async () => {
  const input = { query: 'tea', limit: 8 };
  const missing = await tool(undefined).execute(input, context());
  assert.equal(missing.ok, false);
  const failed = await tool({ exists: async () => { throw Error('secret-provider-credential'); }, search: async () => [] }).execute(input, context());
  assert.deepEqual(failed, missing); assert.ok(!JSON.stringify(failed).includes('secret-provider'));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 10);
  try {
    const result = await tool({ exists: () => new Promise(() => {}), search: async () => [] }).execute(input, { ...context(), signal: controller.signal });
    assert.deepEqual(result, missing);
  } finally { clearTimeout(timeout); }
  controller.abort();
  await assert.rejects(tool(undefined).execute(input, { ...context(), signal: AbortSignal.abort() }));
});

test('memory-first instruction is scoped to main chat, with task prompt versions unchanged', () => {
  assert.match(composePrompt('main'), /Start every user turn with impo_search_memory before answering or using other tools/);
  assert.ok(!composePrompt('task').includes(MEMORY_SEARCH_TOOL));
  assert.ok(!composePrompt('scheduled-task').includes(MEMORY_SEARCH_TOOL));
  assert.equal(promptVersion, 'impo.v3'); assert.equal(mainPromptVersion, 'impo.main.v4');
});
