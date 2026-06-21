import { describe, expect, it } from "vitest";
import {
  hashInClipStartSec,
  inClipOffsetEnabled,
  pickInClipStartFromFrameEmbeddings,
  stockInClipOffsetEnabled,
} from "./clipInClipOffset";

describe("clipInClipOffset", () => {
  it("hashInClipStartSec stays within slack", () => {
    const start = hashInClipStartSec(30, 6, 2);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThanOrEqual(24);
  });

  it("inClipOffsetEnabled respects kill switch", () => {
    const prev = process.env.ENABLE_IN_CLIP_OFFSET;
    process.env.ENABLE_IN_CLIP_OFFSET = "false";
    expect(inClipOffsetEnabled()).toBe(false);
    process.env.ENABLE_IN_CLIP_OFFSET = prev;
  });

  it("stockInClipOffsetEnabled respects kill switch", () => {
    const prev = process.env.ENABLE_STOCK_IN_CLIP_OFFSET;
    process.env.ENABLE_STOCK_IN_CLIP_OFFSET = "false";
    expect(stockInClipOffsetEnabled()).toBe(false);
    process.env.ENABLE_STOCK_IN_CLIP_OFFSET = prev;
  });

  it("pickInClipStartFromFrameEmbeddings picks best-matching frame window", () => {
    const query = [1, 0, 0];
    const frames = [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ];
    const start = pickInClipStartFromFrameEmbeddings(20, 5, frames, query, 0);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThanOrEqual(15);
  });
});
