/**
 * RONDE 119 — a provider with no capacity is not a failed judgement.
 *
 * From production:
 *
 *   LLM invoke failed (groq, model=openai/gpt-oss-20b): 429 Too Many Requests –
 *   … on tokens per day (TPD): Limit 200000, Used 199683, Requested 3630.
 *
 * The gate booked that as `judgementsFailed`. It is not: the model never looked at the picture.
 * "The picture editor looked and could not decide" and "the picture editor was not on shift" are
 * different facts with different fixes, and RONDE 105/115 built the partition to keep them apart.
 *
 * Every call here goes through the REAL provider chain — env keys and a stubbed `fetch` only, so
 * no credentials are used and nothing leaves the machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import {
  __resetProviderCooldownsForTests,
  invokeLLM,
  isGroqDailyExhausted,
  isGroqInCooldown,
  isLlmPreflightRefusal,
  isLlmProviderUnavailable,
  markGroqCooldown,
} from "./_core/llm";
import {
  createBeatImageGateState,
  formatVerdictProviders,
  judgeBeatImage,
  judgementTally,
} from "./beatImageRelevanceGate";

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

const ENV_KEYS = [
  "GROQ_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "LLM_API_KEY",
  "BUILT_IN_FORGE_API_KEY", "BUILT_IN_FORGE_API_URL", "LLM_PROVIDER", "LLM_BUDGET_ENFORCE",
  "ENABLE_BEAT_IMAGE_RELEVANCE_GATE",
];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

/** What each host answers this test. */
type Reply = { status: number; body: string };
type Stub = { groq?: Reply; gemini?: Reply; openai?: Reply };

/** Requests that actually went out, in order — the evidence for "was Gemini really tried". */
let calls: string[] = [];

function providerFor(url: string): "groq" | "gemini" | "openai" | "other" {
  if (url.includes("api.groq.com")) return "groq";
  if (url.includes("generativelanguage.googleapis.com")) return "gemini";
  if (url.includes("api.openai.com")) return "openai";
  return "other";
}

/** An OpenAI-shaped answer carrying the gate's JSON verdict. */
function openAiVerdict(belongs: boolean): Reply {
  return {
    status: 200,
    body: JSON.stringify({
      id: "x", created: 1, model: "stub",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant",
        content: JSON.stringify({ depicts: "a bunker corridor", belongs, reason: "period fits" }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  };
}

/** A Gemini-shaped answer carrying the same verdict — a different wire format entirely. */
function geminiVerdict(belongs: boolean): Reply {
  return {
    status: 200,
    body: JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{
        text: JSON.stringify({ depicts: "a bunker corridor", belongs, reason: "period fits" }),
      }] } }],
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
      statusText: reply.status === 429 ? "Too Many Requests" : "OK",
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

let tmpDir: string;
let framePath: string;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.LLM_BUDGET_ENFORCE = "false";
  __resetProviderCooldownsForTests();
  calls = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ronde119-"));
  framePath = path.join(tmpDir, "frame.jpg");
  // A real JPEG: prepareImageForVision sniffs the bytes, so a fake buffer would be dropped before
  // the provider chain is ever reached and the test would prove nothing about it.
  execSync(
    `ffmpeg -y -f lavfi -i "testsrc=size=320x240:rate=1:duration=1" -frames:v 1 "${framePath}" 2>/dev/null`
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  __resetProviderCooldownsForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/* ═══════════ 1. the chain: Groq's spent day must not end the call ═══════════ */

describe("RONDE 119 — Groq TPD 429 → classified → skipped → Gemini answers", () => {
  it("THE PRODUCTION CASE: a text call falls through to Gemini and succeeds", async () => {
    process.env.GROQ_API_KEY = "stub-groq";
    process.env.GEMINI_API_KEY = "stub-gemini";
    process.env.LLM_PROVIDER = "groq";
    installFetchStub({ groq: { status: 429, body: TPD_BODY }, gemini: geminiVerdict(true) });

    const result = await invokeLLM({
      messages: [{ role: "user", content: "x" }],
      maxTokens: 100,
      preferProvider: "groq",
    });

    // Groq was asked once, said no, and Gemini answered.
    expect(calls).toEqual(["groq", "gemini"]);
    expect(result.choices[0]?.message?.content).toContain("belongs");
    // ...and the answer says who produced it.
    expect(result.provider).toBe("gemini");
  }, 30_000);

  it("the 429 arms the cooldown, so the NEXT call does not ask Groq at all", async () => {
    process.env.GROQ_API_KEY = "stub-groq";
    process.env.GEMINI_API_KEY = "stub-gemini";
    installFetchStub({ groq: { status: 429, body: TPD_BODY }, gemini: geminiVerdict(true) });

    await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 100, preferProvider: "groq" });
    expect(isGroqDailyExhausted()).toBe(true);
    expect(isGroqInCooldown()).toBe(true);

    calls = [];
    await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 100, preferProvider: "groq" });
    // preferProvider: "groq" does NOT reopen the cooled-down provider.
    expect(calls).toEqual(["gemini"]);
  }, 30_000);

  it("preferProvider 'groq' cannot bypass the cooldown even when it is the only preference", async () => {
    markGroqCooldown(429, TPD_BODY);
    process.env.GROQ_API_KEY = "stub-groq";
    process.env.GEMINI_API_KEY = "stub-gemini";
    process.env.OPENAI_API_KEY = "stub-openai";
    installFetchStub({ gemini: geminiVerdict(true) });

    await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 100, preferProvider: "groq" });
    expect(calls).not.toContain("groq");
  }, 30_000);

  it("when Gemini also fails, it goes on to OpenAI rather than stopping", async () => {
    process.env.GROQ_API_KEY = "stub-groq";
    process.env.GEMINI_API_KEY = "stub-gemini";
    process.env.OPENAI_API_KEY = "stub-openai";
    installFetchStub({
      groq: { status: 429, body: TPD_BODY },
      gemini: { status: 429, body: JSON.stringify({ error: { message: "RESOURCE_EXHAUSTED" } }) },
      openai: openAiVerdict(true),
    });

    const result = await invokeLLM({
      messages: [{ role: "user", content: "x" }],
      maxTokens: 100,
      preferProvider: "groq",
    });
    expect(calls.filter((c) => c === "openai")).toHaveLength(1);
    expect(result.provider).toBe("openai");
  }, 90_000);
});

