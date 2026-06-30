/** Visual Matching Engine V2 — Embedding infrastructure types (stage 3).
 *  Inert: nothing outside server/visualMatchingV2 imports from here yet. Gated by
 *  visualMatchingV2EmbeddingsEnabled() in sourcingPolicy.ts. */

/**
 * Provider-agnostic embedding interface. Every component in the embedding layer
 * (cache, search engine) depends only on this interface, never on a concrete provider —
 * swapping OpenAI/Gemini/Voyage/Jina/Nomic/etc. later means writing one new class and
 * changing which provider is wired up, with zero changes elsewhere.
 */
export interface EmbeddingProvider {
  /** Stable identifier used as the cache key's `model` field, e.g. "voyage-3-large". */
  readonly modelId: string;
  /** Embedding dimensionality this provider produces, for vector store sizing. */
  readonly dimensions: number;
  embedText(text: string): Promise<number[]>;
  /** Batched variant of embedText — embeds many texts in as few provider calls as possible
   *  (provider-internal batching, e.g. 100 texts -> ~10 batch API calls). Falls back to
   *  one-at-a-time embedText calls for providers that don't override this. */
  embedBatch?(texts: string[]): Promise<number[][]>;
  /** Optional — image embeddings are out of scope for stage 3. */
  embedImage?(image: Buffer): Promise<number[]>;
}

/**
 * Backend-agnostic vector store contract. The Embedding Search Engine depends only on
 * this interface, never on a concrete vector database — swapping in a different backend
 * later requires no changes to the search engine.
 */
export interface VectorStore {
  upsert(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void>;
  search(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<VectorSearchHit[]>;
  delete(id: string): Promise<void>;
}

export type VectorSearchHit = {
  id: string;
  similarity: number;
  metadata?: Record<string, unknown>;
};

export type EmbeddingSearchResult = {
  hits: VectorSearchHit[];
  durationMs: number;
  provider: string;
  cacheHit: boolean;
};

// ─── Cloud-independence layer: factory, health, resilience ────────────────────

/** Every backend the factory knows the name of. Not every name has an implementation yet —
 *  see vectorStoreFactory.ts's registry. Adding a new backend later means writing one class
 *  and one registry entry, never touching this list's consumers. */
export type VectorStoreProviderName = "qdrant" | "pinecone" | "weaviate" | "milvus" | "pgvector" | "memory";

export type VectorStoreHealth = {
  healthy: boolean;
  latencyMs: number;
  version?: string;
  error?: string;
};

/**
 * Optional capability — a VectorStore MAY implement this in addition to the required
 * interface. Kept separate (Interface Segregation) so `VectorStore` itself never grows
 * health-check obligations that not every backend can support identically.
 */
export interface HealthCheckable {
  checkHealth(): Promise<VectorStoreHealth>;
}
