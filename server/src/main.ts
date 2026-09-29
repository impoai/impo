import { createFixtureServer } from './server.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
const server = createFixtureServer();
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listening address');
  console.log(JSON.stringify({ event: 'listening', mode: 'fixture', url: `http://127.0.0.1:${address.port}/api/v1` }));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
