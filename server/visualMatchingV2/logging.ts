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
