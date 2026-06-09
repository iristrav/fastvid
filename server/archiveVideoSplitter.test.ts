import { describe, expect, it } from "vitest";
import {
  buildClipRanges,
  mapPool,
  maxArchiveUploadBytes,
  maxArchiveVideoDurationSec,
  mergeNearbyCuts,
  splitBudgetMs,
} from "./archiveVideoSplitter";

describe("archiveVideoSplitter", () => {
  it("mergeNearbyCuts dedupes close cut points", () => {
    expect(mergeNearbyCuts([1.0, 1.2, 3.5, 3.7], 0.75)).toEqual([1.0, 3.5]);
  });

  it("buildClipRanges splits on cuts and merges tiny segments", () => {
    const ranges = buildClipRanges([2, 2.4, 10], 15, 1.2, 50);
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges[0].start).toBe(0);
    expect(ranges[ranges.length - 1].end).toBe(15);
    for (const r of ranges) {
      expect(r.end - r.start).toBeGreaterThanOrEqual(1.0);
    }
  });

  it("buildClipRanges returns single range when no cuts", () => {
    expect(buildClipRanges([], 8, 1.2, 50)).toEqual([{ start: 0, end: 8 }]);
  });

  it("defaults support 20 min video within 9 min split budget", () => {
    expect(maxArchiveVideoDurationSec()).toBe(1200);
    expect(splitBudgetMs()).toBe(540_000);
    expect(maxArchiveUploadBytes()).toBe(600 * 1024 * 1024);
  });

  it("mapPool runs with bounded concurrency and preserves order", async () => {
    const order: number[] = [];
    const out = await mapPool([0, 1, 2, 3, 4], 2, async (_v, i) => {
      order.push(i);
      await new Promise((r) => setTimeout(r, 5));
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
    expect(order.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });
});
