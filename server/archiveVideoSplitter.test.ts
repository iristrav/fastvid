import { describe, expect, it } from "vitest";
import {
  buildClipRanges,
  combineShotCutTimes,
  mapPool,
  maxArchiveUploadBytes,
  maxArchiveVideoDurationSec,
  mergeNearbyCuts,
  parsePtsTimesFromFfmpeg,
  parseScdetTimesFromFfmpeg,
  splitBudgetMs,
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

  it("parseScdetTimesFromFfmpeg reads lavfi.scd.time", () => {
    const stderr = 'lavfi.scd.time="3.456"\nlavfi.scd.time=7.89';
    expect(parseScdetTimesFromFfmpeg(stderr, 60)).toEqual([3.456, 7.89]);
  });

  it("parsePtsTimesFromFfmpeg reads showinfo pts_time", () => {
    const stderr = "n:0 pts_time:2.5 ...\nn:1 pts_time:8.0 ...";
    expect(parsePtsTimesFromFfmpeg(stderr, 60)).toEqual([2.5, 8.0]);
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
