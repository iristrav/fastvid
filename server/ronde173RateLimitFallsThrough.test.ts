/**
 * RONDE 173 — a hundred and forty-five seconds spent waiting for a provider while another one was
 * free.
 *
 * ── What render 555 measured ─────────────────────────────────────────────────────────────────
 *
 *     10:37:34 → 10:42:18, in a four-minute-forty-four window:
 *
 *       26 × [LLM] groq rate limit (attempt N/4) — retry in Ns      ← 145 seconds of sleep
 *        9 × [LLM] Succeeded via groq (after N rate-limit retries)
 *        1 × [LLM] groq failed (429) — falling back to openai
 *        1 × [LLM] Succeeded via openai after groq failure
 *
 * Twenty-three of the twenty-six were "attempt 1/4" — a first try, refused, and then slept on. The
 * last two lines are what makes that a bug rather than bad luck: OpenAI was in the chain, healthy,
 * and served a Groq-refused call in this same render.
 *
 * ── The rule that already said so ────────────────────────────────────────────────────────────
 *
 * RONDE 129 classified this exact failure and wrote the answer down:
 *
 *     classifyProviderFailure({ status: 429 })  →  "RATE_LIMITED"
 *     isRetryableFailure("RATE_LIMITED")        →  false
 *
 * and `shouldFallbackToNextProvider(429, …)` has returned true since it was written. Both agreed.
 * The sleep in invokeLLM was the one place that did not — and because it sat ABOVE the fallback
 * branch, it won every time.
 *
 * ── What is kept ─────────────────────────────────────────────────────────────────────────────
 *
 * The retry, for the one case where R129's rule would strand a render instead of speeding it up: a
 * chain with nobody left to ask, where waiting is the only alternative to failing the call. A
 * deployment with a single provider key behaves exactly as it did before.
 *
 * ── What this does NOT claim ─────────────────────────────────────────────────────────────────
 *
 * A wall-clock saving. 145 seconds is the sleep those 26 lines account for, and several of them
 * overlap — two pairs share a timestamp to the millisecond, so some of that waiting was concurrent.
 * What is exactly measurable is what the code now does: zero sleeps where a fallback exists, and
 * the same sleeps as before where none does.
 */
import { describe, expect, it } from "vitest";

import { rateLimitSleepSeconds, shouldFallbackToNextProvider } from "./_core/llm";
import { classifyProviderFailure, isRetryableFailure } from "./providerFailureClass";

/** Render 555's own case: Groq 429, an 8.5-second hint, first attempt. */
const groq429 = (over: Partial<Parameters<typeof rateLimitSleepSeconds>[0]> = {}) =>
  rateLimitSleepSeconds({
    status: 429,
    attempt: 0,
    retryAfterSec: 9,
    skipProviderRetries: false,
    nextProviderAvailable: false,
    ...over,
  });

describe("RONDE 173 — a rate limit falls through to the next provider instead of sleeping", () => {
  it("the bug: with OpenAI waiting in the chain, the call slept anyway", () => {
    // The only thing that differs between these two is whether anyone else could serve the call.
    expect(groq429({ nextProviderAvailable: false })).toBe(9);
    expect(groq429({ nextProviderAvailable: true })).toBeNull();
  });

  it("all twenty-six of render 555's sleeps are gone, and none of them were the last resort", () => {
    /**
     * The log's own distribution: 23 first attempts and 3 seconds, every one of them made while
     * OpenAI was in the chain — the render proved it by falling back to OpenAI successfully.
     */
    const hints = [2, 3, 3, 4, 4, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7, 7, 8, 9, 10];
    const withFallback = hints.map((h) => groq429({ retryAfterSec: h, nextProviderAvailable: true }));
    expect(withFallback.every((w) => w === null)).toBe(true);
    // And the same render on a single-provider deployment still waits exactly as it used to.
    const alone = hints.map((h) => groq429({ retryAfterSec: h }));
    expect(alone).toEqual(hints);
  });

  it("the last resort is kept — a chain with nobody left still waits rather than fails", () => {
    // R129's rule taken literally would refuse this too, and a groq-only deployment would simply
    // lose the call. Waiting is the only alternative to failing here, so waiting stays.
    expect(groq429({ attempt: 0 })).toBe(9);
    expect(groq429({ attempt: 2 })).toBe(9);
  });

  it("this is the classification R129 already made, applied where it was not", () => {
    expect(classifyProviderFailure({ status: 429 })).toBe("RATE_LIMITED");
    expect(isRetryableFailure("RATE_LIMITED")).toBe(false);
    // ...and the fallback predicate has always agreed that a 429 should move on.
    expect(shouldFallbackToNextProvider(429, "rate limit reached")).toBe(true);
  });
});

describe("RONDE 173 — every other guard on that branch is untouched", () => {
  it("the four-attempt ceiling still holds", () => {
    expect(groq429({ attempt: 3 })).toBeNull();
    expect(groq429({ attempt: 9 })).toBeNull();
  });

  it("a hint longer than two minutes is still not waited out", () => {
    // RONDE 116/117: a long hint means a quota window, not a burst. Falling through is the answer.
    expect(groq429({ retryAfterSec: 121 })).toBeNull();
    expect(groq429({ retryAfterSec: 1431 })).toBeNull();
    // 120 is the last hint still inside the window, and the 90s ceiling below then trims it.
    expect(groq429({ retryAfterSec: 120 })).toBe(90);
  });

  it("the ninety-second ceiling on the sleep itself still holds", () => {
    expect(groq429({ retryAfterSec: 100 })).toBe(90);
  });

  it("no hint at all is still not a reason to guess a wait", () => {
    expect(groq429({ retryAfterSec: null })).toBeNull();
  });

  it("skipProviderRetries still wins — an oversize payload and a spent day never sleep", () => {
    // RONDE 116's 413 and RONDE 117's daily quota both arrive here through this flag.
    expect(groq429({ skipProviderRetries: true })).toBeNull();
    expect(groq429({ skipProviderRetries: true, nextProviderAvailable: false })).toBeNull();
  });

  it("a failure that is not a rate limit never reaches the sleep at all", () => {
    for (const status of [200, 400, 403, 404, 413, 500, 503]) {
      expect(groq429({ status }), `status=${status}`).toBeNull();
    }
    expect(groq429({ status: 429 })).toBe(9);
  });

  it("the decision is total — every input combination gives a wait or a null, never a throw", () => {
    for (const status of [429, 500])
      for (const attempt of [0, 3])
        for (const retryAfterSec of [null, 5, 500])
          for (const skipProviderRetries of [true, false])
            for (const nextProviderAvailable of [true, false]) {
              const out = rateLimitSleepSeconds({
                status, attempt, retryAfterSec, skipProviderRetries, nextProviderAvailable,
              });
              expect(out === null || (out > 0 && out <= 90)).toBe(true);
            }
  });
});
