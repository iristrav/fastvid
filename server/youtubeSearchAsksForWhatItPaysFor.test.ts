import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  YOUTUBE_SEARCH_PAGE_MAX,
  youtubeSearchDurationForPass,
  youtubeSearchPageSize,
} from "./sourcingPolicy";

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

describe("the page size", () => {
  it("asks for the whole page the call already paid for", () => {
    delete process.env.YOUTUBE_SEARCH_PAGE_SIZE;
    expect(youtubeSearchPageSize()).toBe(50);
    expect(YOUTUBE_SEARCH_PAGE_MAX, "the API's own maximum").toBe(50);
  });

  it("NEVER EXCEEDS THE API MAXIMUM", () => {
    // `maxResults` above 50 is an API error, not a bigger page: the search would return nothing.
    process.env.YOUTUBE_SEARCH_PAGE_SIZE = "500";
    expect(youtubeSearchPageSize()).toBe(50);
    process.env.YOUTUBE_SEARCH_PAGE_SIZE = "51";
    expect(youtubeSearchPageSize()).toBe(50);
  });

  it("an operator may turn it down, and nonsense is ignored", () => {
    process.env.YOUTUBE_SEARCH_PAGE_SIZE = "10";
    expect(youtubeSearchPageSize()).toBe(10);
    process.env.YOUTUBE_SEARCH_PAGE_SIZE = "0";
    expect(youtubeSearchPageSize()).toBe(50);
    process.env.YOUTUBE_SEARCH_PAGE_SIZE = "banana";
    expect(youtubeSearchPageSize()).toBe(50);
    process.env.YOUTUBE_SEARCH_PAGE_SIZE = "-4";
    expect(youtubeSearchPageSize()).toBe(50);
  });

  it("THE ANSWER DOES NOT DEPEND ON HOW MANY CLIPS THE CALLER WANTS", () => {
    /**
     * That was the old rule and it is the defect. The page is what the CALL returns, not what the
     * render keeps; sizing it to the need sizes it to the wrong quantity. A caller wanting one
     * clip should still choose that clip from fifty candidates rather than from five.
     */
    delete process.env.YOUTUBE_SEARCH_PAGE_SIZE;
    expect(youtubeSearchPageSize.length, "it takes no `needed` argument").toBe(0);
  });
});

