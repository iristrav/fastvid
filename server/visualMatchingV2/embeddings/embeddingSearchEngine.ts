/** Visual Matching Engine V2 — Embedding Search Engine (stage 3).
 *  Sole responsibility: resolve an embedding for a query (cache-first), run a vector
 *  search, return the top candidates as returned by the vector store. No scoring beyond
 *  the vector store's native similarity ordering, no filtering, no CLIP, no reranking —
 *  those are later stages. Provider- and backend-agnostic: depends only on
 *  EmbeddingProvider and VectorStore (types.ts). */

import { getCachedEmbedding, setCachedEmbedding } from "./embeddingCache";
import { logEmbedding } from "../logging";
import type { EmbeddingProvider, EmbeddingSearchResult, VectorStore } from "./types";

const EMBEDDING_VERSION = "v1";

function hashQueryText(text: string): string {
  // Lightweight, dependency-free content hash for cache keys on ad-hoc query text
  // (not an asset id). Collisions are not a correctness concern here — a hash collision
  // would only cause a cache hit to return the wrong (but still valid-shaped) embedding,
  // and this is purely a perf cache, not the source of truth.
  let h = 0;
  const normalized = text.trim().toLowerCase();
  for (let i = 0; i < normalized.length; i++) {
    h = (Math.imul(31, h) + normalized.charCodeAt(i)) | 0;
  }
  return `query:${(h >>> 0).toString(16)}`;
}

export class EmbeddingSearchEngine {
  constructor(
    private provider: EmbeddingProvider,
    private vectorStore: VectorStore
  ) {}

  /** Resolves an embedding for the given text via the cache-first path: cache hit skips
   *  the provider call entirely; a miss calls the provider once and writes the result back. */
  async resolveQueryEmbedding(queryText: string): Promise<{ embedding: number[]; cacheHit: boolean }> {
    const subjectId = hashQueryText(queryText);
    const cached = await getCachedEmbedding(subjectId, this.provider.modelId, EMBEDDING_VERSION);
    if (cached) return { embedding: cached, cacheHit: true };

    const embedding = await this.provider.embedText(queryText);
    await setCachedEmbedding(subjectId, this.provider.modelId, EMBEDDING_VERSION, embedding);
    return { embedding, cacheHit: false };
  }

  /** Embeds the query (cache-first) and runs a vector search, returning the top candidates
   *  exactly as the vector store ranks them. */
  async search(queryText: string, topK: number, filter?: Record<string, unknown>): Promise<EmbeddingSearchResult> {
    const start = Date.now();
    const { embedding, cacheHit } = await this.resolveQueryEmbedding(queryText);
    const hits = await this.vectorStore.search(embedding, topK, filter);
    const durationMs = Date.now() - start;
    logEmbedding("vector_search", {
      provider: this.provider.modelId,
      cacheHit,
      durationMs,
      candidateCount: hits.length,
    });
    return { hits, durationMs, provider: this.provider.modelId, cacheHit };
  }
}
