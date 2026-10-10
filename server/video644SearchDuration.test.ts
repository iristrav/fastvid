/**
 * VIDEO 644 — H1: THE SEARCH ASKS FOR THE LENGTHS THE POOL CAN USE, REVERSIBLY.
 *
 * 644's one search returned 50 results and 42 were thrown away as Shorts before a thumbnail was
 * looked at. The request can carry `videoDuration` (opt-in: `medium` or `long`), the cache key
 * carries the setting, and the default `any` is the request and the key exactly as they were.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { YOUTUBE_SEARCH_DURATION_DEFAULT, youtubeSearchCacheKey, youtubeSearchDuration } from "./youtubeVideoPoolProduction";

describe("H1 — the setting", () => {
  it("a missing or empty setting is `any` — the search as it was — and medium/long are read in any case", () => {
    expect(YOUTUBE_SEARCH_DURATION_DEFAULT).toBe("any");
    expect(youtubeSearchDuration({})).toBe("any");
    expect(youtubeSearchDuration({ YOUTUBE_SEARCH_DURATION: "" })).toBe("any");
    expect(youtubeSearchDuration({ YOUTUBE_SEARCH_DURATION: "   " })).toBe("any");
    expect(youtubeSearchDuration({ YOUTUBE_SEARCH_DURATION: "any" })).toBe("any");
    expect(youtubeSearchDuration({ YOUTUBE_SEARCH_DURATION: " LONG " })).toBe("long");
    expect(youtubeSearchDuration({ YOUTUBE_SEARCH_DURATION: "Medium" })).toBe("medium");
  });

  it("an invalid value falls back to the default `any`, never to a filter", () => {
    expect(youtubeSearchDuration({ YOUTUBE_SEARCH_DURATION: "short" })).toBe("any");
    expect(youtubeSearchDuration({ YOUTUBE_SEARCH_DURATION: "everything" })).toBe("any");
  });
});

describe("H1 — the cache key", () => {
  it("`any` is the key this module always used, so the old behaviour is restored exactly", () => {
    expect(youtubeSearchCacheKey("Tesla Model footage", "any")).toBe("Tesla Model footage#video_pool#n50");
  });

  it("every setting has a key of its own: a payload fetched under one is never served under another", () => {
    const keys = new Set(["any", "medium", "long"].map((d) => youtubeSearchCacheKey("Tesla Model footage", d as "any" | "medium" | "long")));
    expect(keys.size).toBe(3);
    expect(youtubeSearchCacheKey("Tesla Model footage", "medium")).toBe("Tesla Model footage#video_pool#n50#d=medium");
  });
});

describe("H1 — the request (source text, like the existing search-request checks)", () => {
  const PROD = fs.readFileSync(path.join(__dirname, "youtubeVideoPoolProduction.ts"), "utf8");
  const search = PROD.slice(PROD.indexOf("const search = async (query: string)"), PROD.indexOf("const details = async"));

  it("the key and the filter come from the one setting, and `any` sends no videoDuration at all", () => {
    expect(search).toContain("const duration = youtubeSearchDuration();");
    expect(search).toContain("const key = youtubeSearchCacheKey(query, duration);");
    expect(search).toContain('if (duration !== "any") url.searchParams.set("videoDuration", duration);');
  });

  it("the rest of the request is what it was: 50 results, relevance, embeddable, one call per claim", () => {
    expect(search).toContain('url.searchParams.set("maxResults", "50")');
    expect(search).toContain('url.searchParams.set("order", "relevance")');
    expect(search).toContain('url.searchParams.set("videoEmbeddable", "true")');
    expect(search).toContain("if (resp.status === 429) pipeline.markYoutubeRateLimited();");
  });

  it("the local Short rule is untouched as the second lock", () => {
    const NONFOOTAGE = fs.readFileSync(path.join(__dirname, "youtubeNonFootage.ts"), "utf8");
    expect(NONFOOTAGE).toContain("export const YOUTUBE_SHORT_MAX_SEC = 180;");
  });
});
