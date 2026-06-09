import { describe, expect, it } from "vitest";
import { buildClipRanges, mergeNearbyCuts } from "./archiveVideoSplitter";

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
});
