/**
 * One-off: remove all stored chat content (main chat and tasks) from PostgreSQL; Rebyte
 * Sessions are the source of conversation history. Only finished runs are touched: a
 * queued or running submission still needs its input, stream and tool receipts.
 * Rows, IDs, ordering, statuses and hashes stay. DRY_RUN=1 counts without writing.
 * Run inside the VPC: node --import tsx src/persistence/purge-chat-text.ts
 */
import { sql } from 'drizzle-orm';
import { databaseRequiresSsl } from '../config.js';
import { createDatabase } from '../db/client.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const dryRun = process.env.DRY_RUN === '1';
const database = createDatabase(url, { ssl: databaseRequiresSsl(url) });

// Messages owned by a submission that has not finished yet.
const activeMessages = sql`SELECT user_message_id FROM runtime_submissions WHERE status IN ('queued','running','waiting_device')
  UNION SELECT assistant_message_id FROM runtime_submissions WHERE status IN ('queued','running','waiting_device')`;
const finished = sql`SELECT id FROM runtime_submissions WHERE status IN ('completed','failed','cancelled')`;
const statements = {
  messages: sql`UPDATE messages SET text = '', parts = '[]'::jsonb, updated_at = now()
    WHERE (text <> '' OR parts <> '[]'::jsonb) AND id NOT IN (${activeMessages})`,
  streamEvents: sql`DELETE FROM product_events WHERE submission_id IN (${finished})`,
  // Keep only the outcome (ok and error code), as finished runs do.
  toolInvocations: sql`UPDATE tool_invocations SET arguments = '{}'::jsonb, updated_at = now(),
    result = CASE WHEN result IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object('ok', result->'ok', 'error', CASE WHEN result ? 'error' THEN jsonb_build_object('code', result->'error'->'code') END)) END
    WHERE submission_id IN (${finished}) AND (arguments <> '{}'::jsonb OR (result IS NOT NULL AND result - 'ok'::text - 'error'::text <> '{}'::jsonb) OR (jsonb_typeof(result->'error') = 'object' AND (result->'error') - 'code'::text <> '{}'::jsonb))`,
  historyContexts: sql`UPDATE session_bindings SET history_context = NULL, updated_at = now()
    WHERE history_context IS NOT NULL AND provider_session_id IS NOT NULL`,
  // The goal is the task's first message; the check constraint requires a non-empty title.
  taskGoals: sql`UPDATE actions SET goal = '…', updated_at = now() WHERE goal <> '…' AND id IN (
    SELECT c.action_id FROM conversations c WHERE c.kind = 'task' AND NOT EXISTS (
      SELECT 1 FROM runtime_submissions s WHERE s.conversation_id = c.id AND s.status IN ('queued','running','waiting_device')))`,
};

try {
  const counts: Record<string, number> = {};
  await database.db.transaction(async tx => {
    for (const [name, statement] of Object.entries(statements)) counts[name] = (await tx.execute(statement)).rowCount ?? 0;
    if (dryRun) tx.rollback();
  }).catch(error => { if (!(dryRun && error?.constructor?.name === 'TransactionRollbackError')) throw error; });
  console.log(JSON.stringify({ event: 'chat_text_purge_done', dryRun, ...counts }));
} finally { await database.close(); }
