import { describe, expect, it } from "vitest";
import {
  getCrossVideoExcludeAssetIds,
  archiveTopicsShareSubject,
  normalizeArchiveTopicKey,
  recordArchiveVideoUsage,
  seededShuffle,
} from "./archiveUsageMemory";

describe("archiveUsageMemory", () => {
  it("two topics about the same subject share a cooldown, for any subject", () => {
    /**
     * VIDEO 623 — this asserted hand-made buckets ("hitler", "maritime") that four subjects had and
     * no other. The key is now the topic's own distinctive words, and topics that share one match.
     */
    const same = (a: string, b: string) => archiveTopicsShareSubject(normalizeArchiveTopicKey(a), normalizeArchiveTopicKey(b));
    expect(same("Hitler: Rise of the Third Reich", "Adolf Hitler documentary")).toBe(true);
    expect(same("Marie Curie's secret life", "The untold story of Marie Curie")).toBe(true);
    expect(same("Titanic sinking 1912", "Adolf Hitler documentary")).toBe(false);
    expect(same("The rise of the Roman Empire", "The fall of Napoleon")).toBe(false);
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
