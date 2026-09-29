import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { JSONRecord } from './fake-rebyte.js';

const authConfigs = [
  { id: 'ac_fake_gmail', name: 'rebyte-dev-gmail', status: 'ENABLED', is_composio_managed: true, toolkit: { slug: 'gmail', logo: 'https://logos.example.test/gmail' } },
  { id: 'ac_fake_googlecalendar', name: 'rebyte-dev-googlecalendar', status: 'ENABLED', is_composio_managed: true, toolkit: { slug: 'googlecalendar' } },
  { id: 'ac_fake_prod_gmail', name: 'rebyte-prod-gmail', status: 'ENABLED', is_composio_managed: true, toolkit: { slug: 'gmail' } },
  { id: 'ac_fake_disabled', name: 'rebyte-dev-notion', status: 'DISABLED', is_composio_managed: true, toolkit: { slug: 'notion' } },
];

/** A synthetic Composio control plane, connector shelf and mailbox. No request leaves loopback. */
export class FakeComposio {
  readonly errors: string[] = [];
  readonly requests: { method: string; path: string; body?: JSONRecord }[] = [];
  readonly accounts = new Map<string, JSONRecord>();
  readonly routers = new Map<string, { entity: string; account: string; toolkit: string }>();
  readonly executions: { router: string; slug: string; args: JSONRecord }[] = [];
  readonly drafts: { id: string; account: string; args: JSONRecord }[] = [];
  readonly links: string[] = [];
  holdNextDraft = false;
  private held: ServerResponse[] = [];
  foreignAccountInNextList?: string;
  readonly server = createServer((request, response) => {
    void this.route(request, response).catch(error => {
      this.errors.push(String(error));
      if (!response.headersSent) this.json(response, 500, { error: 'Invalid test request' });
      else response.destroy();
    });
  });
  async listen() {
    this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening');
    const address = this.server.address(); assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  }
  activate(entity: string, toolkit = 'gmail') {
    assert.ok(this.links.includes(entity));
    const id = `ca_fake_${this.accounts.size + 1}`;
    this.accounts.set(id, { id, user_id: entity, toolkit: { slug: toolkit }, auth_config: { id: `ac_fake_${toolkit}`, is_disabled: false }, status: 'ACTIVE', is_disabled: false });
    return id;
  }
  releaseHeldResponses() {
    for (const response of this.held.splice(0)) if (!response.destroyed) this.json(response, 200, { data: { successful: true }, successful: true });
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
  private json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }
  private async route(request: IncomingMessage, response: ServerResponse) {
    assert.equal(request.headers['x-api-key'], 'instant-fake-composio-key');
    const url = new URL(request.url!, 'http://127.0.0.1');
    let body: JSONRecord | undefined;
    if (request.method === 'POST') {
      let text = ''; for await (const chunk of request) text += chunk.toString(); body = JSON.parse(text || '{}');
    }
    this.requests.push({ method: request.method!, path: url.pathname, body });
    if (url.pathname === '/api/v3.1/auth_configs' && request.method === 'GET') { this.json(response, 200, { items: authConfigs, next_cursor: null }); return; }
    if (url.pathname === '/api/v3.1/toolkits' && request.method === 'GET') {
      this.json(response, 200, { items: [{ slug: 'gmail', name: 'Gmail', meta: { description: 'Synthetic mail', logo: 'https://logos.example.test/gmail' } }, { slug: 'googlecalendar', name: 'Google Calendar', meta: {} }, { slug: 'notion', name: 'Notion', meta: {} }], next_cursor: null }); return;
    }
    if (url.pathname === '/api/v3.1/connected_accounts/link' && request.method === 'POST') {
      assert.ok(['ac_fake_gmail', 'ac_fake_googlecalendar'].includes(body!.auth_config_id)); assert.match(body!.user_id, /^instant:development:[a-f0-9-]+:[a-f0-9-]+$/);
      assert.deepEqual(Object.keys(body!).sort(), ['auth_config_id', 'user_id']);
      this.links.push(body!.user_id); this.json(response, 200, { redirect_url: `https://connect.example.test/oauth/${this.links.length}` }); return;
    }
    if (url.pathname === '/api/v3.1/connected_accounts' && request.method === 'GET') {
      assert.match(url.searchParams.get('auth_config_ids')!, /^ac_fake_(gmail|googlecalendar)$/);
      const foreign = this.foreignAccountInNextList; this.foreignAccountInNextList = undefined;
      const items = foreign ? [{ id: foreign }] : [...this.accounts.values()].filter(account => account.user_id === url.searchParams.get('user_ids')).map(({ id }) => ({ id }));
      this.json(response, 200, { items, next_cursor: null }); return;
    }
    const accountRoute = /^\/api\/v3\.1\/connected_accounts\/([^/]+)(\/revoke)?$/.exec(url.pathname);
    if (accountRoute) {
      const account = this.accounts.get(accountRoute[1]);
      if (!account) { this.json(response, 404, { error: 'missing account' }); return; }
      if (request.method === 'GET') { this.json(response, 200, account); return; }
      if (request.method === 'POST' && accountRoute[2] === '/revoke') { account.status = 'REVOKED'; this.json(response, 200, { success: true }); return; }
      if (request.method === 'DELETE') { this.accounts.delete(account.id); this.json(response, 200, { success: true }); return; }
    }
    if (url.pathname === '/api/v3.1/tool_router/session' && request.method === 'POST') {
      const toolkit = body!.toolkits?.enable?.[0];
      const accountId = body!.connected_accounts?.[toolkit]?.[0];
      const account = this.accounts.get(accountId); assert.ok(account);
      assert.equal(account.user_id, body!.user_id); assert.equal(account.toolkit.slug, toolkit);
      assert.equal(body!.auth_configs?.[toolkit], `ac_fake_${toolkit}`);
      assert.deepEqual(body!.toolkits, { enable: [toolkit] });
      assert.equal(body!.manage_connections.enable, false); assert.equal(body!.workbench.enable, false);
      const id = `router_fake_${this.routers.size + 1}`;
      this.routers.set(id, { entity: body!.user_id, account: accountId, toolkit });
      this.json(response, 200, { session_id: id }); return;
    }
    const routerRoute = /^\/api\/v3\.1\/tool_router\/session\/([^/]+)(\/execute)?$/.exec(url.pathname);
    if (routerRoute) {
      const router = this.routers.get(routerRoute[1]);
      if (!router) { this.json(response, 404, { error: 'missing router' }); return; }
      if (request.method === 'DELETE') { this.routers.delete(routerRoute[1]); this.json(response, 200, { success: true }); return; }
      if (request.method === 'POST' && routerRoute[2] === '/execute') {
        this.executions.push({ router: routerRoute[1], slug: body!.tool_slug, args: body!.arguments });
        const command = body!.arguments.tools?.[0];
        if (command?.tool_slug === 'GMAIL_CREATE_EMAIL_DRAFT') {
          this.drafts.push({ id: `synthetic_draft_${this.drafts.length + 1}`, account: router.account, args: command.arguments });
          if (this.holdNextDraft) { this.holdNextDraft = false; this.held.push(response); return; }
        }
        this.json(response, 200, { successful: true, data: { test_data: true, source: 'synthetic Composio fixture; no real mailbox', marker: 'GMAIL_PROTOCOL_MARKER', tools: [], results: [{ tool_slug: command?.tool_slug ?? 'GMAIL_GET_PROFILE', successful: true, data: { id: this.drafts.at(-1)?.id ?? 'synthetic_message', emailAddress: 'test@example.test', messages: [] } }] } }); return;
      }
    }
    this.json(response, 404, { error: 'unimplemented fixture route' });
  }
}
