import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { connectorConnections, users } from '../db/schema.js';
import { ServiceError } from '../errors.js';

export type ConnectorConnection = typeof connectorConnections.$inferSelect;
type ConnectionChanges = Partial<Omit<typeof connectorConnections.$inferInsert, 'id' | 'userId' | 'toolkit' | 'createdAt'>>;
const owned = (userId: string) => and(eq(connectorConnections.userId, userId), eq(connectorConnections.toolkit, 'gmail'));

/** Short transactions fence OAuth control-plane operations without holding locks over HTTP. */
export class ConnectorRepository {
  constructor(private readonly db: Database) {}

  async get(userId: string): Promise<ConnectorConnection | undefined> {
    return (await this.db.select().from(connectorConnections).where(owned(userId)))[0];
  }

  /** Persist the new identity before any provider operation, then reserve its control lease. */
  async reserve(userId: string, authConfigId: string): Promise<ConnectorConnection> {
    return this.db.transaction(async tx => {
      const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      if (!user) throw new ServiceError(404, 'not_found', 'User not found');
      let [connection] = await tx.select().from(connectorConnections).where(owned(userId)).for('update');
      if (!connection) {
        const generation = randomUUID();
        [connection] = await tx.insert(connectorConnections).values({ userId, generation, entityId: `instant:development:${userId}:${generation}`, authConfigId, status: 'disconnected' }).returning();
      }
      if (connection!.operationLeaseUntil && connection!.operationLeaseUntil.getTime() > Date.now()) throw new ServiceError(409, 'connector_busy', 'A Gmail connection operation is already in progress', true);
      const [reserved] = await tx.update(connectorConnections).set({ operationToken: randomUUID(), operationLeaseUntil: sql`clock_timestamp() + interval '5 minutes'`, updatedAt: new Date() }).where(eq(connectorConnections.id, connection!.id)).returning();
      return reserved!;
    });
  }

  async update(connection: ConnectorConnection, changes: ConnectionChanges): Promise<ConnectorConnection> {
    const [updated] = await this.db.update(connectorConnections).set({ ...changes, updatedAt: new Date() }).where(and(eq(connectorConnections.id, connection.id), eq(connectorConnections.userId, connection.userId), eq(connectorConnections.operationToken, connection.operationToken!), sql`${connectorConnections.operationLeaseUntil} > clock_timestamp()`)).returning();
    if (!updated) throw new ServiceError(409, 'connector_operation_expired', 'Retry the Gmail connection operation', true);
    return updated;
  }

  async release(connection: ConnectorConnection): Promise<void> {
    await this.db.update(connectorConnections).set({ operationToken: null, operationLeaseUntil: null }).where(and(eq(connectorConnections.id, connection.id), eq(connectorConnections.operationToken, connection.operationToken!)));
  }

  /** An execution must keep the same connection generation; never substitute another account. */
  async assertCurrent(connection: ConnectorConnection): Promise<void> {
    const current = await this.get(connection.userId);
    if (!current || current.id !== connection.id || current.generation !== connection.generation || current.status !== 'connected' || current.disconnectRequested || current.connectedAccountId !== connection.connectedAccountId || current.routerSessionId !== connection.routerSessionId) throw new ServiceError(409, 'gmail_connection_required', 'Connect Gmail before using its tools');
  }

  async expire(connection: ConnectorConnection): Promise<void> {
    await this.db.update(connectorConnections).set({ status: 'expired', updatedAt: new Date() }).where(and(eq(connectorConnections.id, connection.id), eq(connectorConnections.generation, connection.generation), eq(connectorConnections.status, 'connected')));
  }
}