/* ═══════════ 2. the classification: unavailable is not failed ═══════════ */

describe("RONDE 119 — an exhausted chain throws unavailable, not a bare failure", () => {
  it("REGRESSION: Groq's TPD 429 as the LAST link is a provider-unavailable error", async () => {
    /**
     * This is the exact throw the production line came from. With Groq alone in the chain there is
     * no `chain[i + 1]`, so the fallback branch is skipped and `throw lastError` ran — a bare
     * Error, indistinguishable at the call site from "the model returned nonsense".
     */
    process.env.GROQ_API_KEY = "stub-groq";
    installFetchStub({ groq: { status: 429, body: TPD_BODY } });

    const err = await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 100, preferProvider: "groq" })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(isLlmProviderUnavailable(err)).toBe(true);
    // It reached a provider, so it is NOT a pre-flight refusal — the two stay distinct.
    expect(isLlmPreflightRefusal(err)).toBe(false);
    expect(String((err as Error).message)).toMatch(/tokens per day|TPD|quota|capacity/i);
  }, 30_000);

  it("every provider out of capacity is still unavailable, not failed", async () => {
    process.env.GROQ_API_KEY = "stub-groq";
    process.env.GEMINI_API_KEY = "stub-gemini";
    process.env.OPENAI_API_KEY = "stub-openai";
    installFetchStub({
      groq: { status: 429, body: TPD_BODY },
      gemini: { status: 429, body: "RESOURCE_EXHAUSTED" },
      openai: { status: 429, body: JSON.stringify({ error: { message: "insufficient_quota" } }) },
    });

    const err = await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 100 })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isLlmProviderUnavailable(err)).toBe(true);
  }, 120_000);

  it("a provider that ANSWERS badly is still a real failure — the distinction must cut both ways", async () => {
    /**
     * The risk of this change is the mirror image of the bug: calling a genuine model failure
     * "unavailable" would hide a broken prompt or a broken model behind a quota story.
     */
    process.env.GEMINI_API_KEY = "stub-gemini";
    installFetchStub({ gemini: { status: 400, body: "INVALID_ARGUMENT: your request is malformed" } });

    const err = await invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 100 })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isLlmProviderUnavailable(err)).toBe(false);
    expect(isLlmPreflightRefusal(err)).toBe(false);
  }, 30_000);
});

/* ═══════════ 3. the gate: what actually gets booked ═══════════ */

