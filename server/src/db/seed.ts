import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from './client.js';
import { agentConfigVersions, users } from './schema.js';
import { loadDatabaseUrl } from '../config.js';

export const DEVELOPMENT_USERS = {
  alice: { id: '00000000-0000-4000-8000-000000000001', authProvider: 'local-dev', authSubject: 'alice', name: 'Alice' },
  bob: { id: '00000000-0000-4000-8000-000000000002', authProvider: 'local-dev', authSubject: 'bob', name: 'Bob' },
} as const;
export const DEVELOPMENT_AGENT_CONFIG_ID = '00000000-0000-4000-8000-000000000100';
export const DEVELOPMENT_AGENT_CONFIG = {
  provider: 'development',
  name: 'Instant deterministic development runtime',
  tools: ['instant_dev_echo'],
  version: 1,
} as const;

// Idempotent seeds only. Tokens remain in the local-development identity adapter.
export async function seedDevelopment(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    for (const user of Object.values(DEVELOPMENT_USERS)) {
      await tx.insert(users).values(user).onConflictDoNothing();
      const [existing] = await tx.select().from(users).where(eq(users.id, user.id));
      if (!existing || existing.authProvider !== user.authProvider || existing.authSubject !== user.authSubject) {
        throw new Error(`Development identity collision: ${user.authSubject}`);
      }
    }
    const config = DEVELOPMENT_AGENT_CONFIG;
    const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    await tx.insert(agentConfigVersions).values({ id: DEVELOPMENT_AGENT_CONFIG_ID, version: 1, hash, config }).onConflictDoNothing();
    const [existing] = await tx.select().from(agentConfigVersions).where(eq(agentConfigVersions.id, DEVELOPMENT_AGENT_CONFIG_ID));
    if (!existing || existing.hash !== hash) throw new Error('Development Agent configuration collision');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // This seeds fixed local-dev fixture identities; it must never touch a real deployment's database.
  const connection = createDatabase(loadDatabaseUrl('local-dev'));
  try {
    await seedDevelopment(connection.db);
    console.log('Instant development users and runtime configuration seeded.');
  } finally {
    await connection.close();
  }
}
