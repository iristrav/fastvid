/**
 * RONDE 120 — the three cool-offs that were wrong, all found in one worker log.
 *
 * Render 543, three seconds in, on a worker whose keys were all present
 * (`LLM (worker): provider=openai, gemini=true, groq=true, openai=true`):
 *
 *   16:42:10  [LLM] OpenAI quota exhausted — skipping OpenAI for remainder of process lifetime.
 *   16:42:10  [LLM] Gemini failed: Gemini API error 403: PERMISSION_DENIED
 *   16:42:11  [LLM] Succeeded via groq after openai failure
 *   16:42:18  [LLM] Groq daily token budget exhausted — standing down for 60min
 *   16:42:33  [LLM] chain exhausted — every provider out of capacity: groq 429, gemini 429
 *   16:42:36  [Video Generation] Script generation failed for video 543 — script: MISSING
 *
 * The FIRST call of the process removed the only paid provider for the lifetime of a worker that
 * stays up for days. What was left were two free tiers: Groq, whose day ran out fourteen seconds
 * later, and Gemini, whose free tier is twenty requests per day and which was being re-asked every
 * sixty seconds.
 *
 * Every body below is copied from that log.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetProviderCooldownsForTests,
  invokeLLM,
  isGeminiInCooldown,
  isLlmProviderUnavailable,
  isOpenAiInCooldown,
  isProviderCapacityFailure,
  markGeminiCooldown,
  markOpenAiCooldown,
  shouldFallbackToNextProvider,
} from "./_core/llm";

/** Gemini's answer that ended render 543 — twenty requests per DAY, "retry in 29s". */
const GEMINI_TPD_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      "You exceeded your current quota, please check your plan and billing details. For more " +
      "information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. " +
      "\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, " +
      "limit: 20, model: gemini-3.6-flash\nPlease retry in 29.141733906s.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            quotaDimensions: { location: "global", model: "gemini-3.6-flash" },
            quotaValue: "20",
          },
        ],
      },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "29s" },
    ],
  },
});

/** A Gemini per-MINUTE limit — the case whose handling must not change. */
const GEMINI_RPM_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      "Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_model, " +
      "limit: 10, model: gemini-3.6-flash. Please retry in 6s.",
    status: "RESOURCE_EXHAUSTED",
  },
});

/** Gemini's 403 from the same log. */
const GEMINI_403_BODY = JSON.stringify({
  error: { code: 403, message: "Your project has been denied access. Please contact support.", status: "PERMISSION_DENIED" },
});

/** OpenAI's spent-account answer — the wording markOpenAiCooldown keys on. */
const OPENAI_QUOTA_BODY = JSON.stringify({
  error: {
    message: "You exceeded your current quota, please check your plan and billing details.",
    type: "insufficient_quota",
    code: "insufficient_quota",
  },
});

const ENV_KEYS = [
  "GROQ_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "LLM_API_KEY",
  "BUILT_IN_FORGE_API_KEY", "BUILT_IN_FORGE_API_URL", "LLM_PROVIDER", "LLM_BUDGET_ENFORCE",
];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let calls: string[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.LLM_BUDGET_ENFORCE = "false";
  __resetProviderCooldownsForTests();
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  __resetProviderCooldownsForTests();
});

/**
 * How much cool-off is left, probed by bisection against the module clock.
 * Same technique as RONDE 117 — the timestamps are deliberately not exported.
 */
function remainingMs(isCool: () => boolean, since: number): number {
  const elapsed = Date.now() - since;
  let lo = 0;
  let hi = 24 * 60 * 60_000;
  const original = Date.now;
  try {
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      Date.now = () => original.call(Date) + mid;
      if (isCool()) lo = mid;
      else hi = mid;
    }
  } finally {
    Date.now = original;
  }
  return lo + elapsed;
}

function stubFetch(replies: { gemini?: { status: number; body: string }; openai?: { status: number; body: string }; groq?: { status: number; body: string } }): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    const who = url.includes("generativelanguage") ? "gemini" : url.includes("api.groq.com") ? "groq" : "openai";
    calls.push(who);
    const r = replies[who as "gemini" | "openai" | "groq"];
    if (!r) throw new Error(`test stub: no reply for ${who}`);
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
}

