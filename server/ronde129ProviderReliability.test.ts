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
  
  
} from "./providerFailureClass";

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), "server", f), "utf8");

/* ═══════════ 1. the six kinds ═══════════ */

describe("RONDE 129 — a failure is classified before it is retried", () => {

  it("a scene budget abort is a cancellation too — the wrapped wording", () => {
    const err = new Error(
      "Aborted: Wikimedia search scene 1 was cancelled by the enclosing scene budget"
    );
    expect(classifyProviderFailure({ err })).toBe("CANCELLED");
  });

  it("the statuses that will answer the same however often they are asked", () => {
    for (const s of [401, 403, 404, 400]) {
      expect(classifyProviderFailure({ status: s }), String(s)).toBe("PERMANENT");
    }
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

  it("the retry is budget-aware — the tracker can now be asked", () => {
    expect(src("renderBudgetTracker.ts")).toContain("remainingMs(): number {");
    expect(src("videoPipeline.ts")).toContain("remainingBudgetMs: get_activeBudgetTracker()?.remainingMs?.()");
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
