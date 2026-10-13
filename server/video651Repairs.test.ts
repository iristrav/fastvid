/**
 * VIDEO 651 — three repairs, each pinned to what render 651 logged.
 *
 *   1  s1b0: a photo the picture editor approved (FIT) in the historical route was dropped because
 *      it was not a video; the fill waited for it and the sentence ended on the colour field.
 *   2  the synthetic colour field was filed in the archive as asset 60649.
 *   3  s1b1: the 5 s YouTube cap gave 0.51 s of s1b1's slot to s1b0's clip, so s1b1 showed another
 *      sentence's picture ("picture approved for another sentence 0.52s") and the gate refused.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { limitYoutubeShots, YOUTUBE_MAX_SHOT_SEC, type YoutubeSourceFacts } from "./youtubeShotLimit";
import type { TimelineVideoClip } from "./projectTimeline";
import { storeForProduction } from "./productionMediaArchive";
import { SYNTHETIC_PLACEHOLDER_PROVIDER } from "./genericFootageFallback";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const DB = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");
const WORKER = fs.readFileSync(path.join(__dirname, "worker.ts"), "utf8");

const bodyOf = (src: string, head: string, next: string) => {
  const at = src.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf(next, at + head.length));
};

/* ═══════════ 1 — the approved photo survives the historical route ═══════════ */

describe("1 — an approved photo is not thrown away in the historical route when no video comes", () => {
  /** A file name the pipeline tags with its provider, as render 651's photo was. */
  const photo = "/tmp/v651/scene_1_b0_primary_inet_img_serp_serp_0__pid_serpapi-8cef03cf1457773a_transformed.mp4";

  it("a photo approved for THIS sentence is kept; not approved, or approved for another sentence, is not", async () => {
    const vp = await import("./videoPipeline");
    const dedup = {};
    expect(vp.keepsApprovedHistoricalStill(dedup, 1, 0, photo), "no approval yet").toBe(false);
    vp.noteApprovedKeyForBeat(dedup, 1, 0, vp.clipContentKey(photo));
    expect(vp.keepsApprovedHistoricalStill(dedup, 1, 0, photo), "approved for s1b0").toBe(true);
    expect(vp.keepsApprovedHistoricalStill(dedup, 1, 1, photo), "approved for s1b0 is not approved for s1b1").toBe(false);
    expect(vp.keepsApprovedHistoricalStill({}, 1, 0, photo), "another render's approval does not count").toBe(false);
  });

  it("the transformed copy keeps the approval of the photo the editor looked at", async () => {
    const vp = await import("./videoPipeline");
    expect(vp.clipContentKey(photo)).toBe(vp.clipContentKey(photo.replace("_transformed", "")));
  });

  it("the historical branch keeps the approved photo and returns it when no video beats it", () => {
    const route = bodyOf(PIPE, "export async function fetchBeatArchivalThenPexels(", "/** The own archive's clip for a beat");
    const branch = route.slice(route.indexOf("if (historicalDoc) {"), route.indexOf("const article ="));
    /** a video is still returned at once, exactly as before */
    expect(branch).toContain("if (internet && isRealVideoClip(internet)) {");
    /** and an approved photo is no longer dropped */
    expect(branch).toContain("if (internet && keepsApprovedHistoricalStill(dedup, sceneIndex, beat.index, internet)) {");
    expect(branch).toContain("approvedHistoricalStill = internet;");
    /** no article screenshot and no further photo search over a photo already approved */
    expect(route).toContain("const article = approvedHistoricalStill\n    ? null\n    : await fetchBeatArticleScreenshot(");
    expect(route).toContain("const still = approvedHistoricalStill ? null : await fetchBeatAuthenticStills(");
    /** the approved photo is what the route falls back to; licensed stock VIDEO is still asked first */
    expect(route).toContain(
      "const approvedStill = (still && !isPipelineFallbackClip(still) ? still : null) ?? approvedHistoricalStill;"
    );
    expect(route).toContain("if (!canUseLicensedStockBeat(dedup)) return approvedStill;");
    expect(route).toContain("if (stock && isRealVideoClip(stock)) {");
    expect(route.trimEnd().endsWith("return approvedStill;\n}")).toBe(true);
  });

  it("the quality bar is unchanged: only the picture editor's approval keeps a photo", () => {
    const helper = bodyOf(PIPE, "export function keepsApprovedHistoricalStill(", "\n}\n");
    expect(helper).toContain("if (!clip || isPipelineFallbackClip(clip)) return false;");
    expect(helper).toContain("return pictureApprovedForBeat(dedup, sceneIndex, beatIndex, clipContentKey(clip));");
  });
});

