import { describe, expect, it } from "vitest";
import { archiveTopicsShareSubject, normalizeArchiveTopicKey, preferLessUsed, recentUsageCounts, recordArchiveVideoUsage } from "./usageDiversity";

describe("usageDiversity", () => {
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

  it("counts each asset's uses in recent same-subject videos — other subjects do not count", () => {
    recordArchiveVideoUsage(9001, [10, 11, 12], "Hitler rise documentary");
    recordArchiveVideoUsage(9002, [10, 20, 21], "Adolf Hitler Third Reich");
    recordArchiveVideoUsage(9003, [30], "Titanic sinking 1912");
    const uses = recentUsageCounts("Hitler documentary", 9999, 6);
    expect(uses.get(10)).toBe(2);
    expect(uses.get(20)).toBe(1);
    expect(uses.has(30)).toBe(false);
    /** The current video's own earlier record never counts against it. */
    expect(recentUsageCounts("Hitler documentary", 9002, 6).get(20)).toBeUndefined();
  });

  const pick = (id: number, score: number, archiveName = "ww2") => ({ asset: { id }, score, archiveName });

  it("prefers the less-used WITHIN a near-tied band, and never drops a candidate", () => {
    const ranked = [pick(1, 50), pick(2, 49), pick(3, 48)];
    const out = preferLessUsed(ranked, { recentVideoUses: new Map([[1, 3], [2, 1]]) });
    expect(out.map((c) => c.asset.id)).toEqual([3, 2, 1]);
    expect(out).toHaveLength(3);
  });

  it("never lets a clearly better match lose to a less-used weaker one", () => {
    const ranked = [pick(1, 90), pick(2, 40)];
    const out = preferLessUsed(ranked, { recentVideoUses: new Map([[1, 5]]) });
    expect(out.map((c) => c.asset.id)).toEqual([1, 2]);
  });

  it("inside one render, an archive drawn on less goes first among ties", () => {
    const ranked = [pick(1, 50, "ww2"), pick(2, 50, "nara")];
    const out = preferLessUsed(ranked, { archiveUsesThisRender: new Map([["ww2", 4]]) });
    expect(out.map((c) => c.archiveName)).toEqual(["nara", "ww2"]);
  });

  it("nothing used yet is a no-op", () => {
    const ranked = [pick(1, 50), pick(2, 49)];
    expect(preferLessUsed(ranked, {})).toBe(ranked);
  });
});
