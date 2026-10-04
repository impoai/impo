// Impo gadget gateway: the cloud end of the open-source gadget link protocol.
// Gadgets fetch their route, then hold a WebSocket to a per-account Durable
// Object. The Impo server manages pairings and invokes gadget commands through
// the admin routes.

import {
  DEVICE_TOKEN_TTL_S, REFRESH_TOKEN_TTL_S, VM_TOKEN_TTL_S, secretsEqual, signToken, verifyToken,
} from './tokens.mjs';

import { homePage } from './home.mjs';

export { DeviceHub } from './device-hub.mjs';

const VM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function bearer(request) {
  const header = request.headers.get('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

function hub(env, vmId) {
  return env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(vmId));
}

async function pairingActive(env, claims) {
  if (!claims || !VM_ID.test(claims.vm ?? '')) return false;
  return (await hub(env, claims.vm).fetch(`https://hub/pairings/${claims.pid}`)).ok;
}

async function deviceTokens(env, claims) {
  const identity = { vm: claims.vm, pid: claims.pid };
  return {
    access_token: await signToken(env.TOKEN_SECRET, 'device', identity, DEVICE_TOKEN_TTL_S),
    refresh_token: await signToken(env.TOKEN_SECRET, 'refresh', identity, REFRESH_TOKEN_TTL_S),
  };
}

// -- Device routes ------------------------------------------------------------

async function fetchVms(request, env, url) {
  const claims = await verifyToken(env.TOKEN_SECRET, 'device', bearer(request));
  if (!(await pairingActive(env, claims))) return json({ error: 'unauthorized' }, 401);
  return json({
    vm_list: [{
      vm_id: claims.vm,
      vm_name: claims.vm,
      vm_ws_url: `wss://${url.host}`,
      vm_auth_token: await signToken(env.TOKEN_SECRET, 'vm', { vm: claims.vm, pid: claims.pid }, VM_TOKEN_TTL_S),
      default: true,
    }],
  });
}

async function refreshDeviceToken(request, env) {
  // Sent as "Bearer hatch_refresh:<token>".
  const claims = await verifyToken(env.TOKEN_SECRET, 'refresh', bearer(request).split(':').pop());
  if (!(await pairingActive(env, claims))) return json({ error: 'unauthorized' }, 401);
  return json(await deviceTokens(env, claims));
}

async function openNoise(request, env, url) {
  if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'upgrade_required' }, 426);
  const claims = await verifyToken(env.TOKEN_SECRET, 'vm', bearer(request));
  if (!claims || claims.vm !== url.searchParams.get('vm_id') || !VM_ID.test(claims.vm)) {
    return json({ error: 'unauthorized' }, 401);
  }
  return hub(env, claims.vm).fetch(new Request(`https://hub/connect?pairing=${claims.pid}`, request));
}

// -- Admin routes (Impo server only) --------------------------------------------

async function admin(request, env, url, segments) {
  if (!env.ADMIN_TOKEN || !(await secretsEqual(bearer(request), env.ADMIN_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  const [, , vmId, resource, resourceId] = segments;
  if (segments[1] !== 'vms' || !VM_ID.test(vmId ?? '')) return json({ error: 'not_found' }, 404);
  const stub = hub(env, vmId);

  if (!resource && request.method === 'GET') return stub.fetch('https://hub/state');
  if (resource === 'invoke' && request.method === 'POST') {
    return stub.fetch('https://hub/invoke', { method: 'POST', body: await request.text() });
  }
  if (resource === 'replies' && request.method === 'POST') {
    return stub.fetch('https://hub/replies', { method: 'POST', body: await request.text() });
  }
  if (resource === 'pairings' && !resourceId && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const created = await stub.fetch('https://hub/pairings', { method: 'POST', body: JSON.stringify({ label: body.label }) });
    const { pairing_id: pairingId } = await created.json();
    // `pairing` is exactly the record a gadget stores after setup.
    return json({
      vm_id: vmId,
      pairing_id: pairingId,
      pairing: {
        ...await deviceTokens(env, { vm: vmId, pid: pairingId }),
        token_type: 'device',
        api_url_v2: url.origin,
        noise_host: url.host,
        access_token_saved_at: Math.floor(Date.now() / 1000),
      },
    }, 201);
  }
  if (resource === 'pairings' && resourceId && request.method === 'DELETE') {
    return stub.fetch(`https://hub/pairings/${resourceId}`, { method: 'DELETE' });
  }
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    if (!env.TOKEN_SECRET) return json({ error: 'not_configured' }, 503);
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /') return homePage();
    if (route === 'GET /health') return json({ ok: true });
    if (route === 'GET /fetch_vms') return fetchVms(request, env, url);
    if (route === 'POST /device_token/refresh') return refreshDeviceToken(request, env);
    if (route === 'GET /v1/noise') return openNoise(request, env, url);
    if (segments[0] === 'admin') return admin(request, env, url, segments);
    return json({ error: 'not_found' }, 404);
  },
};
