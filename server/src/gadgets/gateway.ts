import { ServiceError } from '../errors.js';

/** What a gadget stores during setup to reach its account through the gateway. */
export interface GadgetPairing {
  pairingId: string;
  accessToken: string;
  refreshToken: string;
  apiURL: string;
  noiseHost: string;
}

export interface Gadget {
  pairingId: string;
  nodeId: string;
  name: string;
  platform: string | null;
  version: string | null;
  online: boolean;
}

/** One command a gadget registered, as its firmware describes it. */
export interface GadgetCommand {
  name: string;
  description: string;
  required: Record<string, unknown>;
  optional: Record<string, unknown>;
}

/** Lets the agent see and drive one account's gadgets. */
export interface GadgetControl {
  commands(subject: string): Promise<(Gadget & { commands: GadgetCommand[] })[]>;
  invoke(subject: string, nodeId: string, command: string, params: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; payload?: unknown; error?: string }>;
}

/**
 * Commands the agent may not run: they replace firmware, run a shell or unpair,
 * and a model that read hostile text must not be able to reach them.
 */
const withheld = (command: string) => /^(device\.ota|device\.unpair|system\.|link\.)/.test(command);

export interface GadgetAPI {
  list(subject: string): Promise<{ gadgets: Gadget[] }>;
  pair(subject: string, name?: string): Promise<GadgetPairing>;
  unpair(subject: string, pairingId: string): Promise<void>;
}

/** A pairing no gadget registered with is an abandoned setup once it is this old. */
const abandonedAfterMs = 60 * 60_000;

/**
 * Manages one account's gadgets on the gadget gateway (server/gadget-gateway).
 * The account's identity-provider subject is its gateway route, so a caller can
 * only ever reach the route of the session it authenticated.
 */
export class GadgetGateway implements GadgetAPI, GadgetControl {
  constructor(private readonly config: { url: string; adminToken: string; timeoutMs?: number }, private readonly fetcher: typeof fetch = fetch) {}

  private async request(subject: string, suffix: string, init: RequestInit = {}, timeoutMs = this.config.timeoutMs ?? 10_000): Promise<Response> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(subject)) throw new ServiceError(400, 'invalid_request', 'Invalid account subject');
    try {
      return await this.fetcher(`${this.config.url}/admin/vms/${subject}${suffix}`, {
        ...init, headers: { Authorization: `Bearer ${this.config.adminToken}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ServiceError(503, 'gadgets_unavailable', 'Gadgets are temporarily unavailable.', true);
    }
  }

  private async state(subject: string): Promise<{ pairings: { pairing_id: string; created_at: number; label?: string | null }[]; devices: Record<string, unknown>[] }> {
    const response = await this.request(subject, '');
    if (!response.ok) throw new ServiceError(503, 'gadgets_unavailable', 'Gadgets are temporarily unavailable.', true);
    return await response.json() as { pairings: { pairing_id: string; created_at: number; label?: string | null }[]; devices: Record<string, unknown>[] };
  }

  async commands(subject: string): Promise<(Gadget & { commands: GadgetCommand[] })[]> {
    return this.registered((await this.state(subject)).devices);
  }

  private registered(devices: Record<string, unknown>[]): (Gadget & { commands: GadgetCommand[] })[] {
    const text = (value: unknown) => typeof value === 'string' && value ? value : null;
    const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return devices.flatMap(device => {
      const pairingId = text(device.pairing_id), nodeId = text(device.node_id);
      if (!pairingId || !nodeId) return [];
      const commands = Object.entries(object(device.commands)).filter(([name]) => !withheld(name)).map(([name, spec]) => ({
        name, description: text(object(spec).description) ?? '', required: object(object(spec).required), optional: object(object(spec).optional),
      }));
      return [{ pairingId, nodeId, name: text(device.display_name) ?? nodeId, platform: text(device.platform), version: text(device.version), online: device.online === true, commands }];
    });
  }

  async list(subject: string): Promise<{ gadgets: Gadget[] }> {
    const { pairings, devices } = await this.state(subject);
    const gadgets: Gadget[] = this.registered(devices).map(({ commands: _, ...gadget }) => gadget);
    // A gadget that was given a pairing but has not reached the gateway yet must still be
    // listed, or its owner could never remove it. It has no node id until it registers.
    const seen = new Set(gadgets.map(gadget => gadget.pairingId));
    for (const pairing of pairings) {
      if (!seen.has(pairing.pairing_id)) gadgets.push({ pairingId: pairing.pairing_id, nodeId: '', name: pairing.label || 'Gadget', platform: null, version: null, online: false });
    }
    return { gadgets };
  }

  async invoke(subject: string, nodeId: string, command: string, params: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; payload?: unknown; error?: string }> {
    if (withheld(command)) throw new ServiceError(403, 'gadget_command_not_allowed', 'This gadget command is not available to the agent.');
    const response = await this.request(subject, '/invoke', { method: 'POST', body: JSON.stringify({ node_id: nodeId, command, params, timeout_ms: timeoutMs }) }, timeoutMs + 10_000);
    const result = await response.json().catch(() => undefined) as { ok?: unknown; payload?: unknown; error?: unknown } | undefined;
    if (!result || typeof result !== 'object') throw new ServiceError(503, 'gadgets_unavailable', 'Gadgets are temporarily unavailable.', true);
    return { ok: result.ok === true, ...(result.payload !== undefined ? { payload: result.payload } : {}), ...(typeof result.error === 'string' ? { error: result.error } : {}) };
  }

  async pair(subject: string, name?: string): Promise<GadgetPairing> {
    // Setups that never finished leave working credentials behind; retire them before issuing more.
    const { pairings, devices } = await this.state(subject);
    const used = new Set(devices.map(device => device.pairing_id));
    for (const pairing of pairings) {
      if (!used.has(pairing.pairing_id) && Date.now() - pairing.created_at > abandonedAfterMs) await this.unpair(subject, pairing.pairing_id).catch(() => {});
    }
    const response = await this.request(subject, '/pairings', { method: 'POST', body: JSON.stringify(name ? { label: name } : {}) });
    const created = response.ok ? await response.json() as { pairing_id?: string; pairing?: Record<string, unknown> } : undefined;
    const record = created?.pairing;
    if (!created?.pairing_id || typeof record?.access_token !== 'string' || typeof record.refresh_token !== 'string'
      || typeof record.api_url_v2 !== 'string' || typeof record.noise_host !== 'string') {
      throw new ServiceError(503, 'gadgets_unavailable', 'Gadgets are temporarily unavailable.', true);
    }
    return { pairingId: created.pairing_id, accessToken: record.access_token, refreshToken: record.refresh_token, apiURL: record.api_url_v2, noiseHost: record.noise_host };
  }

  async unpair(subject: string, pairingId: string): Promise<void> {
    const response = await this.request(subject, `/pairings/${pairingId}`, { method: 'DELETE' });
    if (response.status === 404) throw new ServiceError(404, 'not_found', 'Gadget not found');
    if (!response.ok) throw new ServiceError(503, 'gadgets_unavailable', 'Gadgets are temporarily unavailable.', true);
  }
}
