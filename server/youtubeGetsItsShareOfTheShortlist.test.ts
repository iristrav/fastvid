import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  MAX_FUNNEL_CANDIDATES_TO_SCORE,
  maxShortlistPerYoutubeSource,
} from "./retrievalFunnel";

/**
 * ONE BEAT OF NINETEEN.
 *
 * Render 577 delivered six curated archive clips, two openverse, ONE youtube_cc, six placeholders
 * and four beats with no candidate at all. The brief is a film made mostly of YouTube footage, and
 * the per-beat download shortlist is where that was settled before Vision judged anything:
 *
 *     youtube_cc  →  MAX_SHORTLIST_PER_NON_STOCK_SOURCE = 2, against a budget of 6
 *     archive     →  MAX_SHORTLIST_PER_ARCHIVE_SOURCE    = 3
 *
 * A source allowed at most a third of the shortlist cannot become most of the film.
 */

const ENV = process.env.YOUTUBE_SHORTLIST_CAP;
afterEach(() => {
  if (ENV === undefined) delete process.env.YOUTUBE_SHORTLIST_CAP;
  else process.env.YOUTUBE_SHORTLIST_CAP = ENV;
});

const FUNNEL = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");

describe("YouTube's cap", () => {
  it("is its own number, above the shared non-stock cap and the archive's", () => {
    delete process.env.YOUTUBE_SHORTLIST_CAP;
    expect(maxShortlistPerYoutubeSource()).toBe(4);
    expect(FUNNEL).toContain("const MAX_SHORTLIST_PER_NON_STOCK_SOURCE = 2;");
    expect(FUNNEL).toContain("const MAX_SHORTLIST_PER_ARCHIVE_SOURCE = 3;");
  });

  it("NEVER TAKES THE WHOLE SHORTLIST", () => {
    /**
     * Six would let one source own every slot, and a beat where YouTube found nothing usable would
     * then have nothing to fall back on inside the funnel. Two slots stay reachable by the rest.
     */
    expect(maxShortlistPerYoutubeSource()).toBeLessThan(MAX_FUNNEL_CANDIDATES_TO_SCORE);
    expect(MAX_FUNNEL_CANDIDATES_TO_SCORE - maxShortlistPerYoutubeSource()).toBeGreaterThanOrEqual(2);
  });

  it("an operator may tune it, within the budget, and nonsense is ignored", () => {
    process.env.YOUTUBE_SHORTLIST_CAP = "2";
    expect(maxShortlistPerYoutubeSource()).toBe(2);
    process.env.YOUTUBE_SHORTLIST_CAP = "99";
    expect(maxShortlistPerYoutubeSource(), "above the download budget is refused").toBe(4);
    process.env.YOUTUBE_SHORTLIST_CAP = "0";
    expect(maxShortlistPerYoutubeSource()).toBe(4);
    process.env.YOUTUBE_SHORTLIST_CAP = "banana";
    expect(maxShortlistPerYoutubeSource()).toBe(4);
  });

  it("the shortlist builder reads it for youtube_cc and nothing else", () => {
    /**
     * The cap table moved out of `buildDownloadShortlist` into the exported
     * `shortlistCapForSource`, because a SECOND route — the scene-pool download loop — had never
     * been told about it and was downloading eight candidates from one stock library per beat.
     * One definition, two readers. The claim here is unchanged: the shortlist builder gives
     * youtube_cc its own configured cap and nobody else's.
     */
    const at = FUNNEL.indexOf("export function shortlistCapForSource");
    expect(at).toBeGreaterThan(0);
    const body = FUNNEL.slice(at, FUNNEL.indexOf("\n}", at));
    expect(body).toContain('if (s === "youtube_cc") return maxShortlistPerYoutubeSource();');
    expect(body).toContain('if (s === "archive") return MAX_SHORTLIST_PER_ARCHIVE_SOURCE;');
    expect(body).toContain("isStockSource(s)");
    /** And the builder still reads it, rather than keeping a second table of its own. */
    expect(FUNNEL).toContain(
      "const capFor = (source: FunnelCandidateSource): number => shortlistCapForSource(source);"
    );
  });
});

describe("what did NOT change", () => {
  it("the download budget is untouched", () => {
    /**
     * The forbidden move, and the one this deliberately is not: raising the budget buys downloads
     * and VisionGate calls for every source at once, and costs the beat time it may not have.
     */
    expect(MAX_FUNNEL_CANDIDATES_TO_SCORE).toBe(6);
    expect(FUNNEL).toContain("export const MAX_FUNNEL_CANDIDATES_TO_SCORE = 6;");
  });

  it("EVERY OTHER SOURCE KEEPS ITS CAP", () => {
    // A share for YouTube, not a demotion for anybody else. Archive still gets three, stock one.
    expect(FUNNEL).toContain("const MAX_SHORTLIST_PER_STOCK_SOURCE = 1;");
    expect(FUNNEL).toContain("const MAX_SHORTLIST_PER_ARCHIVE_SOURCE = 3;");
  });

  it("RANKING STILL ORDERS THE SHORTLIST — the cap buys chances, not slots", () => {
    /**
     * The honest limit of this change, pinned so it cannot quietly become something else. The
     * shortlist is filled in `rankingScore` order; YouTube takes four of six only where four of
     * its candidates actually out-rank the alternatives.
     */
    expect(FUNNEL).toContain("const sorted = [...pool].sort((a, b) => b.rankingScore - a.rankingScore);");
  });

  it("the winner is still VisionGate's", () => {
    // A YouTube clip the picture editor refuses is still refused. No gate moved.
    expect(FUNNEL).toContain("pickBestFunnelCandidate");
  });

  it("RONDE 170's overflow fill still runs, so a slack cap leaves no empty slot", () => {
    /**
     * If YouTube has fewer than four candidates the cap is slack, and the slot goes to whoever
     * ranked next rather than staying empty — which is what RONDE 170 measured and built.
     */
    expect(FUNNEL).toContain("const capOverflow: FunnelCandidate[] = [];");
  });
});
