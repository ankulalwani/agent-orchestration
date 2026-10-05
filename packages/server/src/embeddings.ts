import { AppError } from '@ao/core';
import type { ServerConfig } from './config.js';

export type EmbeddingsConfig = Partial<Pick<ServerConfig, 'EMBEDDINGS_URL' | 'EMBEDDINGS_API_KEY' | 'EMBEDDINGS_MODEL' | 'EMBEDDINGS_MIN_SIMILARITY'>>;

/** Characters of a text that are embedded (models have input limits; the start of a listing says what it is). */
const MAX_INPUT = 8000;
const BATCH = 64;

/**
 * Text embeddings from an OpenAI-compatible API, for semantic marketplace suggestions. Off unless
 * `EMBEDDINGS_URL` is set: nothing is sent anywhere by default.
 */
export class EmbeddingService {
  constructor(
    private config: EmbeddingsConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled() {
    return Boolean(this.config.EMBEDDINGS_URL);
  }
  get model() {
    return this.config.EMBEDDINGS_MODEL ?? 'text-embedding-3-small';
  }
  get minSimilarity() {
    return this.config.EMBEDDINGS_MIN_SIMILARITY ?? 0.4;
  }

  /** One vector per text, in order. Throws when the API fails; callers decide what that means for them. */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.enabled) throw new AppError('INTERNAL', 'Embeddings are not configured');
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const res = await this.fetchImpl(`${this.config.EMBEDDINGS_URL!.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.config.EMBEDDINGS_API_KEY ? { authorization: `Bearer ${this.config.EMBEDDINGS_API_KEY}` } : {}) },
        body: JSON.stringify({ model: this.model, input: texts.slice(i, i + BATCH).map((t) => t.slice(0, MAX_INPUT) || ' ') }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new AppError('UPSTREAM_ERROR', `The embeddings API answered HTTP ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
      const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== Math.min(BATCH, texts.length - i) || rows.some((r) => !Array.isArray(r.embedding) || !r.embedding.length)) throw new AppError('UPSTREAM_ERROR', 'The embeddings API returned an unexpected answer');
      out.push(...rows.map((r) => r.embedding!));
    }
    return out;
  }
}

/** Cosine similarity of two vectors of the same length (0 for an empty or zero vector). */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
