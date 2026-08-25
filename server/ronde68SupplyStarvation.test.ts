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
    expect(src).toContain('const downloadsSoFar = () => providerMetrics(sourcingCache, "youtube_cc").downloadCount;');
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
    expect(src).toContain("if (m.downloadCount >= maxDownloads) return false;");
    expect(src).toContain("m.downloadCount++;");
    // And the loop no longer increments behind the download's back.
    expect(src).not.toContain('providerMetrics(sourcingCache, "youtube_cc").downloadCount++;');
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
    vi.stubEnv("YOUTUBE_MAX_DOWNLOADS_PER_RENDER", "junk");
    expect(youtubeMaxDownloadsPerRender()).toBe(20);
    vi.stubEnv("YOUTUBE_MAX_DOWNLOADS_PER_RENDER", "0");
    expect(youtubeMaxDownloadsPerRender()).toBe(20);
  });

  it("the ceiling message no longer claims to be per scene", () => {
    const src = PIPELINE();
    expect(src).toContain("YouTube download ceiling reached for this RENDER");
  });
});

describe("RONDE 68 — a transfer that cannot finish is not started", () => {
  it("the remaining scene budget is checked before the download begins", () => {
    const src = PIPELINE();
    const idx = src.indexOf("const remainingMs = remainingScopeMs();");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 700);
    expect(block).toContain("remainingMs < YOUTUBE_MIN_DOWNLOAD_WINDOW_MS");
    expect(block).toContain("not enough to finish");
    expect(block).toContain("return false;");
  });

  it("it sits before downloadToFileStreaming, not after it", () => {
    const src = PIPELINE();
    const check = src.indexOf("const remainingMs = remainingScopeMs();");
    expect(check).toBeGreaterThan(-1);
    // Searched FROM the guard — downloadToFileStreaming has other call sites earlier in the file.
    const download = src.indexOf(
      "const { response: dlResp, bytesWritten } = await downloadToFileStreaming(",
      check
    );
    expect(download).toBeGreaterThan(check);
    // And nothing else intervenes: it is the guard immediately in front of the transfer.
    expect(download - check).toBeLessThan(1400);
  });

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

  it("skipping is announced with the reason, so a quiet YouTube is explicable", () => {
    const src = PIPELINE();
    expect(src).toContain("skipping YouTube download of ${videoId}");
    expect(src).toContain("left in the scene budget");
  });
});

describe("RONDE 68 — what this is meant to give back", () => {
  it("the cheap sources are the ones that were starved, and they only need a search", () => {
    // Recorded here because the fix is judged on this, not on YouTube's numbers:
    // Wikimedia went 0 searches / 0 results in render 533 while YouTube ran 134 downloads.
    const src = PIPELINE();
    // The guard's comment names what the freed time is for, so a later edit knows the intent.
    expect(src).toContain("Wikimedia needed for a search");
    expect(src).toContain("Internet Archive");
  });

  it("YouTube is bounded, not disabled — it must stay a participant", () => {
    const src = PIPELINE();
    // No blanket off-switch was added; the source still runs, within a budget.
    expect(src).not.toContain("YOUTUBE_DISABLED");
    expect(youtubeMaxDownloadsPerRender()).toBeGreaterThan(0);
  });
});
