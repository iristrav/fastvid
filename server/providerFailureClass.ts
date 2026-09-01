/**
 * RONDE 129 — "it failed" was one word for six different situations.
 *
 * Two production lines, and the same missing distinction under both.
 *
 * ── A. Wikimedia kept being asked after it said stop ─────────────────────────────────────────
 *
 *     [Pipeline] Wikimedia imageinfo for scene 0: HTTP 429 Too Many Requests
 *                — counting as a provider failure
 *
 * "Counting as a provider failure" is exactly what happened, and it is the problem: the breaker
 * needs THREE consecutive failures before it stands down, and it counts a 429 the same as a
 * timeout or an empty result. A timeout is ambiguous — maybe the next one works. A 429 is not
 * ambiguous: the server has said, in words, that it is being asked too often. Waiting for two
 * more before believing it means sending two more requests into a server that already refused,
 * and because scenes are searched in parallel those two can be in flight before the first is
 * even counted.
 *
 * ── B. A cancelled render was retried three times ────────────────────────────────────────────
 *
 *     [Pipeline] Scene 4: fallback attempt 1 failed (transient) — retry 1/3 in 3.6s:
 *                Video generation cancelled
 *     [Pipeline] Scene 4: fallback attempt 1 failed (transient) — retry 2/3 in 7.1s:
 *                Video generation cancelled
 *
 * `throwIfVideoGenerationCancelled` throws `Error("Video generation cancelled")` when the render
 * has been cancelled. The retry loop calls every error "transient" unless it recognises fork
 * pressure, so it slept 4 seconds and asked again — for something that cannot possibly succeed,
 * because the cancel flag is still set and will stay set. Three sleeps and three guaranteed
 * failures per command variant, on a render that had already been told to stop.
 *
 * ── What this module is ──────────────────────────────────────────────────────────────────────
 *
 * One place that answers "what kind of failure was that, and may we try again". It has no
 * imports: the callers pass in what they know. It creates no second retry engine — the existing
 * loops keep their own shape, their own limits and their own backoff, and simply ask this before
 * sleeping.
 */

/** What kind of failure this was. Named for what it means, not for what threw it. */
export type ProviderFailureKind =
  | "RETRYABLE"
  | "CANCELLED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "PERMANENT"
  | "BUDGET_EXCEEDED";

/**
 * Was this a cancellation?
 *
 * Matched on the message because that is what `throwIfVideoGenerationCancelled` throws — a plain
 * Error with no marker on it. The wording is checked in two forms so a caller that wraps it
 * ("Aborted: … cancelled by the enclosing scene budget") is recognised too; both mean the same
 * thing here, which is that the work was called off and asking again cannot change that.
 */
export function isCancellationError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? String(err ?? "");
  return /video generation cancelled|cancelled by the enclosing|was cancelled|aborted:/i.test(msg);
}

/** Was this a deadline rather than a fault? */
export function isBudgetExhaustedError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? String(err ?? "");
  return /budget (exceeded|spent|exhausted)|deadline (exceeded|passed)|out of time/i.test(msg);
}

/**
 * Classify one failure.
 *
 * `status` is the HTTP status when there was one. A 429 is RATE_LIMITED whatever else is true of
 * it, because that classification is the whole point: it is the one failure the server itself
 * explained.
 */
export function classifyProviderFailure(params: {
  err?: unknown;
  status?: number;
}): ProviderFailureKind {
  const { status } = params;
  if (isCancellationError(params.err)) return "CANCELLED";
  if (isBudgetExhaustedError(params.err)) return "BUDGET_EXCEEDED";

  if (typeof status === "number" && status > 0) {
    if (status === 429) return "RATE_LIMITED";
    // 401/403/404 will answer the same way however often they are asked.
    if (status === 401 || status === 403 || status === 404) return "PERMANENT";
    if (status >= 500) return "RETRYABLE";
    if (status >= 400) return "PERMANENT";
  }

  const msg = (params.err as { message?: string })?.message ?? String(params.err ?? "");
  if (/timed? ?out|etimedout|timeout/i.test(msg)) return "TIMEOUT";
  return "RETRYABLE";
}

