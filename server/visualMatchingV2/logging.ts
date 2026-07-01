/** Visual Matching Engine V2 — structured logging.
 *  Single console-based logger with a consistent prefix so stage-1 output is easy to
 *  grep/filter in Railway logs without touching the active pipeline's logging. */

const PREFIX = "[VisualMatchingV2]";

export function logVideoContext(event: "built" | "cache_hit" | "cache_miss" | "error", data: Record<string, unknown>) {
  console.log(`${PREFIX} VideoContext.${event}`, JSON.stringify(data));
}

export function logVisualIntent(event: "built" | "cache_hit" | "cache_miss" | "error", data: Record<string, unknown>) {
  console.log(`${PREFIX} VisualIntent.${event}`, JSON.stringify(data));
}

export function logSourceAdapter(event: "search_start" | "search_result" | "error", data: Record<string, unknown>) {
  console.log(`${PREFIX} SourceAdapter.${event}`, JSON.stringify(data));
}

/** Stage 2 — Candidate Fetcher trace: per-beat summary of which sources ran, how long they
 *  took, cache hits, timeouts, retries and errors. This is the CandidateFetchTrace; it
 *  follows the same per-beat shape the design calls BeatSelectionTrace and will be merged
 *  into it once scoring/selection (later stages) exist to log against. */
export function logCandidateFetch(event: "fetch_complete", trace: Record<string, unknown>) {
  console.log(`${PREFIX} CandidateFetch.${event}`, JSON.stringify(trace));
}

/** Stage 3 — embedding layer: generation, cache hits/misses, vector search timing,
 *  candidate counts, and which provider was used. */
export function logEmbedding(
  event: "generated" | "cache_hit" | "cache_miss" | "vector_search" | "error",
  data: Record<string, unknown>
) {
  console.log(`${PREFIX} Embedding.${event}`, JSON.stringify(data));
}

/** Stage 3 — vector store layer: connection/health, upserts, deletes, searches, retries,
 *  timeouts, and errors. Backend-agnostic event names so a future non-Qdrant VectorStore
 *  implementation logs through the same shape. */
export function logVectorStore(
  event:
    | "init"
    | "health_check"
    | "ensure_collection"
    | "upsert"
    | "batch_upsert"
    | "search"
    | "delete"
    | "delete_many"
    | "retry"
    | "timeout"
    | "error",
  data: Record<string, unknown>
) {
  console.log(`${PREFIX} VectorStore.${event}`, JSON.stringify(data));
}

/** Retrieval Strategy Engine — the sole location where strategy selection decisions are
 *  logged. One event per beat: which mode was selected and why (inferred from context). */
export function logRetrievalStrategy(
  event: "selected" | "override" | "error",
  data: Record<string, unknown>
) {
  console.log(`${PREFIX} RetrievalStrategy.${event}`, JSON.stringify(data));
}

/** Retrieval Orchestrator — the single component that decides how candidates are fetched
 *  across all sources. Logs phase transitions, early-exit decisions, and the final pool
 *  summary, separately from the per-source CandidateFetch trace it builds on top of. */
export function logRetrievalOrchestrator(
  event: "phase_start" | "phase_complete" | "early_exit" | "dedup_complete" | "pool_complete" | "error",
  data: Record<string, unknown>
) {
  console.log(`${PREFIX} RetrievalOrchestrator.${event}`, JSON.stringify(data));
}

/** CLIP Pre-Filter — second funnel stage. Logs one trace per beat: candidate count,
 *  latency, per-candidate similarity, which candidates passed vs. were rejected. CLIP-only;
 *  not the (future) BeatSelectionTrace, which covers LLM Vision + final selection. */
export function logClipPreFilter(
  event: "filter_complete" | "batch_embed" | "error",
  data: Record<string, unknown>
) {
  console.log(`${PREFIX} ClipPreFilter.${event}`, JSON.stringify(data));
}

/** Candidate Ranking Layer — third funnel stage. Logs one trace per beat: the weights and
 *  source priority used, and per-candidate signals/contributions/final position. Combines
 *  only existing retrieval signals — no semantic judgement, no LLM. */
export function logCandidateRanking(event: "ranking_complete" | "error", data: Record<string, unknown>) {
  console.log(`${PREFIX} CandidateRanking.${event}`, JSON.stringify(data));
}

/** LLM Vision Scorer — fourth funnel stage. Logs one trace per beat: model, prompt
 *  version, token usage, per-candidate scores/reasoning/latency, cache hits. */
export function logVisionScorer(event: "score_complete" | "cache_hit" | "error", data: Record<string, unknown>) {
  console.log(`${PREFIX} VisionScorer.${event}`, JSON.stringify(data));
}

/** Candidate Selector — fifth funnel stage, the sole component that may choose a winner.
 *  Logs start/complete/reject/tiebreak/error, each carrying the beatId and minimal fields
 *  needed to diagnose selection decisions without parsing the full SelectorTrace. */
export function logSelector(
  event: "start" | "complete" | "reject" | "tieBreak" | "error",
  data: Record<string, unknown>
) {
  console.log(`${PREFIX} Selection.${event}`, JSON.stringify(data));
}

/** BeatSelectionTrace store — one event per save attempt. Separate from SelectorTrace
 *  (decision log) so storage errors are visible without polluting selection logs. */
export function logBeatSelectionTrace(
  event: "saved" | "error",
  data: Record<string, unknown>
) {
  console.log(`${PREFIX} BeatSelectionTrace.${event}`, JSON.stringify(data));
}

/** Wraps an async step, logging duration_ms and any thrown error under a consistent shape. */
export async function timedStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    console.log(`${PREFIX} step_complete`, JSON.stringify({ label, duration_ms: Date.now() - start }));
    return result;
  } catch (err) {
    console.warn(
      `${PREFIX} step_error`,
      JSON.stringify({ label, duration_ms: Date.now() - start, error: (err as Error).message })
    );
    throw err;
  }
}
