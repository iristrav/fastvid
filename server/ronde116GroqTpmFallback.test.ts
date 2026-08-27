/**
 * RONDE 116 — a Groq tier limit ended the whole call instead of using the next provider.
 *
 * From production:
 *
 *   LLM invoke failed (groq, model=openai/gpt-oss-120b): 413 Payload Too Large –
 *   Request too large for model `openai/gpt-oss-120b` … service tier `on_demand` on tokens per
 *   minute (TPM): Limit 8000, Requested 17076, please reduce your message size and try again.
 *
 * Groq answers an oversize prompt with **413**, not 429. Nothing in the error classification knew
 * that number:
 *
 *   isRateLimitError(413)          → false   (429 only)
 *   isOpenAiQuotaError(413, …)     → false   (429/402 only)
 *   status === 404                 → false
 *   status >= 500                  → false
 *   ⇒ shouldFallbackToNextProvider → FALSE
 *
 * so control fell past the fall-through branch to `throw lastError` and invokeLLM gave up — with
 * Gemini still sitting unused in the provider chain. Gemini has no 8000-tokens-per-minute cap and
 * would have served exactly the same prompt.
 *
 * "Limit 8000, Requested 17076" is a fact about GROQ's tier, not about the request. That is what
 * makes it a fall-through rather than a failure.
 *
 * Two consequences of the same blind spot are fixed with it:
 *
 *   · no cooldown was set, so every remaining large call in the render paid a full round trip to
 *     re-discover the identical ceiling — the pattern already documented and fixed for Gemini's
 *     404s ("16 identical 404s across one render's log");
 *   · an oversize payload was eligible for the wait-and-retry branch. The same bytes are exactly
 *     as oversize ninety seconds later, so that sleep buys nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "http";

import { invokeLLM, isCapacityTooLargeError, shouldFallbackToNextProvider } from "./_core/llm";

/** The verbatim production body, so the classifier is tested against the real wording. */
const GROQ_413_BODY = JSON.stringify({
  error: {
    message:
      "Request too large for model `openai/gpt-oss-120b` in organization `org_01kvctxr50eswstqd5raqwwpzc` " +
      "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 17076, please reduce " +
      "your message size and try again. Need more tokens? Upgrade",
    type: "tokens",
    code: "rate_limit_exceeded",
  },
});

/* ═══════════ the classification, against the real body ═══════════ */

describe("RONDE 116 — 413 is recognised as a provider capacity ceiling", () => {
  it("the production body is classified as capacity, not as a bad request", () => {
    expect(isCapacityTooLargeError(413, GROQ_413_BODY)).toBe(true);
  });

  it("REGRESSION: it is now in the set the provider chain consults", () => {
    /**
     * This is the exact predicate invokeLLM asks before deciding between `break` (try the next
     * provider) and `throw lastError` (give up). It answered false, which is why the call ended
     * at Groq with a capable provider unused.
     */
    expect(shouldFallbackToNextProvider(413, GROQ_413_BODY)).toBe(true);
  });

  it("the statuses around it are unchanged", () => {
    // A malformed request is the caller's fault and must still stop at the first provider —
    // burning the whole chain on it would turn one bug into four failed requests.
    expect(shouldFallbackToNextProvider(400, '{"error":{"message":"bad tool schema"}}')).toBe(false);
    expect(shouldFallbackToNextProvider(401, "unauthorized")).toBe(false);
    /**
     * SUPERSEDED BY RONDE 120: 403 moved to the fall-through side, on production evidence.
     *
     * This line was written to keep the fall-through set from creeping wider than it had to be,
     * and 403 was grouped with 400/401 as "the caller's fault". The worker log for render 543
     * showed what it actually looks like:
     *
     *   Gemini API error 403: { message: "Your project has been denied access.",
     *                           status: "PERMISSION_DENIED" }
     *
     * That is a statement about THIS provider, not about the request — the identical request was
     * served by another provider one second later. Stopping the chain there left working providers
     * unused, which is the same bug this file was opened to fix for 413.
     *
     * 400 and 401 keep their old answer, and that is the half of this assertion that still guards
     * the original concern: a malformed request must not be re-sent to four providers in turn.
     */
    expect(shouldFallbackToNextProvider(403, "forbidden")).toBe(true);
    // ...and the ones that were already fall-throughs still are.
    expect(shouldFallbackToNextProvider(429, "rate limit")).toBe(true);
    expect(shouldFallbackToNextProvider(404, "model not found")).toBe(true);
    expect(shouldFallbackToNextProvider(503, "upstream unavailable")).toBe(true);
  });

  it("a 413 that is NOT about capacity stays a hard failure", () => {
    /**
     * A gateway rejecting the body size carries none of the TPM wording. Handing the identical
     * bytes to the next provider would fail there too, so it is not a fall-through.
     */
    expect(isCapacityTooLargeError(413, "<html><title>413 Request Entity</title></html>")).toBe(false);
    expect(shouldFallbackToNextProvider(413, "<html><title>413 Request Entity</title></html>")).toBe(false);
  });

  it("only 413 is capacity — a 429 keeps its own wait-and-retry handling", () => {
    // The two need opposite treatment: a 429 is worth waiting out, an oversize payload never is.
    expect(isCapacityTooLargeError(429, GROQ_413_BODY)).toBe(false);
  });

  it("the wording variants Groq uses are all covered", () => {
    for (const body of [
      "Request too large for model X",
      "on tokens per minute (TPM): Limit 8000",
      "please reduce your message size and try again",
      "TPM limit reached",
    ]) {
      expect(isCapacityTooLargeError(413, body), body).toBe(true);
    }
  });
});

