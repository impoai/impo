import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { messages, todaySettings, userProfiles } from '../schema.js';
import { ServiceError } from '../../errors.js';
import type { JsonObject } from '../../http/request.js';

import { isModelMode, type ModelMode } from '../../model-modes.js';

export interface Profile { mode: ModelMode; onboarded: boolean; displayName?: string; assistantName?: string; avatarIndex?: number }
const invalid = (message: string) => new ServiceError(400, 'invalid_request', message);

export class ProfileRepository {
  constructor(private readonly db: Database) {}

  /** Accounts created before profiles existed count as onboarded once they have chatted. */
  async get(userId: string): Promise<Profile> {
    const [profile] = await this.db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
    const [settings] = await this.db.select({ displayName: todaySettings.displayName }).from(todaySettings).where(eq(todaySettings.userId, userId));
    let onboarded = Boolean(profile?.onboardedAt);
    if (!onboarded) {
      const [chatted] = await this.db.select({ one: sql<number>`1` }).from(messages).where(and(eq(messages.userId, userId), eq(messages.role, 'user'))).limit(1);
      onboarded = Boolean(chatted);
    }
    return {
      onboarded, mode: profile?.mode ?? 'Balanced',
      ...(settings?.displayName ? { displayName: settings.displayName } : {}),
      ...(profile?.assistantName ? { assistantName: profile.assistantName } : {}),
      ...(profile?.avatarIndex !== null && profile?.avatarIndex !== undefined ? { avatarIndex: profile.avatarIndex } : {}),
    };
  }

  /** Partial update. `onboarded` can only become true. */
  async update(userId: string, input: JsonObject): Promise<Profile> {
    if (Object.keys(input).some(key => !['assistantName', 'avatarIndex', 'onboarded', 'mode'].includes(key))) throw invalid('Unsupported profile field');
    const changes: Partial<typeof userProfiles.$inferInsert> = {};
    if (input.mode !== undefined) {
      if (!isModelMode(input.mode)) throw invalid('mode must be Balanced or Power');
      changes.mode = input.mode;
    }
    if (input.assistantName !== undefined) {
      if (typeof input.assistantName !== 'string') throw invalid('assistantName must be a string');
      const name = input.assistantName.trim();
      if (!name || name.length > 30 || name.includes('\0')) throw invalid('assistantName must be 1 to 30 characters');
      changes.assistantName = name;
    }
    if (input.avatarIndex !== undefined) {
      if (!Number.isInteger(input.avatarIndex) || (input.avatarIndex as number) < 0 || (input.avatarIndex as number) > 6) throw invalid('avatarIndex must be 0 to 6');
      changes.avatarIndex = input.avatarIndex as number;
    }
    if (input.onboarded !== undefined) {
      if (input.onboarded !== true) throw invalid('onboarded can only be set to true');
      changes.onboardedAt = new Date();
    }
    if (Object.keys(changes).length) {
      const onConflict = { ...changes, updatedAt: new Date() };
      // Keep the first completion time.
      if (onConflict.onboardedAt) onConflict.onboardedAt = sql`coalesce(${userProfiles.onboardedAt}, now())` as unknown as Date;
      await this.db.insert(userProfiles).values({ userId, ...changes }).onConflictDoUpdate({ target: userProfiles.userId, set: onConflict });
    }
    return this.get(userId);
  }
}
