import { describe, expect, it } from "vitest";
import {
  getCrossVideoExcludeAssetIds,
  normalizeArchiveTopicKey,
  recordArchiveVideoUsage,
  seededShuffle,
} from "./archiveUsageMemory";

describe("archiveUsageMemory", () => {
  it("normalizes Hitler topics to same bucket", () => {
    expect(normalizeArchiveTopicKey("Hitler: Rise of the Third Reich")).toBe("hitler");
    expect(normalizeArchiveTopicKey("Adolf Hitler documentary")).toBe("hitler");
    expect(normalizeArchiveTopicKey("Titanic sinking 1912")).toBe("maritime");
  });

  it("excludes assets from recent same-topic videos", () => {
    recordArchiveVideoUsage(9001, [10, 11, 12], "Hitler rise documentary");
    recordArchiveVideoUsage(9002, [20, 21], "Adolf Hitler Third Reich");
    recordArchiveVideoUsage(9003, [30], "Titanic sinking 1912");
    const excluded = getCrossVideoExcludeAssetIds("Hitler documentary", 9999, 6);
    expect(excluded.has(10)).toBe(true);
    expect(excluded.has(20)).toBe(true);
    expect(excluded.has(30)).toBe(false);
  });

  it("seededShuffle permutes order deterministically", () => {
    const base = [1, 2, 3, 4, 5];
    const a = seededShuffle(base, 42).join(",");
    const b = seededShuffle(base, 42).join(",");
    const c = seededShuffle(base, 99).join(",");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
