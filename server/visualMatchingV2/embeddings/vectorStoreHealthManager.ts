/** Visual Matching Engine V2 — VectorStore health manager (cloud-independence hardening).
 *  Periodically polls a `HealthCheckable` backend (connection liveness, latency, version)
 *  and exposes the last known state synchronously, so callers (e.g. ResilientVectorStore)
 *  never have to await a live health check on the hot path. Backend-agnostic — works with
 *  any VectorStore that also implements `HealthCheckable`. */

import { logVectorStore } from "../logging";
import type { HealthCheckable, VectorStoreHealth, VectorStoreProviderName } from "./types";

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export type VectorStoreHealthManagerOptions = {
  pollIntervalMs?: number;
};

export class VectorStoreHealthManager {
  private lastHealth: VectorStoreHealth = { healthy: false, latencyMs: 0, error: "not checked yet" };
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;
  private checking = false;

  constructor(
    private readonly store: HealthCheckable,
    private readonly providerName: VectorStoreProviderName,
    private readonly collectionName: string,
    options: VectorStoreHealthManagerOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Runs one health check immediately and stores the result, without starting polling. */
  async checkNow(): Promise<VectorStoreHealth> {
    if (this.checking) return this.lastHealth;
    this.checking = true;
    try {
      const result = await this.store.checkHealth();
      this.lastHealth = result;
      if (!result.healthy) {
        logVectorStore("error", { component: "healthManager", provider: this.providerName, error: result.error });
      }
      return result;
    } catch (err) {
      this.lastHealth = { healthy: false, latencyMs: 0, error: (err as Error).message };
      return this.lastHealth;
    } finally {
      this.checking = false;
    }
  }

  /** Starts periodic background polling. Safe to call once at worker startup (warmup). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkNow();
    }, this.pollIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isHealthy(): boolean {
    return this.lastHealth.healthy;
  }

  lastLatency(): number {
    return this.lastHealth.latencyMs;
  }

  lastError(): string | undefined {
    return this.lastHealth.error;
  }

  provider(): VectorStoreProviderName {
    return this.providerName;
  }

  collection(): string {
    return this.collectionName;
  }
}
