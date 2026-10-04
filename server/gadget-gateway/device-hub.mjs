// One Durable Object per account route ("vm_id"). It terminates the gadgets'
// long-lived WebSockets with the hibernation API, so an idle connection costs
// no compute, and relays invocations between the Impo server and each gadget.

import { DurableObject } from 'cloudflare:workers';
import { CipherState, NoiseResponder } from './noise.mjs';
import {
  ControlMessageDecoder, NoiseFrameDecoder, decodeDeviceFrame, encodeBodyChunk,
  encodeControlMessage, encodeNoiseFrames, encodeResponse,
} from './proto.mjs';
import { fromBase64Url, toBase64Url } from './tokens.mjs';

const CONTROL_PATH = '/link-control';
const CHAT_PATH = '/chat/stream';
const SUBSCRIBE_PATH = '/chat/subscribe';
const IDENTITY_PATH = '/identity';
const AGENT_NAME = 'Impo';
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;
const MAX_INVOKE_WAIT_MS = 620_000;
const MAX_CHAT_BODY_BYTES = 256 * 1024;
const CHAT_HISTORY = 50;
const MAX_REPLY_CHARS = 16_000;
const encoder = new TextEncoder();

const json = (body, status = 200) => Response.json(body, { status });

// In-memory view of one gadget connection. Everything needed after the object
// hibernates lives in the WebSocket attachment; reassembly buffers do not, so
// a message split across a hibernation is dropped.
class Connection {
  frames = new NoiseFrameDecoder();
  control = new ControlMessageDecoder();
  chatBodies = new Map();
  receiving = Promise.resolve();
  sending = Promise.resolve();
  handshake = null;

  constructor(ws) {
    this.ws = ws;
    const saved = ws.deserializeAttachment() ?? {};
    this.pairingId = saved.pairingId;
    this.connectedAt = saved.connectedAt;
    this.nodeId = saved.nodeId ?? null;
    this.controlStream = saved.controlStream ?? null;
    this.subscribeStream = saved.subscribeStream ?? null;
    this.send = saved.send ? new CipherState(fromBase64Url(saved.send[0]), saved.send[1]) : null;
    this.recv = saved.recv ? new CipherState(fromBase64Url(saved.recv[0]), saved.recv[1]) : null;
  }

  persist() {
    const cipher = (state) => state && [toBase64Url(state.rawKey), state.nonce];
    this.ws.serializeAttachment({
      pairingId: this.pairingId,
      connectedAt: this.connectedAt,
      nodeId: this.nodeId,
      controlStream: this.controlStream,
      subscribeStream: this.subscribeStream,
      send: cipher(this.send),
      recv: cipher(this.recv),
    });
  }

  // Ciphertexts must leave in nonce order, so sends are serialized.
  sendEnvelope(envelope) {
    this.sending = this.sending.then(async () => {
      for (const frame of encodeNoiseFrames(envelope)) {
        this.ws.send(await this.send.encrypt(frame));
        this.persist();
      }
    });
    return this.sending;
  }

  sendControl(message) {
    return this.sendEnvelope(encodeBodyChunk(this.controlStream, encodeControlMessage(message)));
  }
}

export class DeviceHub extends DurableObject {
  connections = new Map();
  invokes = new Map();

