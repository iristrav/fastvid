/**
 * RONDE 129 — "it failed" was one word for six different situations.
 *
 * Two production lines, the same missing distinction under both.
 *
 *     [Pipeline] Wikimedia imageinfo for scene 0: HTTP 429 Too Many Requests
 *                — counting as a provider failure
 *
 *     [Pipeline] Scene 4: fallback attempt 1 failed (transient) — retry 1/3 in 3.6s:
 *                Video generation cancelled
 *     [Pipeline] Scene 4: fallback attempt 1 failed (transient) — retry 2/3 in 7.1s:
 *                Video generation cancelled
 *
 * The first counted a 429 as one of three anonymous failures, so two more requests went into a
 * server that had already said stop. The second called a CANCELLED render "transient" and slept
 * four seconds before asking again for something that cannot succeed while the cancel flag is
 * set — three times, per command variant, on a render already told to stop.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  classifyProviderFailure,
  cooldownMsForFailure,
  formatProviderCooldown,
  formatRetryGuard,
  isBudgetExhaustedError,
  isCancellationError,
  isRetryableFailure,
  shouldRetryAfterFailure,
} from "./providerFailureClass";

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), "server", f), "utf8");

/* ═══════════ 1. the six kinds ═══════════ */

describe("RONDE 129 — a failure is classified before it is retried", () => {
  it("THE PRODUCTION CASE: a cancelled render is CANCELLED, not transient", () => {
    // The exact string throwIfVideoGenerationCancelled throws.
    const err = new Error("Video generation cancelled");
    expect(isCancellationError(err)).toBe(true);
    expect(classifyProviderFailure({ err })).toBe("CANCELLED");
    expect(isRetryableFailure("CANCELLED")).toBe(false);
  });

  it("a scene budget abort is a cancellation too — the wrapped wording", () => {
    const err = new Error(
      "Aborted: Wikimedia search scene 1 was cancelled by the enclosing scene budget"
    );
    expect(classifyProviderFailure({ err })).toBe("CANCELLED");
  });

  it("THE OTHER PRODUCTION CASE: 429 is RATE_LIMITED, whatever else is true of it", () => {
    expect(classifyProviderFailure({ status: 429 })).toBe("RATE_LIMITED");
    expect(isRetryableFailure("RATE_LIMITED")).toBe(false);
  });

  it("the statuses that will answer the same however often they are asked", () => {
    for (const s of [401, 403, 404, 400]) {
      expect(classifyProviderFailure({ status: s }), String(s)).toBe("PERMANENT");
    }
  });

  it("a 5xx and a timeout are the two that are worth asking again", () => {
    expect(classifyProviderFailure({ status: 503 })).toBe("RETRYABLE");
    expect(classifyProviderFailure({ err: new Error("socket timed out") })).toBe("TIMEOUT");
    expect(isRetryableFailure("RETRYABLE")).toBe(true);
    expect(isRetryableFailure("TIMEOUT")).toBe(true);
  });

  it("a spent budget is its own kind, never a retry", () => {
    expect(isBudgetExhaustedError(new Error("render budget exceeded"))).toBe(true);
    expect(classifyProviderFailure({ err: new Error("deadline exceeded") })).toBe("BUDGET_EXCEEDED");
    expect(isRetryableFailure("BUDGET_EXCEEDED")).toBe(false);
  });
});

/* ═══════════ 2. the retry decision ═══════════ */

