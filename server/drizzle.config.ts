import { defineConfig } from 'drizzle-kit';
import { loadDatabaseUrl } from './src/config.js';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Direct schema push is only available for local development');
}

const authMode = process.env.INSTANT_AUTH_MODE === 'clerk' ? 'clerk' : 'local-dev';
const databaseUrl = loadDatabaseUrl(authMode);
// The { url } credential shape has no ssl field; only the discrete host/port/... shape does,
// and that shape requires a password even when the local trust-auth database has none.
const url = new URL(databaseUrl);
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  dbCredentials: authMode === 'clerk' ? {
    host: url.hostname, port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: url.pathname.slice(1), ssl: { rejectUnauthorized: false },
  } : { url: databaseUrl },
});