/* ═══════════ 1. OpenAI: "for remainder of process lifetime" ═══════════ */

describe("RONDE 120 — the paid provider comes back", () => {
  it("REGRESSION: a spent OpenAI quota is a cool-off, not a life sentence", () => {
    /**
     * The old code set `openAiQuotaExhausted = true` with nothing anywhere to set it back. On a
     * Railway worker that is the rest of the deploy: topping up the account could not restore it
     * without a redeploy, and the log line said so out loud.
     */
    const before = Date.now();
    markOpenAiCooldown(429, OPENAI_QUOTA_BODY);
    expect(isOpenAiInCooldown()).toBe(true);

    const remaining = remainingMs(isOpenAiInCooldown, before);
    // Long enough not to hammer a dead account...
    expect(remaining).toBeGreaterThan(25 * 60_000);
    // ...and emphatically NOT forever.
    expect(remaining).toBeLessThan(60 * 60_000);
  });

  it("it really does expire — OpenAI is back in the chain afterwards", async () => {
    markOpenAiCooldown(429, OPENAI_QUOTA_BODY);
    process.env.OPENAI_API_KEY = "stub-openai";
    stubFetch({ openai: { status: 200, body: JSON.stringify({
      id: "x", created: 1, model: "gpt-4o",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    }) } });

    // While cooled down, nothing is sent at all.
    await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 50 }).catch(() => undefined);
    expect(calls).toHaveLength(0);

    // An hour later the flag is gone and the paid provider is used again.
    const original = Date.now;
    try {
      Date.now = () => original.call(Date) + 60 * 60_000;
      const result = await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 50 });
      expect(result.provider).toBe("openai");
    } finally {
      Date.now = original;
    }
    expect(calls).toEqual(["openai"]);
  }, 30_000);

  it("an ordinary OpenAI rate limit now cools down too — it had no cool-off at all before", () => {
    const before = Date.now();
    markOpenAiCooldown(429, "Rate limit reached for gpt-4o. Please try again in 20s.");
    const remaining = remainingMs(isOpenAiInCooldown, before);
    expect(remaining).toBeGreaterThan(30_000);
    // ...but a burst must never be given the spent-account treatment.
    expect(remaining).toBeLessThan(5 * 60_000);
  });

  it("a non-rate-limit failure sets no cool-off", () => {
    markOpenAiCooldown(500, "upstream exploded");
    expect(isOpenAiInCooldown()).toBe(false);
  });
});

/* ═══════════ 2. Gemini: twenty requests per DAY, retried every minute ═══════════ */

describe("RONDE 120 — Gemini's day is not Gemini's minute", () => {
  it("REGRESSION: the free-tier DAILY quota gets an hour, not sixty seconds", () => {
    /**
     * quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier, quotaValue 20. The body's own
     * advice is "retry in 29.141733906s", and the old code's flat 60s cool-off meant the whole
     * discovery — two in-call retries, twelve seconds of sleeping, then the chain — repeated every
     * minute for the rest of the day.
     */
    const before = Date.now();
    markGeminiCooldown(429, GEMINI_TPD_BODY);
    const remaining = remainingMs(isGeminiInCooldown, before);
    expect(remaining).toBeGreaterThan(55 * 60_000);
    // The 29-second hint is a floor, never a ceiling — RONDE 117's rule, applied here.
    expect(remaining).toBeGreaterThan(29_000);
  });

  it("a per-MINUTE Gemini limit is unchanged — it still gets about a minute", () => {
    const before = Date.now();
    markGeminiCooldown(429, GEMINI_RPM_BODY);
    const remaining = remainingMs(isGeminiInCooldown, before);
    expect(remaining).toBeGreaterThan(30_000);
    expect(remaining).toBeLessThan(5 * 60_000);
  });

  it("a spent DAY skips the in-call retries instead of sleeping twelve seconds for nothing", async () => {
    process.env.GEMINI_API_KEY = "stub-gemini";
    stubFetch({ gemini: { status: 429, body: GEMINI_TPD_BODY } });

    const started = Date.now();
    await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 50 }).catch(() => undefined);
    // One attempt, not three: the 4s and 8s sleeps cannot help a quota that resets tomorrow.
    expect(calls).toEqual(["gemini"]);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 30_000);

  it("a per-minute limit KEEPS its retries — the saving must not cost the recovery", async () => {
    process.env.GEMINI_API_KEY = "stub-gemini";
    stubFetch({ gemini: { status: 429, body: GEMINI_RPM_BODY } });
    await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 50 }).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(1);
  }, 60_000);
});