describe("RONDE 129 — three questions before a retry", () => {
  it("REGRESSION: a cancellation is never retried, on any attempt", () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const d = shouldRetryAfterFailure({ kind: "CANCELLED", attempt, maxAttempts: 4 });
      expect(d.retry, `attempt ${attempt}`).toBe(false);
      expect(d.reason).toBe("NOT_RETRYABLE");
    }
  });

  it("a real transient failure IS retried while attempts remain", () => {
    expect(shouldRetryAfterFailure({ kind: "RETRYABLE", attempt: 0, maxAttempts: 4 }).retry).toBe(true);
    expect(shouldRetryAfterFailure({ kind: "TIMEOUT", attempt: 2, maxAttempts: 4 }).retry).toBe(true);
  });

  it("...and stops at the limit — retries stay bounded", () => {
    const d = shouldRetryAfterFailure({ kind: "RETRYABLE", attempt: 3, maxAttempts: 4 });
    expect(d.retry).toBe(false);
    expect(d.reason).toBe("ATTEMPTS_EXHAUSTED");
  });

  it("CRITICAL: a retry that cannot finish in the remaining budget is not started", () => {
    /**
     * A retry cut off by the render deadline costs its wait AND its work and delivers nothing —
     * which is how a render that is already late makes itself later.
     */
    const d = shouldRetryAfterFailure({
      kind: "RETRYABLE",
      attempt: 1,
      maxAttempts: 4,
      waitMs: 8_000,
      estimatedCostMs: 45_000,
      remainingBudgetMs: 8_200,
    });
    expect(d.retry).toBe(false);
    expect(d.reason).toBe("INSUFFICIENT_BUDGET");
  });

  it("...and one that CAN finish still runs", () => {
    const d = shouldRetryAfterFailure({
      kind: "RETRYABLE", attempt: 1, maxAttempts: 4,
      waitMs: 8_000, estimatedCostMs: 45_000, remainingBudgetMs: 120_000,
    });
    expect(d.retry).toBe(true);
  });

  it("a caller with no budget to report is not guessed at", () => {
    expect(
      shouldRetryAfterFailure({ kind: "RETRYABLE", attempt: 0, maxAttempts: 4, estimatedCostMs: 45_000 }).retry
    ).toBe(true);
  });

  it("the guard line says which of the three questions failed", () => {
    const decision = shouldRetryAfterFailure({
      kind: "CANCELLED", attempt: 1, maxAttempts: 4,
    });
    const line = formatRetryGuard({
      operation: "colorFallback s4 variant 1", attempt: 1, maxAttempts: 4,
      decision, remainingBudgetMs: 8_200, estimatedCostMs: 45_000,
    });
    expect(line).toContain("[RetryGuard]");
    expect(line).toContain("failure=CANCELLED");
    expect(line).toContain("retryable=false");
    expect(line).toContain("action=SKIP");
    expect(line).toContain("reason=NOT_RETRYABLE");
    expect(line).toContain("remainingBudget=8.2s");
  });
});

/* ═══════════ 3. one 429 is enough ═══════════ */

describe("RONDE 129 — Wikimedia stands down on the first 429, not the third", () => {
  it("only a rate limit produces a cooldown from a single failure", () => {
    expect(cooldownMsForFailure("RATE_LIMITED")).toBeGreaterThanOrEqual(60_000);
    // The ambiguous kinds keep the existing three-strikes behaviour.
    for (const k of ["RETRYABLE", "TIMEOUT", "PERMANENT", "CANCELLED", "BUDGET_EXCEEDED"] as const) {
      expect(cooldownMsForFailure(k), k).toBe(0);
    }
  });

  it("the server's own Retry-After is a floor, not a ceiling", () => {
    // RONDE 117's rule, applied here: a provider's hint is the minimum it will accept.
    expect(cooldownMsForFailure("RATE_LIMITED", 300)).toBe(300_000);
    expect(cooldownMsForFailure("RATE_LIMITED", 5)).toBe(60_000);
  });

  it("REGRESSION: the breaker is wired to the status", () => {
    const p = src("videoPipeline.ts");
    // The status now reaches the breaker, not only the log line.
    expect(p).toContain("function markWikimediaRateLimited(status?: number): void");
    expect(p).toContain("const kind = classifyProviderFailure({ status });");
    expect(p).toContain("const rateCooldownMs = cooldownMsForFailure(kind);");
    expect(p).toContain('markWikimediaRateLimited(typeof resp.status === "number" ? resp.status : undefined);');
    /**
     * The stand-down is SEPARATE from the failure counter, and that separation is load-bearing:
     * every caller of the log site already calls markWikimediaSearchResult(false), so counting in
     * both places tripped RONDE 69's three-strike breaker after two requests. Caught by that
     * round's own test, which is why it is asserted here.
     */
    expect(p).toContain("function markWikimediaSearchResult(success: boolean): void");
    const rateFn = p.slice(p.indexOf("function markWikimediaRateLimited("), p.indexOf("function markWikimediaSearchResult("));
    expect(rateFn).not.toContain("wikimediaFailureStreak++");
  });

  it("the three-strike streak still exists for the ambiguous failures", () => {
    const p = src("videoPipeline.ts");
    expect(p).toContain("wikimediaFailureStreak++");
    expect(p).toContain("wikimediaFailureStreak >= WIKIMEDIA_FAILURE_STREAK_TRIP");
  });

  it("the cooldown line says the other providers are unaffected", () => {
    const line = formatProviderCooldown("wikimedia", "RATE_LIMITED", 60_000);
    expect(line).toContain("[ProviderCooldown] provider=wikimedia");
    expect(line).toContain("reason=RATE_LIMITED");
    expect(line).toMatch(/other providers are unaffected/);
  });

  it("provider isolation: each provider has its OWN cooldown state", () => {
    /**
     * One provider standing down must not take the ladder with it. These are separate
     * module-level timers, one per provider, and this counts them rather than assuming it.
     */
    const p = src("videoPipeline.ts");
    for (const v of ["wikimediaCooldownUntilMs", "internetArchiveCooldownUntilMs"]) {
      expect(p, v).toContain(v);
    }
    const isInCooldownFns = (p.match(/function is\w+InCooldown\(\)/g) ?? []).length;
    expect(isInCooldownFns).toBeGreaterThan(5);
  });
});

