/** Visual Matching Engine V2 — Qdrant-backed VectorStore implementation (stage 3, final).
 *
 *  Replaces the earlier PgVector design: this project's infrastructure is Railway MySQL
 *  (metadata) + Cloudflare R2 (object storage) + Railway (compute) — no Postgres anywhere,
 *  and none is being introduced. Qdrant is a purpose-built vector database reachable over
 *  plain HTTP/REST, with no relational dependency, fitting this stack directly.
 *
 *  Implements the unchanged `VectorStore` interface (types.ts) — upsert/search/delete —
 *  plus additional methods (batchUpsert, deleteMany, createCollection, ensureCollection,
 *  healthCheck) that go beyond what the interface requires, for callers that want them
 *  explicitly. The Embedding Search Engine and everything else in the Visual Matching
 *  Engine V2 only ever calls through `VectorStore`, so swapping this for a different
 *  backend later is a one-file change.
 *
 *  Talks to Qdrant via its REST API using plain `fetch` — no SDK dependency, nothing to
 *  version-lock, fewer moving parts to break across Qdrant version bumps. */

import { logVectorStore } from "../logging";
import { recordVectorStoreCall } from "./vectorStoreMetrics";
import type { HealthCheckable, VectorSearchHit, VectorStore, VectorStoreHealth } from "./types";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_BATCH_SIZE = 256;

