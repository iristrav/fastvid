/**
 * "WHERE DID MY FOOTAGE COME FROM" WAS ANSWERED ABOUT A FILE NOBODY RECEIVED.
 *
 * ── The number and the film it described ─────────────────────────────────────────────────────
 *
 * `buildVideoQualityReport` runs at stage 6, over `composedUsedClips` — the compose montage's own
 * clip list, which at that point is the only finished film in existence. Since the delivery
 * cutover the viewer may instead receive the cinematic timeline render, built eight hundred lines
 * later by a different renderer from its own list. `bySource`, `byMixKind`, `totalClips` and the
 * score they feed then describe the montage, under headings a reader takes to mean their video.
 *
 * Render 574 reported nineteen clips. The delivered file carried twelve.
 *
 * ── Why this was the last piece and not the first ────────────────────────────────────────────
 *
 * The three other readers of `composedUsedClips` needed a FALLBACK — use the selected set when
 * compose produced nothing — and that was the previous commit. This one must not fall back at
 * all: a scene that composed nothing put no picture in the montage, so reporting its selected
 * clips there would turn a missing scene into a full one. It needed the opposite, a list of what
 * is actually IN the delivered file, and that list already existed: `deliveredPaths`, built from
 * the render job's own `renderedClipIds`, spent on `replaceFinalVideo`, and then dropped.
 *
 * The same defect this codebase keeps finding — a value computed and handed to nobody.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

import {
  buildVideoQualityReport,
  recountQualityReportForDeliveredClips,
} from "./videoQualityReport";

const PIPELINE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** Nineteen worked with, of which twelve reach the delivered file — render 574's shape. */
const MONTAGE = [
  ...Array.from({ length: 7 }, (_, i) => `/tmp/scene_0_b${i}_pex_vid${i}__pid_pexels-a${i}.mp4`),
  ...Array.from({ length: 12 }, (_, i) => `/tmp/scene_1_b${i}_curated_a${5700 + i}.mp4`),
];
const DELIVERED = MONTAGE.slice(7);

const provider = (p: string): string | null =>
  p.includes("pexels") ? "pexels" : p.includes("curated") ? "ww2" : null;

function report(clips: string[]) {
  return buildVideoQualityReport(clips, "Why Adolf Hitler Took His Own Life in 1945", {
    resolveSource: provider,
    archiveOnly: true,
  });
}

