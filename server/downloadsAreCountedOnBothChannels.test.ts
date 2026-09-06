/**
 * WHY RENDER 569 LOOKED LIKE IT HAD DOWNLOADED NOTHING.
 *
 * ── The line that raised the question ───────────────────────────────────────────────────────
 *
 *     [SourcingMetrics]  pexels:    searches=19 results=3562 downloads=0 accepted=0
 *     [SourcingMetrics]  wikimedia: searches=23 results=257  downloads=0 accepted=0
 *     [SourcingMetrics]  serpapi:   searches=0  results=0    downloads=0 accepted=4
 *
 * Two providers returned thousands of results and fetched nothing; a third accepted four clips
 * without searching or downloading at all. None of that happened. The beat ledger of the same
 * render names the files:
 *
 *     origin=wikimedia selected=…pool_wikimedia_File_Signed_Photograph_of_Adolf_Hitler_a_still…
 *     origin=serpapi   selected=scene_0_b3_inet_img_serp_serp_2__pid_serpapi-…
 *
 * ── The cause ───────────────────────────────────────────────────────────────────────────────
 *
 * A completed download is recorded on one of two channels: `providerMetrics(…).downloadCount`,
 * bumped by the direct fetchers, or a DOWNLOAD_SUCCEEDED lineage event, filed by the pool route.
 * `[SourcingMetrics]` printed only the first.
 *
 * The split is deliberate and stays: `[AssetUsageSummary]` ADDS the two channels, so a provider
 * reporting on both would be counted twice — which is exactly why Pexels files the event alone.
 * The defect was a report reading half a ledger, not the ledger.
 *
 * Commons IMAGES were worse than half-counted: they reported on NEITHER channel, so the provider
 * that supplied two of the render's adopted stills read as one that fetched nothing. Only Commons
 * VIDEOS, which barely exist, bumped anything.
 *
 * ── What these tests hold ───────────────────────────────────────────────────────────────────
 *
 * That every route which downloads a file says so somewhere, and that no route says so twice.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** The body of one top-level function, sliced the way this file's structural tests always do. */
const bodyOf = (name: string): string => {
  const at = PIPE.indexOf(`function ${name}(`);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const next = PIPE.slice(at + 10).search(/\n(?:export )?(?:async )?function /);
  return PIPE.slice(at, next === -1 ? undefined : at + 10 + next);
};

describe("every fetcher that downloads reports it", () => {
  /**
   * The gap render 569 exposed. Both halves of this function download a Commons file — one from
   * the cached candidate pool, one from the live search — and neither said so.
   */
  it("fetchWikimediaImages reports both of its downloads", () => {
    const body = bodyOf("fetchWikimediaImages");
    const downloads = body.split("downloadToFileStreaming").length - 1;
    const reports = body.split("recordProviderDownloadOutcome").length - 1;
    expect(downloads, "the cached-pool site and the live-search site").toBe(2);
    expect(reports, "render 569 had 0 here while Commons supplied two adopted stills").toBe(2);
  });

  /**
   * NOT on the counter, and that is the point rather than an accident: `fetchWikimediaVideos`
   * already bumps `downloadCount` for this provider, and the end-of-render fold adds the channels.
   * A counter bump here would report each Commons image download twice.
   */
  it("and does so on the event channel, because its sibling owns the counter", () => {
    expect(bodyOf("fetchWikimediaImages")).not.toContain('providerMetrics(sourcingCache, "wikimedia").downloadCount++');
    expect(bodyOf("fetchWikimediaVideos")).toContain('providerMetrics(sourcingCache, "wikimedia").downloadCount++');
  });

  /** The two providers that established the event channel keep using it, and only it. */
  it.each(["fetchPexelsClips", "fetchSerpAPIImages"])(
    "%s reports on the event channel and bumps no download counter",
    (fn) => {
      const body = bodyOf(fn);
      expect(body).toContain("recordProviderDownloadOutcome");
      expect(body).not.toMatch(/providerMetrics\([^)]*\)\.downloadCount\+\+/);
    }
  );

  /** And the direct fetchers keep the counter, so the fold's disjointness assumption holds. */
  it.each(["fetchPixabayClips", "fetchInternetArchiveClips"])(
    "%s bumps the counter and files no event",
    (fn) => {
      const body = bodyOf(fn);
      expect(body).toMatch(/providerMetrics\([^)]*\)\.downloadCount\+\+/);
      expect(body).not.toContain("recordProviderDownloadOutcome");
    }
  );
});

describe("the metrics line reads the whole ledger", () => {
  const body = bodyOf("logSourcingMetrics");

  it("adds the event channel to the counter", () => {
    expect(body).toContain("eventDownloads");
    expect(body).toContain("downloadSucceeded");
  });

  /**
   * Subtracting the counter before adding is what keeps the addition safe: `summary()` folds the
   * counter into `downloadSucceeded` itself, so the events-only remainder is what is left over.
   * Without this the direct fetchers would report double.
   */
  it("subtracts the counter from the summary so nothing is counted twice", () => {
    expect(body).toContain("counts.downloadSucceeded ?? 0) - viaCounter");
  });

  /** The reader can still see which channel a number came from — a fold that hides its parts. */
  it("names both channels in the per-provider line", () => {
    expect(body).toContain("counter=");
    expect(body).toContain("events=");
  });

  /** Metrics are a report. A ledger that throws must cost the line, never the render. */
  it("survives a ledger that is absent or throws", () => {
    expect(body).toContain("cache.lineage?.summary()");
    const guard = body.indexOf("try {", body.indexOf("eventDownloads"));
    expect(guard, "the summary call is not guarded").toBeGreaterThan(-1);
    expect(body.indexOf("} catch", guard)).toBeGreaterThan(guard);
  });
});
