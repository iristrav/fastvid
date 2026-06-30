/** Visual Matching Engine V2 — Candidate Fetcher.
 *  Sole responsibility: start sources, search in parallel, collect results, normalize.
 *  No selection, no scoring, no filtering — that's later stages. Gated by
 *  visualMatchingV2FetcherEnabled() in sourcingPolicy.ts; not called from the active
 *  pipeline yet. */

import pLimit from "p-limit";
import { ALL_SOURCE_ADAPTERS } from "./sourceAdapters";
import { getCachedSearch, setCachedSearch } from "./searchCache";
import { logCandidateFetch } from "./logging";
import type {
  CandidateAsset,
  CandidateFetchResult,
  CandidateFetcherOptions,
  SourceAdapter,
  SourceAdapterSearchCtx,
  SourceFetchOutcome,
  VisualIntent,
} from "./types";

const DEFAULT_PER_SOURCE_TIMEOUT_MS = 8_000;
const DEFAULT_RETRIES_PER_SOURCE = 1;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<{ result: T } | { timedOut: true }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    promise.then(
      (result) => {
        clearTimeout(timer);
        resolve({ result });
      },
      () => {
        clearTimeout(timer);
        resolve({ timedOut: true });
      }
    );
  });
}

async function searchOneSourceWithRetry(
  adapter: SourceAdapter,
  intent: VisualIntent,
  ctx: SourceAdapterSearchCtx,
  perSourceTimeoutMs: number,
  retriesPerSource: number
): Promise<SourceFetchOutcome> {
  const start = Date.now();
  const cacheKey = { source: adapter.name, query: intent.primaryKeyword || intent.visualDescription || intent.visualSubject };
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    return { source: adapter.name, candidates: cached, durationMs: Date.now() - start, cacheHit: true, timedOut: false, retries: 0, error: null };
  }

  let attempt = 0;
  let lastError: string | null = null;
  while (attempt <= retriesPerSource) {
    const outcome = await withTimeout(adapter.search(intent, ctx), perSourceTimeoutMs);
    if ("timedOut" in outcome) {
      if (attempt === retriesPerSource) {
        return { source: adapter.name, candidates: [], durationMs: Date.now() - start, cacheHit: false, timedOut: true, retries: attempt, error: lastError };
      }
      attempt += 1;
      continue;
    }
    // adapter.search already swallows its own errors and returns [] (withAdapterLogging),
    // so a thrown error here would be unexpected, but handle defensively anyway.
    setCachedSearch(cacheKey, outcome.result);
    return { source: adapter.name, candidates: outcome.result, durationMs: Date.now() - start, cacheHit: false, timedOut: false, retries: attempt, error: null };
  }
  return { source: adapter.name, candidates: [], durationMs: Date.now() - start, cacheHit: false, timedOut: false, retries: attempt, error: lastError };
}

/**
 * Runs every configured source adapter for one beat, in parallel, with per-source
 * timeout/retry isolation so one slow source never blocks the others. Collects and
 * normalizes results — does not select, score, or filter.
 */
export async function fetchCandidates(
  intent: VisualIntent,
  ctx: SourceAdapterSearchCtx,
  options: CandidateFetcherOptions = {}
): Promise<CandidateFetchResult> {
  const adapters = options.adapters ?? ALL_SOURCE_ADAPTERS;
  const perSourceTimeoutMs = options.perSourceTimeoutMs ?? DEFAULT_PER_SOURCE_TIMEOUT_MS;
  const retriesPerSource = options.retriesPerSource ?? DEFAULT_RETRIES_PER_SOURCE;
  const limit = pLimit(options.concurrency ?? adapters.length);

  const startedAt = new Date().toISOString();
  const fetchStart = Date.now();

  const sources: SourceFetchOutcome[] = await Promise.all(
    adapters.map((adapter) => limit(() => searchOneSourceWithRetry(adapter, intent, ctx, perSourceTimeoutMs, retriesPerSource)))
  );

  const candidates: CandidateAsset[] = sources.flatMap((s) => s.candidates);

  const trace = {
    beatId: intent.beatId,
    startedAt,
    durationMs: Date.now() - fetchStart,
    sources,
    totalCandidates: candidates.length,
  };

  logCandidateFetch("fetch_complete", trace);

  return { candidates, trace };
}