describe("the clip figures follow the file the viewer receives", () => {
  it("a fresh report says it counted the compose montage", () => {
    /** Honest at the moment it is built: stage 6 has no other finished film to count. */
    expect(report(MONTAGE).clipsMeasuredOn).toBe("compose_montage");
  });

  it("recounting says so, and says which file", () => {
    const r = report(MONTAGE);
    recountQualityReportForDeliveredClips(r, DELIVERED, { resolveSource: provider });
    expect(r.clipsMeasuredOn).toBe("delivered_render");
  });

  it("totalClips becomes the delivered count, not the montage's", () => {
    const r = report(MONTAGE);
    expect(r.totalClips).toBe(19);
    const out = recountQualityReportForDeliveredClips(r, DELIVERED, { resolveSource: provider });
    expect(r.totalClips).toBe(12);
    expect(out).toMatchObject({ clipsBefore: 19, clipsAfter: 12 });
  });

  it("bySource stops naming providers that are not in the file", () => {
    /**
     * The seven stock clips were worked with and did not survive into the delivered render. A
     * report that still counts them answers the provenance question about the wrong video.
     */
    const r = report(MONTAGE);
    expect(r.bySource.pexels).toBe(7);
    recountQualityReportForDeliveredClips(r, DELIVERED, { resolveSource: provider });
    expect(r.bySource.pexels).toBeUndefined();
    expect(r.bySource.ww2).toBe(12);
  });

  it("the three tallies and the diagnostic reading follow too", () => {
    const r = report(MONTAGE);
    expect(r.stockCount).toBe(7);
    recountQualityReportForDeliveredClips(r, DELIVERED, { resolveSource: provider });
    expect(r.stockCount).toBe(0);
    expect(r.diagnosticBySource.pexels).toBeUndefined();
    expect(Object.values(r.byMixKind).reduce((s, n) => s + n, 0)).toBe(12);
  });

  it("the score is recomputed, not left describing the other file", () => {
    /**
     * The score reads totalClips, archiveCount, stockCount and byMixKind. Leaving it while those
     * four change is exactly the pair of contradictory numbers this report keeps apologising for
     * — a stock penalty for seven clips that are not in the film.
     */
    const r = report(MONTAGE);
    const before = r.score;
    const out = recountQualityReportForDeliveredClips(r, DELIVERED, { resolveSource: provider });
    expect(out.scoreBefore).toBe(before);
    expect(r.score).toBe(out.scoreAfter);
    /** Seven stock clips gone means the stock penalty is gone with them. */
    expect(r.score).toBeGreaterThan(before);
  });

  it("a suspect that is not in the delivered file stops being reported as one", () => {
    const r = report(MONTAGE);
    r.offTopicSuspects = [
      { basename: "scene_0_b0_pex_vid0__pid_pexels-a0.mp4", reason: "urban" },
      { basename: "scene_1_b0_curated_a5700.mp4", reason: "urban" },
    ];
    recountQualityReportForDeliveredClips(r, DELIVERED, { resolveSource: provider });
    expect(r.offTopicSuspects.map((s) => s.basename)).toEqual(["scene_1_b0_curated_a5700.mp4"]);
  });

  it("what describes the RENDER rather than a file is left alone", () => {
    /**
     * The reject audit and the beat coverage are not properties of a video file — they record what
     * the render did on its way there, and re-counting them against a clip list would be a
     * category error, not a correction.
     */
    const r = report(MONTAGE);
    const rejects = r.rejectSummary;
    const beats = r.beatVisuals;
    recountQualityReportForDeliveredClips(r, DELIVERED, { resolveSource: provider });
    expect(r.rejectSummary).toBe(rejects);
    expect(r.beatVisuals).toBe(beats);
  });

  it("counting the same list twice changes nothing", () => {
    /** A correction that is not idempotent is a second opinion, not a correction. */
    const r = report(MONTAGE);
    recountQualityReportForDeliveredClips(r, DELIVERED, { resolveSource: provider });
    const once = JSON.stringify({ ...r, generatedAt: "" });
    recountQualityReportForDeliveredClips(r, DELIVERED, { resolveSource: provider });
    expect(JSON.stringify({ ...r, generatedAt: "" })).toBe(once);
  });
});

/* ═══════════════════════ it runs on the delivery path, from the list already there ═══════════════════════ */

describe("the render calls it with the list it already built", () => {
  it("the recount reads deliveredPaths, not a second list of its own", () => {
    const at = PIPELINE.indexOf("recountQualityReportForDeliveredClips(");
    expect(at, "the recount is not wired up").toBeGreaterThan(-1);
    const call = PIPELINE.slice(at, at + 500);
    expect(call).toContain("qualityReport,");
    expect(call).toContain("deliveredPaths,");
  });

  it("it uses the same two resolvers stage 6 used", () => {
    const at = PIPELINE.indexOf("recountQualityReportForDeliveredClips(");
    const call = PIPELINE.slice(at, at + 500);
    expect(call).toContain("ledger.providerFor(clipPath)");
    expect(call).toContain("ledger.isGeneratedFallback(clipPath)");
  });

  it("and says what it changed, in the report", () => {
    expect(PIPELINE).toContain("figures re-counted against the delivered file");
  });

  it("the compose route is untouched — its montage IS the delivered file", () => {
    /**
     * `allClipPaths` still counts `composedUsedClips` at stage 6. On the fallback route that list
     * is exactly right, and the recount above never runs.
     */
    expect(PIPELINE).toContain("const allClipPaths = composedUsedClips.flat().filter(Boolean);");
  });
});
