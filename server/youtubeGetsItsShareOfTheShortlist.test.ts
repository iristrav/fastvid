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

describe("what did NOT change", () => {

  it("the winner is still VisionGate's", () => {
    // A YouTube clip the picture editor refuses is still refused. No gate moved.
    expect(FUNNEL).toContain("pickBestFunnelCandidate");
  });

});