/* ═══════════ 4. the fallback ladder ═══════════ */

describe("RONDE 129 — the colour fallback no longer retries a cancelled render", () => {
  it("REGRESSION: the retry loop asks the classifier instead of saying 'transient'", () => {
    const p = src("videoPipeline.ts");
    const fn = p.slice(p.indexOf("const FALLBACK_RETRIES = 4;"), p.indexOf("const FALLBACK_RETRIES = 4;") + 4000);
    expect(fn).toContain("const decision = shouldRetryAfterFailure({");
    expect(fn).toContain("kind: classifyProviderFailure({ err }),");
    // The blanket "transient" label is gone.
    expect(fn).not.toContain('`(${forkPressure ? "fork pressure" : "transient"})`');
  });

  it("a cancellation ends the whole ladder, not just this variant", () => {
    /**
     * Every remaining command variant would throw the same thing, so continuing to the next one
     * is the same waste one level up.
     */
    const p = src("videoPipeline.ts");
    expect(p).toContain('if (decision.kind === "CANCELLED" || decision.kind === "BUDGET_EXCEEDED") throw err;');
  });

  it("the retry is budget-aware — the tracker can now be asked", () => {
    expect(src("renderBudgetTracker.ts")).toContain("remainingMs(): number {");
    expect(src("videoPipeline.ts")).toContain("remainingBudgetMs: get_activeBudgetTracker()?.remainingMs?.()");
  });

  it("fork pressure is still recognised and still retried", () => {
    // The original reason this loop retried hard at all — unchanged.
    const p = src("videoPipeline.ts");
    expect(p).toContain("const forkPressure = isForkPressureError(err);");
  });
});

/* ═══════════ 5. nothing earlier is disturbed ═══════════ */

describe("RONDE 129 — earlier provider work intact", () => {
  it("the LLM provider cooldowns are untouched", async () => {
    const llm = await import("./_core/llm");
    expect(typeof llm.markGroqCooldown).toBe("function");
    expect(typeof llm.markGeminiCooldown).toBe("function");
    expect(typeof llm.markOpenAiCooldown).toBe("function");
    // RONDE 120: 403 is provider-unavailable and falls through.
    expect(llm.isProviderCapacityFailure(403, "PERMISSION_DENIED")).toBe(true);
    expect(llm.shouldFallbackToNextProvider(403, "PERMISSION_DENIED")).toBe(true);
  });

  it("RONDE 128's still policy is untouched", async () => {
    const { MAX_STILL_IMAGE_DURATION_SEC, containCenterFilter } = await import("./stillImagePolicy");
    expect(MAX_STILL_IMAGE_DURATION_SEC).toBe(5);
    expect(containCenterFilter({ widthPx: 1920, heightPx: 1080 })).toContain(
      "force_original_aspect_ratio=decrease"
    );
  });
});
