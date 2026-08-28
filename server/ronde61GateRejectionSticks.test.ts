import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pickBestFunnelCandidate } from "./retrievalFunnel";
import {
  createBeatImageGateState,
  maxYoutubeBeatImageJudgements,
  maxBeatImageJudgementsPerRender,
} from "./beatImageRelevanceGate";
import { youtubeVideoContextTimeoutMs } from "./youtubeVideoContext";

/**
 * RONDE 61 — the gate was right and the pipeline ignored it.
 *
 * Render 532 ran the RONDE 58 gate for the first time, and it worked. It named what it saw:
 *
 *   s2b3  does_not_fit  "modern posters ... related to white supremacy"
 *   s2b2  does_not_fit  "modern-day street scene featuring a tram and contemporary buildings"
 *   s2b1  does_not_fit  "Adolf Hitler with high-ranking officers, outdoors"
 *   s2b0  fits          "Signed Photograph of Adolf Hitler"
 *
 * All four of those clips are in the final manifest. Three of them were refused twice — once per
 * look — and adopted anyway.
 *
 * The cause is one line in pickBestFunnelCandidate:
 *
 *     const passers = unusedPassers.length > 0 ? unusedPassers : allPassers;
 *
 * Marking a refused candidate "used" is a soft preference for variety, and when it empties the
 * unused set the picker restores the full list and hands back the very clip just refused. On a
 * beat with one passer — the common case — the rejection could not do anything at all.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── A scored funnel candidate, minimal but real in the fields the picker reads ────────────────
const cand = (id: string, source: string, score: number) =>
  ({
    candidate: { id, source, title: id },
    clipPath: `/tmp/${id}.mp4`,
    visionResult: { pass: true, worstScore10: score },
  }) as unknown as Parameters<typeof pickBestFunnelCandidate>[0][number];

describe("RONDE 61 — a refused candidate stays refused", () => {
  it("the sole passer on a beat is NOT handed back after it is refused", () => {
    const scored = [cand("white-lives-matter-montana", "internet_archive", 9)];
    const used = new Set(["white-lives-matter-montana"]);
    const refused = new Set(["white-lives-matter-montana"]);

    // The old behaviour, still intact for the soft used-set: variety yields to availability.
    expect(pickBestFunnelCandidate(scored, used)?.candidate.id).toBe("white-lives-matter-montana");
    // The new hard exclusion does not yield. The beat gets nothing and falls through.
    expect(pickBestFunnelCandidate(scored, used, refused)).toBeNull();
  });

  it("a refused candidate steps aside for one that was not refused", () => {
    const scored = [
      cand("bundesarchiv-marburg", "wikimedia", 9),
      cand("signed-photograph-of-adolf-hitler", "wikimedia", 4),
    ];
    // Untouched, the higher score wins — which in render 532 was the wrong picture.
    expect(pickBestFunnelCandidate(scored)?.candidate.id).toBe("bundesarchiv-marburg");
    // Refused, the beat takes the genuine Hitler photograph even though it scores lower.
    expect(
      pickBestFunnelCandidate(scored, new Set(), new Set(["bundesarchiv-marburg"]))?.candidate.id
    ).toBe("signed-photograph-of-adolf-hitler");
  });

  it("refusing every candidate returns null rather than the least-bad one", () => {
    const scored = [cand("a", "pexels", 9), cand("b", "archive", 8), cand("c", "wikimedia", 7)];
    expect(pickBestFunnelCandidate(scored, new Set(), new Set(["a", "b", "c"]))).toBeNull();
  });

  it("the soft used-set still behaves exactly as before when nothing is refused", () => {
    const scored = [cand("a", "archive", 9), cand("b", "archive", 8)];
    // Prefers the unused one...
    expect(pickBestFunnelCandidate(scored, new Set(["a"]))?.candidate.id).toBe("b");
    // ...and restores the full set once everything has been used, so a beat is never starved.
    expect(pickBestFunnelCandidate(scored, new Set(["a", "b"]))?.candidate.id).toBe("a");
  });

  it("an empty refusal set changes nothing", () => {
    const scored = [cand("a", "archive", 9), cand("b", "archive", 8)];
    expect(pickBestFunnelCandidate(scored, new Set(), new Set())?.candidate.id).toBe("a");
    expect(pickBestFunnelCandidate(scored, undefined, undefined)?.candidate.id).toBe("a");
  });

  it("a candidate that failed VisionGate is still excluded, refusals aside", () => {
    const failing = {
      candidate: { id: "z", source: "archive", title: "z" },
      clipPath: "/tmp/z.mp4",
      visionResult: { pass: false, worstScore10: 10 },
    } as unknown as Parameters<typeof pickBestFunnelCandidate>[0][number];
    expect(pickBestFunnelCandidate([failing], new Set(), new Set())).toBeNull();
  });
});

describe("RONDE 61 — the pipeline records and honours the refusal", () => {
  const SRC = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("the refusal set is render-scoped, like the gate's own budget", () => {
    const src = SRC();
    expect(src).toContain("beatImageRejectedIds: Set<string>;");
    expect(src).toContain("beatImageRejectedIds: new Set<string>(),");
  });

  it("every pick on the beat passes the refusal set, including the first", () => {
    const src = SRC();
    const idx = src.indexOf("let winner = pickBestFunnelCandidate(");
    expect(idx).toBeGreaterThan(-1);
    // RONDE 142 widened this again: the judging loop and the research pass were split so the
    // research pass is reachable for a beat with no candidate, which lengthened the block.
    // RONDE 131 widened this from 5200: the refusal branch gained the mismatch-feedback
    // block, which pushed the reprieve check past the old edge. The window says "in the
    // funnel's adopt block"; no assertion below it changed.
    const block = src.slice(idx, idx + 9800);
    const picks = [...block.matchAll(/pickBestFunnelCandidate\(\s*\n?\s*scored, dedup\.usedFunnelCandidateIds, dedup\.beatImageRejectedIds/g)];
    expect(picks.length).toBe(2);
    // The bare two-argument call that could hand a refused clip back is gone from this block.
    expect(block).not.toMatch(/pickBestFunnelCandidate\(scored, dedup\.usedFunnelCandidateIds\)/);
  });

  it("a refusal is added to the hard set, not only to the soft one", () => {
    const src = SRC();
    const idx = src.indexOf("let winner = pickBestFunnelCandidate(");
    // RONDE 142 widened this again: the judging loop and the research pass were split so the
    // research pass is reachable for a beat with no candidate, which lengthened the block.
    // RONDE 131 widened this from 5200: the refusal branch gained the mismatch-feedback
    // block, which pushed the reprieve check past the old edge. The window says "in the
    // funnel's adopt block"; no assertion below it changed.
    const block = src.slice(idx, idx + 9800);
    expect(block).toContain("dedup.beatImageRejectedIds.add(winner.candidate.id);");
  });

  /**
   * RONDE 67 amends this. Dropping the winner let the beat fall through to another source, which
   * is right when another source has something — and render 533 showed what it costs when none
   * does: eight beats ended on a grey placeholder, which matches the narration worse than the
   * imperfect picture that was refused. The refusal still removes it from THIS decision; it is
   * now held and used only if nothing else is found anywhere.
   */
  it("running out of looks releases the winner, but keeps it as a last resort", () => {
    const src = SRC();
    const idx = src.indexOf("let winner = pickBestFunnelCandidate(");
    // RONDE 142 widened this again: the judging loop and the research pass were split so the
    // research pass is reachable for a beat with no candidate, which lengthened the block.
    // RONDE 131 widened this from 5200: the refusal branch gained the mismatch-feedback
    // block, which pushed the reprieve check past the old edge. The window says "in the
    // funnel's adopt block"; no assertion below it changed.
    const block = src.slice(idx, idx + 9800);
    expect(block).toContain("if (winner && dedup.beatImageRejectedIds.has(winner.candidate.id))");
    expect(block).toContain("no acceptable candidate");
    // Still nulled here, so every other route is tried first — that half is unchanged.
    expect(block).toMatch(/no acceptable candidate[\s\S]{0,320}winner = null;/);
    // And no longer thrown away.
    expect(block).toMatch(/gateReprieveWinner = winner;[\s\S]{0,80}winner = null;/);
  });
});

