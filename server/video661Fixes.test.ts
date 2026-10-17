/**
 * VIDEO 661 — the fix round from render 70 (video 661).
 *
 *   A  a sentence with nothing approved yet may look `MAX_JUDGEMENTS_PER_BEAT` more times before it
 *      falls back to a card (render 70: 18.3 s of chapter cards, eight downloaded candidates unjudged)
 *   B  the same picture from another file is a repeat: removed before the timeline, so the sentence's
 *      rungs offer another picture (render 70: one static book page three times, REPEATS=11)
 *   E  a dark source is not darkened by the grade; near-black is refused at mean luma 34 everywhere
 *   F  YouTube and stock under 480 lines are refused, archive under 360; archive re-encode at crf 18
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_JUDGEMENTS_PER_BEAT, maxBeatImageJudgementsPerRender } from "./beatImageRelevanceGate";
import {
  beatHasApprovedPicture,
  createBeatRelevanceLedger,
  looksLeftOnBeat,
  maxRelevanceLooksPerBeat,
  relevanceLookCeilingOnBeat,
  unapprovedBeatExtraLooks,
  type BeatRelevanceEntry,
} from "./beatVisualRelevance";
import { fingerprintOf, type FrameFingerprint } from "./contactSheet";
import { buildDocumentaryColorGradeVF, buildPerClipDocumentaryGradeVF, DARK_SOURCE_MEAN_LUMA, isDarkSource } from "./documentaryStyle";
import { minShortSideForSource, videoResolutionVerdict } from "./technicalMediaGate";
import { gradeChain } from "./timelineFilters";
import { probeMeanLuma } from "./timelineRenderer";
import { EMERGENCY_FIELD_NEAR_BLACK_MEAN_LUMA, NEAR_BLACK_MEAN_LUMA, removeVisualRepeats } from "./videoPipeline";
import { findVisualRepeats, fingerprintClipFile, sameLookingClips } from "./visualRepeatCheck";
import { judgeAcquiredFile } from "./youtubeAcquisitionValidation";

const SRC = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

/* ═══════════ A ═══════════ */

describe("A — a sentence with nothing approved gets more looks before a card", () => {
  const entry = (verdict: string, extra: Partial<{ evaluated: boolean; reprieved: boolean }> = {}): BeatRelevanceEntry =>
    ({ ctx: {}, decision: { verdict, allowed: true, reprieved: false, cached: false, depicts: "", reason: "", route: "t", ...extra } }) as unknown as BeatRelevanceEntry;

  afterEach(() => {
    delete process.env.MAX_BEAT_RELEVANCE_LOOKS_UNAPPROVED_EXTRA;
  });

  it("nothing approved: the base ceiling plus MAX_JUDGEMENTS_PER_BEAT (5 + 4 = 9 by default)", () => {
    const ledger = createBeatRelevanceLedger();
    expect(unapprovedBeatExtraLooks()).toBe(MAX_JUDGEMENTS_PER_BEAT);
    expect(relevanceLookCeilingOnBeat(ledger, "s2b0")).toBe(maxRelevanceLooksPerBeat() + MAX_JUDGEMENTS_PER_BEAT);
    expect(looksLeftOnBeat(ledger, 2, 0)).toBe(maxRelevanceLooksPerBeat() + MAX_JUDGEMENTS_PER_BEAT);
    ledger.spendByBeat.set("s2b0", 5);
    expect(looksLeftOnBeat(ledger, 2, 0)).toBe(MAX_JUDGEMENTS_PER_BEAT);
  });

  it("once a fit or acceptable picture is on record for the sentence, the ceiling is the old one", () => {
    for (const verdict of ["fits", "acceptable"]) {
      const ledger = createBeatRelevanceLedger();
      ledger.byBeat.set("s2b0\u0000content:youtube_cc:abc", entry(verdict));
      expect(beatHasApprovedPicture(ledger, "s2b0")).toBe(true);
      expect(relevanceLookCeilingOnBeat(ledger, "s2b0")).toBe(maxRelevanceLooksPerBeat());
      /** another sentence's approval does not count */
      expect(beatHasApprovedPicture(ledger, "s2b1")).toBe(false);
      /** a prefix match on the slot is not the same sentence (s2b1 vs s2b10) */
      expect(beatHasApprovedPicture(ledger, "s2b")).toBe(false);
    }
  });

  it("a refusal, a decline (nobody looked) and a reprieved refusal are not an approval", () => {
    const ledger = createBeatRelevanceLedger();
    ledger.byBeat.set("s1b6\u0000path:a.mp4", entry("does_not_fit"));
    ledger.byBeat.set("s1b6\u0000path:b.mp4", entry("fits", { evaluated: false }));
    ledger.byBeat.set("s1b6\u0000path:c.mp4", entry("fits", { reprieved: true }));
    expect(beatHasApprovedPicture(ledger, "s1b6")).toBe(false);
  });

  it("the extra is a setting (0 switches it off), and the render's ceiling of 120 is untouched", () => {
    process.env.MAX_BEAT_RELEVANCE_LOOKS_UNAPPROVED_EXTRA = "0";
    expect(relevanceLookCeilingOnBeat(createBeatRelevanceLedger(), "s0b0")).toBe(maxRelevanceLooksPerBeat());
    expect(maxBeatImageJudgementsPerRender()).toBe(120);
    expect(SRC("beatImageRelevanceGate.ts")).toContain("state.judgementAttempts >= maxBeatImageJudgementsPerRender() && !params.finalSay");
  });

  it("the judge reads the sentence's own ceiling, and a cached verdict still costs nothing", () => {
    const BVR = SRC("beatVisualRelevance.ts");
    expect(BVR).toContain("const ownCeiling = relevanceLookCeilingOnBeat(ledger, slot);");
    expect(BVR).toContain("if (!alreadyKnown && spentOnBeat >= ownCeiling && !params.finalSay) {");
  });
});

