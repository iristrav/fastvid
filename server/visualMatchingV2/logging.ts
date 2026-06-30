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
