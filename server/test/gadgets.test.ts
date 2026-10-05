import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { GadgetGateway, type GadgetAPI } from '../src/gadgets/gateway.js';
import { createApiServer, type ApiRepository } from '../src/http/api-server.js';
import { gadgetToolRegistry } from '../src/tools/gadget-tools.js';

const pairingId = '0b0e5a52-6f0e-4d0c-9d50-6f7f6a1d2c11';
const pairing = { pairingId, accessToken: 'access', refreshToken: 'refresh', apiURL: 'https://gadgets.example', noiseHost: 'gadgets.example' };

async function listen(t: TestContext, gadgets?: GadgetAPI) {
  const repository = { findUser: async (subject: string) => ({ id: `user-${subject}` }) } as unknown as ApiRepository;
  const server = createApiServer(repository, { gadgets });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const alice = { Authorization: 'Bearer instant-dev-alice', 'Content-Type': 'application/json' };

test('gadget routes act on the signed-in account only', async t => {
  const calls: unknown[][] = [];
  const base = await listen(t, {
    list: async subject => { calls.push(['list', subject]); return { gadgets: [] }; },
    pair: async (subject, name) => { calls.push(['pair', subject, name]); return pairing; },
    unpair: async (subject, id) => { calls.push(['unpair', subject, id]); },
  });
  const created = await fetch(`${base}/api/v1/gadgets/pairings`, { method: 'POST', headers: alice, body: '{"name":"ImpoGadget-1"}' });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await created.json(), pairing);
  assert.equal((await fetch(`${base}/api/v1/gadgets`, { headers: alice })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/gadgets/pairings/${pairingId}`, { method: 'DELETE', headers: alice })).status, 200);
  assert.deepEqual(calls, [['pair', 'alice', 'ImpoGadget-1'], ['list', 'alice'], ['unpair', 'alice', pairingId]]);

  assert.equal((await fetch(`${base}/api/v1/gadgets/pairings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/gadgets/pairings`, { method: 'POST', headers: alice, body: '{"subject":"bob"}' })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/gadgets/pairings/not-an-id`, { method: 'DELETE', headers: alice })).status, 400);
  assert.equal(calls.length, 3);
});

test('gadget routes are unavailable without a gateway', async t => {
  const base = await listen(t);
  assert.equal((await fetch(`${base}/api/v1/gadgets`, { headers: alice })).status, 503);
});

function gateway(state: { pairings: { pairing_id: string; created_at: number; label?: string }[]; devices: Record<string, unknown>[] }) {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET';
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer admin-token');
    requests.push(`${method} ${new URL(url).pathname}`);
    if (method === 'GET') return Response.json(state);
    if (method === 'DELETE') return Response.json({ ok: true }, { status: url.endsWith('/missing') ? 404 : 200 });
    return Response.json({ vm_id: 'user_a', pairing_id: pairingId, pairing: { access_token: 'access', refresh_token: 'refresh', token_type: 'device', api_url_v2: 'https://gadgets.example', noise_host: 'gadgets.example' } }, { status: 201 });
  }) as typeof fetch;
  return { requests, client: new GadgetGateway({ url: 'https://gadgets.example', adminToken: 'admin-token' }, fetcher) };
}

test('the gateway client issues a pairing and retires abandoned ones', async () => {
  const { client, requests } = gateway({
    pairings: [
      { pairing_id: 'in-use', created_at: 0 },
      { pairing_id: 'abandoned', created_at: 0 },
      { pairing_id: 'in-progress', created_at: Date.now(), label: 'Kitchen' },
    ],
    devices: [{ node_id: 'homelink-1', pairing_id: 'in-use', online: true, display_name: 'Desk', platform: 'esp32', version: '1.2.3' }],
  });
  assert.deepEqual(await client.pair('user_a'), pairing);
  assert.deepEqual(requests, ['GET /admin/vms/user_a', 'DELETE /admin/vms/user_a/pairings/abandoned', 'POST /admin/vms/user_a/pairings']);
  // Pairings no gadget has registered with stay listed so they can be removed; the agent never sees them.
  assert.deepEqual(await client.list('user_a'), { gadgets: [
    { pairingId: 'in-use', nodeId: 'homelink-1', name: 'Desk', platform: 'esp32', version: '1.2.3', online: true },
    { pairingId: 'abandoned', nodeId: '', name: 'Gadget', platform: null, version: null, online: false },
    { pairingId: 'in-progress', nodeId: '', name: 'Kitchen', platform: null, version: null, online: false },
  ] });
  assert.deepEqual((await client.commands('user_a')).map(gadget => gadget.nodeId), ['homelink-1']);
});

