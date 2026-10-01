import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

/**
 * RONDE 61 — YOUTUBE EATING THE RENDER'S JUDGEMENTS, AND WHY THE SLICE IS GONE.
 *
 * Render 532 spent 52 of its 60 judgements on YouTube candidates and refused 48 of them, leaving
 * the funnel — the route the adopted clips actually come from — just 8. This describe guarded the
 * answer to that: a separate 24-judgement slice YouTube could not spend past.
 *
 * The crowding was possible only because YouTube was judged BEFORE a clip entered any beat's
 * pool, so it drew on the render ceiling outside the one place where drawing is bounded. That
 * screening is gone, and with it the need for a slice: YouTube now reaches the editor through the
 * beat shortlist like every other source, where `maxShortlistPerBeatPerSource` caps what any one
 * source may put to the editor per beat.
 *
 * So the finding survives and the mechanism it justified does not. See
 * youtubeIsJudgedWhereItIsUsed.test.ts, which carries render 532's measurement and asserts both
 * that the slice has no definition left and that the two real budgets are untouched.
 */

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
