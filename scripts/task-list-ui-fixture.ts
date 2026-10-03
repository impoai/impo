/** Loopback-only task loading fixture. Start one instance per native UI test suite. */
import { createServer, request, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createAndroidFixture } from './android-ui-fixture.js';

if (process.env.NODE_ENV === 'production') throw new Error('Local UI tests only');
const port = Number(process.argv[2] ?? 3021);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port');
const upstream = createAndroidFixture();
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
let mode = 'hold';
const pending = new Set<ServerResponse>();
function reply(response: ServerResponse) {
  if (response.destroyed) return;
  const task = { taskId: '11111111-1111-4111-a111-111111111111', conversationId: '22222222-2222-4222-a222-222222222222', title: 'Existing research task', status: 'completed', createdAt: '2026-10-01T08:00:00Z' };
  response.writeHead(mode === 'error' ? 503 : 200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(mode === 'error' ? { error: { code: 'unavailable', message: 'Tasks are temporarily unavailable.' } } : { tasks: mode === 'empty' ? [] : [task] }));
}
const server = createServer((incoming, response) => {
  const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/fixture/tasks') {
    const next = url.searchParams.get('mode');
    if (incoming.method === 'POST' && next && ['hold', 'rows', 'empty', 'error'].includes(next)) {
      mode = next;
      if (mode !== 'hold') { for (const held of pending) reply(held); pending.clear(); }
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode, pending: pending.size }));
  } else if (url.pathname === '/api/v1/tasks' && incoming.method === 'GET') {
    if (mode === 'hold') { pending.add(response); response.once('close', () => pending.delete(response)); }
    else reply(response);
  } else {
    const forwarded = request({ hostname: '127.0.0.1', port: (upstream.address() as AddressInfo).port, path: incoming.url, method: incoming.method, headers: incoming.headers }, result => {
      response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response);
    });
    forwarded.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    incoming.pipe(forwarded);
  }
});
server.listen(port, '127.0.0.1');
await once(server, 'listening');
console.log(JSON.stringify({ event: 'task_list_fixture_ready', port }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close();
});
