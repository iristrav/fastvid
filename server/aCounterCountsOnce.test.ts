import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { VisualSourceLedger } from "./visualSourceLineage";

/**
 * A DOWNLOAD IS COUNTED ON ONE CHANNEL, BECAUSE THE FOLD ADDS BOTH.
 *
 * ── The arithmetic ──────────────────────────────────────────────────────────────────────────
 *
 * A completed download reaches the render summary one of two ways:
 *
 *     the counter   `providerMetrics(cache, "<provider>").downloadCount++`, folded in at the end
 *                   of the render by `countProviderDownloads`
 *     the event     a DOWNLOAD_SUCCEEDED lineage event, counted by `summary()` from the events
 *
 * `summary()` ADDS them. That was a deliberate change from choosing between them, and the reason
 * given is exact: "the two channels are disjoint by construction: the pool route files events and
 * bumps no counter, the direct fetchers bump the counter and file no events". Wikimedia depends on
 * the addition — its direct fetches and its pool fetches are different retrievals that must both
 * be counted — so the fold cannot be made to choose again without losing real downloads.
 *
 * The disjointness is therefore a RULE ABOUT THE FETCHERS, and it is enforced nowhere. Pexels,
 * SerpAPI and Openverse each file the event alone on purpose. The Internet Archive route files a
 * REJECTION instead of a download event for the same reason, and says so in its own comment.
 *
 * ── What broke it ───────────────────────────────────────────────────────────────────────────
 *
 * The YouTube route was given `recordProviderDownloadOutcome` — a real improvement, and the thing
 * that put YouTube's download failures into the failure histogram at all — while keeping its
 * `downloadCount++`. Both channels, same arrival, and the fold three thousand lines away added
 * them:
 *
 *     [VisualFunnel] youtube_cc retrieved=2479 downloadSucceeded=88 eligible=1 composed=0
 *
 * That figure is inflated, and by how much cannot be read off it. YouTube arrives by TWO paths and
 * they counted differently:
 *
 *   `fetchYouTubeCCClips`   files the event AND bumps the counter — counted twice
 *   the scene-pool route    files the event alone, and says so in its own comment
 *                           ("this route does not bump `providerMetrics.downloadCount` either")
 *                           — counted once
 *
 * So 88 is a mixture of singles and doubles: the real number of files is somewhere between 44 and
 * 88, and the one line cannot say where. What it CAN say is that 88 is wrong —
 * `youtubeMaxDownloadsPerRender()` is 60 ATTEMPTS, and no number of successes above 60 can come
 * out of 60 attempts.
 *
 * Written this way deliberately. An earlier version of this comment said "forty-four downloads,
 * reported as eighty-eight", which assumed a single path and was not checked. A confident number
 * in a comment is read later as a measurement.
 *
 * ── What these tests are for ────────────────────────────────────────────────────────────────
 *
 * `render573ProvenanceReach` already holds this line for ONE route: it asserts the archive region
 * does not contain `recordProviderDownloadOutcome`. A rule that binds every fetcher, checked on
 * one of them, is this codebase's signature defect — RONDE 53, 62, 70, 86 and this session's
 * vision counter were all the same shape. So the arithmetic is pinned here on the ledger itself,
 * where it is a fact rather than a regex, and the YouTube route is pinned beside it.
 */

describe("the fold adds the two channels — which is why a fetcher may only use one", () => {
  it("A PROVIDER ON BOTH CHANNELS IS COUNTED TWICE. This is the bug, stated as arithmetic.", () => {
    const ledger = new VisualSourceLedger({ renderId: "r-counter" });
    const id = ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "yt-abc123",
      contentKey: "youtube:abc123",
      localPath: "/tmp/r/yt_abc123.mp4",
      provider: "youtube_cc",
      providerAssetId: "abc123",
    }).lineageId;
    ledger.recordEvent(id, "DOWNLOAD_SUCCEEDED", { status: "OK" });
    // The same single arrival, reported a second time on the counter channel.
    ledger.countProviderDownloads("youtube_cc", 1);

    expect(ledger.summary().byProvider.youtube_cc?.downloadSucceeded).toBe(2);
  });

  it("and a provider on ONE channel is counted once, whichever channel it is", () => {
    const viaEvent = new VisualSourceLedger({ renderId: "r-event" });
    const id = viaEvent.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "yt-abc123",
      contentKey: "youtube:abc123",
      localPath: "/tmp/r/yt_abc123.mp4",
      provider: "youtube_cc",
      providerAssetId: "abc123",
    }).lineageId;
    viaEvent.recordEvent(id, "DOWNLOAD_SUCCEEDED", { status: "OK" });
    expect(viaEvent.summary().byProvider.youtube_cc?.downloadSucceeded).toBe(1);

    const viaCounter = new VisualSourceLedger({ renderId: "r-count" });
    viaCounter.countProviderDownloads("internet_archive", 1);
    expect(viaCounter.summary().byProvider.internet_archive?.downloadSucceeded).toBe(1);
  });

  it("THE ADDITION IS NOT THE BUG — two real retrievals still add up", () => {
    /**
     * Wikimedia fetches directly AND through the pool, and those are different downloads. Making
     * the fold choose between the channels would lose one of them, which is the failure the
     * addition replaced. The fold is right; the fetcher using both channels for ONE arrival is
     * what is wrong.
     */
    const ledger = new VisualSourceLedger({ renderId: "r-counter" });
    const id = ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "wm-berlin",
      contentKey: "wikimedia:File:Berlin.jpg",
      localPath: "/tmp/r/wm_pool.jpg",
      provider: "wikimedia",
      providerAssetId: "File:Berlin.jpg",
    }).lineageId;
    ledger.recordEvent(id, "DOWNLOAD_SUCCEEDED", { status: "OK" });
    ledger.countProviderDownloads("wikimedia", 3);
    expect(ledger.summary().byProvider.wikimedia?.downloadSucceeded).toBe(4);
  });
});

