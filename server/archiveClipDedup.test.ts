import { describe, expect, it } from "vitest";
import { dHashFromGray8x8, hammingDistance, isNearDuplicateHash } from "./archiveClipDedup";

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
});