/* ═══════════ 3. the 403 nobody handled ═══════════ */

describe("RONDE 120 — PERMISSION_DENIED is an answer about the provider", () => {
  it("403 counts as provider-unavailable, so it is never a failed judgement", () => {
    expect(isProviderCapacityFailure(403, GEMINI_403_BODY)).toBe(true);
  });

  it("REGRESSION: a 403 no longer ends the chain — it falls through to the next provider", () => {
    /**
     * `shouldFallbackToNextProvider` knew 429, 404, 413 and 5xx. 403 was in none of them, so an
     * OpenAI-compatible provider answering PERMISSION_DENIED hit `throw lastError` with the rest
     * of the chain untouched. Gemini escaped it only because it is called from a different
     * function that continues on any error.
     */
    expect(shouldFallbackToNextProvider(403, GEMINI_403_BODY)).toBe(true);
  });

  it("it really falls through: a 403 from OpenAI still reaches Gemini", async () => {
    process.env.OPENAI_API_KEY = "stub-openai";
    process.env.GEMINI_API_KEY = "stub-gemini";
    process.env.LLM_PROVIDER = "openai";
    stubFetch({
      openai: { status: 403, body: GEMINI_403_BODY },
      gemini: { status: 200, body: JSON.stringify({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }],
      }) },
    });

    const result = await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 50 });
    expect(calls).toEqual(["openai", "gemini"]);
    expect(result.provider).toBe("gemini");
  }, 30_000);

  it("a refused Gemini project is cooled down instead of retried on every single call", () => {
    const before = Date.now();
    markGeminiCooldown(403, GEMINI_403_BODY);
    const remaining = remainingMs(isGeminiInCooldown, before);
    expect(remaining).toBeGreaterThan(60_000);
    /**
     * ...but only minutes. The same log shows Gemini answering 403 twice and then serving real
     * quota errors seconds later, so the denial was not permanent — an hour-long stand-down would
     * have removed a provider that was in fact partly working.
     */
    expect(remaining).toBeLessThan(30 * 60_000);
  });
});

/* ═══════════ 4. the whole log, replayed ═══════════ */

describe("RONDE 120 — render 543, once through", () => {
  it("every provider exhausted still reports unavailable, and every cool-off is armed", async () => {
    process.env.OPENAI_API_KEY = "stub-openai";
    process.env.GEMINI_API_KEY = "stub-gemini";
    process.env.LLM_PROVIDER = "openai";
    stubFetch({
      openai: { status: 429, body: OPENAI_QUOTA_BODY },
      gemini: { status: 429, body: GEMINI_TPD_BODY },
    });

    const err = await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 50 })
      .then(() => null)
      .catch((e: unknown) => e);

    // RONDE 119's classification still holds for the combination.
    expect(isLlmProviderUnavailable(err)).toBe(true);
    // Both providers stood down — so the NEXT render does not repeat this discovery...
    expect(isOpenAiInCooldown()).toBe(true);
    expect(isGeminiInCooldown()).toBe(true);
    // ...and neither stood down for good.
    const openAiLeft = remainingMs(isOpenAiInCooldown, Date.now());
    const geminiLeft = remainingMs(isGeminiInCooldown, Date.now());
    expect(openAiLeft).toBeLessThan(2 * 60 * 60_000);
    expect(geminiLeft).toBeLessThan(2 * 60 * 60_000);
  }, 60_000);
});
