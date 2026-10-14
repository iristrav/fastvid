/**
 * VIDEO 653 — ALWAYS A FILM.
 *
 * 653 rendered completely (65 s, 1920×1080, 30 fps, audio, 19 clips) and was thrown away:
 *
 *   [DeliveryGate] SENTENCE_NOT_COVERED — s2b1 "Elon Musk's 2014 decision to open Tesla's patents …":
 *                  6.88s of 8.46s covered — clip held past its source 1.58s
 *
 * Since 11 October no film was delivered: 646, 647, 649 (×3), 651 (×3), 652 and 653 were refused for
 * what one sentence's picture was — a card, a colour field, an unjudged clip, a short source — and 651
 * and 652 because the colour field could not be found again at render time.
 *
 * Now a picture finding is a QUALITY PROBLEM: named sentence by sentence, the film delivered, the shot
 * replaced in the editor. A broken FILE still blocks. Provenance (where the pictures came from) still
 * blocks. Real footage the picture editor did not approve is tried before generic footage and the
 * colour field, and it is never passed off as approved.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  deliveryGate,
  enforceQualityExportGate,
  QUALITY_ONLY_DELIVERY_CODES,
  QUALITY_ONLY_EXPORT_CODES,
  type DeliveryGateInput,
} from "./deliveryGate";
import { sentenceCoverage } from "./sentenceCoverage";
import { emptyTimeline, videoTrack, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { rehydrateAsset, syntheticPlaceholderSpec, type RehydrateDeps } from "./assetRehydrator";
import { forgetUnjudgedFallback, noteUnjudgedFallback, pickUnjudgedFallback } from "./videoPipeline";
import { UNVERIFIED_PROVIDER } from "./visualSourceLineage";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const goodFile = { exists: true, readable: true, durationSec: 65.13, hasVideoStream: true, hasAudioStream: true, sizeBytes: 32_721_057 };
const clip = { clipId: "c1", archiveAssetId: 1, provider: "youtube_cc", resolved: true, fromArchive: true, isPlaceholder: false };
const film = (over: Partial<DeliveryGateInput> = {}): DeliveryGateInput => ({
  videoId: 653, route: "cinematic_timeline", timelineExists: true, clips: [clip], delivered: goodFile, voiceoverSec: 65, ...over,
});

/** 653's s2b1: one approved clip whose source is 1.58 s shorter than its sentence. */
function timeline653(): ProjectTimeline {
  const t = emptyTimeline(653);
  t.durationSec = 8.46;
  const c = {
    id: "vc_s2b1", kind: "video",
    source: { provider: "youtube_cc", providerAssetId: "musk", archiveAssetId: 1, contentApproval: "judge_fit" },
    sourceIn: 0, sourceOut: 6.88, timelineStart: 0, timelineEnd: 8.46,
    motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset", sceneIndex: 2, beatIndex: 1,
  } as unknown as TimelineVideoClip;
  videoTrack(t).push(c);
  t.sentences = [{ sceneIndex: 2, beatIndex: 1, startSec: 0, endSec: 8.46, timingBasis: "measured", text: "Elon Musk's 2014 decision to open Tesla's patents reshaped the industry." }];
  return t as ProjectTimeline;
}

describe("1. video 653 is delivered, and its one problem is named", () => {
  it("6.88 s of 8.46 s covered on one sentence → DELIVERY_GATE_PASS with a QUALITY_PROBLEM line for s2b1", () => {
    const cov = sentenceCoverage(timeline653());
    expect(cov.sentences[0]!.status).not.toBe("covered");
    const v = deliveryGate(film({ sentenceCoverage: cov }));
    expect(v.allow).toBe(true);
    if (!v.allow) return;
    expect(v.qualityProblems.map((p) => p.code)).toEqual(["SENTENCE_NOT_COVERED"]);
    expect(v.qualityProblems[0]!.detail).toContain("s2b1");
    expect(v.lines[0]).toContain("DELIVERY_GATE_PASS video=653");
    expect(v.lines[0]).toContain("qualityProblems=1");
    expect(v.lines.some((l) => l.includes("QUALITY_PROBLEM SENTENCE_NOT_COVERED") && l.includes("delivered anyway"))).toBe(true);
  });

  it("a film with every picture in order passes with no quality problem at all", () => {
    const v = deliveryGate(film());
    expect(v.allow && v.qualityProblems).toEqual([]);
  });
});