describe("RONDE 61 — YouTube no longer eats the render's judgements", () => {
  it("YouTube gets a slice, not the whole budget", () => {
    expect(maxYoutubeBeatImageJudgements()).toBeLessThan(maxBeatImageJudgementsPerRender());
    // Render 532 spent 52 of 60 on YouTube; the slice has to be well under that.
    expect(maxYoutubeBeatImageJudgements()).toBeLessThan(52);
  });

  it("the slice is env-overridable within sane bounds", () => {
    vi.stubEnv("MAX_YOUTUBE_BEAT_IMAGE_JUDGEMENTS", "10");
    expect(maxYoutubeBeatImageJudgements()).toBe(10);
    vi.stubEnv("MAX_YOUTUBE_BEAT_IMAGE_JUDGEMENTS", "nonsense");
    expect(maxYoutubeBeatImageJudgements()).toBe(24);
  });

  it("the state tracks YouTube's spend separately from the render's", () => {
    const state = createBeatImageGateState();
    expect(state.judgementAttempts).toBe(0);
    expect(state.youtubeJudgementsUsed).toBe(0);
  });

  it("past its slice, YouTube adopts as before rather than starting to reject", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const idx = src.indexOf("async function youtubeClipPassesImageGate(");
    const block = src.slice(idx, idx + 2600);
    expect(block).toContain(
      "if (gate.youtubeJudgementsUsed >= maxYoutubeBeatImageJudgements()) return true;"
    );
  });

  it("a cached verdict is free — it does not count against the slice", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const idx = src.indexOf("async function youtubeClipPassesImageGate(");
    const block = src.slice(idx, idx + 2600);
    expect(block).toContain("const spentBefore = gate.judgementAttempts;");
    expect(block).toContain("if (gate.judgementAttempts > spentBefore) gate.youtubeJudgementsUsed++;");
  });
});

