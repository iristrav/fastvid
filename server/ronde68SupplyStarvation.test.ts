import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { youtubeMaxDownloadsPerRender } from "./sourcingPolicy";

/**
 * RONDE 68 — the supply problem, and it was mine.
 *
 * Seven rounds went into SELECTION — choosing better, judging harder, cutting the right second.
 * Render 533 showed the real constraint is SUPPLY:
 *
 *     internet_archive   3 searches   12 results     0 downloads   0 used
 *     sepiasearch        3 searches   45 results     1 download    0 used
 *     wikimedia          0 searches    0 results     0 downloads   0 used
 *     youtube_cc        18 searches  210 results   134 downloads   0 used
 *
 * Wikimedia — the source for a WWII documentary — ran zero searches:
 *
 *     Wikimedia search failed: cancelled by the enclosing scene budget
 *     Wikimedia: 3 consecutive search failures — skipping for 3min
 *
 * It was cancelled three times and stood itself down. What consumed the budget:
 *
 *     150 x  RapidAPI YouTube download ... cancelled by the enclosing scene budget
 *      58 x  SepiaSearch download ...     cancelled
 *      30 x  Internet Archive search ...  cancelled
 *      24 x  Wikimedia (video) search ... cancelled
 *
 * And the 150 is a RONDE 62 bug of mine. The download ceiling was a local variable in
 * fetchYouTubeCCClips, which is called about twenty-six times per render — so "6 per scene" was
 * really "6 per call":
 *
 *     26 x "download ceiling reached (6/6 attempts, 0 accepted)"   ->  26 x 6 = 156
 *
 * The cap fired every single time and bounded nothing.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

const PIPELINE = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("RONDE 68 — the ceiling counts what it claimed to count", () => {
  it("the counter is render-scoped, not a local reset on every call", () => {
    const src = PIPELINE();
    expect(src).toContain(
      'const downloadsSoFar = () => providerMetrics(sourcingCache, "youtube_cc").downloadSlotsClaimed;'
    );
    // The local that made the cap per-call is gone.
    expect(src).not.toContain("let downloadAttempts = 0;");
    expect(src).not.toContain("downloadAttempts++;");
  });

  it("all three loop levels check the render-wide count", () => {
    const src = PIPELINE();
    const checks = [...src.matchAll(/downloadsSoFar\(\) >= maxDownloadAttempts/g)];
    expect(checks).toHaveLength(3);
  });

  it("it reads the same counter the download increments, so it cannot drift", () => {
    // RONDE 69 makes this stricter rather than looser. RONDE 68 had the check at the top of the
    // loop and the increment after the download returned — the same counter, but two awaits
    // apart, which render 534 showed is not a ceiling at all (20/20, 21/20, 22/20, 23/20).
    // The read and the write are now two adjacent lines of one function, so "cannot drift" is
    // no longer a property of where the calls happen to sit. See claimYoutubeDownloadSlot.
    const src = PIPELINE();
    expect(src).toContain('const m = providerMetrics(cache, "youtube_cc");');
    expect(src).toContain("if (m.downloadSlotsClaimed >= maxDownloads) return false;");
    expect(src).toContain("m.downloadSlotsClaimed++;");
    /**
     * And the loop no longer increments behind the download's back.
     *
     * The field is `downloadSlotsClaimed` now, and moving this assertion onto it is what keeps the
     * test honest rather than merely green. The ceiling's counter must still be written in exactly
     * one place; `downloadCount` is a different number with a different meaning — successes, for
     * the usage report — and the loop bumping THAT after a download arrives is correct and is what
     * this split exists to allow.
     */
    expect(src).not.toContain('providerMetrics(sourcingCache, "youtube_cc").downloadSlotsClaimed++;');
  });

  it("the ceiling is a render budget YouTube can still work within", () => {
    // Generous on purpose: YouTube must stay a real participant.
    expect(youtubeMaxDownloadsPerRender()).toBeGreaterThanOrEqual(10);
    // But far below the 134 it spent in render 533 for zero adopted clips.
    expect(youtubeMaxDownloadsPerRender()).toBeLessThan(134);
  });

  it("is env-overridable, and honours the old variable name too", () => {
    vi.stubEnv("YOUTUBE_MAX_DOWNLOADS_PER_RENDER", "5");
    expect(youtubeMaxDownloadsPerRender()).toBe(5);
    vi.unstubAllEnvs();
    vi.stubEnv("YOUTUBE_MAX_DOWNLOAD_ATTEMPTS", "7");
    expect(youtubeMaxDownloadsPerRender()).toBe(7);
    vi.unstubAllEnvs();
    // The default the ceiling falls back to. Raised from 20 to 60 deliberately — see the note on
    // `youtubeMaxDownloadsPerRender`: the production logs show 97-103 attempts completing without
    // harm and yielding 17-44 clips, against 20 attempts yielding 0-2. The RANGE this file guards
    // (>= 10, < 134) is unchanged and 60 sits inside it.
    vi.stubEnv("YOUTUBE_MAX_DOWNLOADS_PER_RENDER", "junk");
    expect(youtubeMaxDownloadsPerRender()).toBe(60);
    vi.stubEnv("YOUTUBE_MAX_DOWNLOADS_PER_RENDER", "0");
    expect(youtubeMaxDownloadsPerRender()).toBe(60);
  });

  it("the ceiling message no longer claims to be per scene", () => {
    const src = PIPELINE();
    expect(src).toContain("YouTube download ceiling reached for this RENDER");
  });
});

describe("RONDE 68 — a transfer that cannot finish is not started", () => {


  it("the window is large enough to be a real judgement, not a formality", () => {
    const src = PIPELINE();
    const m = /const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = ([0-9_]+);/.exec(src);
    expect(m).not.toBeNull();
    const ms = Number(m![1]!.replace(/_/g, ""));
    // Render 533's downloads were given a 5s floor and still died mid-transfer.
    expect(ms).toBeGreaterThan(5_000);
    // But not so large that YouTube can never download anything.
    expect(ms).toBeLessThanOrEqual(30_000);
  });

});

describe("RONDE 68 — what this is meant to give back", () => {

  it("YouTube is bounded, not disabled — it must stay a participant", () => {
    const src = PIPELINE();
    // No blanket off-switch was added; the source still runs, within a budget.
    expect(src).not.toContain("YOUTUBE_DISABLED");
    expect(youtubeMaxDownloadsPerRender()).toBeGreaterThan(0);
  });
});
