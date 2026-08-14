import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  archiveVisualBeatSecForVideo,
  archiveVisualMaxClipSecForVideo,
  archiveVisualMaxClipSec,
} from "./sourcingPolicy";

// F3-23: on the 1-min ("fast/short") video path, archiveVisualBeatSecForVideo used to default to
// 24s and was ALSO used directly as several beats' holdSec (videoPipeline.ts) — meaning a single
// archive clip could be held on screen for up to 24s of a 60s video. A critical review of the
// "Why Hitler Killed Himself" 1-min production render flagged exactly this: "te lang hetzelfde
// beeld" / one static image held over a long stretch of narration. Tightened the default to 10s
// (env override range narrowed from 12-24s to 6-12s) — still longer than the normal 8s cap (some
// of the intended fast-path perf benefit is kept — fewer, slightly longer beats than the full
// cadence), but nowhere near the 24s that directly caused the complaint.
describe("sourcingPolicy — F3-23 fast-path shot duration", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.FAST_ARCHIVE_BEAT_SEC;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("Test 5/6 — a 1-minute (fast/short) video's max single-shot hold is well under half the video, not 24s", () => {
    const oneMinHold = archiveVisualBeatSecForVideo("1");
    expect(oneMinHold).toBe(10);
    expect(oneMinHold).toBeLessThan(24);
    // archiveVisualMaxClipSecForVideo delegates straight to this value on the fast path — the
    // actual clip-trim ceiling used by prepareCuratedArchiveClip's clampHoldSec.
    expect(archiveVisualMaxClipSecForVideo("1")).toBe(oneMinHold);
  });

  it("longer (non fast/short) videos are unaffected — still use the standard 5-8s cadence/cap", () => {
    expect(archiveVisualMaxClipSecForVideo("8-10")).toBe(archiveVisualMaxClipSec());
    expect(archiveVisualMaxClipSecForVideo(null)).toBe(archiveVisualMaxClipSec());
  });

  it("FAST_ARCHIVE_BEAT_SEC override is now clamped to the tightened 6-12s range, not the old 12-24s range", () => {
    process.env.FAST_ARCHIVE_BEAT_SEC = "24";
    // 24 is now out of range — falls back to the new default (10), not the old permissive 24.
    expect(archiveVisualBeatSecForVideo("1")).toBe(10);

    process.env.FAST_ARCHIVE_BEAT_SEC = "8";
    expect(archiveVisualBeatSecForVideo("1")).toBe(8);
  });
});
