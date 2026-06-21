import { describe, expect, it } from "vitest";
import { hashInClipStartSec, inClipOffsetEnabled } from "./clipInClipOffset";

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
});
