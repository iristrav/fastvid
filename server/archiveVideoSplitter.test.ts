import { describe, expect, it } from "vitest";
import {
  buildClipRanges,
  capClipRanges,
  combineShotCutTimes,
  enforceMinClipDuration,
  mapPool,
  maxArchiveClips,
  maxArchiveUploadBytes,
  maxArchiveVideoDurationSec,
  mergeNearbyCuts,
  normalizeWindowCutTimes,
  parsePtsTimesFromFfmpeg,
  parseScdetTimesFromFfmpeg,
  refineClipRangesWithInteriorCuts,
  splitBudgetMs,
  splitRangeAtInteriorCuts,
} from "./archiveVideoSplitter";

describe("archiveVideoSplitter", () => {
  it("mergeNearbyCuts dedupes duplicate detections of the same cut", () => {
    expect(mergeNearbyCuts([1.0, 1.12, 3.5, 3.55], 0.22)).toEqual([1.0, 3.5]);
  });

  it("buildClipRanges creates one clip per detected shot (not fixed intervals)", () => {
    const cuts = [2, 5, 9, 14];
    const ranges = buildClipRanges(cuts, 20, 50, 0.22);
    expect(ranges).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 5 },
      { start: 5, end: 9 },
      { start: 9, end: 14 },
      { start: 14, end: 20 },
    ]);
  });

  it("buildClipRanges keeps brief shots as separate clips", () => {
    const ranges = buildClipRanges([1, 2, 3, 4, 5, 6, 7, 8], 9, 50, 0.22);
    expect(ranges.length).toBe(9);
    expect(ranges[1]).toEqual({ start: 1, end: 2 });
  });

  it("buildClipRanges returns single range when no cuts", () => {
    expect(buildClipRanges([], 8)).toEqual([{ start: 0, end: 8 }]);
  });

  it("combineShotCutTimes merges scdet + scene detector output", () => {
    const combined = combineShotCutTimes([[1.0, 5.0], [1.05, 5.1, 10.0]]);
    expect(combined).toEqual([1.0, 5.0, 10.0]);
  });

  it("combineShotCutTimes ignores cuts closer than min shot gap", () => {
    expect(combineShotCutTimes([[1, 2, 3, 4, 5, 8]])).toEqual([1, 3, 5, 8]);
  });

  it("enforceMinClipDuration merges sub-min clips with neighbors", () => {
    const merged = enforceMinClipDuration(
      [
        { start: 1014, end: 1015 },
        { start: 1015, end: 1016 },
        { start: 1016, end: 1020 },
      ],
      2.5
    );
    expect(merged).toEqual([{ start: 1014, end: 1020 }]);
  });

  it("parseScdetTimesFromFfmpeg reads lavfi.scd.time", () => {
    const stderr = 'lavfi.scd.time="3.456"\nlavfi.scd.time=7.89';
    expect(parseScdetTimesFromFfmpeg(stderr, 60)).toEqual([3.456, 7.89]);
  });

  it("parsePtsTimesFromFfmpeg reads showinfo pts_time", () => {
    const stderr = "n:0 pts_time:2.5 ...\nn:1 pts_time:8.0 ...";
    expect(parsePtsTimesFromFfmpeg(stderr, 60)).toEqual([2.5, 8.0]);
  });

  it("capClipRanges merges only sub-second flash with neighbor", () => {
    const ranges = [
      { start: 0, end: 4 },
      { start: 4, end: 4.3 },
      { start: 4.3, end: 9 },
    ];
    const capped = capClipRanges(ranges, 2, 0.45);
    expect(capped).toEqual([
      { start: 0, end: 4.3 },
      { start: 4.3, end: 9 },
    ]);
  });

  it("capClipRanges refuses to merge two full shots when over max", () => {
    const ranges = [
      { start: 0, end: 3 },
      { start: 3, end: 6 },
      { start: 6, end: 9 },
    ];
    const capped = capClipRanges(ranges, 2, 0.45);
    expect(capped.length).toBe(3);
  });

  it("splitRangeAtInteriorCuts subdivides a range with missed cuts", () => {
    const parts = splitRangeAtInteriorCuts({ start: 10, end: 20 }, [14, 17]);
    expect(parts).toEqual([
      { start: 10, end: 14 },
      { start: 14, end: 17 },
      { start: 17, end: 20 },
    ]);
  });

  it("refineClipRangesWithInteriorCuts splits only affected ranges", () => {
    const refined = refineClipRangesWithInteriorCuts(
      [
        { start: 0, end: 5 },
        { start: 5, end: 12 },
      ],
      [[], [8]]
    );
    expect(refined).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 8 },
      { start: 8, end: 12 },
    ]);
  });

  it("defaults allow more clips without multi-shot merge", () => {
    expect(maxArchiveClips()).toBe(300);
  });

  it("normalizeWindowCutTimes offsets relative window timestamps", () => {
    expect(normalizeWindowCutTimes([1.5, 4.2], 10, 20)).toEqual([11.5, 14.2]);
  });

  it("defaults support 20 min video within 9 min split budget", () => {
    expect(maxArchiveVideoDurationSec()).toBe(1200);
    expect(splitBudgetMs()).toBe(540_000);
    expect(maxArchiveUploadBytes()).toBe(600 * 1024 * 1024);
  });

  it("mapPool runs with bounded concurrency and preserves order", async () => {
    const out = await mapPool([0, 1, 2, 3, 4], 2, async (_v, i) => {
      await new Promise((r) => setTimeout(r, 5));
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
  });
});
