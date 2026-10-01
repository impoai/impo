import { MemoryDatabaseRepository } from '../db/repositories/memory-database-repository.js';
import type { Database } from '../db/client.js';
import type { loadConfig } from '../config.js';
import { DevelopmentEmbedder, GeminiEmbedder } from './embedder.js';
import { LocalFileProvider, TursoProvider } from './provider.js';
import { MemoryStore } from './store.js';

export function createMemoryStore(db: Database, config: ReturnType<typeof loadConfig>['memory']): MemoryStore | undefined {
  if (!config) return undefined;
  const embedder = 'localDirectory' in config ? new DevelopmentEmbedder() : new GeminiEmbedder(config.embedding!);
  const provider = 'localDirectory' in config ? new LocalFileProvider(config.localDirectory!) : new TursoProvider(config.turso!);
  return new MemoryStore(new MemoryDatabaseRepository(db, provider, embedder), embedder);
}
