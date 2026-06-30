/** Visual Matching Engine V2 — VectorStore provider factory (cloud-independence hardening).
 *  The single place in the codebase that knows which vector database backend is active.
 *  Every other component (EmbeddingSearchEngine, ResilientVectorStore, warmup, health
 *  manager) depends only on the `VectorStore` interface and never imports a concrete
 *  backend directly — switching providers is a one-line env var change, not a code change.
 *
 *  Reads `VECTOR_STORE_PROVIDER` (default "qdrant"). Backends without an implementation yet
 *  are registered with a stub that throws a clear error, so adding a real implementation
 *  later means writing one class and replacing one registry entry — every caller of
 *  `createVectorStore()` is unaffected. */

import { logVectorStore } from "../logging";
import { MemoryVectorStore } from "./memoryVectorStore";
import { QdrantVectorStore } from "./qdrantVectorStore";
import type { VectorStore, VectorStoreProviderName } from "./types";

export type VectorStoreFactoryOptions = {
  provider?: VectorStoreProviderName;
};

function notImplemented(provider: VectorStoreProviderName): () => VectorStore {
  return () => {
    throw new Error(
      `VectorStoreFactory: provider "${provider}" is registered but has no implementation yet. ` +
        `Supported now: qdrant, memory.`
    );
  };
}

/** Registry of provider name -> constructor function. Adding a new backend is exactly
 *  one new entry here plus one new class file — no changes to any consumer. */
const registry: Record<VectorStoreProviderName, () => VectorStore> = {
  qdrant: () => new QdrantVectorStore(),
  memory: () => new MemoryVectorStore(),
  pinecone: notImplemented("pinecone"),
  weaviate: notImplemented("weaviate"),
  milvus: notImplemented("milvus"),
  pgvector: notImplemented("pgvector"),
};

function resolveProviderName(options: VectorStoreFactoryOptions = {}): VectorStoreProviderName {
  const raw = options.provider ?? (process.env.VECTOR_STORE_PROVIDER as VectorStoreProviderName | undefined) ?? "qdrant";
  if (!(raw in registry)) {
    throw new Error(
      `VectorStoreFactory: unknown VECTOR_STORE_PROVIDER "${raw}". Valid options: ${Object.keys(registry).join(", ")}.`
    );
  }
  return raw;
}

/** Creates a VectorStore instance for the configured (or explicitly passed) provider.
 *  Construction is cheap and side-effect-free for every current implementation (lazy
 *  init, no network calls until first real operation) so calling this at module load
 *  time is safe. */
export function createVectorStore(options: VectorStoreFactoryOptions = {}): VectorStore {
  const provider = resolveProviderName(options);
  const instance = registry[provider]();
  logVectorStore("init", { provider });
  return instance;
}

export function getActiveProviderName(options: VectorStoreFactoryOptions = {}): VectorStoreProviderName {
  return resolveProviderName(options);
}