describe("no fetcher reports one arrival on both channels", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const code = PIPE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("THE YOUTUBE ROUTE FILES THE EVENT AND NOT THE COUNTER", () => {
    const at = code.indexOf("if (!claimDownloadSlot()) {");
    expect(at, "the YouTube download loop moved").toBeGreaterThan(-1);
    const block = code.slice(at, code.indexOf("results.push(outPath);", at));
    expect(block).toContain("recordProviderDownloadOutcome(");
    expect(
      code,
      "youtube_cc is back on both channels — the fold will report double its downloads"
    ).not.toContain('providerMetrics(sourcingCache, "youtube_cc").downloadCount++');
  });

  it("YOUTUBE ARRIVES BY TWO PATHS, AND NEITHER USES BOTH CHANNELS", () => {
    /**
     * The fact an earlier reading of this file missed, and the reason its arithmetic was stated as
     * a range rather than a number.
     *
     *   `fetchYouTubeCCClips`  the direct loop — where the double count was
     *   the scene-pool route   `downloadAndTrim`, which files its outcome in a `finally` so that
     *                          no branch can forget it, and bumps no counter
     *
     * Asserted together because "the YouTube route" is two routes, and a rule checked on one of
     * them is exactly the shape this file exists to catch.
     */
    const pool = code.indexOf("let arrivalFailure: string | null =");
    expect(pool, "the pool route's arrival flag moved").toBeGreaterThan(-1);
    /**
     * Anchored on the next FUNCTION, not on the comment that introduces it: this slice is taken
     * from `code`, which has had its comments stripped, so a prose anchor resolves to -1 and the
     * slice silently runs to the end of the file — where nine other providers do bump the counter.
     * Found by this test failing on its first run, which is the anchor working.
     */
    const poolEnd = code.indexOf("async function trimDownloadedStockClip(", pool);
    expect(poolEnd, "the function after the pool route was renamed").toBeGreaterThan(pool);
    const poolBody = code.slice(pool, poolEnd);
    expect(poolBody).toContain("recordProviderDownloadOutcome(");
    expect(
      poolBody,
      "the pool route joined the counter channel — its downloads would count twice"
    ).not.toContain(".downloadCount++");
  });

  it("and the archive route still files the rejection rather than a download event", () => {
    /** Held elsewhere too, for the same reason. Asserted here so both halves sit in one place. */
    const at = code.indexOf('providerMetrics(sourcingCache, "internet_archive").downloadCount++');
    expect(at).toBeGreaterThan(-1);
  });

  it("EVERY PROVIDER THAT BUMPS THE COUNTER IS NAMED, so a new one cannot slip in unnoticed", () => {
    /**
     * Not a style rule. A fetcher added on the counter channel that also files a download event
     * doubles its own numbers silently, and the number is what every later judgement is made
     * against — including which sources a render is thought to be short of.
     *
     * If this list needs updating, the question to answer first is which channel the new fetcher
     * uses, and whether it uses only that one.
     */
    const bumps = [...code.matchAll(/providerMetrics\(sourcingCache, "([a-z_]+)"\)\.downloadCount\+\+/g)]
      .map((m) => m[1])
      .sort();
    expect([...new Set(bumps)]).toEqual([
      "europeana",
      "flickr",
      "gdelt_tv",
      "internet_archive",
      "media_ccc",
      "pixabay",
      "sepiasearch",
      "vimeo",
      "wikimedia",
    ]);
  });
});
