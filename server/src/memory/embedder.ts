import { createHash } from 'node:crypto';
import { ServiceError } from '../errors.js';

export type EmbeddingPurpose = 'document' | 'query';
export interface Embedder {
  /** Stored in each memory database; vectors from different models are not comparable. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], purpose: EmbeddingPurpose, signal?: AbortSignal): Promise<number[][]>;
}

function normalize(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return length > 0 ? vector.map(value => value / length) : vector;
}

export interface GeminiEmbedderConfig { apiKey: string; baseURL: string; model: string; dimensions: number; timeoutMs: number }

/** Gemini embeddings; truncated dimensions must be re-normalized for cosine search. */
export class GeminiEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  constructor(private readonly config: GeminiEmbedderConfig) { this.model = config.model; this.dimensions = config.dimensions; }

  async embed(texts: string[], purpose: EmbeddingPurpose, signal?: AbortSignal): Promise<number[][]> {
    if (!texts.length) return [];
    const model = `models/${this.config.model}`;
    const response = await fetch(`${this.config.baseURL}/v1beta/${model}:batchEmbedContents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.config.apiKey },
      body: JSON.stringify({ requests: texts.map(text => ({ model, content: { parts: [{ text }] },
        taskType: purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', outputDimensionality: this.dimensions })) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]) : AbortSignal.timeout(this.config.timeoutMs),
    });
    // Provider bodies can echo input text; never surface them.
    if (!response.ok) throw new ServiceError(502, 'embedding_failed', 'The embedding service is unavailable', response.status >= 500 || response.status === 429);
    const body = await response.json() as { embeddings?: Array<{ values?: unknown }> };
    const vectors = body.embeddings?.map(item => item.values);
    if (!vectors || vectors.length !== texts.length || vectors.some(values => !Array.isArray(values) || values.length !== this.dimensions || values.some(value => typeof value !== 'number' || !Number.isFinite(value)))) {
      throw new ServiceError(502, 'embedding_failed', 'The embedding service returned an invalid response', true);
    }
    return (vectors as number[][]).map(normalize);
  }
}

/** Deterministic hashed bag-of-words: offline development and tests only, not semantic. */
export class DevelopmentEmbedder implements Embedder {
  readonly model = 'development-hash-v1';
  constructor(readonly dimensions = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => {
      const vector = new Array<number>(this.dimensions).fill(0);
      // Latin words, plus single CJK characters so Chinese text also overlaps.
      for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.flatMap(word => /\p{Script=Han}/u.test(word) ? [...word] : [word]) ?? []) {
        const digest = createHash('sha256').update(token).digest();
        vector[digest.readUInt32BE(0) % this.dimensions]! += digest[4]! & 1 ? 1 : -1;
      }
      return normalize(vector);
    });
  }
}
