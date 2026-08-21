import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  isFastShortVideoLength,
  pipelineEmergencyFinishMs,
  pipelineRushModeMs,
  visualSourcingTurboMs,
} from "./sourcingPolicy";

// RONDE 8 — the residual defects renders 517/518 proved after RONDE 5-7:
//
// 8A: the 3min turbo threshold was too tight — the visual stage for a 3-scene 1-min video took
//     ~5min (scenes fill partly sequentially), so the LAST scene always landed in 12s turbo
//     budgets and dropped its beats. Ladder widened for the fast-short path: 5/7/9 min.
// 8B: a scene padded with gray filler scored 100/100 at the export gate because a gray PAD is
//     not a fallback CLIP. Gray pads are now registered on the dedup state and pushed into the
//     quality report's warnings.
// 8D: archive.org WAS finding the right WW2 material (CSPAN 1944, EUROPA The Last Battle,
//     Churchill docs in render 518) but lost it three ways: metadata calls died at 8s, Railway
//     downloads died at 18s, and full-length films (>50MB smallest derivative) were skipped
//     outright. Timeouts widened; oversized items now get a short SEGMENT via ffmpeg's HTTP
//     range seeking, falling back to the old skip on any failure.

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

// ─── 8A: sourcing-ladder thresholds for the 1-min fast path ──────────────────────────────────

describe("RONDE 8A — fast-short sourcing ladder widened to 5/7/9 minutes", () => {
  it("sanity: '1' is the fast-short video length", () => {
    expect(isFastShortVideoLength("1")).toBe(true);
    expect(isFastShortVideoLength("8-10")).toBe(false);
  });

  it("turbo threshold is 5 minutes on the fast-short path", () => {
    expect(visualSourcingTurboMs("1")).toBe(5 * 60_000);
  });

  it("rush mode is 7 minutes on the fast-short path", () => {
    expect(pipelineRushModeMs("1")).toBe(7 * 60_000);
  });

  it("emergency finish is 9 minutes on the fast-short path", () => {
    expect(pipelineEmergencyFinishMs("1")).toBe(9 * 60_000);
  });

  it("ladder order turbo < rush < emergency holds on both paths", () => {
    for (const len of ["1", "8-10"]) {
      expect(visualSourcingTurboMs(len)).toBeLessThan(pipelineRushModeMs(len));
      expect(pipelineRushModeMs(len)).toBeLessThan(pipelineEmergencyFinishMs(len));
    }
  });

  it("the non-fast-short defaults are untouched", () => {
    expect(visualSourcingTurboMs("8-10")).toBe(12_000);
    expect(pipelineRushModeMs("8-10")).toBe(3 * 60_000);
    expect(pipelineEmergencyFinishMs("8-10")).toBe(7 * 60_000);
  });
});

// ─── 8B: gray pads reach the quality report ──────────────────────────────────────────────────

describe("RONDE 8B — a gray pad is registered and reported, not silently shipped", () => {
  it("VisualDedupState tracks grayPadScenes and initializes it empty", () => {
    expect(pipelineSrc).toContain("grayPadScenes: number[];");
    expect(pipelineSrc).toContain("grayPadScenes: [],");
  });

  it("the gray-pad warn site registers the scene on the dedup state (deduplicated)", () => {
    const idx = pipelineSrc.indexOf("gray pad will fill gap");
    expect(idx).toBeGreaterThan(-1);
    const before = pipelineSrc.slice(idx - 800, idx);
    expect(before).toContain("composeOptions.dedup.grayPadScenes.push(scene.index)");
    expect(before).toContain("!composeOptions.dedup.grayPadScenes.includes(scene.index)");
  });

  it("the export path pushes the shortfall into the persisted quality report", () => {
    // RONDE 27 reworded this warning without changing what triggers it. The old text asserted a
    // grey filler had been RENDERED; the list is actually built from the pre-compose estimate,
    // and since RONDE 26 the filler holds the last frame rather than going grey. The registration
    // and the report entry — what this test exists to protect — are unchanged.
    expect(pipelineSrc).toContain("visualDedup.grayPadScenes.length > 0");
    expect(pipelineSrc).toMatch(/qualityReport\.warnings\.push\(\s*`short montage: scene\(s\)/);
    expect(pipelineSrc).toContain("scene(s) with a short montage");
  });
});

// ─── 8D: archive.org yield ───────────────────────────────────────────────────────────────────

describe("RONDE 8D — archive.org items survive their metadata/download window", () => {
  it("the metadata call is back to 8s (RONDE 11 reverted the 15s that stalled render 521)", () => {
    // RONDE 8 raised this to 15s; render 521 proved that backfired (36 calls × 15s = 12m44s
    // render, all scenes gray), so RONDE 11 reverted it to 8s. The download timeout stays 45s.
    const idx = pipelineSrc.indexOf("`Internet Archive metadata scene ${sceneIndex}`");
    expect(idx).toBeGreaterThan(-1);
    const window = pipelineSrc.slice(idx - 500, idx);
    expect(window).toContain("8_000");
    expect(window).not.toContain("15_000");
  });

  it("the download gets a flat 45s (the old Railway 18s killed real archive reels)", () => {
    const idx = pipelineSrc.indexOf("`Internet Archive download scene ${sceneIndex}`");
    expect(idx).toBeGreaterThan(-1);
    const window = pipelineSrc.slice(idx - 400, idx);
    expect(window).toContain("45_000");
    expect(window).not.toContain("IS_RAILWAY ? 18_000");
  });
});

describe("RONDE 8D — oversized archive films are segment-fetched instead of skipped", () => {
  const fnStart = pipelineSrc.indexOf("async function fetchArchiveSegmentViaFfmpeg(");
  const fnEnd = pipelineSrc.indexOf("Download a YouTube CC clip", fnStart);
  const fn = pipelineSrc.slice(fnStart, fnEnd);

  it("the segment fetcher exists", () => {
    expect(fnStart).toBeGreaterThan(-1);
  });

  it("it stream-copies a bounded window over HTTP (no full-file download, no re-encode)", () => {
    expect(fn).toContain('"-ss", "90"');
    expect(fn).toContain('"-t", String(segmentSec)');
    expect(fn).toContain('"-c", "copy"');
  });

  it("it is time-bounded and validates its output before claiming success", () => {
    expect(fn).toContain("30_000");
    expect(fn).toContain("isValidVideoFile(outPath)");
  });

  it("it never throws — every failure returns false so the caller can skip the item", () => {
    expect(fn).toContain("return false;");
    expect(fn).toMatch(/catch \(err\) \{[\s\S]{0,400}return false;/);
  });

  it("the oversize branch calls the segment fetcher and only skips when that also fails", () => {
    const idx = pipelineSrc.indexOf("segment fetch failed, skipping");
    expect(idx).toBeGreaterThan(-1);
    const window = pipelineSrc.slice(idx - 900, idx);
    expect(window).toContain("knownSize > MAX_ARCHIVE_SIZE");
    expect(window).toContain("fetchArchiveSegmentViaFfmpeg(videoUrl, tmpPath, segmentSec, sceneIndex)");
  });

  it("the ≤50MB path still enforces the exact old size ceiling after download", () => {
    expect(pipelineSrc).toContain("if (bytesWritten > MAX_ARCHIVE_SIZE) {");
    expect(pipelineSrc).toContain("const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024;");
  });
});
