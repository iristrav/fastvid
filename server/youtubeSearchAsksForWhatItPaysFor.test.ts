import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TWENTY-FIVE SEARCHES, 215 RESULTS.
 *
 * Render 577's supply, by provider:
 *
 *     pexels             searches=17  results=4468    263 per search
 *     internet_archive   searches=25  results=309      12 per search
 *     youtube_cc         searches=25  results=215     8.6 per search
 *
 * YouTube was asked as often as the Internet Archive and answered with a fraction of the supply.
 * Not because of the platform: the call site asked for `Math.max(5, (count - fetched) * 4)` and
 * `count` is 1 or 2 at every production call site, so nearly every YouTube search asked for FIVE.
 * `search.list` costs 100 quota units per CALL for any maxResults between 1 and 50.
 */

const ENV = process.env.YOUTUBE_SEARCH_PAGE_SIZE;
afterEach(() => {
  if (ENV === undefined) delete process.env.YOUTUBE_SEARCH_PAGE_SIZE;
  else process.env.YOUTUBE_SEARCH_PAGE_SIZE = ENV;
});

describe("the call site", () => {
  const src = () => readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("the old need-shaped page size no longer reaches the API", () => {
    /**
     * Scoped to the ARGUMENT rather than the whole file: the comment at the call site quotes the
     * old expression to explain what was wrong with it, and a file-wide search cannot tell the
     * prose that records a removal from the code that performs one.
     */
    const PIPE = src();
    /** RONDE 658 — the per-beat call now sits behind the video pool; the arguments are the same. */
    const at = PIPE.indexOf("const items = poolMode ? await rowsFromPool() : await searchYoutubeVideoCandidates(");
    const call = PIPE.slice(at, PIPE.indexOf(");", at));
    const args = call.replace(/\/\*\*[\s\S]*?\*\//g, "");
    expect(args, "the expression that asked for five").not.toContain("count - fetched");
  });

});
