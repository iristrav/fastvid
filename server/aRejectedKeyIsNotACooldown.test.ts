/**
 * RONDE 270 — A REJECTED CREDENTIAL IS NOT A COOLDOWN.
 *
 * ── What production printed, over and over ──────────────────────────────────────────────────
 *
 *     LLM invoke failed (groq, model=openai/gpt-oss-20b): 401 Unauthorized –
 *     {"error":{"message":"Invalid API Key","type":"invalid_request_error",
 *      "code":"expired_api_key"}}
 *
 * The owner's question was the right one: why is Groq being called at all, when OpenAI has credit?
 * Because sixteen production call sites pass `preferProvider: "groq"` — the script engine, the
 * keyword extractor, the query generator, the clip annotator, the editorial planners — and
 * `preferProvider` overrides the configured primary. So most of this system's work asked a dead
 * provider FIRST, on every single call.
 *
 * ── The gap, exactly ────────────────────────────────────────────────────────────────────────
 *
 * `markGroqCooldown` is reached only behind `isRateLimitError(response.status)`, which is
 * `status === 429`. A 401 is not 429, so it was never called — and its own first line would have
 * refused anyway. Every classifier in llm.ts describes a TEMPORARY condition: a burst limit, a
 * day's tokens, a TPM ceiling, a model that 404s. The one condition that never clears by itself
 * had no handler at all, and was therefore the one retried forever.
 *
 * ── What is checked here ────────────────────────────────────────────────────────────────────
 *
 * §1 a 401 takes the provider out of the chain, and the next call does not ask it again
 * §2 the gap this closes: a 429 still cools down, a 401 is a different thing entirely
 * §3 the all-blocked escape hatch cannot resurrect a rejected key
 * §4 nothing else changed: a working chain still works, and no credential is ever read
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetProviderCooldownsForTests,
  invokeLLM,
  isGroqInCooldown,
  isProviderKeyRejected,
} from "./_core/llm";
import { stripComments } from "./sourceScan.test.support";
import fs from "fs";
import path from "path";

const LLM = stripComments(fs.readFileSync(path.join(__dirname, "_core", "llm.ts"), "utf8"));

/** The verbatim production body. */
const EXPIRED_KEY_BODY = JSON.stringify({
  error: {
    message: "Invalid API Key",
    type: "invalid_request_error",
    code: "expired_api_key",
  },
});

const TPD_BODY = JSON.stringify({
  error: { message: "Rate limit reached ... on tokens per day (TPD)", type: "tokens", code: "rate_limit_exceeded" },
});

type Reply = { status: number; body: string };
type Stub = { groq?: Reply; gemini?: Reply; openai?: Reply };

const ENV_KEYS = ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "LLM_PROVIDER", "LLM_BUDGET_ENFORCE"];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

let calls: string[] = [];

function providerFor(url: string): "groq" | "gemini" | "openai" | "other" {
  if (url.includes("api.groq.com")) return "groq";
  if (url.includes("generativelanguage.googleapis.com")) return "gemini";
  if (url.includes("api.openai.com")) return "openai";
  return "other";
}

function openAiAnswer(): Reply {
  return {
    status: 200,
    body: JSON.stringify({
      id: "x", created: 1, model: "stub",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  };
}

function geminiAnswer(): Reply {
  return {
    status: 200,
    body: JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }),
  };
}

function installFetchStub(stub: Stub): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    const who = providerFor(url);
    calls.push(who);
    const reply = who === "other" ? undefined : stub[who];
    if (!reply) throw new Error(`test stub: no reply configured for ${who}`);
    return new Response(reply.body, {
      status: reply.status,
      statusText: reply.status === 401 ? "Unauthorized" : reply.status === 429 ? "Too Many Requests" : "OK",
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

const ask = () =>
  invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 50, preferProvider: "groq" });

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
  vi.restoreAllMocks();
});

/* ═══════════ 1. the production case ═══════════ */

