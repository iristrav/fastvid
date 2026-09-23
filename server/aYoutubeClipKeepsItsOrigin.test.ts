/**
 * A YOUTUBE CLIP KEEPS ITS ORIGIN, AND THE BACKGROUND GETS ITS TIME — RONDE 645.
 *
 * Render 603: archive asset 57802, a YouTube segment the background prefetch had just filed, was
 * adopted as `provider=UNVERIFIED` (`UNTRACED_ADOPTION … route=rescue`), because the curated route
 * that prepared it opened no lineage record. And the same render's background fetch timed the cloud
 * route out at 148 s — half of its window, capped — on a route it was running alone.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { VisualSourceLedger, ensureCuratedAssetLineageOn } from "./visualSourceLineage";
import { identityFromAdoption } from "./assetIdentity";
import { prefetchStaleClaimMs, prefetchWindowMs, formatPrefetchLine } from "./youtubePrefetch";

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");

const ytPick = {
  asset: {
    id: 57802,
    mediaType: "video",
    storageUrl: "https://storage.example/archive-ingested/1/youtube_cc_yc-eHRAWgVM_25s.mp4",
    title: "Hitler's Downfall — edit",
    sourceUrl: "https://www.youtube.com/watch?v=yc-eHRAWgVM&t=25s",
    sourcePlatform: "youtube_cc",
  },
  archiveName: "WW2",
  score: 1187,
};

describe("§1 — an archived YouTube clip carries its YouTube origin in the ledger", () => {
  it("the record has a provider (the archive), the archive id, and the YouTube page it came from", () => {
    const ledger = new VisualSourceLedger({ renderId: "r1" });
    const rec = ensureCuratedAssetLineageOn(ledger, ytPick, 0, 3);
    expect(rec.provider).toBe("ww2"); /** the ledger normalises provider names */
    expect(rec.archiveAssetId).toBe(57802);
    expect(rec.originalUrl).toContain("youtube.com/watch?v=yc-eHRAWgVM");
    expect(rec.sourceUrl).toContain("storage.example");
  });

  it("an anonymous record opened earlier gets the origin filled in, not overwritten", () => {
    const ledger = new VisualSourceLedger({ renderId: "r2" });
    const first = ensureCuratedAssetLineageOn(ledger, { ...ytPick, asset: { ...ytPick.asset, sourceUrl: null } }, 0, 3);
    expect(first.originalUrl).toBeUndefined();
    const again = ensureCuratedAssetLineageOn(ledger, ytPick, 0, 3);
    expect(again.lineageId).toBe(first.lineageId);
    expect(again.originalUrl).toContain("yc-eHRAWgVM");
  });

  it("the timeline identity names the YouTube page, and still fetches from our own copy", () => {
    const id = identityFromAdoption({
      provider: "WW2",
      providerAssetId: "57802",
      archiveAssetId: 57802,
      sourceUrl: ytPick.asset.storageUrl,
      originalUrl: ytPick.asset.sourceUrl,
    } as never);
    expect(id?.sourcePageUrl).toBe(ytPick.asset.sourceUrl);
    expect(id?.mediaUrl).toBe(ytPick.asset.storageUrl);
    expect(id?.archiveAssetId).toBe(57802);
  });

  it("a non-URL origin is never promoted to a page", () => {
    const id = identityFromAdoption({ provider: "WW2", originalUrl: "youtube_cc:abc" } as never);
    expect(id?.sourcePageUrl).toBeUndefined();
  });
});

describe("§2 — the curated route that prepared the clip opens its record", () => {
  it("fetchCuratedArchiveBeatClip hands the pick to the ledger hook the moment the file exists", () => {
    const src = read("curatedMediaSourcing.ts");
    const hook = src.indexOf("curatedClipPreparedHook?.(picked, sceneIndex, beat.index, clipPath);");
    const log = src.indexOf("curated archive #${picked.asset.id} ");
    expect(hook).toBeGreaterThan(-1);
    expect(log).toBeGreaterThan(hook);
  });

  it("the pipeline registers the hook: open from the pick, bind the file, record the download", () => {
    const src = read("videoPipeline.ts");
    const at = src.indexOf("setCuratedClipPreparedHook((picked, sceneIndex, beatIndex, clipPath) => {");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 600);
    expect(body).toContain("ensureCuratedAssetLineageOn(lineage, picked, sceneIndex, beatIndex)");
    expect(body).toContain("lineage.bindPath(record.lineageId, clipPath, clipContentKey(clipPath))");
  });

  it("and then the adoption resolves that file to the record — not an anonymous UNVERIFIED one", () => {
    const ledger = new VisualSourceLedger({ renderId: "r3" });
    const rec = ensureCuratedAssetLineageOn(ledger, ytPick, 0, 3);
    const clip = "/var/tmp/fastvid_603/scene_0_b3_curated_a57802.mp4";
    ledger.bindPath(rec.lineageId, clip);
    const resolved = ledger.resolve(clip);
    expect(resolved?.lineageId).toBe(rec.lineageId);
    expect(resolved?.provider).toBe("ww2");
    expect(resolved?.originalUrl).toContain("yc-eHRAWgVM");
  });

  it("a bookkeeping failure never costs a prepared clip", () => {
    expect(read("curatedMediaSourcing.ts")).toContain("/* provenance bookkeeping never costs a clip that was prepared correctly */");
  });
});

describe("§3 — the background gets its time", () => {
  it("ten minutes per route by default, bounded, configurable", () => {
    expect(prefetchWindowMs()).toBe(10 * 60_000);
  });

  it("A LIVE SLOW FETCH IS NEVER TAKEN FOR A DEAD ONE — stale is longer than both routes' windows", () => {
    expect(prefetchStaleClaimMs()).toBeGreaterThan(2 * prefetchWindowMs());
  });

  it("the row is touched before every segment", () => {
    const src = read("youtubePrefetch.ts");
    expect(src).toContain("await deps.touch?.().catch(() => {});");
    expect(src).toContain("touch: () => touchPrefetchRow(row.id)");
  });

  it("each route on its own gets the whole window — no render share, no 180 s base", () => {
    const src = read("videoPipeline.ts");
    expect(src).toContain("onlyRoute && Number.isFinite(remainingForCloud)\n        ? remainingForCloud");
    expect(src).toContain("onlyRoute && Number.isFinite(remainingScopeMs())\n              ? Math.max(5_000, remainingScopeMs())");
    expect(read("youtubePrefetch.ts")).toContain("prefetchWindowMs(),\n            `youtube prefetch ${route}");
  });

  it("A RENDER STILL GETS EXACTLY WHAT IT HAD — its calls pass no route", () => {
    const src = read("videoPipeline.ts");
    expect(src).toContain("Math.min(youtubeDownloadTimeoutMs(budgetMs), cloudWindowMs)");
    expect(src).toContain("scopedTimeoutMs(youtubeDownloadTimeoutMs(), 5_000)");
  });

  it("every segment's real download time is logged, so the window can be set from measurement", () => {
    const line = formatPrefetchLine(
      { videoId: "abc" },
      { segments: [{ startSec: 0, downloaded: true, downloadMs: 31_200 }, { startSec: 90, downloaded: false, downloadMs: 600_000 }] },
      { status: "ingested", lastError: null, archiveAssetId: 1, attempts: 1, nextAttemptAt: new Date(0) }
    );
    expect(line).toContain("segmentMs=31200,600000");
  });
});