/* ═══════════ 2 — the synthetic colour field never enters the archive ═══════════ */

describe("2 — a synthetic placeholder is never archived and never offered again", () => {
  it("the archive store refuses it before reading the file or touching storage", async () => {
    const lines: string[] = [];
    const out = await storeForProduction({
      localPath: "/does/not/exist/scene_1_generic_b0.mp4",
      provider: SYNTHETIC_PLACEHOLDER_PROVIDER,
      providerAssetId: "synthetic-p4-7s",
      metadata: { title: "placeholder", tags: [], sourceNote: "synthetic_placeholder:synthetic-p4-7s", mediaType: "video", mimeType: "video/mp4" },
      deps: new Proxy({}, { get: () => { throw new Error("storage must not be touched"); } }) as never,
      ctx: { projectId: 651, sceneIndex: 1, beatIndex: 0, provider: SYNTHETIC_PLACEHOLDER_PROVIDER, providerAssetId: "synthetic-p4-7s" },
      verifyDir: "/tmp",
      log: (l) => lines.push(l),
    });
    expect(out.status).toBe("failed");
    expect(out.status === "failed" && out.code).toBe("ARCHIVE_INGEST_REFUSED");
    expect(out.mediaStatus).toBe("REJECTED");
    expect(lines.join("\n")).toContain("never archived");
  });

  it("the case of the provider name does not get it past", async () => {
    const out = await storeForProduction({
      localPath: "/does/not/exist.mp4",
      provider: "  Synthetic_Placeholder ",
      metadata: { title: "x", tags: [], sourceNote: "x", mediaType: "video", mimeType: "video/mp4" },
      deps: {} as never,
      ctx: { projectId: null, sceneIndex: 0, beatIndex: 0, provider: "synthetic_placeholder", providerAssetId: null },
      verifyDir: "/tmp",
      log: () => {},
    });
    expect(out.status === "failed" && out.code).toBe("ARCHIVE_INGEST_REFUSED");
  });

  it("the generic floor no longer sends the colour field to the archive", () => {
    const floor = bodyOf(PIPE, "export async function placeGenericMovingFallbacks(", "async function fetchBeatGeneratedImage(");
    expect(floor).not.toContain("storeExternalClipForTimeline(");
    expect(floor).toContain("synthetic placeholder not archived");
  });

  it("an already-stored placeholder (asset 60649, and any shot piece of it) is switched off, never deleted", () => {
    const fn = bodyOf(DB, "export async function deactivateSyntheticPlaceholderArchiveAssets(", "\n}\n");
    expect(fn).toContain('eq(mediaArchiveAssets.sourcePlatform, "synthetic_placeholder")');
    /** shot pieces carry the parent's sourceNote with a `#shotN` suffix, so a prefix match takes them too */
    expect(fn).toContain('like(mediaArchiveAssets.sourceNote, "synthetic_placeholder:%")');
    expect(fn).toContain(".set({ isActive: 0, previewIssue: SYNTHETIC_PLACEHOLDER_ARCHIVE_ISSUE })");
    expect(fn).not.toMatch(/\.delete\(/);
    /** run at every worker start, before the archive sweeps, and logged with the ids */
    const sweep = WORKER.indexOf("deactivateSyntheticPlaceholderArchiveAssets()");
    expect(sweep).toBeGreaterThan(-1);
    expect(sweep).toBeLessThan(WORKER.indexOf("startArchiveShotSplitSweep"));
    expect(WORKER).toContain("[ArchiveHygiene] synthetic placeholder asset(s): deactivated now=");
  });

  it("every archive candidate query already filters on isActive = 1, so a switched-off row is never offered", () => {
    const tagged = bodyOf(DB, "export async function listActiveVideoArchiveAssetsByTag(", "\n}\n");
    expect(tagged).toContain("eq(mediaArchiveAssets.isActive, 1)");
  });
});

/* ═══════════ 3 — the 5 s YouTube cap never lends a sentence's slot to another sentence ═══════════ */

const oneShot = (sourceDurationSec: number): YoutubeSourceFacts => ({ sourceDurationSec, cutsSec: [], measured: true });
const clip = (id: string, start: number, end: number, over: Partial<TimelineVideoClip> = {}): TimelineVideoClip => ({
  id,
  kind: "video",
  source: { provider: "synthetic_placeholder", archiveAssetId: 1 },
  sourceIn: 0,
  timelineStart: start,
  timelineEnd: end,
  motion: "none",
  transitionIn: "hard_cut",
  transitionOut: "hard_cut",
  previewSource: "asset",
  sceneIndex: 1,
  ...over,
});
/** Which sentence's clip is on screen at time `t`. */
const sentenceAt = (clips: TimelineVideoClip[], t: number) =>
  clips.find((c) => !c.disabled && t >= c.timelineStart - 1e-6 && t < c.timelineEnd - 1e-6)?.beatIndex;

describe("3 — render 651's s1b1: the cap cuts the YouTube clip into pieces instead of stretching s1b0", () => {
  /** Render 651's planned shape: s1b0 17.07–22.23 (spoken to 21.91, then the pause), s1b1's YouTube 22.23–27.74. */
  const s1b0 = clip("vc_cdcfeaf1cc", 17.07, 22.23, { beatIndex: 0 });
  const s1b1 = clip("vc_57d3b836ba", 22.23, 27.74, { beatIndex: 1, source: { provider: "youtube", archiveAssetId: 60278 }, sourceIn: 3 });

  it("s1b0's clip ends where it was planned, and every second of s1b1 (22.23–27.31 spoken) shows s1b1's picture", () => {
    const { clips, notes } = limitYoutubeShots({ clips: [s1b0, s1b1], youtube: new Map([["vc_57d3b836ba", oneShot(60)]]) });
    const first = clips.find((c) => c.id === "vc_cdcfeaf1cc")!;
    expect(first.timelineEnd, "s1b0 does not run into s1b1").toBeCloseTo(22.23, 3);
    expect(notes.join("\n")).not.toContain("holds 0.51s longer");
    for (let t = 22.23; t < 27.31; t += 0.05) expect(sentenceAt(clips, t), `t=${t.toFixed(2)}`).toBe(1);
    /** the YouTube rule itself still holds: no piece over five seconds, and the span is unchanged */
    const pieces = clips.filter((c) => c.beatIndex === 1);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.timelineEnd - p.timelineStart).toBeLessThanOrEqual(YOUTUBE_MAX_SHOT_SEC + 1e-6);
    expect(Math.min(...pieces.map((p) => p.timelineStart))).toBeCloseTo(22.23, 3);
    expect(Math.max(...pieces.map((p) => p.timelineEnd))).toBeCloseTo(27.74, 3);
  });

  it("a neighbour of the SAME sentence still takes the time, exactly as before", () => {
    const own = clip("own", 17.07, 22.23, { beatIndex: 1 });
    const { clips, notes } = limitYoutubeShots({ clips: [own, s1b1], youtube: new Map([["vc_57d3b836ba", oneShot(60)]]) });
    expect(notes.join("\n")).toContain("own holds 0.51s longer to fill it");
    expect(clips.find((c) => c.id === "own")!.timelineEnd).toBeCloseTo(22.74, 2);
  });

  it("clips that do not say their sentence keep the earlier behaviour", () => {
    const a = clip("a", 17.07, 22.23);
    const b = clip("b", 22.23, 27.74, { source: { provider: "youtube", archiveAssetId: 60278 } });
    const { notes } = limitYoutubeShots({ clips: [a, b], youtube: new Map([["b", oneShot(60)]]) });
    expect(notes.join("\n")).toContain("a holds 0.51s longer to fill it");
  });
});
