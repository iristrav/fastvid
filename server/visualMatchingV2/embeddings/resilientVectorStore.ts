/** Visual Matching Engine V2 — resilient VectorStore decorator (cloud-independence
 *  hardening). Wraps any concrete `VectorStore` and never lets a backend outage propagate
 *  as an exception: every operation is caught, logged as a warning, and degrades to a safe
 *  no-op/empty result instead of crashing the pipeline. `isAvailable()` reflects the health
 *  manager's last known state, so a caller upstream (the future candidate scorer/selector)
 *  can choose to fall back to keyword-only retrieval while the vector database is down, and
 *  resume using embeddings automatically once it recovers — entirely transparent to the
 *  rest of Visual Matching Engine V2, which only ever sees a `VectorStore`. */

import { logVectorStore } from "../logging";
import type { VectorStoreHealthManager } from "./vectorStoreHealthManager";
import type { VectorSearchHit, VectorStore } from "./types";

export class ResilientVectorStore implements VectorStore {
  constructor(
    private readonly inner: VectorStore,
    private readonly healthManager?: VectorStoreHealthManager
  ) {}

  /** True when the last known health check succeeded. Defaults to true (optimistic) when
   *  no health manager is wired in, so this decorator stays usable standalone in tests. */
  isAvailable(): boolean {
    return this.healthManager ? this.healthManager.isHealthy() : true;
  }

  async upsert(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
    try {
      await this.inner.upsert(id, vector, metadata);
    } catch (err) {
      logVectorStore("error", { operation: "upsert", id, error: (err as Error).message, degraded: true });
    }
  }

  /** On failure, returns an empty hit list rather than throwing — callers see "no
   *  candidates from the vector store" exactly as if the search legitimately found
   *  nothing, which lets upstream code fall back to keyword-only retrieval without any
   *  special-casing for vector-store outages. */
  async search(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<VectorSearchHit[]> {
    try {
      return await this.inner.search(vector, topK, filter);
    } catch (err) {
      logVectorStore("error", { operation: "search", error: (err as Error).message, degraded: true });
      return [];
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.inner.delete(id);
    } catch (err) {
      logVectorStore("error", { operation: "delete", id, error: (err as Error).message, degraded: true });
    }
  }

  /** Forwards to the inner store's batchUpsert when it implements one (e.g.
   *  QdrantVectorStore, chunked internally), so batch writers get the same degrade-on-error
   *  guarantee as every other method instead of bypassing the decorator. Falls back to
   *  sequential upsert() calls (still through this same try/catch) when the inner store has
   *  no native batch path. */
  async batchUpsert(points: { id: string; vector: number[]; payload?: Record<string, unknown> }[]): Promise<void> {
    try {
      const maybeBatch = this.inner as unknown as { batchUpsert?: (pts: typeof points) => Promise<void> };
      if (typeof maybeBatch.batchUpsert === "function") {
        await maybeBatch.batchUpsert(points);
      } else {
        await Promise.all(points.map((p) => this.inner.upsert(p.id, p.vector, p.payload)));
      }
    } catch (err) {
      logVectorStore("error", { operation: "batchUpsert", count: points.length, error: (err as Error).message, degraded: true });
    }
  }
}
