/**
 * RONDE 115 — a render that got no verdicts could not say why.
 *
 * A production render reported `attempts=44 answered=0 unavailable=44`: the picture editor was
 * asked forty-four times and answered nothing. That reading sent several rounds of investigation
 * at the vision model, the frames and the prompt. None of them was the problem.
 *
 * ── What was actually wrong ──────────────────────────────────────────────────────────────────
 *
 * `judgeBeatImage` increments `judgementAttempts` BEFORE calling invokeLLM, and invokeLLM can
 * refuse before it opens a socket — no provider key configured anywhere, every provider in
 * cooldown or quota-exhausted, or the daily spend budget already spent. All three threw into the
 * gate's catch and were counted as `judgementsFailed`.
 *
 * So a render where no provider was EVER CONTACTED reported the exact same numbers as a render
 * where the model was asked and could not answer. Those two need completely different work, and
 * the report could not tell them apart. Reproduced here: with no key configured, one call gives
 * attempts=1 failed=1 — the 44/44 shape, from a condition that never reached a provider.
 *
 * RONDE 105 built this partition for exactly this distinction and already had a bucket for "the
 * gate never asked". A pre-flight refusal belongs there.
 *
 * ── The second half ──────────────────────────────────────────────────────────────────────────
 *
 * The reason was returned and logged per clip, so a render with forty-four failures printed
 * forty-four separate lines — and the one fact that mattered, that they all said the same thing,
 * was the one nobody could see. The reasons are now counted and summarised in one line that
 * reaches the stored pipeline report.
 *
 * ── What did NOT change ──────────────────────────────────────────────────────────────────────
 *
 * The outcome. A gate that cannot get an answer still returns `unknown`, still fails open, and
 * still never returns `fits`. This round changed what the render can SAY about that, not what it
 * does about it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import path from "path";

import {
  createBeatImageGateState,
  formatNoVerdictReasons,
  judgeBeatImage,
  judgementTally,
} from "./beatImageRelevanceGate";
import { isLlmPreflightRefusal, LlmUnavailableError } from "./_core/llm";

const FRAME = path.join(__dirname, "__fixtures__", "visionFrame.jpg");

/** What the stub provider answers next. */
let stubContent = "";
let stubFinish = "stop";
let stubStatus = 200;
/** The exact payload the pipeline built, so the request itself can be asserted on. */
let lastPayload: Record<string, unknown> | null = null;
let server: http.Server;
let port = 0;

const ENV_KEYS = [
  "BUILT_IN_FORGE_API_KEY", "BUILT_IN_FORGE_API_URL", "GEMINI_API_KEY", "GROQ_API_KEY",
  "OPENAI_API_KEY", "LLM_API_KEY", "LLM_PROVIDER", "BEAT_VERDICT_STORE_DISABLED",
  "LLM_BUDGET_ENFORCE",
];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastPayload = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(stubStatus, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: stubContent }, finish_reason: stubFinish }],
          usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
        })
      );
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
  lastPayload = null;
});

/** Point the pipeline at the stub, with nothing else configured. */
function useStub() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.BUILT_IN_FORGE_API_KEY = "stub-key";
  process.env.BUILT_IN_FORGE_API_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
  process.env.BEAT_VERDICT_STORE_DISABLED = "true";
  process.env.LLM_BUDGET_ENFORCE = "false";
}

/** No provider configured at all — the production condition this round is about. */
function useNoProvider() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.BEAT_VERDICT_STORE_DISABLED = "true";
}

async function judge(beatText = "Hitler died in his bunker in 1945.") {
  const state = createBeatImageGateState();
  const decision = await judgeBeatImage({
    framePaths: [FRAME],
    beatText,
    videoTitle: "Why Hitler Killed Himself",
    contentKey: `r115:${Math.random()}`,
    beatIdentity: "r115-identity",
    state,
    timeoutMs: 20_000,
  });
  return { decision, state, tally: judgementTally(state) };
}

/* ═══════════ the route works end to end ═══════════ */

