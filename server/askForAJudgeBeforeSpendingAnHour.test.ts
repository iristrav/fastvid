import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  formatVisionJudgeUnreachable,
  VISION_PROBE_TIMEOUT_MS,
} from "./visionJudgeReachability";

/**
 * ASK WHETHER THERE IS A JUDGE BEFORE SPENDING AN HOUR FINDING OUT.
 *
 * ── What render 580 cost ────────────────────────────────────────────────────────────────────
 *
 *     [Pipeline] Stage 4 (compose): 3 scenes in 3788.7s
 *     [BeatImageGate] no verdict: 219x gate could not ask: No vision-capable provider is
 *                     available | 7x provider unavailable (gemini 403) | 4x timeout
 *     [Video Generation] Error: Render rejected — the picture editor was unreachable
 *
 * Sixty-three minutes to discover a condition that was already true when the render started. All
 * 228 declines had one cause and the first one knew it.
 *
 * ── Why a configuration check would not have caught it ──────────────────────────────────────
 *
 * `GEMINI_API_KEY` was set. `providersToTry` checks for a key and a cooldown, not for permission,
 * so the chain would have included Gemini and a config check would have reported a healthy render.
 * The 403 PERMISSION_DENIED — "project has been denied access" — exists only in the answer to a
 * real call. So the probe makes one, through the same `invokeLLM` and the same chain the gate
 * itself uses: a second opinion about which providers are usable would drift from the first, and a
 * preflight that disagrees with the thing it protects is worse than none.
 *
 * ── What it must never become ───────────────────────────────────────────────────────────────
 *
 * A new way to lose a video. A probe that could fail a render by failing ITSELF would be exactly
 * that, so every failure path returns `reachable: false` with a reason instead of throwing.
 */

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

/** Load the probe with `invokeLLM` replaced — no provider is contacted by this test file. */
async function probeWith(impl: () => unknown) {
  /**
   * Reset FIRST. This file imports the module statically for its pure helpers, so the real
   * `_core/llm` is already in the registry by the time the first case runs; without this the mock
   * is ignored and the probe reaches a provider that is not configured — which then LOOKS like the
   * unreachable case and would have made the reachable test pass for the wrong reason.
   */
  vi.resetModules();
  vi.doMock("./_core/llm", () => ({ invokeLLM: vi.fn(impl) }));
  const mod = await import("./visionJudgeReachability");
  return mod.probeVisionJudge(50);
}

describe("the probe answers what the render needs to know", () => {
  it("A PROVIDER THAT ANSWERS IS REACHABLE, AND IS NAMED", () => {
    return probeWith(() => ({
      choices: [{ index: 0, message: { content: "ok" } }],
      provider: "openai",
    })).then((r) => {
      expect(r.reachable).toBe(true);
      expect(r.provider).toBe("openai");
    });
  });

  it("RENDER 580'S CONDITION IS CAUGHT — the provider's own words come back", async () => {
    const r = await probeWith(() => {
      throw new Error(
        "No vision-capable provider is available: Groq is excluded from image calls and no other provider is usable right now."
      );
    });
    expect(r.reachable).toBe(false);
    expect(r.reason).toContain("No vision-capable provider is available");
  });

  it("and so is a key that exists but is denied", async () => {
    const r = await probeWith(() => {
      throw new Error("No LLM provider had capacity for this request (gemini 403). Last response: …");
    });
    expect(r.reachable).toBe(false);
    expect(r.reason).toContain("gemini 403");
  });

  it("A PROBE THAT FAILS NEVER THROWS — it must not become a new way to lose a video", async () => {
    for (const boom of [
      () => { throw new Error("socket hang up"); },
      () => { throw "a bare string, not an Error"; },
      () => new Promise(() => { /* never settles — the timeout must win */ }),
    ]) {
      const r = await probeWith(boom as () => unknown);
      expect(r.reachable).toBe(false);
      expect(typeof r.reason).toBe("string");
    }
  });

  it("an answer with no content is not a reachable judge", async () => {
    /** A provider that replies but says nothing cannot judge a frame either. */
    const r = await probeWith(() => ({ choices: [{ index: 0, message: { content: null } }] }));
    expect(r.reachable).toBe(false);
    expect(r.reason).toContain("no content");
  });

  it("the reason is bounded — a provider may return a page of HTML", async () => {
    const r = await probeWith(() => { throw new Error("x".repeat(5000)); });
    expect(r.reason!.length).toBeLessThanOrEqual(300);
  });
});