export type QdrantVectorStoreOptions = {
  url?: string;
  apiKey?: string;
  collection?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

type QdrantPoint = {
  id: string;
  vector: number[];
  payload?: Record<string, unknown>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Converts a flat metadata filter (key -> value) into Qdrant's payload filter format.
 *  Stage 3 scope: equality matches only — no range/geo/nested filters yet. */
function buildPayloadFilter(filter?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!filter || Object.keys(filter).length === 0) return undefined;
  return {
    must: Object.entries(filter).map(([key, value]) => ({
      key,
      match: { value },
    })),
  };
}

export class QdrantVectorStore implements VectorStore, HealthCheckable {
  private url: string | undefined;
  private apiKey: string | undefined;
  private collection: string;
  private timeoutMs: number;
  private maxRetries: number;
  private collectionEnsured = false;

  /** Lazy initialization: reads env vars at construction but makes no network call until
   *  the first real operation — so simply instantiating this class (e.g. at module load
   *  time) has zero side effects and zero cost when Qdrant isn't configured. */
  constructor(options: QdrantVectorStoreOptions = {}) {
    this.url = (options.url ?? process.env.QDRANT_URL)?.trim().replace(/\/+$/, "");
    this.apiKey = (options.apiKey ?? process.env.QDRANT_API_KEY)?.trim();
    this.collection = options.collection ?? process.env.QDRANT_COLLECTION ?? "visual_matching_v2";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  private requireUrl(): string {
    if (!this.url) {
      throw new Error("QdrantVectorStore: QDRANT_URL is not set");
    }
    return this.url;
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown },
    operation: import("./vectorStoreMetrics").VectorStoreOperation
  ): Promise<T> {
    const base = this.requireUrl();
    const start = Date.now();
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= this.maxRetries) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const resp = await fetch(`${base}${path}`, {
          method: init.method,
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey ? { "api-key": this.apiKey } : {}),
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          // Retry on 429/5xx (transient); fail fast on 4xx client errors.
          if ((resp.status === 429 || resp.status >= 500) && attempt < this.maxRetries) {
            lastError = new Error(`Qdrant ${operation} failed (${resp.status}): ${text.slice(0, 256)}`);
            logVectorStore("retry", { operation, attempt, status: resp.status });
            recordVectorStoreCall(operation, Date.now() - start, { retries: 1 });
            attempt += 1;
            await sleep(DEFAULT_RETRY_BASE_DELAY_MS * 2 ** attempt);
            continue;
          }
          throw new Error(`Qdrant ${operation} failed (${resp.status}): ${text.slice(0, 256)}`);
        }

        const json = (await resp.json()) as T;
        recordVectorStoreCall(operation, Date.now() - start, {});
        return json;
      } catch (err) {
        clearTimeout(timer);
        const isAbort = err instanceof Error && err.name === "AbortError";
        if (isAbort) {
          logVectorStore("timeout", { operation, attempt, timeoutMs: this.timeoutMs });
        }
        if (attempt < this.maxRetries) {
          lastError = err as Error;
          logVectorStore("retry", { operation, attempt, error: (err as Error).message });
          recordVectorStoreCall(operation, Date.now() - start, { retries: 1 });
          attempt += 1;
          await sleep(DEFAULT_RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        recordVectorStoreCall(operation, Date.now() - start, {
          error: true,
          timeout: isAbort,
          providerError: !isAbort,
          healthFailure: operation === "healthCheck",
        });
        logVectorStore("error", { operation, error: (err as Error).message });
        throw err;
      }
    }
    recordVectorStoreCall(operation, Date.now() - start, { error: true, healthFailure: operation === "healthCheck" });
    throw lastError ?? new Error(`Qdrant ${operation} failed after ${this.maxRetries} retries`);
  }

  /** Creates the collection if it doesn't exist. Idempotent — safe to call on every
   *  startup. Memoized in-process so repeated calls after the first don't hit the network. */
  async ensureCollection(dimensions: number): Promise<void> {
    if (this.collectionEnsured) return;
    const start = Date.now();
    try {
      const exists = await this.request<{ result?: unknown }>(`/collections/${this.collection}`, { method: "GET" }, "ensureCollection").catch(
        () => null
      );
      if (!exists) {
        await this.createCollection(dimensions);
      }
      this.collectionEnsured = true;
      logVectorStore("ensure_collection", { collection: this.collection, dimensions, durationMs: Date.now() - start });
    } catch (err) {
      logVectorStore("error", { operation: "ensureCollection", error: (err as Error).message });
      throw err;
    }
  }

  /** Explicit collection creation — cosine similarity, fixed dimensionality. */
  async createCollection(dimensions: number): Promise<void> {
    await this.request(
      `/collections/${this.collection}`,
      {
        method: "PUT",
        body: { vectors: { size: dimensions, distance: "Cosine" } },
      },
      "ensureCollection"
    );
  }

  /** Legacy boolean health check — kept for backward compatibility with any existing
   *  callers. New code should prefer `checkHealth()` for the richer result shape. */
  async healthCheck(): Promise<boolean> {
    const result = await this.checkHealth();
    return result.healthy;
  }

  /** Implements `HealthCheckable`. Reports connection liveness, latency, and Qdrant's
   *  reported version — used by the VectorStoreHealthManager for periodic polling. */
  async checkHealth(): Promise<VectorStoreHealth> {
    const start = Date.now();
    try {
      if (!this.url) {
        return { healthy: false, latencyMs: 0, error: "QDRANT_URL is not set" };
      }
      const result = await this.request<{ result?: { status?: string }; version?: string }>(
        `/collections/${this.collection}`,
        { method: "GET" },
        "healthCheck"
      );
      const latencyMs = Date.now() - start;
      logVectorStore("health_check", { collection: this.collection, latencyMs, healthy: true });
      return { healthy: true, latencyMs, version: (result as { version?: string }).version };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const error = (err as Error).message;
      logVectorStore("health_check", { collection: this.collection, latencyMs, healthy: false, error });
      return { healthy: false, latencyMs, error };
    }
  }

  async upsert(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
    await this.batchUpsert([{ id, vector, payload: metadata }]);
  }

  /** Upserts many points in one request, chunked to DEFAULT_BATCH_SIZE so a single call
   *  with hundreds of thousands of points doesn't produce one oversized HTTP payload. */
  async batchUpsert(points: QdrantPoint[]): Promise<void> {
    if (points.length === 0) return;
    for (let i = 0; i < points.length; i += DEFAULT_BATCH_SIZE) {
      const chunk = points.slice(i, i + DEFAULT_BATCH_SIZE);
      await this.request(
        `/collections/${this.collection}/points`,
        {
          method: "PUT",
          body: {
            points: chunk.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload ?? {} })),
          },
        },
        "batchUpsert"
      );
    }
    logVectorStore("batch_upsert", { collection: this.collection, count: points.length });
  }

  async search(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<VectorSearchHit[]> {
    const body: Record<string, unknown> = {
      vector,
      limit: topK,
      with_payload: true,
    };
    const payloadFilter = buildPayloadFilter(filter);
    if (payloadFilter) body.filter = payloadFilter;

    const result = await this.request<{ result?: Array<{ id: string; score: number; payload?: Record<string, unknown> }> }>(
      `/collections/${this.collection}/points/search`,
      { method: "POST", body },
      "search"
    );
    const hits = (result.result ?? []).map((r) => ({
      id: String(r.id),
      similarity: r.score,
      metadata: r.payload,
    }));
    logVectorStore("search", { collection: this.collection, topK, candidateCount: hits.length });
    return hits;
  }

  async delete(id: string): Promise<void> {
    await this.deleteMany([id]);
  }

  /** Deletes many points in one request, chunked to DEFAULT_BATCH_SIZE. */
  async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (let i = 0; i < ids.length; i += DEFAULT_BATCH_SIZE) {
      const chunk = ids.slice(i, i + DEFAULT_BATCH_SIZE);
      await this.request(
        `/collections/${this.collection}/points/delete`,
        { method: "POST", body: { points: chunk } },
        "deleteMany"
      );
    }
    logVectorStore("delete_many", { collection: this.collection, count: ids.length });
  }
}