describe("2. a broken FILE still blocks — the release rule is about pictures, not about files", () => {
  const blocked: Array<[string, Partial<DeliveryGateInput>, string]> = [
    ["no video stream", { delivered: { ...goodFile, hasVideoStream: false } }, "DELIVERED_FILE_NO_VIDEO"],
    ["no audio with a voiceover", { delivered: { ...goodFile, hasAudioStream: false } }, "DELIVERED_FILE_NO_AUDIO"],
    ["wrong length", { delivered: { ...goodFile, durationSec: 30 } }, "DELIVERED_DURATION_WRONG"],
    ["no file", { delivered: null }, "DELIVERED_FILE_MISSING"],
    ["unreadable file", { delivered: { ...goodFile, readable: false, sizeBytes: 0 } }, "DELIVERED_FILE_UNREADABLE"],
    ["a black picture", { blankPicture: "every sample black" }, "FINAL_PICTURE_IS_BLACK"],
    ["no timeline", { timelineExists: false }, "TIMELINE_MISSING"],
    ["a failed render", { cinematicRefusal: "ffmpeg exit 1" }, "AUTHORITATIVE_RENDER_FAILED"],
  ];
  for (const [what, over, code] of blocked) {
    it(`${what} → blocked (${code})`, () => {
      const v = deliveryGate(film(over));
      expect(v.allow).toBe(false);
      if (v.allow) return;
      expect(v.failures.map((f) => f.code)).toContain(code);
    });
  }

  it("the quality-only codes are exactly the picture findings — none of the file codes", () => {
    expect([...QUALITY_ONLY_DELIVERY_CODES].sort()).toEqual([
      "CHAPTER_CARD_PLACEHOLDER", "CLIP_UNRESOLVED", "CLIP_WITHOUT_ARCHIVE_ASSET", "PLACEHOLDER_CHECK_INCOMPLETE", "PLACEHOLDER_IN_DELIVERY",
      "PLACEHOLDER_IN_FILE", "SENTENCE_COVERAGE_UNPROVEN", "SENTENCE_NOT_COVERED",
    ]);
    for (const [, , code] of blocked) expect(QUALITY_ONLY_DELIVERY_CODES.has(code as never)).toBe(false);
  });

  it("owner's rule — a clip whose file cannot be found is delivered with a quality problem, the MP4 is still measured", () => {
    const v = deliveryGate(film({ clips: [{ ...clip, resolved: false }] }));
    expect(v.allow).toBe(true);
    if (!v.allow) return;
    expect(v.qualityProblems.map((p) => p.code)).toEqual(["CLIP_UNRESOLVED"]);
    const broken = deliveryGate(film({ clips: [{ ...clip, resolved: false }], delivered: { ...goodFile, hasVideoStream: false } }));
    expect(broken.allow).toBe(false);
  });

  it("a broken file with picture problems blocks on the file, and still names the picture problems", () => {
    const v = deliveryGate(film({ delivered: { ...goodFile, hasVideoStream: false }, clips: [{ ...clip, isPlaceholder: true }] }));
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.failures.map((f) => f.code)).toEqual(["DELIVERED_FILE_NO_VIDEO"]);
    expect(v.lines.join("\n")).toContain("QUALITY_PROBLEM PLACEHOLDER_IN_DELIVERY");
  });
});

