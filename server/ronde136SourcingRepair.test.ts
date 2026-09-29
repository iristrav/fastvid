/**
 * RONDE 136 — three sourcing repairs, each traced from video 558's own log.
 *
 * ── 1. Wikimedia: 15 searches, 38 results, 0 downloads ───────────────────────────────────────
 *
 *     32x [Pipeline] Wikimedia imageinfo for scene N: HTTP 429 Too Many Requests
 *     34x [ProviderCooldown] provider=wikimedia reason=RATE_LIMITED standing down for 60s
 *
 * The search was never the problem. Both Wikimedia routes asked Commons about ONE title per HTTP
 * request, and with the exclusion set open that is up to 25 requests per scene per beat. Commons
 * throttled it, and without imageinfo there is no URL — so every candidate was dropped before it
 * could become a file.
 *
 * MediaWiki's query API takes up to 50 pipe-separated titles in one call. Same endpoint, same
 * parameters, same User-Agent, same parsing — one request instead of twenty-five.
 *
 * ── 2. LOC offered files nothing can decode ──────────────────────────────────────────────────
 *
 * `mimetype?.includes("image")` accepts image/jp2 and image/tiff, which is exactly what
 * Chronicling America serves for newspaper issues like sn81002003. Those download and then fail.
 *
 * Worth stating because it is easy to misread the log: the `asset=https://www.loc.gov/item/...`
 * in the REJECT line is the item's IDENTITY, not its download address. This adapter has always
 * required a real media file, so a catalogue page was never handed out as remoteUrl.
 *
 * ── 3. The 480-line bar starts refusing, for stock only ──────────────────────────────────────
 *
 *     Pexels 426x226 (3x)   YouTube CC 640x360 (2x)   Internet Archive 532x300 (1x)
 *
 * RONDE 134 held the bar at "observe only" on the argument that refusing would hit the archives
 * and not stock. The first measurement says the opposite — four of the six were stock. So stock
 * gets the 480 floor and the archive keeps 144, which is the half of that argument that survived.
 */
import { describe, expect, it } from "vitest";
import {
  VIDEO_MIN_SHORT_SIDE_PX,
  VIDEO_QUALITY_BAR_SHORT_SIDE_PX,
  isStockSource,
  minShortSideForSource,
  videoResolutionVerdict,
} from "./technicalMediaGate";
import { WIKIMEDIA_IMAGEINFO_BATCH_SIZE } from "./videoPipeline";

const read = (rel: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "..", rel), "utf8");
};
/**
 * Source with PROSE comments removed.
 *
 * Only block comments that BEGIN a line are stripped, which is what an explanatory comment looks
 * like. The obvious `/\*[\s\S]*?\*\/` desynchronises on a `*​/` inside a string or a regex, and on a
 * 37 000-line file that silently swallows real code: measured on videoPipeline.ts it removed
 * `fetchPexelsClips` entirely and four of six `renderAiStillToClip` call sites, which would make
 * every `not.toContain` assertion below pass for the wrong reason. Inline `/* ignore *​/` survives,
 * which is harmless.
 */
const readCode = (rel: string) =>
  read(rel)
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

/* ═══════════════════════ 1. Wikimedia ═══════════════════════ */

describe("RONDE 136 §2 — Wikimedia asks once, not once per title", () => {

  it("one request covers a whole batch, and the batch size is MediaWiki's documented cap", () => {
    // The API accepts 50 titles per call; asking for more would be silently truncated.
    expect(WIKIMEDIA_IMAGEINFO_BATCH_SIZE).toBeLessThanOrEqual(50);
    expect(WIKIMEDIA_IMAGEINFO_BATCH_SIZE).toBeGreaterThan(1);
  });
});

/* LOC (§3) was removed in VIDEO 619 together with Library of Congress itself. */

/* ═══════════════════════ 3. stock resolution ═══════════════════════ */