  async fetch(request) {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'connect') return this.connect(request, url.searchParams.get('pairing'));
    if (segments[0] === 'pairings' && request.method === 'POST') return this.createPairing(await request.json());
    if (segments[0] === 'pairings' && request.method === 'GET') {
      return (await this.ctx.storage.get(`pairing:${segments[1]}`)) ? json({ active: true }) : json({ active: false }, 404);
    }
    if (segments[0] === 'pairings' && request.method === 'DELETE') return this.deletePairing(segments[1]);
    if (segments[0] === 'state') return this.state();
    if (segments[0] === 'invoke' && request.method === 'POST') return this.invoke(await request.json());
    if (segments[0] === 'replies' && request.method === 'POST') return this.reply(await request.json());
    return json({ error: 'not_found' }, 404);
  }

  // -- Pairings ---------------------------------------------------------------

  async createPairing({ label }) {
    const pairingId = crypto.randomUUID();
    await this.ctx.storage.put(`pairing:${pairingId}`, { createdAt: Date.now(), label: label ?? null });
    return json({ pairing_id: pairingId });
  }

  async deletePairing(pairingId) {
    if (!(await this.ctx.storage.delete(`pairing:${pairingId}`))) return json({ error: 'not_found' }, 404);
    for (const [key, device] of await this.ctx.storage.list({ prefix: 'device:' })) {
      if (device.pairingId === pairingId) await this.ctx.storage.delete(key);
    }
    for (const connection of this.live()) {
      if (connection.pairingId !== pairingId) continue;
      if (connection.controlStream !== null && connection.send) {
        await connection.sendControl({ type: 'evt', event: 'link.unpaired' }).catch(() => {});
      }
      connection.ws.close(1000, 'unpaired');
    }
    return json({ ok: true });
  }

  async state() {
    const online = new Map(this.live().filter((c) => c.nodeId).map((c) => [c.nodeId, c]));
    const pairings = [...await this.ctx.storage.list({ prefix: 'pairing:' })].map(
      ([key, value]) => ({ pairing_id: key.slice('pairing:'.length), created_at: value.createdAt, label: value.label }),
    );
    const devices = [...await this.ctx.storage.list({ prefix: 'device:' })].map(([, device]) => ({
      node_id: device.params.node_id,
      pairing_id: device.pairingId,
      online: online.has(device.params.node_id),
      connected_at: online.get(device.params.node_id)?.connectedAt ?? null,
      registered_at: device.registeredAt,
      display_name: device.params.display_name,
      platform: device.params.platform,
      version: device.params.version,
      commands: device.params.commands_v2 ?? {},
    }));
    return json({ pairings, devices, chat: (await this.ctx.storage.get('chat')) ?? [] });
  }

  // -- Invocation ---------------------------------------------------------------

  async invoke({ node_id: nodeId, command, params, timeout_ms: timeoutMs }) {
    if (typeof command !== 'string' || !command) return json({ ok: false, error: 'command_required' }, 400);
    const targets = this.live().filter((c) => c.nodeId && c.controlStream !== null && (!nodeId || c.nodeId === nodeId));
    if (!targets.length) return json({ ok: false, error: 'device_offline' }, 409);
    if (targets.length > 1) return json({ ok: false, error: 'node_id_required' }, 409);
    const [connection] = targets;
    const id = crypto.randomUUID();
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_INVOKE_TIMEOUT_MS;
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), Math.min(budget + 5000, MAX_INVOKE_WAIT_MS));
      this.invokes.set(id, { connection, resolve: (value) => { clearTimeout(timer); resolve(value); } });
      connection.sendControl({ method: 'link.invoke', id, command, params: params ?? {}, timeout_ms: budget })
        .catch(() => resolve({ ok: false, error: 'device_disconnected' }));
    });
    this.invokes.delete(id);
    const { method: _method, id: _id, ...outcome } = result;
    return json({ node_id: connection.nodeId, ...outcome });
  }

  // -- Replies ------------------------------------------------------------------

  // Delivers one assistant message to every gadget subscribed on this route, as
  // the reply events the gadget firmware reads from POST /chat/subscribe.
  async reply({ text, reply_to_message_id: replyTo, message_id: messageId }) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_REPLY_CHARS) {
      return json({ ok: false, error: 'text_required' }, 400);
    }
    const subscribers = this.live().filter((c) => c.subscribeStream !== null && c.send);
    if (!subscribers.length) return json({ ok: false, error: 'no_subscriber' }, 409);
    const id = typeof messageId === 'string' && messageId ? messageId : crypto.randomUUID();
    let seq = (await this.ctx.storage.get('reply_seq')) ?? 0;
    const pieces = text.match(/[\s\S]{1,400}/gu);
    const events = [
      ['delta.message_start', { message_id: id, reply_to_message_id: replyTo ?? null }],
      ...pieces.map((piece) => ['delta.text_append', { message_id: id, text: piece }]),
      ['delta.message_done', { message_id: id, display_text: text }],
    ].map(([event, payload]) => `${JSON.stringify({ type: 'event', seq: (seq += 1), event, payload })}\n`);
    await this.ctx.storage.put('reply_seq', seq);
    const body = encoder.encode(events.join(''));
    let delivered = 0;
    for (const connection of subscribers) {
      try {
        await connection.sendEnvelope(encodeBodyChunk(connection.subscribeStream, body));
        delivered += 1;
      } catch {
        // That gadget went away; the others still get the reply.
      }
    }
    return json({ ok: delivered > 0, message_id: id, delivered });
  }

  // -- WebSocket lifecycle ------------------------------------------------------

  async connect(request, pairingId) {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'upgrade_required' }, 426);
    if (!pairingId || !(await this.ctx.storage.get(`pairing:${pairingId}`))) return json({ error: 'unpaired' }, 401);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pairingId, connectedAt: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  connection(ws) {
    let connection = this.connections.get(ws);
    if (!connection) {
      connection = new Connection(ws);
      this.connections.set(ws, connection);
    }
    return connection;
  }

  live() {
    return this.ctx.getWebSockets().map((ws) => this.connection(ws));
  }

  async webSocketMessage(ws, message) {
    if (typeof message === 'string') return;
    const connection = this.connection(ws);
    connection.receiving = connection.receiving.then(() => this.receive(connection, new Uint8Array(message)));
    try {
      await connection.receiving;
    } catch (error) {
      console.error('gadget link error', error?.message ?? error);
      this.drop(connection);
      ws.close(1011, 'protocol error');
    }
  }

  async webSocketClose(ws, code) {
    this.drop(this.connection(ws));
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed');
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws) {
    this.drop(this.connection(ws));
  }

  drop(connection) {
    this.connections.delete(connection.ws);
    for (const invoke of this.invokes.values()) {
      if (invoke.connection === connection) invoke.resolve({ ok: false, error: 'device_disconnected' });
    }
  }

  // -- Inbound frames -----------------------------------------------------------

  async receive(connection, bytes) {
    if (!connection.recv) {
      if (!connection.handshake) {
        connection.handshake = new NoiseResponder();
        connection.ws.send(await connection.handshake.readMessage1AndWriteMessage2(bytes));
        return;
      }
      Object.assign(connection, await connection.handshake.readMessage3(bytes));
      connection.handshake = null;
      connection.persist();
      return;
    }
    const plain = await connection.recv.decrypt(bytes);
    connection.persist();
    const assembled = connection.frames.decode(plain);
    if (!assembled) return;
    const frame = decodeDeviceFrame(assembled);
    if (frame.kind === 'request') return this.onRequest(connection, frame.streamId, frame.value);
    if (frame.kind === 'body_chunk') return this.onBody(connection, frame.streamId, frame.value.data, frame.value.endBody);
    if (frame.kind === 'reset' && frame.streamId === connection.controlStream) connection.ws.close(1000, 'control reset');
  }

  async onRequest(connection, streamId, request) {
    const path = request.path.split('?')[0];
    if (request.verb === 'GET' && path === IDENTITY_PATH) {
      // Firmware with a screen shows this as the agent's name.
      const body = encoder.encode(JSON.stringify({ ok: true, result: { name: AGENT_NAME } }));
      return connection.sendEnvelope(encodeResponse(streamId, { status: 200, body, endBody: true }));
    }
    if (request.verb === 'POST' && path === SUBSCRIBE_PATH) {
      // Stays open; reply() writes NDJSON reply events to it.
      connection.subscribeStream = streamId;
      connection.persist();
      return connection.sendEnvelope(encodeResponse(streamId, { status: 200 }));
    }
    if (request.verb === 'POST' && path === CONTROL_PATH) {
      connection.controlStream = streamId;
      connection.persist();
      await connection.sendEnvelope(encodeResponse(streamId, { status: 200 }));
      return this.onBody(connection, streamId, request.body, request.endBody);
    }
    // Firmware with a screen chats on a second connection that never registers.
    if (request.verb === 'POST' && path === CHAT_PATH) {
      connection.chatBodies.set(streamId, []);
      return this.onBody(connection, streamId, request.body, request.endBody);
    }
    return connection.sendEnvelope(encodeResponse(streamId, { status: 404, endBody: true }));
  }

  async onBody(connection, streamId, data, endBody) {
    if (streamId === connection.controlStream) {
      for (const message of connection.control.feed(data)) await this.onControl(connection, message);
      if (endBody) connection.ws.close(1000, 'control ended');
      return;
    }
    const chunks = connection.chatBodies.get(streamId);
    if (!chunks) return;
    chunks.push(data);
    if (chunks.reduce((total, chunk) => total + chunk.length, 0) > MAX_CHAT_BODY_BYTES) {
      connection.chatBodies.delete(streamId);
      await connection.sendEnvelope(encodeResponse(streamId, { status: 413, endBody: true }));
    } else if (endBody) {
      connection.chatBodies.delete(streamId);
      await this.onChat(connection, streamId, new Blob(chunks));
    }
  }

  async onControl(connection, message) {
    if (message.method === 'link.register') {
      const params = message.params;
      if (!params || typeof params.node_id !== 'string' || !/^[\w.:-]{1,128}$/.test(params.node_id)) {
        return connection.sendControl({ type: 'res', id: message.id, ok: false, error: 'invalid_node_id' });
      }
      // A reconnect replaces the gadget's previous socket.
      for (const other of this.live()) {
        if (other !== connection && other.nodeId === params.node_id) {
          this.drop(other);
          other.ws.close(1000, 'replaced');
        }
      }
      connection.nodeId = params.node_id;
      connection.persist();
      await this.ctx.storage.put(`device:${params.node_id}`, {
        params, registeredAt: Date.now(), pairingId: connection.pairingId,
      });
      return connection.sendControl({ type: 'res', id: message.id, ok: true });
    }
    if (message.method === 'link.result') this.invokes.get(message.id)?.resolve(message);
  }

  async onChat(connection, streamId, blob) {
    let body;
    try {
      body = JSON.parse(await blob.text());
    } catch {
      body = null;
    }
    if (!body || typeof body.message !== 'string' || !body.message.trim()) {
      return connection.sendEnvelope(encodeResponse(streamId, { status: 400, endBody: true }));
    }
    const messageId = crypto.randomUUID();
    const history = (await this.ctx.storage.get('chat')) ?? [];
    history.push({
      message_id: messageId, at: Date.now(),
      node_id: connection.nodeId ?? (typeof body.device_id === 'string' ? body.device_id : null),
      session_id: typeof body.session_id === 'string' ? body.session_id : null, message: body.message,
    });
    await this.ctx.storage.put('chat', history.slice(-CHAT_HISTORY));
    return connection.sendEnvelope(encodeResponse(streamId, {
      status: 200, body: encoder.encode(JSON.stringify({ message_id: messageId })), endBody: true,
    }));
  }
}
