/**
 * A GROQ TOKEN BUDGET IS NOT WHY AN IMAGE CALL FAILED.
 *
 * ── The render this comes from ───────────────────────────────────────────────────────────────
 *
 *     Render rejected — the picture editor was unreachable and this video contains footage nobody
 *     judged: 9 of 13 beat(s) with real footage received no verdict (s2b0, s2b1, s1b0, …), after
 *     128 judgement(s) were declined for want of a vision provider.
 *     [BeatImageGate] no verdict: 102x gate could not ask: Groq's daily token budget is spent and
 *     no other provider is available
 *
 * The refusal is correct and stays: nine beats carried footage nobody looked at, and RONDE 89's
 * rule is that such a render must not ship. What was wrong is the SIGNPOST.
 *
 * `invokeLLM` removes Groq from every vision chain — its vision models 404 — so for an image call
 * Groq is not a candidate at all and its daily budget says nothing about why the call failed. The
 * daily-budget branch nevertheless came first and fired on `groqKey && isGroqDailyExhausted()`
 * without asking whether this was a vision call. So an operator was sent to a Groq quota page,
 * when the condition was "no vision-capable provider is configured" and would have been identical
 * with a full Groq budget.
 *
 * RONDE 119 wrote the correct branch for exactly this. It sat below the daily one and was
 * unreachable whenever Groq's day happened to be spent — which is precisely when a render notices.
 *
 * This is the same failure RONDE 117 fixed for text calls ("API key is not configured", with the
 * key plainly set), still standing on the path the picture editor uses.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetProviderCooldownsForTests,
  invokeLLM,
  isGroqDailyExhausted,
  isLlmPreflightRefusal,
  markGroqCooldown,
} from "./_core/llm";

/** The verbatim production body — a tokens-per-day refusal. */
const TPD_BODY = JSON.stringify({
  error: {
    message:
      "Rate limit reached for model `openai/gpt-oss-20b` in organization `org_x` service tier " +
      "`on_demand` on tokens per day (TPD): Limit 200000, Used 199683, Requested 3630. " +
      "Please try again in 23m51.216s.",
    type: "tokens",
    code: "rate_limit_exceeded",
  },
});

const ENV_KEYS = [
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "BUILT_IN_FORGE_API_KEY",
  "LLM_BUDGET_ENFORCE",
];

const saved: Record<string, string | undefined> = {};

/** One image part is all `messagesIncludeImages` looks for. */
const visionMessages = [
  {
    role: "user" as const,
    content: [
      { type: "text" as const, text: "does this picture belong under this sentence?" },
      { type: "image_url" as const, image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
    ],
  },
];

const textMessages = [{ role: "user" as const, content: "x" }];

const onlyGroqConfiguredAndSpent = () => {
  markGroqCooldown(429, TPD_BODY);
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.LLM_BUDGET_ENFORCE = "false";
  process.env.GROQ_API_KEY = "stub";
};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  __resetProviderCooldownsForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetProviderCooldownsForTests();
});

describe("an image call names the vision cause, whatever Groq's day looks like", () => {
  it("the refusal does not blame Groq's token budget", async () => {
    onlyGroqConfiguredAndSpent();
    expect(isGroqDailyExhausted()).toBe(true);

    const err = await invokeLLM({ messages: visionMessages, maxTokens: 100 })
      .then(() => null)
      .catch((e: Error) => e);

    expect(String(err?.message)).toContain("No vision-capable provider is available");
    expect(String(err?.message)).not.toMatch(/^Groq's daily token budget is spent/);
  }, 30_000);

  it("it says which key to set", async () => {
    onlyGroqConfiguredAndSpent();
    const err = await invokeLLM({ messages: visionMessages, maxTokens: 100 })
      .then(() => null)
      .catch((e: Error) => e);
    expect(String(err?.message)).toContain("GEMINI_API_KEY");
    expect(String(err?.message)).toContain("LLM_API_KEY");
  }, 30_000);

  it("the spent budget is still mentioned, as the aside it is", async () => {
    /** Hiding it would be its own wrong signpost: an operator watching Groq should still see it. */
    onlyGroqConfiguredAndSpent();
    const err = await invokeLLM({ messages: visionMessages, maxTokens: 100 })
      .then(() => null)
      .catch((e: Error) => e);
    expect(String(err?.message)).toContain("does not affect image calls");
  }, 30_000);

  it("with a full Groq budget the image call fails the same way", async () => {
    /**
     * The point of the whole change: the condition is "no vision provider", and it does not depend
     * on Groq's quota. Both paths must reach the same sentence.
     */
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.LLM_BUDGET_ENFORCE = "false";
    process.env.GROQ_API_KEY = "stub";
    expect(isGroqDailyExhausted()).toBe(false);

    const err = await invokeLLM({ messages: visionMessages, maxTokens: 100 })
      .then(() => null)
      .catch((e: Error) => e);
    expect(String(err?.message)).toContain("No vision-capable provider is available");
    expect(String(err?.message)).not.toContain("does not affect image calls");
  }, 30_000);

  it("it stays a pre-flight refusal, so the gate still records never-asked", async () => {
    /**
     * `beatImageRelevanceGate` takes the attempt back and files `judgementsProviderUnavailable`
     * on this classification. Losing it would turn "nobody looked" into "the model was asked and
     * could not answer" — two findings that need entirely different work.
     */
    onlyGroqConfiguredAndSpent();
    const err = await invokeLLM({ messages: visionMessages, maxTokens: 100 })
      .then(() => null)
      .catch((e: Error) => e);
    expect(isLlmPreflightRefusal(err)).toBe(true);
  }, 30_000);
});

describe("a text call keeps the daily-budget message, which is the truth for it", () => {
  it("the wording RONDE 117 wrote is unchanged", async () => {
    onlyGroqConfiguredAndSpent();
    const err = await invokeLLM({ messages: textMessages, maxTokens: 100 })
      .then(() => null)
      .catch((e: Error) => e);
    expect(String(err?.message)).toContain("Groq's daily token budget is spent");
    expect(String(err?.message)).toContain("wait for Groq's daily quota to reset");
  }, 30_000);

  it("and it is still not blamed on a missing key", async () => {
    onlyGroqConfiguredAndSpent();
    const err = await invokeLLM({ messages: textMessages, maxTokens: 100 })
      .then(() => null)
      .catch((e: Error) => e);
    expect(String(err?.message)).not.toContain("API key is not configured");
  }, 30_000);
});