describe("3. before the render: pictures and provenance are reported, a black picture still blocks", () => {
  const report = (over: Record<string, unknown>) =>
    ({ beatVisuals: { beats: 10, verifiedOwnVisual: 0, ownFootage: 0, byCoverage: {}, byVerification: { never_asked: 10 } }, bySource: {}, totalClips: 0, generatedClips: 0, ...over }) as never;

  it("no approved picture anywhere (NO_VERIFIED_OWN_VISUAL) → reported, not thrown", () => {
    expect(QUALITY_ONLY_EXPORT_CODES.has("NO_VERIFIED_OWN_VISUAL")).toBe(true);
    expect(() => enforceQualityExportGate(653, report({}))).not.toThrow();
  });

  it("owner's rule — most clips without a proven source (MOSTLY_UNVERIFIED_CLIPS) → reported, not thrown", () => {
    expect(QUALITY_ONLY_EXPORT_CODES.has("MOSTLY_UNVERIFIED_CLIPS")).toBe(true);
    expect(() => enforceQualityExportGate(653, report({ bySource: { [UNVERIFIED_PROVIDER]: 8 }, totalClips: 10 }))).not.toThrow();
  });

  it("a black picture (FINAL_PICTURE_IS_BLACK) is still thrown — that is a broken film", () => {
    expect(QUALITY_ONLY_EXPORT_CODES.has("FINAL_PICTURE_IS_BLACK")).toBe(false);
    const black = report({ postRenderSpotCheck: { framesChecked: 4, blackFrameCount: 4, worstMeanLuma: 2 } });
    expect(() => enforceQualityExportGate(653, black)).toThrow(/FINAL_PICTURE_IS_BLACK/);
  });

  it("the pipeline reports the picture checks instead of throwing them; the provenance gate is still called", () => {
    expect(PIPE).not.toContain("assertVisionCoverageExportGate(visionCoverageParams);");
    expect(PIPE).toContain("[VisionCoverage] QUALITY_PROBLEM UNJUDGED_FOOTAGE");
    expect(PIPE).toContain("[ExportGate] QUALITY_PROBLEM VISUAL_COVERAGE");
    expect(PIPE).toContain("QUALITY_PROBLEM FILM_WITHOUT_REAL_PICTURE");
    expect(PIPE).not.toContain("no picture was found for any of its beats — export geblokkeerd");
    expect(PIPE).toContain("enforceQualityExportGate(videoId, qualityReport);");
  });
});

