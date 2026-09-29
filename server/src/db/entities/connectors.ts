import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './chat.js';

/** One row per (user, Composio toolkit). OAuth tokens stay with Composio; Instant stores only owned account/session handles. */
export const connectorConnections = pgTable('connector_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  toolkit: text('toolkit').notNull(),
  generation: uuid('generation').notNull(),
  entityId: text('entity_id').notNull(),
  authConfigId: text('auth_config_id').notNull(),
  status: text('status', { enum: ['disconnected', 'pending', 'connected', 'expired'] }).notNull(),
  connectedAccountId: text('connected_account_id'),
  routerSessionId: text('router_session_id'),
  redirectURL: text('redirect_url'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  email: text('email'),
  disconnectRequested: boolean('disconnect_requested').notNull().default(false),
  operationToken: uuid('operation_token'),
  operationLeaseUntil: timestamp('operation_lease_until', { withTimezone: true }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('connector_connections_user_toolkit_unique').on(table.userId, table.toolkit),
  unique('connector_connections_user_id_unique').on(table.userId, table.id),
  unique('connector_connections_entity_unique').on(table.entityId),
  unique('connector_connections_account_unique').on(table.connectedAccountId),
  unique('connector_connections_router_unique').on(table.routerSessionId),
  // A new name lets Drizzle push replace the former Gmail-only constraint;
  // the pinned Kit version skips changed expressions on same-name checks.
  check('connector_connections_toolkit_slug_check', sql`${table.toolkit} ~ '^[a-z0-9_]{1,64}$'`),
  check('connector_connections_status_check', sql`${table.status} IN ('disconnected', 'pending', 'connected', 'expired')`),
  check('connector_connections_connected_check', sql`${table.status} <> 'connected' OR (${table.connectedAccountId} IS NOT NULL AND ${table.routerSessionId} IS NOT NULL)`),
  check('connector_connections_lease_check', sql`(${table.operationToken} IS NULL) = (${table.operationLeaseUntil} IS NULL)`),
]);