test('the gateway client rejects bad subjects and reports missing gadgets', async () => {
  const { client, requests } = gateway({ pairings: [], devices: [] });
  await assert.rejects(client.list('../other'), { status: 400 });
  assert.deepEqual(requests, []);
  await assert.rejects(client.unpair('user_a', 'missing'), { status: 404 });
});

const sparkbot = { pairingId, nodeId: 'homelink-1', name: 'Desk', platform: 'esp32', version: '1.2.3', online: true,
  commands: [{ name: 'display.show_text', description: 'Show text', required: { text: { type: 'string' } }, optional: {} }] };

function tools(gadgets: (typeof sparkbot)[] = [sparkbot]) {
  const calls: unknown[][] = [];
  const registry = gadgetToolRegistry({
    commands: async subject => { calls.push(['commands', subject]); return gadgets; },
    invoke: async (...args) => { calls.push(['invoke', ...args]); return { ok: true, payload: { shown: true } }; },
  }, async userId => userId === 'user-1' ? 'user_a' : undefined);
  const run = (name: string, input: unknown, userId = 'user-1') => {
    const tool = registry.get(name, 1);
    return tool.execute(tool.validate(input), { userId, invocationId: 'i1', signal: new AbortController().signal });
  };
  return { calls, run, registry };
}

test('the agent lists gadgets and runs a listed command on the owner\'s route', async () => {
  const { calls, run } = tools();
  assert.deepEqual(await run('impo_list_gadgets', {}), { ok: true, data: { gadgets: [{ gadget_id: 'homelink-1', name: 'Desk', platform: 'esp32', version: '1.2.3', online: true, commands: sparkbot.commands }] } });
  assert.deepEqual(await run('impo_gadget_command', { gadget_id: 'homelink-1', command: 'display.show_text', params: { text: 'hi' } }),
    { ok: true, data: { gadget: 'Desk', command: 'display.show_text', result: { shown: true } } });
  assert.deepEqual(calls.at(-1), ['invoke', 'user_a', 'homelink-1', 'display.show_text', { text: 'hi' }, 30_000]);
});

test('the agent cannot run unlisted commands, reach offline gadgets or act without an account subject', async () => {
  const { calls, run, registry } = tools([{ ...sparkbot, online: false }]);
  const code = async (input: unknown, userId?: string) => { const result = await run('impo_gadget_command', input, userId); return result.ok ? 'ok' : result.error.code; };
  assert.equal(await code({ gadget_id: 'homelink-1', command: 'device.ota', params: { url: 'https://x.example/fw.bin' } }), 'gadget_command_unknown');
  assert.equal(await code({ gadget_id: 'someone-else', command: 'display.show_text' }), 'gadget_not_found');
  assert.equal(await code({ gadget_id: 'homelink-1', command: 'display.show_text' }), 'gadget_offline');
  await assert.rejects(run('impo_list_gadgets', {}, 'user-2'), { status: 422 });
  assert.throws(() => registry.get('impo_gadget_command', 1).validate({ gadget_id: 'homelink-1', command: 'x', route: 'user_b' }), { status: 422 });
  assert.equal(calls.some(call => call[0] === 'invoke'), false);
});

test('the gateway client hides and refuses firmware, shell and unpair commands', async () => {
  const { client, requests } = gateway({ pairings: [], devices: [{ node_id: 'homelink-1', pairing_id: 'p', online: true,
    commands: { 'speaker.beep': { description: 'Beep', required: {}, optional: {} }, 'device.ota': { description: 'Flash' }, 'system.run': { description: 'Shell' } } }] });
  assert.deepEqual((await client.commands('user_a'))[0]!.commands.map(command => command.name), ['speaker.beep']);
  await assert.rejects(client.invoke('user_a', 'homelink-1', 'system.run', { cmd: 'id' }, 1000), { status: 403 });
  assert.deepEqual(requests, ['GET /admin/vms/user_a']);
});