describe("4. the colour field is drawn again at render time (651, 652)", () => {
  it("its id names its palette and its length", () => {
    expect(syntheticPlaceholderSpec("synthetic-p4-7s")).toEqual({ palette: 4, durationSec: 7 });
    expect(syntheticPlaceholderSpec("synthetic-p0-12s")).toEqual({ palette: 0, durationSec: 12 });
    expect(syntheticPlaceholderSpec("archive-42")).toBeNull();
    expect(syntheticPlaceholderSpec("synthetic-p1-0s")).toBeNull();
    expect(syntheticPlaceholderSpec(null)).toBeNull();
  });

  it("rehydrateAsset draws it with ffmpeg — no archive, no provider, no network", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video653-synthetic-"));
    const network: string[] = [];
    const deps: RehydrateDeps = { download: async (u) => (network.push(u), false) };
    try {
      const r = await rehydrateAsset({ identity: { provider: "synthetic_placeholder", providerAssetId: "synthetic-p4-4s" }, workDir: dir, deps });
      expect(r.status).toBe("ok");
      if (r.status !== "ok") return;
      expect(fs.statSync(r.localPath).size).toBeGreaterThan(1_000);
      expect(r.provenance).toContain("drawn again from its id");
      expect(network).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("a drawer that fails gives ASSET_NOT_FOUND, never a silent pass", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video653-synthetic-"));
    try {
      const r = await rehydrateAsset({
        identity: { provider: "synthetic_placeholder", providerAssetId: "synthetic-p1-5s" },
        workDir: dir,
        deps: { download: async () => false, makeSynthetic: async () => false },
      });
      expect(r.status).not.toBe("ok");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("5. real footage the picture editor did not approve comes before generic footage and the colour field", () => {
  const ok = { valid: async () => true, durationSec: async () => 6, black: async () => false };
  const touch = (name: string) => {
    const p = path.join(os.tmpdir(), `video653-${name}-${process.pid}.mp4`);
    fs.writeFileSync(p, "x");
    return p;
  };

  it("a refused or unjudged candidate is remembered per sentence; a declined (hard mismatch) one is forgotten", () => {
    const dedup: { unjudgedFallbacks?: Map<string, string[]> } = {};
    noteUnjudgedFallback(dedup, 2, 1, "/a.mp4");
    noteUnjudgedFallback(dedup, 2, 1, "/b.mp4");
    noteUnjudgedFallback(dedup, 2, 1, "/a.mp4");
    expect(dedup.unjudgedFallbacks!.get("2:1")).toEqual(["/a.mp4", "/b.mp4"]);
    forgetUnjudgedFallback(dedup, 2, 1, "/a.mp4");
    expect(dedup.unjudgedFallbacks!.get("2:1")).toEqual(["/b.mp4"]);
    expect(dedup.unjudgedFallbacks!.get("0:0")).toBeUndefined();
  });

  it("the pick skips what is on screen elsewhere, what was refused for the file, a missing file, a black or invalid one", async () => {
    const used = touch("used"), refusedFile = touch("bad"), black = touch("black"), invalid = touch("invalid"), good = touch("good");
    const missing = path.join(os.tmpdir(), `video653-missing-${process.pid}.mp4`);
    const { clipContentKey } = await import("./videoPipeline");
    const dedup = {
      unjudgedFallbacks: new Map([["2:1", [used, refusedFile, missing, black, invalid, good]]]),
      usedContentKeys: new Set([clipContentKey(used)]),
      refusedAssetsThisRender: new Map([[clipContentKey(refusedFile), "not_a_valid_video"]]),
    };
    try {
      const picked = await pickUnjudgedFallback(dedup as never, 2, 1, {
        valid: async (p) => p !== invalid,
        durationSec: async () => 6,
        black: async (p) => p === black,
      });
      expect(picked).toEqual({ path: good, durationSec: 6 });
      expect(await pickUnjudgedFallback({ usedContentKeys: new Set() } as never, 0, 0, ok)).toBeNull();
    } finally {
      for (const p of [used, refusedFile, black, invalid, good]) fs.rmSync(p, { force: true });
    }
  });

  /**
   * FIX 1+2 (14 October) — remembered as before; but a remembered candidate is placed only after it
   * passed both mandatory checks for its sentence (`firstCheckedFallback` + `check`), so it may now
   * be placed approved. A refusal on record fails that check for free.
   */
  it("wiring: remembered at the editor's refusal and at UNREVIEWED, forgotten at the hard mismatch, checked before it is placed, before generic footage", () => {
    expect(PIPE).toContain('registerRejection(dedup.rejections, sceneIndex, beatIndex, p, "beat_image_gate", sourceQuery);\n        /** VIDEO 653 — kept as this sentence\'s last real picture before the colour field. */\n        noteUnjudgedFallback(dedup, sceneIndex, beatIndex, p);');
    expect(PIPE).toContain("UNREVIEWED: no verdict on this sentence, so it stays a candidate");
    expect(PIPE).toMatch(/UNREVIEWED: no verdict on this sentence[\s\S]{0,300}noteUnjudgedFallback\(dedup, sceneIndex, beatIndex, p\);/);
    expect(PIPE).toMatch(/"hard_mismatch", sourceQuery\);\s*forgetUnjudgedFallback\(dedup, sceneIndex, beatIndex, p\);/);
    const place = PIPE.slice(PIPE.indexOf("export async function placeGenericMovingFallbacks("));
    const unjudged = place.indexOf("const unjudged = await firstCheckedFallback(");
    const generic = place.indexOf("const decision = genericFootageDecision(");
    expect(unjudged).toBeGreaterThan(0);
    expect(unjudged).toBeLessThan(generic);
    const block = place.slice(unjudged, generic);
    expect(block).toContain("dedup.unjudgedFallbacks?.get(`${si}:${beat.index}`)");
    expect(block).toContain("(p) => check(scene, beat, p, UNJUDGED_FOOTAGE_FALLBACK)");
    /** never passed off as generic footage, and no approval is written here by hand — only the check writes it */
    expect(block).not.toMatch(/markGenericFootageForBeat|judge_fit|contentApproval/);
  });
});