describe("RONDE 115 — a real frame reaches a provider and comes back a verdict", () => {
  it("beat → frame → data url → provider → fits", async () => {
    useStub();
    stubContent = JSON.stringify({
      depicts: "A black and white photograph of Adolf Hitler",
      belongs: true,
      reason: "shows the subject the line is about",
    });
    stubFinish = "stop";
    const { decision, tally } = await judge();
    expect(decision.verdict).toBe("fits");
    expect(decision.depicts).toContain("Hitler");
    expect(tally).toMatchObject({ attempts: 1, fits: 1, mismatch: 0, failed: 0, skipped: 0 });
    expect(tally.inconsistent).toBe(false);
  }, 30_000);

  it("...and a refusal comes back as does_not_fit, not as a failure", async () => {
    useStub();
    stubContent = JSON.stringify({ depicts: "a test pattern", belongs: false, reason: "not footage" });
    stubFinish = "stop";
    const { decision, tally } = await judge();
    expect(decision.verdict).toBe("does_not_fit");
    expect(tally).toMatchObject({ attempts: 1, fits: 0, mismatch: 1, failed: 0 });
  }, 30_000);

  it("the request really carries the frame, as a jpeg data url", async () => {
    useStub();
    stubContent = JSON.stringify({ depicts: "x", belongs: true, reason: "y" });
    stubFinish = "stop";
    await judge();
    const messages = (lastPayload?.messages ?? []) as Array<{ content: unknown }>;
    const parts = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const image = parts.find((p) => (p as { type?: string }).type === "image_url") as
      | { image_url: { url: string; detail?: string } }
      | undefined;
    expect(image, "no image part reached the provider").toBeDefined();
    expect(image!.image_url.url.startsWith("data:image/")).toBe(true);
    expect(image!.image_url.url).toContain(";base64,");
    // A real jpeg, not an empty placeholder.
    expect(image!.image_url.url.length).toBeGreaterThan(5000);
    expect(image!.image_url.detail).toBe("low");
    // ...and the narration it is being judged against travelled with it.
    const text = parts.find((p) => (p as { type?: string }).type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("Hitler died in his bunker in 1945.");
  }, 30_000);

  it("a verdict is only written down when it is a real answer", async () => {
    // RONDE 104's rule, re-checked here because this round touches the same catch.
    const gate = fs_readGate();
    expect(gate).toContain('if (judgement.verdict !== "unknown") {');
    expect(gate).toContain("void persistVerdict(seenKey,");
  });
});

/* ═══════════ the 44/44 shape ═══════════ */

describe("RONDE 115 — a question that was never asked is not a question that failed", () => {
  it("REPRODUCTION: with no provider configured, the old code counted an attempt AND a failure", async () => {
    /**
     * This is the production shape. Before this round the tally read attempts=1 failed=1 — and at
     * forty-four beats, attempts=44 answered=0 unavailable=44, which reads as a model outage.
     * Nothing was ever sent.
     */
    useNoProvider();
    const { decision, tally } = await judge();
    expect(decision.verdict).toBe("unknown");
    expect(decision.reason).toContain("gate could not ask");
    expect(decision.reason).toContain("LLM API key is not configured");
    // The attempt is taken back: the gate never asked.
    expect(tally.attempts).toBe(0);
    expect(tally.failed).toBe(0);
    expect(tally.skipped).toBe(1);
    expect(tally.inconsistent).toBe(false);
  }, 30_000);

  it("the spend budget is the same kind of fact, and is classified the same way", async () => {
    useNoProvider();
    process.env.GEMINI_API_KEY = "stub";
    process.env.LLM_BUDGET_ENFORCE = "true";
    process.env.LLM_DAILY_BUDGET_USD = "0.0000001";
    try {
      const { decision, tally } = await judge();
      // Either the budget refused (pre-flight) or the fake key failed at the provider. Only the
      // first may be counted as never-asked, and the classification must agree with the reason.
      if (decision.reason.startsWith("gate could not ask")) {
        expect(tally.attempts).toBe(0);
        expect(tally.skipped).toBe(1);
      } else {
        expect(tally.attempts).toBe(1);
        expect(tally.failed).toBe(1);
      }
      expect(decision.verdict).toBe("unknown");
    } finally {
      delete process.env.LLM_DAILY_BUDGET_USD;
    }
  }, 30_000);

  it("a genuine PROVIDER failure is still counted as a failed attempt", async () => {
    // The distinction only helps if the other side of it still works: a provider that answers
    // with something unusable was asked, and must stay in `failed`.
    useStub();
    stubContent = "not json at all";
    stubFinish = "stop";
    const { decision, tally } = await judge();
    expect(decision.verdict).toBe("unknown");
    expect(tally.attempts).toBe(1);
    expect(tally.failed).toBe(1);
    expect(tally.skipped).toBe(0);
    expect(tally.inconsistent).toBe(false);
  }, 30_000);

  it("an answer truncated at max_tokens is a failed attempt, not a never-asked", async () => {
    useStub();
    stubContent = '{"depicts":"A photograph of Adolf Hitler standing in a garden with sever';
    stubFinish = "length";
    const { decision, tally } = await judge();
    expect(decision.verdict).toBe("unknown");
    expect(tally.attempts).toBe(1);
    expect(tally.failed).toBe(1);
  }, 30_000);

  it("the pre-flight marker is a type, not a message substring", () => {
    // Matching on wording would rot the moment one of those messages is reworded.
    expect(isLlmPreflightRefusal(new LlmUnavailableError("x"))).toBe(true);
    expect(isLlmPreflightRefusal(new Error("LLM API key is not configured"))).toBe(false);
    expect(isLlmPreflightRefusal(new Error("Gemini API error 429"))).toBe(false);
    expect(isLlmPreflightRefusal(null)).toBe(false);
  });
});

/* ═══════════ the render can now say why ═══════════ */

describe("RONDE 115 — one line instead of forty-four", () => {
  it("reasons are counted, and the commonest one is named with its count", async () => {
    useNoProvider();
    const state = createBeatImageGateState();
    for (let i = 0; i < 44; i++) {
      await judgeBeatImage({
        framePaths: [FRAME],
        beatText: `beat ${i}`,
        contentKey: `r115-many:${i}`,
        beatIdentity: `b${i}`,
        state,
        timeoutMs: 5_000,
      });
    }
    const line = formatNoVerdictReasons(state);
    expect(line).toContain("[BeatImageGate] no verdict:");
    expect(line).toContain("44x");
    expect(line).toContain("LLM API key is not configured");
    // ...and the render's own numbers now say never-asked rather than unavailable.
    const tally = judgementTally(state);
    expect(tally.attempts).toBe(0);
    expect(tally.failed).toBe(0);
    expect(tally.skipped).toBe(44);
  }, 60_000);

  it("an empty tally produces no line at all", () => {
    expect(formatNoVerdictReasons(createBeatImageGateState())).toBe("");
  });

  it("the line reaches the log and the stored pipeline report", () => {
    const pipeline = fs_read("videoPipeline.ts");
    expect(pipeline).toContain("const why = formatNoVerdictReasons(g);");
    expect(pipeline).toContain('pipelineReport.add("summary", why);');
  });
});

/* ═══════════ the outcome is unchanged ═══════════ */

describe("RONDE 115 — failures are still honest", () => {
  it("no route out of the gate without an answer returns anything but unknown", async () => {
    useNoProvider();
    const noProvider = await judge();
    expect(noProvider.decision.verdict).toBe("unknown");

    useStub();
    stubContent = "garbage";
    stubFinish = "stop";
    const badAnswer = await judge();
    expect(badAnswer.decision.verdict).toBe("unknown");

    stubContent = JSON.stringify({ depicts: "x", reason: "y" }); // no `belongs`
    const noVerdict = await judge();
    expect(noVerdict.decision.verdict).toBe("unknown");
  }, 60_000);

  it("unknown is never persisted, so a hiccup cannot become a permanent silence", () => {
    const gate = fs_readGate();
    expect(gate).toContain('if (judgement.verdict !== "unknown") {');
  });

  it("fail-open is intact — the gate still adopts on unknown", () => {
    const relevance = fs_read("beatVisualRelevance.ts");
    expect(relevance).toContain("never RECORDED as `fits`");
  });
});

function fs_read(name: string): string {
  return require("fs").readFileSync(path.join(__dirname, name), "utf8") as string;
}
function fs_readGate(): string {
  return fs_read("beatImageRelevanceGate.ts");
}
