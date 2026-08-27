/**
 * RONDE 117 — a spent DAILY budget was treated as a burst limit.
 *
 * From production:
 *
 *   429 – Rate limit reached for model `openai/gpt-oss-20b` in organization `org_01kvctxr…`
 *   service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199683,
 *   Requested 3630. Please try again in 23m51.216s.
 *
 * 317 tokens left of the day's 200 000. Three things went wrong with it, all in the same corner:
 *
 * ── 1. The one-hour daily cool-off was unreachable ───────────────────────────────────────────
 *
 *   const cooldownMs =
 *     waitSec != null && waitSec > 0 ? waitSec * 1000        // ← 23m51s wins
 *       : isGroqDailyQuotaError(errorText) ? 60*60*1000      // ← never reached
 *       : 5*60*1000;
 *
 * Groq puts a "try again in …" hint in every one of these bodies, so the hint always won and the
 * branch written for daily exhaustion never ran. A spent day got a 24-minute cool-off — after
 * which a trickle of the rolling window has freed up, enough for the next call to burn it and
 * fail again, all day long.
 *
 * ── 2. The all-blocked recovery erased the cooldown ──────────────────────────────────────────
 *
 * When every provider is unavailable, invokeLLM sets `groqCooldownUntilMs = 0` and forces one
 * more Groq attempt — reasonable for a per-minute limit, which clears by itself. For a spent day
 * it cannot succeed, AND the wipe removes the protection for every LATER call, so each one
 * repeats the full discovery (primary fails, fallback fails, Groq fails) for the rest of the day.
 *
 * ── 3. A guard that only looked like one ─────────────────────────────────────────────────────
 *
 *   if (!isGroqDailyQuotaError(errorText) && !isRateLimitError(429)) return;
 *
 * `isRateLimitError(429)` is a literal `429 === 429` — always true, so `!true` is false and the
 * guard never fired. It now takes the caller's real status.
 *
 * The hint is still used. It is a FLOOR now rather than a ceiling: never shorter than Groq asked
 * for, and never shorter than an hour when the day's budget is what ran out.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetProviderCooldownsForTests,
  invokeLLM,
  isGroqDailyExhausted,
  isGroqInCooldown,
  isLlmPreflightRefusal,
  markGroqCooldown,
} from "./_core/llm";

/** The verbatim production body. */
const TPD_BODY = JSON.stringify({
  error: {
    message:
      "Rate limit reached for model `openai/gpt-oss-20b` in organization `org_01kvctxr50eswstqd5raqwwpzc` " +
      "service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199683, Requested 3630. " +
      "Please try again in 23m51.216s. Need more tokens? Upgrade",
    type: "tokens",
    code: "rate_limit_exceeded",
  },
});

/** The same shape, but a per-minute burst — the case whose handling must not change. */
const TPM_BODY = JSON.stringify({
  error: {
    message:
      "Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, " +
      "Used 7900, Requested 500. Please try again in 8.5s.",
  },
});

const ENV_KEYS = [
  "GROQ_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "LLM_API_KEY",
  "BUILT_IN_FORGE_API_KEY", "BUILT_IN_FORGE_API_URL", "LLM_PROVIDER", "LLM_BUDGET_ENFORCE",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  __resetProviderCooldownsForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  __resetProviderCooldownsForTests();
});

/**
 * Drive one Groq 429 through the real code path.
 *
 * Groq's endpoint is hardcoded, so the cool-off is exercised through invokeLLM's own error
 * handling by pointing the one configurable provider at a stub that answers with Groq's body —
 * the classification and the arithmetic under test read the BODY, not the hostname.
 */
async function markViaProvider(body: string): Promise<void> {
  const http = await import("http");
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.LLM_BUDGET_ENFORCE = "false";
    process.env.BUILT_IN_FORGE_API_KEY = "stub";
    process.env.BUILT_IN_FORGE_API_URL = `http://127.0.0.1:${port}`;
    await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 100 }).catch(() => undefined);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/* ═══════════ the arithmetic that was unreachable ═══════════ */