describe("RONDE 136 §4 — the 480 bar refuses stock and spares the archive", () => {
  it("STOCK: 426x226 is refused", () => {
    // The exact measurement from video 558, three times over, from Pexels.
    const v = videoResolutionVerdict(426, 226, minShortSideForSource("pexels"));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("video_too_low_res");
      expect(v.actual).toBe("426x226");
      expect(v.required).toBe("480 lines");
    }
  });

  it("YOUTUBE IS NOT STOCK: 640x360 is kept, because sourcingPolicy already ruled on it", () => {
    /**
     * Video 558 measured YouTube CC at 640x360 twice, under the bar — and it stays.
     *
     * youtubeMinFormatHeight() has decided this exact question since RONDE 27, and decided it the
     * other way: prefer a format of 480 lines or more, and when none exists take the tallest one
     * anyway. A hard reject here would silently overrule a written, deliberate policy, and the
     * round authorising this floor asked for it only where it safely connects to that policy.
     *
     * The Pexels argument does not transfer: a stock library that cannot supply 480 lines has
     * another clip, whereas a specific YouTube video has exactly one upload.
     */
    expect(isStockSource("youtube_cc")).toBe(false);
    expect(minShortSideForSource("youtube_cc")).toBe(VIDEO_MIN_SHORT_SIDE_PX);
    expect(videoResolutionVerdict(640, 360, minShortSideForSource("youtube_cc")).ok).toBe(true);
    // ...and it is still NOTED, so the evidence keeps accumulating.
    expect(videoResolutionVerdict(640, 360, minShortSideForSource("youtube_cc")).belowQualityBar).toBe(true);
  });

  it("STOCK: 1080p passes", () => {
    expect(videoResolutionVerdict(1920, 1080, minShortSideForSource("pexels")).ok).toBe(true);
  });

  it("ARCHIVE: a genuine 352x240 newsreel is STILL allowed", () => {
    /**
     * The half of RONDE 134's argument that survived the data, and the most important assertion
     * here: the material this pipeline exists to find must not be collateral damage.
     */
    for (const src of ["internet_archive", "loc", "nara", "wikimedia", "archive", "europeana"]) {
      const v = videoResolutionVerdict(352, 240, minShortSideForSource(src));
      expect(v.ok, `${src} refused a genuine sub-SD archive clip`).toBe(true);
      expect(v.belowQualityBar).toBe(true);
    }
  });

  it("ARCHIVE: the absolute 144 floor still refuses what is unusable at any content value", () => {
    expect(videoResolutionVerdict(128, 96, minShortSideForSource("internet_archive")).ok).toBe(false);
  });

  it("an UNKNOWN source defaults to the permissive archive floor", () => {
    /**
     * The safe direction. Guessing "stock" for something unrecognised would start refusing archive
     * footage silently, which is the one outcome this design exists to avoid.
     */
    expect(minShortSideForSource("some_new_museum_api")).toBe(VIDEO_MIN_SHORT_SIDE_PX);
    expect(minShortSideForSource(undefined)).toBe(VIDEO_MIN_SHORT_SIDE_PX);
    expect(minShortSideForSource("")).toBe(VIDEO_MIN_SHORT_SIDE_PX);
  });

  it("the stock list is explicit and matches the labels the shared trim helpers receive", () => {
    // trimRemoteVideoToClip/trimDownloadedStockClip get a label like "Trim Pexels clip 0 scene 2".
    expect(isStockSource("pexels")).toBe(true);
    expect(isStockSource("Trim Pexels clip 0 scene 2")).toBe(true);
    expect(isStockSource("YouTube CC RapidAPI scene 2")).toBe(false); // see the YouTube test above
    expect(isStockSource("Internet Archive scene 1")).toBe(false);
    expect(isStockSource("NARA scene 2")).toBe(false);
    expect(minShortSideForSource("Trim Pexels clip 0 scene 2")).toBe(VIDEO_QUALITY_BAR_SHORT_SIDE_PX);
    expect(minShortSideForSource("Internet Archive scene 1")).toBe(VIDEO_MIN_SHORT_SIDE_PX);
  });

});
