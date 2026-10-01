/**
 * One-off: remove all stored chat content (main chat and tasks) from PostgreSQL; Rebyte
 * Sessions are the source of conversation history. Only finished runs are touched: a
 * queued or running submission still needs its input, stream and tool receipts.
 * Rows, IDs, ordering, statuses and hashes stay. DRY_RUN=1 counts without writing.
 * Run inside the VPC: node --import tsx src/persistence/purge-chat-text.ts
 */
import { MaintenanceRepository } from '../db/repositories/maintenance-repository.js';
import { databaseRequiresSsl } from '../config.js';
import { createDatabase } from '../db/client.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const dryRun = process.env.DRY_RUN === '1';
const database = createDatabase(url, { ssl: databaseRequiresSsl(url) });

try {
  const counts = await new MaintenanceRepository(database.db).purgeChatText(dryRun);
  console.log(JSON.stringify({ event: 'chat_text_purge_done', dryRun, ...counts }));
} finally { await database.close(); }