describe("R270 §1 — a 401 removes the provider, and it stays removed", () => {
  it("THE PRODUCTION CASE: Groq's expired key falls through and OpenAI answers", async () => {
    process.env.GROQ_API_KEY = "stub-groq";
    process.env.OPENAI_API_KEY = "stub-openai";
    installFetchStub({ groq: { status: 401, body: EXPIRED_KEY_BODY }, openai: openAiAnswer() });

    const result = await ask();
    expect(calls).toEqual(["groq", "openai"]);
    expect(result.provider).toBe("openai");
  }, 30_000);

  it("AND THE NEXT CALL DOES NOT ASK GROQ AT ALL — this is the whole repair", async () => {
    /**
     * Before this round every call repeated the round trip. Sixteen call sites pass
     * `preferProvider: "groq"`, so that was most of the system's work paying for a guaranteed
     * refusal, for as long as the key stayed expired.
     */
    process.env.GROQ_API_KEY = "stub-groq";
    process.env.OPENAI_API_KEY = "stub-openai";
    installFetchStub({ groq: { status: 401, body: EXPIRED_KEY_BODY }, openai: openAiAnswer() });

    await ask();
    expect(isProviderKeyRejected("groq")).toBe(true);

    calls = [];
    await ask();
    expect(calls, "a rejected credential was asked a second time").toEqual(["openai"]);
  }, 30_000);

  it("`preferProvider: groq` cannot put a rejected provider back at the front", async () => {
    process.env.GROQ_API_KEY = "stub-groq";
    process.env.GEMINI_API_KEY = "stub-gemini";
    process.env.OPENAI_API_KEY = "stub-openai";
    installFetchStub({
      groq: { status: 401, body: EXPIRED_KEY_BODY },
      gemini: geminiAnswer(),
      openai: openAiAnswer(),
    });

    await ask();
    calls = [];
    await ask();
    expect(calls).not.toContain("groq");
  }, 30_000);

  it("IT IS NOT A COOLDOWN — a cooldown expires, and this must not", async () => {
    process.env.GROQ_API_KEY = "stub-groq";
    process.env.OPENAI_API_KEY = "stub-openai";
    installFetchStub({ groq: { status: 401, body: EXPIRED_KEY_BODY }, openai: openAiAnswer() });

    await ask();
    /**
     * Deliberately NOT expressed as a very long cooldown: the all-blocked branch in invokeLLM
     * resets `groqCooldownUntilMs` to 0 on purpose, so a cooldown would be wiped and the whole
     * discovery would repeat. §3 checks that branch directly.
     */
    expect(isGroqInCooldown(), "the rejection was stored as a cooldown, which gets reset").toBe(false);
    expect(isProviderKeyRejected("groq")).toBe(true);
  }, 30_000);

  it("and every provider is covered, not just the one production caught", async () => {
    /**
     * Groq is where it was found, but the gap is in the classification: `markOpenAiCooldown` also
     * opens with `if (!quota && !isRateLimitError(status)) return`, so an expired OpenAI key would
     * have been retried forever in exactly the same way.
     */
    process.env.OPENAI_API_KEY = "stub-openai";
    process.env.GEMINI_API_KEY = "stub-gemini";
    installFetchStub({ openai: { status: 401, body: EXPIRED_KEY_BODY }, gemini: geminiAnswer() });

    await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 50, preferProvider: "openai" });
    expect(isProviderKeyRejected("openai")).toBe(true);
  }, 30_000);
});

/* ═══════════ 2. the two conditions stay apart ═══════════ */

describe("R270 §2 — a spent quota and a dead key are not the same finding", () => {
  it("A 429 STILL ARMS THE COOLDOWN AND NOT THE REJECTION", async () => {
    process.env.GROQ_API_KEY = "stub-groq";
    process.env.OPENAI_API_KEY = "stub-openai";
    installFetchStub({ groq: { status: 429, body: TPD_BODY }, openai: openAiAnswer() });

    await ask();
    expect(isGroqInCooldown()).toBe(true);
    expect(
      isProviderKeyRejected("groq"),
      "a spent day was recorded as a dead key — that would never retry after the reset"
    ).toBe(false);
  }, 30_000);

  it("and a 500 is neither — a broken provider may well work on the next call", async () => {
    process.env.GROQ_API_KEY = "stub-groq";
    process.env.OPENAI_API_KEY = "stub-openai";
    installFetchStub({
      groq: { status: 500, body: JSON.stringify({ error: { message: "internal" } }) },
      openai: openAiAnswer(),
    });

    await ask();
    expect(isProviderKeyRejected("groq")).toBe(false);
  }, 30_000);

  it("THE TRIGGER IS 401 AND ONLY 401", () => {
    const at = LLM.indexOf("function isCredentialRejection(");
    expect(at).toBeGreaterThan(0);
    expect(LLM.slice(at, at + 200)).toContain("status === 401");
  });
});