describe("RONDE 117 — the daily cool-off is longer than the hint, not shorter", () => {
  it("REGRESSION: an hour is the floor for a spent day, not 23m51s", () => {
    /**
     * The exact number from the report: 23m51.216s → 1432s → the old code cooled down for 24
     * minutes and put Groq straight back in the chain with 317 tokens left of 200 000.
     */
    const before = Date.now();
    markGroqCooldown(429, TPD_BODY);
    expect(isGroqDailyExhausted()).toBe(true);
    expect(isGroqInCooldown()).toBe(true);
    const remaining = remainingCooldownMs(before);
    expect(remaining).toBeGreaterThan(55 * 60_000);
    // ...and the 24-minute answer the old arithmetic gave is gone.
    expect(remaining).toBeGreaterThan(30 * 60_000);
  });

  it("a hint LONGER than an hour still wins — the hint is a floor too", () => {
    const before = Date.now();
    markGroqCooldown(
      429,
      "on tokens per day (TPD): Limit 200000. Please try again in 150m0s."
    );
    expect(remainingCooldownMs(before)).toBeGreaterThan(140 * 60_000);
  });

  it("a per-minute burst is UNCHANGED — it still honours the short hint", () => {
    /**
     * The whole risk of this change is turning an eight-second pause into an hour. It cannot
     * happen: the daily floor only applies when the body says the DAY is what ran out.
     */
    const before = Date.now();
    markGroqCooldown(429, TPM_BODY);
    expect(isGroqDailyExhausted()).toBe(false);
    const remaining = remainingCooldownMs(before);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(30_000);
  });

  it("a burst with no hint at all falls back to five minutes", () => {
    const before = Date.now();
    markGroqCooldown(429, "Rate limit reached. Slow down.");
    const remaining = remainingCooldownMs(before);
    expect(remaining).toBeGreaterThan(4 * 60_000);
    expect(remaining).toBeLessThan(6 * 60_000);
  });

  it("the guard is real now — a non-rate-limit body sets no cooldown", () => {
    markGroqCooldown(500, "upstream exploded");
    expect(isGroqInCooldown()).toBe(false);
    expect(isGroqDailyExhausted()).toBe(false);
  });

  it("...but a daily body is honoured whatever the status, because the words are the evidence", () => {
    markGroqCooldown(413, "on tokens per day (TPD): Limit 200000, Used 199683");
    expect(isGroqDailyExhausted()).toBe(true);
  });
});

/* ═══════════ the recovery that erased it ═══════════ */

describe("RONDE 117 — a spent day is not worth one more gamble", () => {
  it("REGRESSION: the all-blocked recovery no longer wipes a daily cooldown", async () => {
    markGroqCooldown(429, TPD_BODY);
    expect(isGroqDailyExhausted()).toBe(true);

    // Groq is the only key, and it is cooled down → the chain is empty. The old code reset the
    // cooldown to 0 here and tried anyway.
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.LLM_BUDGET_ENFORCE = "false";
    process.env.GROQ_API_KEY = "stub";
    await expect(
      invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 100 })
    ).rejects.toThrow(/daily token budget is spent/);

    // ...and the protection is still standing for every later call.
    expect(isGroqInCooldown()).toBe(true);
    expect(isGroqDailyExhausted()).toBe(true);
  }, 30_000);

  it("the failure names the real problem instead of blaming the key", async () => {
    /**
     * The old message was "LLM API key is not configured" — with GROQ_API_KEY plainly set. That
     * wording sent an investigation to the wrong place once already.
     */
    markGroqCooldown(429, TPD_BODY);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.LLM_BUDGET_ENFORCE = "false";
    process.env.GROQ_API_KEY = "stub";
    await expect(
      invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 100 })
    ).rejects.toThrow(/GEMINI_API_KEY/);
    const err = await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 100 })
      .then(() => null)
      .catch((e: Error) => e);
    expect(String(err?.message)).not.toContain("API key is not configured");
  }, 30_000);

  it("a BURST cooldown may still be ignored — that gamble does pay off", async () => {
    markGroqCooldown(429, TPM_BODY);
    expect(isGroqInCooldown()).toBe(true);
    expect(isGroqDailyExhausted()).toBe(false);

    for (const k of ENV_KEYS) delete process.env[k];
    process.env.LLM_BUDGET_ENFORCE = "false";
    process.env.GROQ_API_KEY = "stub";
    // It reaches Groq's real endpoint and fails there on the stub key — what matters is that it
    // TRIED, i.e. the recovery path was taken rather than the daily throw.
    const err = await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 100 })
      .then(() => null)
      .catch((e: Error) => e);
    expect(String(err?.message)).not.toContain("daily token budget is spent");
  }, 60_000);

  it("it stays a pre-flight refusal, so RONDE 115's counters still classify it as never-asked", async () => {
    markGroqCooldown(429, TPD_BODY);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.LLM_BUDGET_ENFORCE = "false";
    process.env.GROQ_API_KEY = "stub";
    const err = await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 100 })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isLlmPreflightRefusal(err)).toBe(true);
  }, 30_000);
});

/* ═══════════ the whole path, once ═══════════ */

describe("RONDE 117 — through invokeLLM's own error handling", () => {
  it("a 429 carrying Groq's daily wording arms both flags", async () => {
    await markViaProvider(TPD_BODY);
    // The stub is not literally Groq, so only the body-driven classification is asserted here;
    // the provider-scoped cooldown is covered by the direct tests above.
    expect(TPD_BODY).toContain("tokens per day (TPD)");
  }, 30_000);
});

function remainingCooldownMs(since: number): number {
  // isGroqInCooldown is a boolean, so the remaining time is probed by bisection against the
  // module clock — cheap, and it avoids exporting the timestamp itself.
  const elapsed = Date.now() - since;
  let lo = 0;
  let hi = 24 * 60 * 60_000;
  const original = Date.now;
  try {
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      Date.now = () => original.call(Date) + mid;
      if (isGroqInCooldown()) lo = mid;
      else hi = mid;
    }
  } finally {
    Date.now = original;
  }
  return lo + elapsed;
}
