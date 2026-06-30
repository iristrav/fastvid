/** Visual Matching Engine V2 — Candidate Fetcher.
 *  Sole responsibility: start sources, search in parallel, collect results, normalize.
 *  No selection, no scoring, no filtering — that's later stages. Gated by
 *  visualMatchingV2FetcherEnabled() in sourcingPolicy.ts; not called from the active
 *  pipeline yet.
 *
 *  Cancellation: each source search gets its own AbortController. On timeout the
 *  controller is aborted, which (a) immediately settles the race so the Fetcher stops
 *  waiting on that source — no zombie awaits accumulating across beats — and (b) is passed
 *  to the adapter via ctx.signal, so adapters built against fetch's `signal` option (or any
 *  future adapter) get a genuine network-level abort. The 5 stage-1 adapters wrap legacy
 *  fetch*Clips functions that predate AbortSignal support; those functions are part of the
 *  proven, currently-running pipeline and are deliberately left untouched to avoid
 *  regression risk, so for them the abort stops the Fetcher from waiting but the underlying
 *  HTTP request may still complete in the background. This is documented, not hidden. */

import pLimit from "p-limit";
import { ALL_SOURCE_ADAPTERS } from "./sourceAdapters";
import { getCachedSearch, setCachedSearch } from "./searchCache";
import { logCandidateFetch } from "./logging";
import { recordSourceOutcome } from "./metrics";
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

/** Races a promise against a real AbortController-driven timeout. On timeout, aborts the
 *  controller (genuine cancellation signal, not just an abandoned await) before resolving. */
function withAbortableTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number
): Promise<{ result: T } | { timedOut: true }> {
  const controller = new AbortController();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, ms);
    fn(controller.signal).then(
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
  const cached = await getCachedSearch(cacheKey);
  if (cached) {
    const outcome: SourceFetchOutcome = { source: adapter.name, candidates: cached, durationMs: Date.now() - start, cacheHit: true, timedOut: false, retries: 0, error: null };
    recordSourceOutcome(outcome);
    return outcome;
  }

  let attempt = 0;
  let lastError: string | null = null;
  while (attempt <= retriesPerSource) {
    const raced = await withAbortableTimeout((signal) => adapter.search(intent, { ...ctx, signal }), perSourceTimeoutMs);
    if ("timedOut" in raced) {
      if (attempt === retriesPerSource) {
        const outcome: SourceFetchOutcome = { source: adapter.name, candidates: [], durationMs: Date.now() - start, cacheHit: false, timedOut: true, retries: attempt, error: lastError };
        recordSourceOutcome(outcome);
        return outcome;
      }
      attempt += 1;
      continue;
    }
    // adapter.search already swallows its own errors and returns [] (withAdapterLogging),
    // so a thrown error here would be unexpected, but handle defensively anyway.
    await setCachedSearch(cacheKey, raced.result);
    const outcome: SourceFetchOutcome = { source: adapter.name, candidates: raced.result, durationMs: Date.now() - start, cacheHit: false, timedOut: false, retries: attempt, error: null };
    recordSourceOutcome(outcome);
    return outcome;
  }
  const outcome: SourceFetchOutcome = { source: adapter.name, candidates: [], durationMs: Date.now() - start, cacheHit: false, timedOut: false, retries: attempt, error: lastError };
  recordSourceOutcome(outcome);
  return outcome;
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