describe("RONDE 61 — the watch page gets a budget it can finish in", () => {
  it("it no longer inherits the 3.5s transcript timeout", () => {
    // Render 532: src=unknown on all 52 plans. One to two megabytes of HTML in 3.5 seconds.
    expect(youtubeVideoContextTimeoutMs()).toBeGreaterThan(3_500);
  });

  it("is env-overridable within sane bounds", () => {
    vi.stubEnv("YOUTUBE_CONTEXT_TIMEOUT_MS", "15000");
    expect(youtubeVideoContextTimeoutMs()).toBe(15_000);
    vi.stubEnv("YOUTUBE_CONTEXT_TIMEOUT_MS", "999999");
    expect(youtubeVideoContextTimeoutMs()).toBe(9_000);
    vi.stubEnv("YOUTUBE_CONTEXT_TIMEOUT_MS", "junk");
    expect(youtubeVideoContextTimeoutMs()).toBe(9_000);
  });

  it("the planner caps it by what is left of its own deadline", () => {
    const src = fs.readFileSync(path.join(__dirname, "scriptGuidedClipFinder.ts"), "utf8");
    expect(src).toContain("Math.min(youtubeVideoContextTimeoutMs(), options.deadlineMs - Date.now())");
    // And never hands over a budget too small to be worth spending.
    expect(src).toContain("Math.max(\n    2_500,");
  });

  it("every outcome is logged — render 532 could only say src=unknown", async () => {
    const src = fs.readFileSync(path.join(__dirname, "youtubeVideoContext.ts"), "utf8");
    expect(src).toContain("[YTContext]");
    // The three outcomes that need telling apart: refused, unreadable, timed out.
    expect(src).toContain("http=${resp.status}");
    expect(src).toContain('usable ? "ok" : "unreadable"');
    expect(src).toContain("timeout after ${timeoutMs}ms");
  });
});

describe("RONDE 61 — the log actually distinguishes the failures", () => {
  it("names the timeout as a timeout and a refusal as a status", async () => {
    const { fetchYoutubeVideoContext, _resetYoutubeVideoContextCache } = await import(
      "./youtubeVideoContext"
    );
    _resetYoutubeVideoContextCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    await fetchYoutubeVideoContext("refused", 5_000);
    expect(warn.mock.calls.flat().join(" ")).toContain("http=429");

    warn.mockClear();
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await fetchYoutubeVideoContext("slow", 5_000);
    expect(warn.mock.calls.flat().join(" ")).toContain("timeout after 5000ms");

    warn.mockRestore();
    vi.unstubAllGlobals();
    _resetYoutubeVideoContextCache();
  });

  it("says 'unreadable' when the page arrives but carries nothing usable", async () => {
    const { fetchYoutubeVideoContext, _resetYoutubeVideoContextCache } = await import(
      "./youtubeVideoContext"
    );
    _resetYoutubeVideoContextCache();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "<html></html>" }));
    await fetchYoutubeVideoContext("empty", 5_000);
    expect(log.mock.calls.flat().join(" ")).toContain("unreadable");
    log.mockRestore();
    vi.unstubAllGlobals();
    _resetYoutubeVideoContextCache();
  });
});