/* ═══════════ the behaviour, through the public surface ═══════════ */

let hits = 0;
let server: http.Server;
let port = 0;
const ENV_KEYS = [
  "GROQ_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "LLM_API_KEY",
  "BUILT_IN_FORGE_API_KEY", "BUILT_IN_FORGE_API_URL", "LLM_PROVIDER", "LLM_BUDGET_ENFORCE",
];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      hits++;
      res.writeHead(413, { "content-type": "application/json" });
      res.end(GROQ_413_BODY);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  hits = 0;
});

describe("RONDE 116 — an oversize payload is never re-sent to the provider that refused it", () => {
  it("one request, no retry sleep, and the provider's own words survive", async () => {
    /**
     * Groq's URL is hardcoded, so this runs the same code path through the one provider whose
     * endpoint is configurable. What it proves is the part that is provider-independent: a
     * capacity 413 is attempted exactly once and the message reaches the caller intact.
     *
     * Before this round the request was eligible for the rate-limit retry branch — up to four
     * attempts, each preceded by a sleep, all of them certain to fail on the same bytes.
     */
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.LLM_BUDGET_ENFORCE = "false";
    process.env.BUILT_IN_FORGE_API_KEY = "stub-key";
    process.env.BUILT_IN_FORGE_API_URL = `http://127.0.0.1:${port}`;

    const started = Date.now();
    await expect(
      invokeLLM({ messages: [{ role: "user", content: "x".repeat(200) }], maxTokens: 8000 })
    ).rejects.toThrow(/413/);
    const elapsed = Date.now() - started;

    expect(hits, "the oversize payload must be sent once, not retried").toBe(1);
    expect(elapsed, "no retry sleep may happen for an oversize payload").toBeLessThan(5_000);
  }, 30_000);

  it("the failure still tells the operator exactly what to change", async () => {
    // Falling through cannot invent capacity that is not configured. What it must not do is hide
    // why: "Limit 8000, Requested 17076" is the whole diagnosis.
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.LLM_BUDGET_ENFORCE = "false";
    process.env.BUILT_IN_FORGE_API_KEY = "stub-key";
    process.env.BUILT_IN_FORGE_API_URL = `http://127.0.0.1:${port}`;
    await expect(
      invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 8000 })
    ).rejects.toThrow(/Limit 8000, Requested 17076/);
  }, 30_000);
});

/* ═══════════ the cooldown ═══════════ */

describe("RONDE 116 — the render stops re-discovering the same ceiling", () => {
  it("a Groq capacity 413 cools Groq down, and says so", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "_core", "llm.ts"), "utf8");
    const idx = src.indexOf('if (provider === "groq" && isCapacityTooLargeError(response.status, errorText)) {');
    expect(idx, "the cooldown branch is missing").toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 700);
    expect(body).toContain("groqCooldownUntilMs = Math.max(groqCooldownUntilMs,");
    expect(body).toContain("Groq TPM ceiling hit");
    // A TPM window is a minute — the cooldown must not be a day.
    expect(body).toContain("parseRetryAfterSeconds(errorText) ?? 60");
  });

  it("and the retry branch is skipped for it", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "_core", "llm.ts"), "utf8");
    expect(src).toContain("isCapacityTooLargeError(response.status, errorText) ||");
  });
});
