/** Visual Matching Engine V2 — VectorStore warmup (cloud-independence hardening).
 *  Intended to run once at worker startup: construct the configured backend, ensure its
 *  collection exists, run an initial health check, and start background health polling —
 *  so the first real search request never pays connection/collection-creation latency.
 *
 *  NOT wired into actual worker startup yet, consistent with every prior Visual Matching
 *  Engine V2 stage: this stays inert until explicitly activated by the caller. */

import { logVectorStore } from "../logging";
import { createVectorStore, getActiveProviderName } from "./vectorStoreFactory";
import { ResilientVectorStore } from "./resilientVectorStore";
import { VectorStoreHealthManager } from "./vectorStoreHealthManager";
import type { HealthCheckable, VectorStore, VectorStoreProviderName } from "./types";

export type WarmupResult = {
  provider: VectorStoreProviderName;
  collection: string;
  store: VectorStore;
  resilientStore: ResilientVectorStore;
  healthManager: VectorStoreHealthManager | null;
  healthy: boolean;
};

function isHealthCheckable(store: VectorStore): store is VectorStore & HealthCheckable {
  return typeof (store as Partial<HealthCheckable>).checkHealth === "function";
}

function hasEnsureCollection(store: VectorStore): store is VectorStore & { ensureCollection(dimensions: number): Promise<void> } {
  return typeof (store as { ensureCollection?: unknown }).ensureCollection === "function";
}

/** Constructs the active VectorStore, ensures its collection exists for the given embedding
 *  dimensionality, runs one health check, and starts background polling. Wraps the result
 *  in a `ResilientVectorStore` so callers get graceful-degradation behavior for free. */
export async function warmupVectorStore(dimensions: number): Promise<WarmupResult> {
  const provider = getActiveProviderName();
  const store = createVectorStore();

  if (hasEnsureCollection(store)) {
    try {
      await store.ensureCollection(dimensions);
    } catch (err) {
      logVectorStore("error", { operation: "warmup_ensure_collection", provider, error: (err as Error).message });
    }
  }

  const collection = (process.env.QDRANT_COLLECTION ?? "visual_matching_v2").trim();
  let healthManager: VectorStoreHealthManager | null = null;
  let healthy = false;

  if (isHealthCheckable(store)) {
    healthManager = new VectorStoreHealthManager(store, provider, collection);
    const result = await healthManager.checkNow();
    healthy = result.healthy;
    healthManager.start();
  }

  logVectorStore("init", { component: "warmup", provider, collection, healthy });

  return {
    provider,
    collection,
    store,
    resilientStore: new ResilientVectorStore(store, healthManager ?? undefined),
    healthManager,
    healthy,
  };
}
