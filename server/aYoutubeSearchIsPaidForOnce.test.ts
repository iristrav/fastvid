import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  cachedYoutubeSearchPayload,
  countYoutubeQuotaCall,
  formatYoutubeSearchCall,
  resetYoutubeSearchQuotaState,
  storeYoutubeSearchPayload,
  youtubeQuotaCallsToday,
  youtubeSearchCacheTtlMs,
} from "./youtubeSearchQuota";
import { nextQuotaResetMs } from "./youtubeApiKeys";
import { prefetchAltSearchesPerDay } from "./youtubePrefetch";

/**
 * RONDE 653 — 100 search.list calls a day for everything, and a cache that only lived as long as one
 * render: the same topic again, or the same video re-queued after a deploy, paid for every search
 * a second time. Nothing said, per search, whether it cost quota.
 */
afterEach(() => {
  resetYoutubeSearchQuotaState();
  vi.unstubAllEnvs();
});

describe("the same request is answered from the process cache for a few hours", () => {
  it("hits within the TTL and misses after it", () => {
    const t0 = 1_000_000;
    storeYoutubeSearchPayload("berlin 1945#creative_common#n50#dmedium", { items: [1] }, t0);
    expect(cachedYoutubeSearchPayload("berlin 1945#creative_common#n50#dmedium", t0 + 60_000)).toEqual({ items: [1] });
    expect(cachedYoutubeSearchPayload("berlin 1945#creative_common#n50#dmedium", t0 + youtubeSearchCacheTtlMs() + 1)).toBeUndefined();
  });

  it("keys on the whole request: another licence or duration is another search", () => {
    storeYoutubeSearchPayload("q#creative_common#n50#dmedium", { items: [1] });
    expect(cachedYoutubeSearchPayload("q#any#n50#dmedium")).toBeUndefined();
    expect(cachedYoutubeSearchPayload("q#creative_common#n50#dshort")).toBeUndefined();
  });

  it("can be switched off with YOUTUBE_SEARCH_CACHE_TTL_MIN=0", () => {
    vi.stubEnv("YOUTUBE_SEARCH_CACHE_TTL_MIN", "0");
    storeYoutubeSearchPayload("q", { items: [] });
    expect(cachedYoutubeSearchPayload("q")).toBeUndefined();
  });
});

describe("every call that reaches Google is counted until Google's own reset", () => {
  it("counts up and starts again after midnight Pacific", () => {
    const now = Date.UTC(2026, 8, 25, 12, 0, 0);
    expect(countYoutubeQuotaCall(now)).toBe(1);
    expect(countYoutubeQuotaCall(now + 1000)).toBe(2);
    expect(youtubeQuotaCallsToday(now + 2000)).toBe(2);
    const after = nextQuotaResetMs(now) + 1000;
    expect(youtubeQuotaCallsToday(after)).toBe(0);
    expect(countYoutubeQuotaCall(after)).toBe(1);
  });

  it("the log line names video, render, scene, query, cache and quota", () => {
    const line = formatYoutubeSearchCall({
      videoId: 608,
      renderId: "r-1",
      sceneIndex: 2,
      query: "Berlin 1945 archival footage",
      source: "network",
      status: 200,
      callsToday: 7,
    });
    expect(line).toBe(
      '[YouTubeSearchCall] video=608 render=r-1 scene=2 cacheHit=false quotaCall=true status=200 ' +
        'processCallsToday=7 query="Berlin 1945 archival footage"'
    );
    expect(
      formatYoutubeSearchCall({ videoId: 608, renderId: "r-1", sceneIndex: 2, query: "q", source: "process_cache", callsToday: 7 })
    ).toContain("cacheHit=true quotaCall=false");
  });
});

describe("the search uses the process cache and logs each call", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const at = SRC.indexOf("export async function searchYoutubeVideoCandidates(");
  const body = SRC.slice(at, SRC.indexOf("export async function youtubeRowsRankedByThumbnail(", at));

  it("asks the process cache before the network and stores only a successful answer", () => {
    expect(body.indexOf("cachedYoutubeSearchPayload(processKey)")).toBeLessThan(body.indexOf('new URL("https://www.googleapis.com/youtube/v3/search")'));
    expect(body.indexOf("storeYoutubeSearchPayload(processKey, payload);")).toBeGreaterThan(body.indexOf("markYoutubeSearchResult(true);"));
  });

  it("counts and logs every network call, including one that fails", () => {
    const fetchAt = body.indexOf("const searchResp = await providerLimiter(\"youtube\")");
    const after = body.slice(fetchAt, fetchAt + 700);
    expect(after).toContain('source: "network"');
    expect(after).toContain("callsToday: countYoutubeQuotaCall()");
    expect(after.indexOf("countYoutubeQuotaCall()")).toBeLessThan(after.indexOf("if (searchResp.status === 429)"));
  });
});

describe("background searching gives way to renders", () => {
  it("spends no quota unless the operator turns it on", () => {
    vi.stubEnv("YOUTUBE_PREFETCH_ALT_SEARCHES_PER_DAY", "");
    expect(prefetchAltSearchesPerDay()).toBe(0);
    vi.stubEnv("YOUTUBE_PREFETCH_ALT_SEARCHES_PER_DAY", "5");
    expect(prefetchAltSearchesPerDay()).toBe(5);
  });

  it("never searches during the renders' quota cooldown", () => {
    const PREFETCH = fs.readFileSync(path.join(__dirname, "youtubePrefetch.ts"), "utf8");
    expect(PREFETCH).toContain("takeDailySlot: () => !pipeline.isYoutubeInCooldown() && takeDailyAltSlot(),");
  });
});