/* ═══════════ B ═══════════ */

/** A 9×8 grey frame from a seed: the same seed is the same picture. */
function frame(seed: number, atSec = 0): FrameFingerprint {
  const g = new Uint8Array(72);
  let x = seed * 2654435761;
  for (let i = 0; i < 72; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    g[i] = 30 + (x % 190);
  }
  return fingerprintOf(g, atSec);
}
const flat = (v = 10): FrameFingerprint => fingerprintOf(new Uint8Array(72).fill(v), 0);

describe("B — the same picture from another file is a repeat", () => {
  it("render 70: one static book page in three files — the second and third are repeats of the first", () => {
    const page = [frame(7, 0), frame(7, 1), frame(7, 2), frame(7, 3)];
    const aerial = [frame(1), frame(2), frame(3)];
    const out = findVisualRepeats([
      { id: "asset61476", prints: page },
      { id: "aerial", prints: aerial },
      { id: "asset61477", prints: page.slice(0, 3) },
      { id: "raw_gefeJvBKnGI", prints: page.slice(1) },
    ]);
    expect(out).toEqual([
      { id: "asset61477", sameAs: "asset61476" },
      { id: "raw_gefeJvBKnGI", sameAs: "asset61476" },
    ]);
  });

  it("different footage is never a repeat; one shared frame in a moving shot is not enough", () => {
    expect(sameLookingClips([frame(1), frame(2), frame(3), frame(4)], [frame(5), frame(6), frame(7), frame(8)])).toBe(false);
    expect(sameLookingClips([frame(1), frame(2), frame(3), frame(4)], [frame(4), frame(9), frame(10), frame(11)])).toBe(false);
    /** half of the shorter clip is the bar */
    expect(sameLookingClips([frame(1), frame(2), frame(3), frame(4)], [frame(3), frame(4), frame(10), frame(11)])).toBe(true);
  });

  it("black and plain frames are never compared; an unreadable clip is never a repeat", () => {
    expect(sameLookingClips([flat(), flat()], [flat(), flat()])).toBe(false);
    expect(findVisualRepeats([{ id: "a", prints: [frame(3)] }, { id: "b", prints: null }, { id: "c", prints: [] }])).toEqual([]);
  });

  it("in the pipeline: the later repeat leaves its sentence (by position), the first stays, nothing else moves", async () => {
    const page = [frame(7), frame(7)];
    const prints: Record<string, FrameFingerprint[] | null> = {
      "/w/s0_a.mp4": page,
      "/w/s0_b.mp4": [frame(1), frame(2)],
      "/w/s1_c.mp4": page,
      "/w/s1_d.mp4": null,
    };
    const scenes = [{ index: 0 }, { index: 1 }] as never;
    const vr0 = { clips: ["/w/s0_a.mp4", "/w/s0_b.mp4"], beatDurations: [3, 3], clipBeatIndices: [0, 1] };
    const vr1 = { clips: ["/w/s1_c.mp4", "/w/s1_d.mp4"], beatDurations: [4, 2], clipBeatIndices: [0, 1] };
    const dedup = { sceneBeatsBySceneIndex: new Map() } as never;
    const res = await removeVisualRepeats(scenes, [vr0, vr1] as never, dedup, async (p) => prints[p] ?? null);
    expect(res).toEqual({ compared: 4, removed: 1 });
    expect(vr0.clips).toEqual(["/w/s0_a.mp4", "/w/s0_b.mp4"]);
    expect(vr1).toEqual({ clips: ["/w/s1_d.mp4"], beatDurations: [2], clipBeatIndices: [1] });
  });

  it("it runs after the first mandatory checks and before the rungs that find the sentence another picture", () => {
    const PIPE = SRC("videoPipeline.ts");
    const after = PIPE.indexOf('await enforceMandatoryChecks(scenes, sceneVisualResults, visualDedup, workDir, topicContext, "after_sourcing");');
    const repeat = PIPE.indexOf("await removeVisualRepeats(scenes, sceneVisualResults, visualDedup);");
    const rungs = PIPE.indexOf("await generateMissingBeatImages(scenes, sceneVisualResults, visualDedup, workDir, topicContext);");
    expect(after).toBeGreaterThan(0);
    expect(repeat).toBeGreaterThan(after);
    expect(rungs).toBeGreaterThan(repeat);
  });

  it("on real files: the same still twice matches, a different picture does not", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v661b-"));
    const mk = (name: string, src: string) => {
      const out = path.join(dir, name);
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", src, "-t", "3", "-pix_fmt", "yuv420p", out]);
      return out;
    };
    const a = mk("a.mp4", "testsrc2=size=320x240:rate=5,trim=end_frame=1,loop=loop=-1:size=1");
    const b = mk("b.mp4", "testsrc2=size=320x240:rate=5,trim=end_frame=1,loop=loop=-1:size=1");
    const c = mk("c.mp4", "mandelbrot=size=320x240:rate=5,trim=end_frame=1,loop=loop=-1:size=1");
    const [pa, pb, pc] = await Promise.all([a, b, c].map((f) => fingerprintClipFile(f, "ffmpeg")));
    expect(pa?.length).toBeGreaterThan(0);
    expect(sameLookingClips(pa!, pb!)).toBe(true);
    expect(sameLookingClips(pa!, pc!)).toBe(false);
    expect(await fingerprintClipFile(path.join(dir, "missing.mp4"), "ffmpeg")).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ═══════════ E ═══════════ */

describe("E — a dark source is not darkened; near-black is refused", () => {
  it("the ordinary grade is byte-for-byte what it was", () => {
    expect(buildDocumentaryColorGradeVF("archive")).toContain("brightness=-0.03:gamma=1.02");
    expect(buildPerClipDocumentaryGradeVF("archive")).toMatch(/vignette=angle=0\.62/);
    expect(gradeChain({ grade: "documentary" }, "archive")).toBe(buildPerClipDocumentaryGradeVF("archive"));
  });

  it("a dark source: no brightness pull, a slight gamma lift, no vignette — at full and at half strength", () => {
    const dark = gradeChain({ grade: "documentary" }, "archive", { darkSource: true })!;
    expect(dark).toContain("brightness=0:gamma=1.08");
    expect(dark).not.toContain("-0.03");
    expect(dark).not.toContain("vignette");
    const half = gradeChain({ grade: "documentary", strength: 0.5 }, "stock", { darkSource: true })!;
    expect(half).toContain("brightness=0.0000:gamma=1.0400");
    expect(half).not.toContain("vignette");
    /** the colour and contrast of the calibration stay */
    expect(dark).toContain("saturation=0.88");
    expect(dark).toContain("colorbalance=");
  });

  it("dark means mean luma under 60; unmeasured is not dark", () => {
    expect(DARK_SOURCE_MEAN_LUMA).toBe(60);
    expect(isDarkSource(45)).toBe(true);
    expect(isDarkSource(60)).toBe(false);
    expect(isDarkSource(null)).toBe(false);
    expect(isDarkSource(Number.NaN)).toBe(false);
  });

  it("the renderer measures the file and passes it to the grade", () => {
    const R = SRC("timelineRenderer.ts");
    expect(R).toContain("const darkSource = isDarkSource(meanLuma);");
    expect(R).toContain("buildVideoFilter(unbranded, fmt, dur, look, { portraitSource: portraitSource || offShape, darkSource })"); // VIDEO 663
  });

  it("probeMeanLuma reads a dark and a bright file as such", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v661e-"));
    const mk = (name: string, color: string) => {
      const out = path.join(dir, name);
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:size=160x90:rate=5`, "-t", "2", "-pix_fmt", "yuv420p", out]);
      return out;
    };
    const dark = await probeMeanLuma(mk("dark.mp4", "0x202020"));
    const bright = await probeMeanLuma(mk("bright.mp4", "0xb0b0b0"));
    expect(dark).not.toBeNull();
    expect(isDarkSource(dark)).toBe(true);
    expect(isDarkSource(bright)).toBe(false);
    expect(await probeMeanLuma(path.join(dir, "missing.mp4"))).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("near-black: 34 on Railway too (was 24), still two samples of three", () => {
    expect(NEAR_BLACK_MEAN_LUMA).toBe(34);
    const PIPE = SRC("videoPipeline.ts");
    expect(PIPE).toContain("const dark = samples.filter((m) => m < nearBlackLuma).length;");
    expect(PIPE).toContain("nearBlackLuma: number = NEAR_BLACK_MEAN_LUMA");
    /** the emergency colour field — the floor under "always a video" — keeps its old bar of 24 */
    expect(EMERGENCY_FIELD_NEAR_BLACK_MEAN_LUMA).toBe(24);
    expect(PIPE).toContain('source === "synthetic" ? EMERGENCY_FIELD_NEAR_BLACK_MEAN_LUMA : NEAR_BLACK_MEAN_LUMA');
    expect(PIPE).toContain("return samples.length === 1 ? dark === 1 : dark >= 2;");
    expect(PIPE).not.toContain("samples.filter((m) => m < 24)");
  });
});

/* ═══════════ F ═══════════ */

describe("F — resolution floors and the archive re-encode", () => {
  it("a YouTube file under 480 lines is refused like any failed attempt; 480p passes", () => {
    expect(judgeAcquiredFile({ meta: { width: 640, height: 360, durationSec: 10 }, requestedSec: 5, frameDecoded: true })).toMatchObject({
      ok: false,
      code: "LOW_RESOLUTION",
    });
    expect(judgeAcquiredFile({ meta: { width: 854, height: 480, durationSec: 10 }, requestedSec: 5, frameDecoded: true }).ok).toBe(true);
  });

  it("stock and YouTube 480, archive 360 (480x360 SD newsreel kept, 352x240 refused)", () => {
    expect(minShortSideForSource("youtube_cc")).toBe(480);
    expect(minShortSideForSource("pexels")).toBe(480);
    expect(minShortSideForSource("archive")).toBe(360);
    expect(videoResolutionVerdict(480, 360, minShortSideForSource("archive")).ok).toBe(true);
    expect(videoResolutionVerdict(352, 240, minShortSideForSource("archive")).ok).toBe(false);
    expect(videoResolutionVerdict(534, 300, minShortSideForSource("archive")).ok).toBe(false);
  });

  it("the archive splitter re-encodes at veryfast / crf 18, never ultrafast / crf 23", () => {
    const S = SRC("archiveVideoSplitter.ts");
    expect(S).not.toContain("-preset ultrafast -crf 23");
    expect(S.match(/-preset veryfast -crf 18/g)?.length).toBe(3);
    /** the downscaled cut-detection proxy is never delivered and stays fast */
    expect(S).toContain("-preset ultrafast -crf 28 -g 5");
  });
});
