/**
 * Per-provider concurrency limiter — caps how many in-flight search/API requests this worker
 * process sends to a given external provider at once. Single-process-scoped (module-level Map,
 * same shape as ffmpegSemaphore/getUserRenderSemaphore) — not fleet-wide, and not swappable for
 * a Redis-backed limiter without further work, but the Semaphore abstraction underneath is the
 * same one a future Redis-backed limiter would slot behind, so callers don't need to change when
 * that happens. Conservative defaults, env-overridable per provider so a future rate-limit
 * incident with one provider doesn't require touching code.
 */
import { Semaphore } from "./semaphore";

const DEFAULT_PROVIDER_CONCURRENCY = 4;

const limiters = new Map<string, Semaphore>();

function envConcurrencyFor(provider: string): number {
  const envKey = `PROVIDER_CONCURRENCY_${provider.toUpperCase()}`;
  const raw = process.env[envKey]?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 32) return n;
  }
  return DEFAULT_PROVIDER_CONCURRENCY;
}

/** Get (creating if needed) the shared concurrency limiter for a named external provider. */
export function providerLimiter(provider: string): Semaphore {
  let sem = limiters.get(provider);
  if (!sem) {
    sem = new Semaphore(envConcurrencyFor(provider));
    limiters.set(provider, sem);
  }
  return sem;
}
