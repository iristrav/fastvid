import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { youtubeSourceTierBonus } from "./retrievalFunnel";

/**
 * A MISSING ROW, NOT A NUMBER SET TOO LOW.
 *
 * The pre-Vision ranking reads `EXTERNAL_SOURCE_TIER_BONUS[c.source] ?? 0`. `youtube_cc` arrived
 * later than that table — the pool route was built in RONDE 169/170/175 — and no entry was ever
 * added, so every YouTube candidate scored `0.7 + 0`: the same tier as Pexels and Pixabay, and
 * below all seven historical sources including Wikimedia's 0.10.
 *
 * With `buildDownloadShortlist` filling in rankingScore order, that decided whether YouTube ever
 * ranked high enough to use the chances its per-source cap allowed it. Render 577: one beat of
 * nineteen.
 */

const ENV = process.env.YOUTUBE_TIER_BONUS;
afterEach(() => {
  if (ENV === undefined) delete process.env.YOUTUBE_TIER_BONUS;
  else process.env.YOUTUBE_TIER_BONUS = ENV;
});

const FUNNEL = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");

/** The table's own values, read from the source so the test cannot drift from it. */
function tierBonus(source: string): number {
  const table = FUNNEL.slice(
    FUNNEL.indexOf("const EXTERNAL_SOURCE_TIER_BONUS"),
    FUNNEL.indexOf("};", FUNNEL.indexOf("const EXTERNAL_SOURCE_TIER_BONUS"))
  );
  const m = new RegExp(`\\b${source}:\\s*([0-9.]+)`).exec(table);
  expect(m, `${source} is not in the tier table`).not.toBeNull();
  return Number.parseFloat(m![1]!);
}

describe("YouTube is in the table now", () => {
  it("and ranks above every historical source", () => {
    delete process.env.YOUTUBE_TIER_BONUS;
    const youtube = youtubeSourceTierBonus();
    expect(youtube).toBe(0.22);
    for (const source of ["internet_archive", "nara", "loc", "nasa", "openverse", "europeana", "wikimedia"]) {
      expect(youtube, `youtube must outrank ${source}`).toBeGreaterThan(tierBonus(source));
    }
  });

  it("BY A MARGIN LARGER THAN THE WHOLE EXISTING SPREAD", () => {
    /**
     * The table's best-to-worst historical spread is 0.15 down to 0.10. A margin under 0.05 would
     * leave YouTube inside the existing tier noise, which answers a different question than the
     * one the brief asked.
     */
    const spread = tierBonus("internet_archive") - tierBonus("wikimedia");
    expect(spread).toBeCloseTo(0.05, 5);
    expect(youtubeSourceTierBonus() - tierBonus("internet_archive")).toBeGreaterThan(spread);
  });

  it("it is no longer the `?? 0` default", () => {
    // The defect itself: absent from the table, silently scored as stock.
    expect(FUNNEL).toContain("get youtube_cc() {");
    expect(FUNNEL).toContain("return youtubeSourceTierBonus();");
  });

  it("an operator may dial it, and nonsense is ignored", () => {
    process.env.YOUTUBE_TIER_BONUS = "0.13";
    expect(youtubeSourceTierBonus()).toBe(0.13);
    process.env.YOUTUBE_TIER_BONUS = "0";
    expect(youtubeSourceTierBonus(), "zero is a legitimate choice — back to the old behaviour").toBe(0);
    process.env.YOUTUBE_TIER_BONUS = "5";
    expect(youtubeSourceTierBonus()).toBe(0.22);
    process.env.YOUTUBE_TIER_BONUS = "banana";
    expect(youtubeSourceTierBonus()).toBe(0.22);
  });
});

describe("what a bonus still cannot do", () => {
  it("STOCK STAYS AT ZERO — this is not a general loosening", () => {
    expect(tierBonus("pexels")).toBe(0);
    expect(tierBonus("pixabay")).toBe(0);
  });

  it("every other source keeps its exact value", () => {
    expect(tierBonus("internet_archive")).toBe(0.15);
    expect(tierBonus("nara")).toBe(0.145);
    expect(tierBonus("loc")).toBe(0.14);
    expect(tierBonus("nasa")).toBe(0.135);
    expect(tierBonus("openverse")).toBe(0.125);
    expect(tierBonus("europeana")).toBe(0.12);
    expect(tierBonus("wikimedia")).toBe(0.1);
  });

  it("AN OFF-TOPIC CANDIDATE IS STILL DROPPED BEFORE THE BONUS IS APPLIED", () => {
    /**
     * The guard that keeps this honest: a bonus can lift a matching candidate up the shortlist,
     * and can never rescue material that does not match the beat. The topicality verdict is read
     * and the candidate `continue`d BEFORE `rankingScore` is computed.
     */
    const at = FUNNEL.indexOf("const topical = topicMatcher ? assessCandidateTopicality(");
    const scoreAt = FUNNEL.indexOf("const rankingScore =", at);
    expect(at).toBeGreaterThan(0);
    expect(scoreAt).toBeGreaterThan(at);
    expect(FUNNEL.slice(at, scoreAt)).toContain('if (topical?.verdict === "off_topic") {');
    expect(FUNNEL.slice(at, scoreAt)).toContain("continue;");
  });

  it("the bonus feeds ranking only — the winner is still VisionGate's", () => {
    /** Anchored on the external merge — `rankingScore` is computed on more than one path. */
    const from = FUNNEL.indexOf("const topical = topicMatcher ? assessCandidateTopicality(");
    const at = FUNNEL.indexOf("const rankingScore =", from);
    const body = FUNNEL.slice(at, at + 420);
    expect(body).toContain("EXTERNAL_SOURCE_TIER_BONUS[c.source] ?? 0");
    expect(FUNNEL).toContain("pickBestFunnelCandidate");
  });

  it("the per-source cap and the download budget are untouched", () => {
    // Ranking decides the ORDER; these two still decide how many get downloaded at all.
    expect(FUNNEL).toContain("export const MAX_FUNNEL_CANDIDATES_TO_SCORE = 6;");
    expect(FUNNEL).toContain('if (source === "youtube_cc") return maxShortlistPerYoutubeSource();');
  });
});
