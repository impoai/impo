import { asc, eq, gt } from 'drizzle-orm';
import type { Database } from '../client.js';
import { users } from '../schema.js';

export interface BackgroundUsers {
  list(after?: string, limit?: number): Promise<Array<{ id: string }>>;
  exists(userId: string): Promise<boolean>;
}
export class BackgroundUserRepository implements BackgroundUsers {
  constructor(private readonly db: Database) {}
  async list(after?: string, limit = 100) {
    return this.db.select({ id: users.id }).from(users).where(after ? gt(users.id, after) : undefined)
      .orderBy(asc(users.id)).limit(limit);
  }
  async exists(userId: string) {
    return (await this.db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)).length > 0;
  }
}
