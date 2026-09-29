import type { Database } from '../db/client.js';
import type { loadConfig } from '../config.js';
import { DevelopmentEmbedder, GeminiEmbedder } from './embedder.js';
import { LocalFileProvider, TursoProvider } from './provider.js';
import { MemoryStore } from './store.js';

export function createMemoryStore(db: Database, config: ReturnType<typeof loadConfig>['memory']): MemoryStore | undefined {
  if (!config) return undefined;
  if ('localDirectory' in config) return new MemoryStore(db, new LocalFileProvider(config.localDirectory!), new DevelopmentEmbedder());
  return new MemoryStore(db, new TursoProvider(config.turso!), new GeminiEmbedder(config.embedding!));
}