/** Only these are worth asking again. */
export function isRetryableFailure(kind: ProviderFailureKind): boolean {
  return kind === "RETRYABLE" || kind === "TIMEOUT";
}

export type RetryDecision = {
  retry: boolean;
  reason:
    | "OK"
    | "NOT_RETRYABLE"
    | "ATTEMPTS_EXHAUSTED"
    | "INSUFFICIENT_BUDGET";
  kind: ProviderFailureKind;
};

/**
 * May this operation be tried again?
 *
 * Three questions, in the order that makes the cheapest one first:
 *
 *  1. is the failure the kind that could go away — a cancellation and a 403 cannot;
 *  2. are there attempts left;
 *  3. is there enough time left for the retry to finish. A retry that is going to be cut off by
 *     the render deadline costs its wait AND its work and delivers nothing, which is how a render
 *     that is already late makes itself later.
 *
 * `remainingBudgetMs` omitted means the caller does not track one; the budget question is then
 * skipped rather than guessed at.
 */
export function shouldRetryAfterFailure(params: {
  kind: ProviderFailureKind;
  attempt: number;
  maxAttempts: number;
  waitMs?: number;
  estimatedCostMs?: number;
  remainingBudgetMs?: number;
}): RetryDecision {
  const { kind, attempt, maxAttempts } = params;
  if (!isRetryableFailure(kind)) return { retry: false, reason: "NOT_RETRYABLE", kind };
  if (attempt + 1 >= maxAttempts) return { retry: false, reason: "ATTEMPTS_EXHAUSTED", kind };

  const remaining = params.remainingBudgetMs;
  if (typeof remaining === "number" && Number.isFinite(remaining)) {
    const needed = (params.waitMs ?? 0) + (params.estimatedCostMs ?? 0);
    if (needed > remaining) return { retry: false, reason: "INSUFFICIENT_BUDGET", kind };
  }
  return { retry: true, reason: "OK", kind };
}

/** The line the pipeline logs when it decides NOT to retry. */
export function formatRetryGuard(params: {
  operation: string;
  attempt: number;
  maxAttempts: number;
  decision: RetryDecision;
  remainingBudgetMs?: number;
  estimatedCostMs?: number;
}): string {
  const { decision } = params;
  const budget =
    typeof params.remainingBudgetMs === "number"
      ? ` remainingBudget=${(params.remainingBudgetMs / 1000).toFixed(1)}s`
      : "";
  const cost =
    typeof params.estimatedCostMs === "number"
      ? ` estimatedCost=${(params.estimatedCostMs / 1000).toFixed(1)}s`
      : "";
  return (
    `[RetryGuard] ${params.operation} attempt=${params.attempt + 1}/${params.maxAttempts} ` +
    `failure=${decision.kind} retryable=${isRetryableFailure(decision.kind)}${budget}${cost} ` +
    `action=${decision.retry ? "RETRY" : "SKIP"} reason=${decision.reason}`
  );
}

/**
 * How long a provider should be left alone after one failure of this kind.
 *
 * Returns 0 for the kinds that carry no rate information — those keep the existing
 * three-strikes-then-cool-off behaviour, which is right for an ambiguous failure. A 429 is not
 * ambiguous and stands the provider down on the first one.
 *
 * `retryAfterSec` is honoured as a FLOOR when the server sent one, for the same reason as
 * RONDE 117: a provider's own hint is the minimum it will accept, not a promise about the next
 * request.
 */
export function cooldownMsForFailure(kind: ProviderFailureKind, retryAfterSec?: number | null): number {
  if (kind !== "RATE_LIMITED") return 0;
  const hintMs = Math.max(0, (retryAfterSec ?? 0) * 1000);
  const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
  return Math.max(hintMs, DEFAULT_RATE_LIMIT_COOLDOWN_MS);
}

/** The line the pipeline logs when a provider is stood down. */
export function formatProviderCooldown(provider: string, kind: ProviderFailureKind, ms: number): string {
  return (
    `[ProviderCooldown] provider=${provider} reason=${kind} ` +
    `standing down for ${Math.round(ms / 1000)}s — other providers are unaffected`
  );
}
