import { describe, expect, it } from "vitest";
import {
  dHashFromGray8x8,
  hammingDistance,
  isNearDuplicateFingerprint,
  isNearDuplicateHash,
  parseArchiveFragmentNote,
} from "./archiveClipDedup";

describe("archiveClipDedup", () => {
  it("dHash differs for contrasting horizontal gradient vs inverted", () => {
    const a = Buffer.alloc(64);
    const b = Buffer.alloc(64);
    for (let i = 0; i < 64; i++) {
      a[i] = i % 2 === 0 ? 20 : 200;
      b[i] = i % 2 === 0 ? 200 : 20;
    }
    const ha = dHashFromGray8x8(a);
    const hb = dHashFromGray8x8(b);
    expect(ha).not.toBe(hb);
    expect(hammingDistance(ha, hb)).toBeGreaterThan(6);
  });

  it("isNearDuplicateHash matches identical hashes", () => {
    const gray = Buffer.alloc(64, 128);
    const h = dHashFromGray8x8(gray);
    expect(isNearDuplicateHash(h, h, 6)).toBe(true);
  });

  it("isNearDuplicateHash rejects very different hashes", () => {
    expect(isNearDuplicateHash(0n, 0xffffffffffffffn, 6)).toBe(false);
  });

  it("isNearDuplicateFingerprint matches when most samples align", () => {
    const a = [1n, 2n, 3n];
    const b = [1n, 99n, 3n];
    expect(isNearDuplicateFingerprint(a, b, 0)).toBe(true);
  });

  it("parseArchiveFragmentNote reads source and time range", () => {
    const parsed = parseArchiveFragmentNote("Fragment uit videoplayback (1).mp4 (16:54–16:55)");
    expect(parsed).toEqual({
      sourceKey: "videoplayback (1).mp4",
      startSec: 16 * 60 + 54,
      endSec: 16 * 60 + 55,
    });
  });

  it("fragments from same source with identical time range are redundant", () => {
    const a = parseArchiveFragmentNote("Fragment uit netherlands.mp4 (16:54–16:55)");
    const b = parseArchiveFragmentNote("Fragment uit netherlands.mp4 (16:54–16:55)");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.sourceKey).toBe(b!.sourceKey);
    expect(a!.startSec).toBe(b!.startSec);
    expect(a!.endSec).toBe(b!.endSec);
  });
    const a = [1n, 2n, 3n];
    const b = [255n, 254n, 253n];
    expect(isNearDuplicateFingerprint(a, b, 2)).toBe(false);
  });
});