describe("the call site", () => {
  const src = () => readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("the search asks the policy, not an arithmetic of its own", () => {
    const PIPE = src();
    const at = PIPE.indexOf("const items = await searchYoutubeVideoCandidates(");
    expect(at).toBeGreaterThan(0);
    const call = PIPE.slice(at, PIPE.indexOf(");", at));
    expect(call).toContain("youtubeSearchPageSize()");
  });

  it("the old need-shaped page size no longer reaches the API", () => {
    /**
     * Scoped to the ARGUMENT rather than the whole file: the comment at the call site quotes the
     * old expression to explain what was wrong with it, and a file-wide search cannot tell the
     * prose that records a removal from the code that performs one.
     */
    const PIPE = src();
    const at = PIPE.indexOf("const items = await searchYoutubeVideoCandidates(");
    const call = PIPE.slice(at, PIPE.indexOf(");", at));
    const args = call.replace(/\/\*\*[\s\S]*?\*\//g, "");
    expect(args, "the expression that asked for five").not.toContain("count - fetched");
  });

  it("NO GATE, CEILING OR THRESHOLD MOVED WITH IT", () => {
    /**
     * This is a supply change and must be only that. The same searches, the same quota, the same
     * number of network calls — one larger response each. Everything that bounds the EXPENSIVE
     * half stays exactly where it was, so a render may now choose from more candidates and still
     * download no more of them.
     */
    const PIPE = src();
    expect(PIPE).toContain("const maxDownloadAttempts = youtubeMaxDownloadsPerRender();");
    expect(PIPE).toContain("if (downloadsSoFar() >= maxDownloadAttempts) break;");
    expect(PIPE).toContain("if (Date.now() > ytDeadline) break;");
    expect(PIPE).toContain("if (remainingMs < YOUTUBE_MIN_DOWNLOAD_WINDOW_MS) {");
  });

  it("the page size is part of the query cache key", () => {
    /**
     * Two callers asking the same query with different page sizes must not share one payload —
     * the smaller answer would satisfy the larger request and silently cap it again.
     */
    expect(src()).toContain("#n${maxResults}");
  });

  it("the RapidAPI fallback is sized by the same number", () => {
    // It returns a whole page and slices client-side, so the same argument governs both routes.
    const PIPE = src();
    const at = PIPE.indexOf("async function searchYoutubeViaRapidApi(");
    const body = PIPE.slice(at, at + 2200);
    expect(body).toContain(".slice(0, maxResults)");
  });
});

/**
 * AND NOTHING UNDER FOUR MINUTES COULD BE FOUND AT ALL.
 *
 * The search sent `videoDuration=medium` unconditionally — 4 to 20 minutes. Short archival clips,
 * the richest category on the platform and the one this pipeline is best suited to (it keeps three
 * to six seconds, and VIDRUSH_MIN_SOURCE_VIDEO_SEC is 2.8), were excluded from every YouTube
 * search this render made. It arrived in a broad "improve visual candidate selection" commit with
 * no note and no test.
 */
describe("the duration slice", () => {
  it("alternates across the passes, so both slices are searched", () => {
    expect(youtubeSearchDurationForPass(0, 3)).toBe("short");
    expect(youtubeSearchDurationForPass(1, 3)).toBe("medium");
    expect(youtubeSearchDurationForPass(2, 3)).toBe("short");
  });

  it("A SINGLE PASS KEEPS MEDIUM — rotating alone would swap a slice, not add one", () => {
    /**
     * With nothing to alternate against, giving the only pass `short` would not widen the
     * render's supply; it would trade the pool this render has always had for a different one.
     */
    expect(youtubeSearchDurationForPass(0, 1)).toBe("medium");
    expect(youtubeSearchDurationForPass(0, 0)).toBe("medium");
  });

  it("nonsense indices answer with the old behaviour rather than throwing", () => {
    expect(youtubeSearchDurationForPass(-1, 3)).toBe("medium");
    expect(youtubeSearchDurationForPass(NaN, 3)).toBe("medium");
    expect(youtubeSearchDurationForPass(0, NaN)).toBe("medium");
  });

  it("LONG IS NEVER ASKED FOR, and that is deliberate", () => {
    /**
     * This route downloads the WHOLE source and only then trims, under an 80 MB ceiling. A
     * forty-minute upload spends a download slot and the scene's remaining time to arrive at a
     * file the size guard refuses. `long` is not missing from the type — it is excluded by it.
     */
    const slices = [0, 1, 2, 3, 4].map((i) => youtubeSearchDurationForPass(i, 3));
    expect(slices).not.toContain("long");
    expect(new Set(slices)).toEqual(new Set(["short", "medium"]));
  });
});

describe("the duration reaches the API and the cache", () => {
  const src = () => readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("the request carries the pass's slice, not a constant", () => {
    const PIPE = src();
    expect(PIPE).toContain('searchUrl.searchParams.set("videoDuration", videoDuration);');
    expect(PIPE, "the unconditional medium is gone").not.toContain(
      'searchUrl.searchParams.set("videoDuration", "medium")'
    );
  });

  it("THE DURATION IS PART OF THE QUERY CACHE KEY", () => {
    /**
     * Without this the first pass's payload would satisfy the second pass's request, the second
     * slice would never be fetched, and the alternation would be a no-op that still looked right
     * in the log.
     */
    expect(src()).toContain("`${query}#${license}#n${maxResults}#d${videoDuration}`");
  });

  it("the pass loop hands its index to the policy", () => {
    const PIPE = src();
    expect(PIPE).toContain("for (const [passIndex, pass] of licensePasses.entries()) {");
    expect(PIPE).toContain(
      "const passDuration = youtubeSearchDurationForPass(passIndex, licensePasses.length);"
    );
  });

  it("the render says which slice it searched", () => {
    // A supply change nobody can see in the log is a supply change nobody can verify.
    expect(src()).toContain("`duration=${passDuration} attempted=true ` +");
  });

  it("NO EXTRA SEARCH CALL WAS ADDED", () => {
    /**
     * The whole reason this shape was chosen over a second search per query: the passes are calls
     * the render already makes. One search per (query, pass), exactly as before.
     */
    const PIPE = src();
    const at = PIPE.indexOf("for (const [passIndex, pass] of licensePasses.entries()) {");
    const body = PIPE.slice(at, PIPE.indexOf("[Retrieval] s${sceneIndex} source=youtube", at));
    const calls = body.match(/await searchYoutubeVideoCandidates\(/g) ?? [];
    expect(calls.length, "one search per pass").toBe(1);
  });
});