describe("RONDE 119 — BeatImageGate books the verdict, not the outage", () => {
  const judge = (state: ReturnType<typeof createBeatImageGateState>) =>
    judgeBeatImage({
      framePaths: [framePath],
      beatText: "Hitler died in his bunker in 1945.",
      videoTitle: "The Fall of Berlin",
      contentKey: `clip-${Math.random()}`,
      beatIdentity: "beat-1",
      state,
      timeoutMs: 20_000,
    });

  it("THE WHOLE FLOW: Groq's day is spent, Gemini answers, the verdict is booked normally", async () => {
    markGroqCooldown(429, TPD_BODY);
    process.env.GROQ_API_KEY = "stub-groq";
    process.env.GEMINI_API_KEY = "stub-gemini";
    installFetchStub({ gemini: geminiVerdict(true) });

    const state = createBeatImageGateState();
    const judgement = await judge(state);

    expect(judgement.verdict).toBe("fits");
    const tally = judgementTally(state);
    expect(tally.attempts).toBe(1);
    expect(tally.fits).toBe(1);
    expect(tally.failed).toBe(0);
    expect(tally.skipped).toBe(0);
    expect(tally.inconsistent).toBe(false);
    // Groq was never asked for a picture — it has no vision model here — and the log says which
    // provider did decide.
    expect(calls).not.toContain("groq");
    expect(judgement.provider).toBe("gemini");
    expect(formatVerdictProviders(state)).toContain("gemini");
  }, 60_000);

  it("REGRESSION: an out-of-capacity chain is NOT counted as a failed judgement", async () => {
    process.env.GEMINI_API_KEY = "stub-gemini";
    process.env.OPENAI_API_KEY = "stub-openai";
    installFetchStub({
      gemini: { status: 429, body: "RESOURCE_EXHAUSTED" },
      openai: { status: 429, body: JSON.stringify({ error: { message: "insufficient_quota" } }) },
    });

    const state = createBeatImageGateState();
    const judgement = await judge(state);

    // Fail-open is unchanged: the clip is still adopted.
    expect(judgement.verdict).toBe("unknown");
    const tally = judgementTally(state);
    expect(tally.failed).toBe(0);
    expect(tally.skipped).toBe(1);
    expect(tally.attempts).toBe(0);
    expect(tally.inconsistent).toBe(false);
    expect(judgement.reason).toMatch(/unavailable|capacity|quota/i);
  }, 120_000);

  it("a model that answers with nonsense IS still counted as failed", async () => {
    process.env.GEMINI_API_KEY = "stub-gemini";
    installFetchStub({
      gemini: { status: 200, body: JSON.stringify({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json at all" }] } }],
      }) },
    });

    const state = createBeatImageGateState();
    const judgement = await judge(state);
    expect(judgement.verdict).toBe("unknown");
    const tally = judgementTally(state);
    expect(tally.failed).toBe(1);
    expect(tally.attempts).toBe(1);
    expect(tally.skipped).toBe(0);
  }, 30_000);

  it("a vision call with only a Groq key says what is missing, not 'no API key'", async () => {
    /**
     * Groq is stripped from every vision chain (its vision models 404), so this arrives at the
     * empty-chain branch with GROQ_API_KEY plainly set — and used to be told the key was not
     * configured. Same wrong signpost RONDE 117 removed from the daily-quota branch.
     */
    process.env.GROQ_API_KEY = "stub-groq";
    installFetchStub({});

    const state = createBeatImageGateState();
    const judgement = await judge(state);
    expect(judgement.reason).toMatch(/vision/i);
    expect(judgement.reason).not.toMatch(/API key is not configured/);
    expect(calls).toHaveLength(0);
    expect(judgementTally(state).failed).toBe(0);
  }, 30_000);

  it("a pre-flight refusal stays a pre-flight refusal — RONDE 115 is untouched", async () => {
    // No key anywhere: nothing is ever sent.
    const state = createBeatImageGateState();
    const judgement = await judge(state);
    expect(judgement.verdict).toBe("unknown");
    expect(judgementTally(state).failed).toBe(0);
    expect(judgementTally(state).skipped).toBe(1);
    expect(calls).toHaveLength(0);
  }, 30_000);
});

/* ═══════════ 4. the log actually reaches a log ═══════════ */

describe("RONDE 119 — the render says which provider judged its pictures", () => {
  const src = (p: string) => fs.readFileSync(path.join(process.cwd(), "server", p), "utf8");

  it("the pipeline prints the provider line next to the no-verdict line", () => {
    /**
     * A formatter nothing calls is not observability. Both places that already report the gate's
     * counters report who produced them, so the fact is in the same block as the numbers it
     * explains rather than in a helper waiting to be used.
     */
    const pipeline = src("videoPipeline.ts");
    expect(pipeline).toContain("formatVerdictProviders,");
    expect(pipeline).toContain("const who = formatVerdictProviders(g);");
    expect(pipeline).toContain("formatVerdictProviders(visualDedup.beatImageGate)");
  });

  it("the label on the failed counter no longer says 'unavailable'", () => {
    /**
     * `judgementsFailed` now means only "a provider answered and the judgement failed" —
     * unavailability moved to never_asked. A log reading `unavailable=${t.failed}` would point at
     * the wrong number, which is the exact class of mistake RONDE 105 was written to end.
     */
    expect(src("videoPipeline.ts")).toContain("failed=${t.failed} never_asked=${t.skipped}");
    expect(src("visualSourceLineage.ts")).toContain("gate_failed=${input.unavailable}");
    expect(src("beatVisualRelevance.ts")).not.toContain("unavailable=${t.failed}");
  });
});
