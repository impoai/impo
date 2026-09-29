import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type Database = NodePgDatabase;

// Encrypts the connection for a real remote database; loopback local dev has no such requirement.
// rejectUnauthorized is off because RDS's CA is not in Node's default trust store; this still encrypts in transit.
export function createDatabase(url: string, options: { ssl?: boolean } = {}) {
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: url, max: 10, ssl: options.ssl ? { rejectUnauthorized: false } : undefined });
  const db = drizzle({ client: pool });
  return { db, pool, close: () => pool.end() };
}

export type DatabaseConnection = ReturnType<typeof createDatabase>;