describe("what the probe costs and what it refuses to send", () => {
  const SRC = readFileSync(join(__dirname, "visionJudgeReachability.ts"), "utf8");

  it("ONE TINY IMAGE AT LOW DETAIL, AND FIVE TOKENS", () => {
    /**
     * The probe runs before every render. A costly one would be a tax on each of them, and the
     * question it asks — "is anything there" — does not need a real frame.
     */
    expect(SRC).toContain('detail: "low" as const');
    expect(SRC).toContain("maxTokens: 5");
    expect(VISION_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it("IT READS NO FRAME FROM THE RENDER", () => {
    /** Waiting for the render to produce a frame is the hour this exists to save. */
    expect(SRC).not.toMatch(/readFileSync|ffmpeg|workDir/);
  });

  it("and it never reports a credential", () => {
    /**
     * The distinction that matters: NAMING a variable an operator must set is guidance and belongs
     * in the message — `formatVisionJudgeUnreachable` says "a Gemini key whose project is not
     * denied" on purpose. READING one, or putting a value anywhere near the output, is what must
     * not happen. So this asserts the module never touches the environment and never asks a
     * provider helper for a key, rather than banning the word.
     */
    expect(SRC, "the probe reads the environment").not.toMatch(/process\.env/);
    expect(SRC).not.toMatch(/KeyFromEnv|apiKey|api_key|Bearer |sk-[A-Za-z0-9]/);
    /** And the reason it prints is the provider's error string, never a constructed report. */
    expect(SRC).toContain("(err as Error)?.message?.slice(0, 300)");
  });

  it("it reuses the one chain rather than deriving a second opinion", () => {
    expect(SRC).toContain('from "./_core/llm"');
    expect(SRC).not.toContain("providersToTry");
    expect(SRC).not.toMatch(/groqKeyFromEnv|geminiKeyFromEnv|openAiKeyFromEnv/);
  });
});

describe("the message matches the gate it is standing in for", () => {
  it("SAME TWO REMEDIES, SAME WARNING ON THE ESCAPE HATCH", () => {
    /**
     * Two different sentences for one condition is how an operator ends up fixing the wrong thing.
     * Pinned against the export gate's own wording.
     */
    const msg = formatVisionJudgeUnreachable({ reachable: false, reason: "gemini 403" });
    const REPORT = readFileSync(join(__dirname, "videoQualityReport.ts"), "utf8");
    expect(msg).toContain("Restore a vision provider (OpenAI credit, or a Gemini key whose project is not denied)");
    expect(REPORT).toContain("Restore a vision provider (OpenAI credit, or a Gemini key whose project is not denied)");
    expect(msg).toContain("only if you accept unjudged footage");
    expect(REPORT).toContain("only if you accept unjudged footage");
  });

  it("and says plainly that nothing was rendered", () => {
    const msg = formatVisionJudgeUnreachable({ reachable: false });
    expect(msg).toContain("Render not started");
    expect(msg).toContain("No provider answered.");
  });
});

describe("where the pipeline asks it", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("BEFORE ANY WORK, BESIDE THE DISK-SPACE PRECONDITION", () => {
    const disk = PIPE.indexOf("assertDiskSpaceAvailable(workDir, videoId);");
    const probe = PIPE.indexOf("const judge = await probeVisionJudge();");
    const compose = PIPE.indexOf("Stage 4 (compose)");
    expect(probe).toBeGreaterThan(disk);
    expect(probe, "the probe must run before the render does any work").toBeLessThan(compose);
  });

  it("AND ONLY WHEN THE JUDGE IS SUPPOSED TO BE ASKED", () => {
    /**
     * `ENABLE_BEAT_IMAGE_RELEVANCE_GATE=false` means the operator turned the judge off on purpose,
     * and the export gate says the same in as many words: "a render where every provider is down
     * but the gate is switched off passes." A preflight that refused anyway would be stricter than
     * the gate it stands in for.
     */
    const probe = PIPE.indexOf("const judge = await probeVisionJudge();");
    expect(PIPE.slice(Math.max(0, probe - 400), probe)).toContain("if (beatImageRelevanceGateEnabled()) {");
  });

  it("it refuses with the same error class the export gate uses", () => {
    const probe = PIPE.indexOf("const judge = await probeVisionJudge();");
    const after = PIPE.slice(probe, probe + 700);
    expect(after).toContain("PIPELINE_ERROR.QUALITY_GATE");
    expect(after).toContain("formatVisionJudgeUnreachable(judge)");
  });

  it("and says which provider answered when one does", () => {
    /** A preflight that is silent on success cannot be told from one that never ran. */
    expect(PIPE).toContain("[VisionPreflight] video ${videoId}: picture editor reachable via ${judge.provider}");
  });

  it("THE EXPORT GATE IS STILL THERE — this replaces nothing", () => {
    /**
     * The preflight cannot know whether real footage reaches an unjudged beat; only the export gate
     * can. A preflight that quietly took its place would be a loosening wearing a fix's clothes.
     */
    expect(PIPE).toContain("assertVisionCoverageExportGate(visionCoverageParams)");
    expect(PIPE).toContain("recordBlockedExport(videoId, url,");
  });
});
