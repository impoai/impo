import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client.js';
import { listeningBatches, listeningSegments } from '../schema.js';
import { echoSourceId } from '../../listening/speakers.js';

/** Only the current, explicitly confirmed revision can support a personal memory. */
export class EchoSourceRepository {
  constructor(private readonly db: Database) {}
  async valid(userId: string, sourceIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(sourceIds.flatMap(source => {
      const match = /^echo:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):v[1-9][0-9]*$/i.exec(source);
      return match ? [match[1]!] : [];
    }))];
    const valid = new Set<string>();
    for (let start = 0; start < ids.length; start += 500) {
      for (const table of [listeningBatches, listeningSegments]) {
        const rows = await this.db.select({ id: table.id, review: table.speakerReview }).from(table)
          .where(and(eq(table.userId, userId), eq(table.status, 'transcribed'), inArray(table.id, ids.slice(start, start + 500))));
        for (const row of rows) if (row.review.status === 'confirmed' && row.review.selfSpeakerIds.length) valid.add(echoSourceId(row.id, row.review));
      }
    }
    return new Set(sourceIds.filter(source => valid.has(source)));
  }
}