/* ═══════════ 3. the escape hatch cannot revive it ═══════════ */

describe("R270 §3 — the all-blocked retry must not resurrect a rejected key", () => {
  it("WHEN EVERY PROVIDER IS OUT, GROQ IS NOT RETRIED ON A DEAD KEY", async () => {
    /**
     * invokeLLM has a branch that deliberately ignores Groq's cooldown when nothing else is left,
     * and it resets `groqCooldownUntilMs = 0` to do so. RONDE 117 already records one condition
     * where that bet cannot pay off — a spent daily budget. A rejected credential is the second,
     * and it is stronger: waiting will never mint a key inside one process.
     */
    process.env.GROQ_API_KEY = "stub-groq";
    installFetchStub({ groq: { status: 401, body: EXPIRED_KEY_BODY } });

    await ask().catch(() => undefined);
    expect(isProviderKeyRejected("groq")).toBe(true);

    calls = [];
    await ask().catch(() => undefined);
    expect(calls, "the escape hatch re-opened a rejected credential").toEqual([]);
  }, 30_000);

  it("and the branch names the rejection in its own condition", () => {
    const at = LLM.indexOf('chain = ["groq"];');
    expect(at).toBeGreaterThan(0);
    const before = LLM.slice(Math.max(0, at - 400), at);
    expect(before).toContain('!isProviderKeyRejected("groq")');
  });
});

/* ═══════════ 4. nothing else moved, and no secret is read ═══════════ */

describe("R270 §4 — a classification was added, nothing was relaxed", () => {
  it("A WORKING CHAIN IS COMPLETELY UNAFFECTED", async () => {
    process.env.GROQ_API_KEY = "stub-groq";
    process.env.OPENAI_API_KEY = "stub-openai";
    installFetchStub({ groq: { ...openAiAnswer() }, openai: openAiAnswer() });

    const result = await ask();
    expect(calls).toEqual(["groq"]);
    expect(result.provider).toBe("groq");
    expect(isProviderKeyRejected("groq")).toBe(false);
  }, 30_000);

  it("THE REJECTION READS A STATUS, NEVER A CREDENTIAL", () => {
    /**
     * The whole input is the provider's own refusal. Nothing here may read, log, compare or
     * report the key that was rejected — the log line names the provider and the status code.
     */
    const at = LLM.indexOf("function markProviderKeyRejected(");
    expect(at).toBeGreaterThan(0);
    const body = LLM.slice(at, at + 1200);
    for (const forbidden of ["KeyFromEnv", "process.env", "apiKey", "Authorization"]) {
      expect(body, `the rejection handler reads ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("and it is announced once, not on every call", () => {
    const at = LLM.indexOf("function markProviderKeyRejected(");
    expect(LLM.slice(at, at + 400)).toContain("if (deadKeyProviders.has(provider)) return;");
  });

  it("the existing cooldowns are all still there", () => {
    for (const fn of ["markGroqCooldown", "markOpenAiCooldown", "isGroqInCooldown", "isGroqDailyExhausted"]) {
      expect(LLM, `${fn} was removed`).toContain(fn);
    }
    expect(LLM).toContain("function isRateLimitError(status: number): boolean {");
  });

  it("AND THE TEST RESET CLEARS IT — a dead key must not leak between tests", () => {
    const at = LLM.indexOf("export function __resetProviderCooldownsForTests(");
    expect(LLM.slice(at, at + 400)).toContain("deadKeyProviders.clear();");
  });
});
