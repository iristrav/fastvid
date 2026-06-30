/** Visual Matching Engine V2 — in-memory VectorStore (cloud-independence hardening).
 *  Sole purpose: the `memory` provider in VectorStoreFactory, used for tests and local
 *  development where no real vector database is reachable. Implements the exact same
 *  `VectorStore` + `HealthCheckable` contracts as every other backend, so swapping it in
 *  requires zero changes anywhere else. Cosine similarity computed in plain JS — fine for
 *  the small in-memory datasets this is meant for, not intended for production scale. */

import type { HealthCheckable, VectorSearchHit, VectorStore, VectorStoreHealth } from "./types";

type StoredPoint = {
  vector: number[];
  metadata?: Record<string, unknown>;
};

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function matchesFilter(metadata: Record<string, unknown> | undefined, filter?: Record<string, unknown>): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (!metadata) return false;
  return Object.entries(filter).every(([key, value]) => metadata[key] === value);
}

export class MemoryVectorStore implements VectorStore, HealthCheckable {
  private points = new Map<string, StoredPoint>();

  async upsert(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
    this.points.set(id, { vector, metadata });
  }

  async search(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<VectorSearchHit[]> {
    const hits: VectorSearchHit[] = [];
    for (const [id, point] of Array.from(this.points.entries())) {
      if (!matchesFilter(point.metadata, filter)) continue;
      hits.push({ id, similarity: cosineSimilarity(vector, point.vector), metadata: point.metadata });
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, topK);
  }

  async delete(id: string): Promise<void> {
    this.points.delete(id);
  }

  async checkHealth(): Promise<VectorStoreHealth> {
    return { healthy: true, latencyMs: 0, version: "memory" };
  }

  /** Test helper — not part of the VectorStore contract. */
  clear(): void {
    this.points.clear();
  }

  /** Test helper — not part of the VectorStore contract. */
  size(): number {
    return this.points.size;
  }
}
