/**
 * VIDEO 650 — GENERIC_FOOTAGE_FALLBACK: the moving, rights-clear floor under the sourcing ladder.
 *
 * What is tested: the pure rules (when to place, which archive clip, the ffmpeg arguments), the
 * synthetic clip itself with REAL ffmpeg (made, decodable, moving, long enough), the motion check's
 * refusal of a still, the coverage check counting generic footage as cover of its own kind, the
 * delivery gate allowing such a film and naming it, the archive kind, and the pipeline's wiring
 * (ledger mark → timeline `contentApproval: "generic_footage"`, the pass after the generated-image
 * pass, the stock cap yielding to a sentence's only picture).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveFFmpegBin } from "./ffmpegBinary";
import {
  GENERIC_ARCHIVE_TAG,
  GENERIC_FOOTAGE_PROVIDER,
  SYNTHETIC_MIN_SEC,
  SYNTHETIC_PALETTES,
  SYNTHETIC_PLACEHOLDER_PROVIDER,
  SYNTHETIC_PLACEHOLDER_TITLE,
  clipHasMotion,
  formatGenericFootagePlacement,
  genericFootageDecision,
  makeSyntheticMotionClip,
  pickGenericArchiveAsset,
  syntheticAssetId,
  syntheticMotionClipArgs,
} from "./genericFootageFallback";
import { sentenceCoverage } from "./sentenceCoverage";
import { deliveryGate } from "./deliveryGate";
import { AUTO_ARCHIVES, autoArchiveKind } from "./stockArchive";
import { emptyTimeline, videoTrack, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";

const run = promisify(execFile);
const FFMPEG = resolveFFmpegBin();
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
let ROOT = "";

beforeAll(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "v650generic-"));
});
afterAll(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* not worth a failure */ }
});

async function probe(file: string): Promise<{ codec: string; durationSec: number; frames: number; width: number }> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,nb_frames,duration", "-of", "json", file]);
  const st = (JSON.parse(stdout).streams ?? [])[0] ?? {};
  return { codec: String(st.codec_name), durationSec: Number(st.duration), frames: Number(st.nb_frames), width: Number(st.width) };
}

/* ═══════════════ 1. the rules ═══════════════ */

describe("VIDEO 650 — generic footage: the rules", () => {
  it("places only for a sentence without a picture, and not when the render has no time left", () => {
    expect(genericFootageDecision({ hasPicture: true, remainingMs: null })).toMatchObject({ place: false });
    expect(genericFootageDecision({ hasPicture: false, remainingMs: null })).toEqual({ place: true });
    expect(genericFootageDecision({ hasPicture: false, remainingMs: 10 * 60_000 })).toEqual({ place: true });
    const late = genericFootageDecision({ hasPicture: false, remainingMs: 30_000 });
    expect(late.place).toBe(false);
    if (!late.place) expect(late.reason).toContain("left in the render");
  });

  it("picks an active READY video that covers the sentence, prefers one not yet used, and rotates by seed", () => {
    const assets = [
      { id: 1, mediaType: "video", mediaStatus: "READY", isActive: 1, durationSec: 12 },
      { id: 2, mediaType: "video", mediaStatus: "READY", isActive: 1, durationSec: 3 }, // too short for 5 s
      { id: 3, mediaType: "image", mediaStatus: "READY", isActive: 1, durationSec: 30 }, // a still
      { id: 4, mediaType: "video", mediaStatus: "FAILED", isActive: 1, durationSec: 30 }, // not READY
      { id: 5, mediaType: "video", mediaStatus: "READY", isActive: 0, durationSec: 30 }, // switched off
      { id: 6, mediaType: "video", mediaStatus: "READY", isActive: 1, durationSec: 8 },
    ];
    const none = new Set<number>();
    expect(pickGenericArchiveAsset(assets, { neededSec: 5, usedIds: none, seed: 0 })?.id).toBe(1);
    expect(pickGenericArchiveAsset(assets, { neededSec: 5, usedIds: none, seed: 1 })?.id).toBe(6);
    /** used in this film → the other one, while one is left; both used → rotate again rather than nothing */
    expect(pickGenericArchiveAsset(assets, { neededSec: 5, usedIds: new Set([1]), seed: 0 })?.id).toBe(6);
    expect(pickGenericArchiveAsset(assets, { neededSec: 5, usedIds: new Set([1, 6]), seed: 0 })?.id).toBe(1);
    expect(pickGenericArchiveAsset(assets, { neededSec: 20, usedIds: none, seed: 0 })).toBeNull();
    expect(pickGenericArchiveAsset([], { neededSec: 1, usedIds: none, seed: 0 })).toBeNull();
  });

  it("the synthetic clip's ffmpeg arguments: gradients source, grain, the frame rate stated, the archive's minimum length", () => {
    const args = syntheticMotionClipArgs({ output: "/tmp/x.mp4", durationSec: 2, widthPx: 1920, heightPx: 1080, fps: 30, seed: 7 });
    const src = args[args.indexOf("-i") + 1]!;
    expect(src).toMatch(/^gradients=s=1920x1080:/);
    expect(src).toContain(":rate=30:");
    expect(src).toContain(`:duration=${SYNTHETIC_MIN_SEC.toFixed(2)}`);
    expect(args.slice(args.indexOf("-r"), args.indexOf("-r") + 2)).toEqual(["-r", "30"]);
    expect(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2)).toEqual(["-t", SYNTHETIC_MIN_SEC.toFixed(2)]);
    expect(args[args.indexOf("-vf") + 1]).toContain("noise=");
    expect(args[args.length - 1]).toBe("/tmp/x.mp4");
    /** a longer sentence gets its own length, and the palette follows the seed */
    expect(syntheticMotionClipArgs({ output: "o", durationSec: 9.25, widthPx: 1280, heightPx: 720, fps: 25, seed: 1 })[7]).toContain(":duration=9.25");
    expect(SYNTHETIC_PALETTES.length).toBeGreaterThanOrEqual(4);
    expect(syntheticAssetId(0, 4.2)).toBe("synthetic-p0-5s");
    expect(syntheticAssetId(1, 4.2)).toBe("synthetic-p1-5s");
  });

  it("the placement line names the sentence, the source, the asset, the seconds; an archive clip is generic footage, the synthetic field an EMERGENCY placeholder", () => {
    const archive = formatGenericFootagePlacement({ sceneIndex: 2, beatIndex: 3, source: "archive", assetId: 418, durationSec: 9, neededSec: 4.2 });
    expect(archive).toContain("[GENERIC_FOOTAGE_FALLBACK] s2b3 placed source=archive asset=418 duration=9.00s needed=4.20s");
    expect(archive).toContain("NOT a content fit (contentApproval=generic_footage)");
    expect(archive).not.toContain("EMERGENCY");
    const line = formatGenericFootagePlacement({ sceneIndex: 2, beatIndex: 3, source: "synthetic", assetId: "synthetic-p1-5s", durationSec: 5, neededSec: 4.2 });
    expect(line).toContain("[GENERIC_FOOTAGE_FALLBACK] s2b3 placed source=synthetic asset=synthetic-p1-5s duration=5.00s needed=4.20s");
    expect(line).toContain("EMERGENCY PLACEHOLDER (provider=synthetic_placeholder)");
    expect(line).toContain("NOT footage, NOT a content choice");
    expect(line).toContain("QUALITY PROBLEM");
  });

  it("generated generic clips are filed in their own archive, by platform or by source note", () => {
    expect(autoArchiveKind({ sourcePlatform: GENERIC_FOOTAGE_PROVIDER, sourceNote: "generic_footage:synthetic-p0-5s" })).toBe("generic");
    /** the placeholder is filed with them so an operator finds and replaces it — under its own provider name, never as footage */
    expect(autoArchiveKind({ sourcePlatform: SYNTHETIC_PLACEHOLDER_PROVIDER, sourceNote: "synthetic_placeholder:synthetic-p0-5s" })).toBe("generic");
    expect(SYNTHETIC_PLACEHOLDER_PROVIDER).toBe("synthetic_placeholder");
    expect(SYNTHETIC_PLACEHOLDER_TITLE).toContain("EMERGENCY PLACEHOLDER");
    expect(SYNTHETIC_PLACEHOLDER_TITLE).toContain("not footage");
    expect(autoArchiveKind({ sourcePlatform: null, sourceNote: "generic_footage:synthetic-p0-5s" })).toBe("generic");
    expect(autoArchiveKind({ sourcePlatform: "pexels", sourceNote: "pexels:1" })).toBe("stock");
    expect(AUTO_ARCHIVES.generic.slug).toBe("generic");
    expect(AUTO_ARCHIVES.generic.isActive).toBe(1);
    expect(GENERIC_ARCHIVE_TAG).toBe("generic");
  });
});

/* ═══════════════ 2. the synthetic clip, with real ffmpeg ═══════════════ */

describe("VIDEO 650 — the synthetic clip is a real moving video", () => {
  it("is rendered, decodes as H.264, covers the sentence at the stated frame rate, and MOVES", async () => {
    const out = path.join(ROOT, "synthetic.mp4");
    const made = await makeSyntheticMotionClip(FFMPEG, { output: out, durationSec: 4.2, widthPx: 640, heightPx: 360, fps: 30, seed: 3 });
    expect(made).toEqual({ ok: true });
    expect(fs.statSync(out).size).toBeGreaterThan(50_000); // the archive's own file floor
    const p = await probe(out);
    expect(p.codec).toBe("h264");
    expect(p.width).toBe(640);
    expect(p.durationSec).toBeGreaterThanOrEqual(4.2);
    expect(Math.abs(p.frames - p.durationSec * 30)).toBeLessThanOrEqual(2);
    const motion = await clipHasMotion(FFMPEG, out);
    expect(motion.moving, motion.detail).toBe(true);
  }, 120_000);

  it("a still rendered to video is refused by the motion check — a card can never pass as generic footage", async () => {
    const still = path.join(ROOT, "still.mp4");
    await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=#2f3e4e:s=320x180:rate=30:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", still]);
    const motion = await clipHasMotion(FFMPEG, still);
    expect(motion.moving).toBe(false);
    expect(motion.detail).toMatch(/frozen/);
  }, 60_000);

  it("ffmpeg that cannot run is a named failure, not a thrown render", async () => {
    const made = await makeSyntheticMotionClip("/nonexistent/ffmpeg", { output: path.join(ROOT, "none.mp4"), durationSec: 2, widthPx: 320, heightPx: 180, fps: 30, seed: 0 });
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.reason).toContain("ffmpeg");
  });
});

/* ═══════════════ 3. coverage and delivery ═══════════════ */

function clipFor(id: string, o: { start: number; end: number; approval?: "judge_fit" | "generic_footage" | "unverified"; archive?: number | null; beat?: [number, number] }): TimelineVideoClip {
  return {
    id, kind: "video",
    source: { provider: o.approval === "generic_footage" ? GENERIC_FOOTAGE_PROVIDER : "youtube_cc", providerAssetId: id, ...(o.archive === null ? {} : { archiveAssetId: o.archive ?? 1 }), ...(o.approval ? { contentApproval: o.approval } : {}) },
    sourceIn: 0, sourceOut: o.end - o.start,
    timelineStart: o.start, timelineEnd: o.end,
    motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset",
    sceneIndex: o.beat?.[0] ?? 0, beatIndex: o.beat?.[1] ?? 0,
  } as TimelineVideoClip;
}
function timelineWith(clips: TimelineVideoClip[], sentences: ProjectTimeline["sentences"]): ProjectTimeline {
  const t = emptyTimeline(650);
  t.durationSec = 8;
  videoTrack(t).push(...clips);
  t.sentences = sentences;
  return t;
}
const sentence = (b: number, start: number, end: number) => ({ sceneIndex: 0, beatIndex: b, startSec: start, endSec: end, timingBasis: "measured" as const, text: `Sentence ${b}.` });

describe("VIDEO 650 — generic footage in the coverage check and the delivery gate", () => {
  it("a sentence under generic footage placed FOR it is covered, of kind generic_footage, with the seconds named", () => {
    const r = sentenceCoverage(timelineWith([clipFor("g", { start: 0, end: 4, approval: "generic_footage" })], [sentence(0, 0, 4)]));
    expect(r.sentences[0]).toMatchObject({ status: "covered", coveredSec: 4, approvedFootageSec: 0, genericFootageSec: 4, unverifiedSec: 0, kinds: ["generic_footage"], reasons: [] });
    expect(r).toMatchObject({ covered: 1, uncovered: 0, proven: true });
  });

  it("generic footage placed for ANOTHER sentence is not this sentence's cover", () => {
    const r = sentenceCoverage(timelineWith([clipFor("g", { start: 0, end: 4, approval: "generic_footage", beat: [0, 1] })], [sentence(0, 0, 4)]));
    expect(r.sentences[0]).toMatchObject({ status: "uncovered", genericFootageSec: 0, otherSentenceSec: 4 });
  });

  it("an approved picture is counted before generic footage under the same seconds", () => {
    const r = sentenceCoverage(timelineWith([clipFor("a", { start: 0, end: 2, approval: "judge_fit" }), clipFor("g", { start: 0, end: 4, approval: "generic_footage" })], [sentence(0, 0, 4)]));
    expect(r.sentences[0]).toMatchObject({ status: "covered", approvedFootageSec: 2, genericFootageSec: 2, kinds: ["approved_footage", "generic_footage"] });
  });

  it("the delivery gate ALLOWS a film on generic footage with an archive handle and NAMES it as not a content fit", () => {
    const t = timelineWith([clipFor("g", { start: 0, end: 4, approval: "generic_footage", archive: 42 })], [sentence(0, 0, 4)]);
    const v = deliveryGate({
      videoId: 650, route: "cinematic_timeline", timelineExists: true, assetsOnly: true, delivered: null,
      clips: [{ clipId: "g", archiveAssetId: 42, provider: GENERIC_FOOTAGE_PROVIDER, providerAssetId: "synthetic-p0-5s", resolved: true, fromArchive: true, isPlaceholder: false }],
      sentenceCoverage: sentenceCoverage(t),
    });
    expect(v.allow, v.allow ? "" : JSON.stringify(v.failures)).toBe(true);
    expect(v.lines.some((l) => l.includes("QUALITY_NOTE GENERIC_FOOTAGE sentences=1 sec=4.00 (s0b0)"))).toBe(true);
  });

  it("the synthetic colour field is NOT cover: its sentence is uncovered, named synthetic_placeholder on the row, a problem in the report, a QUALITY_PROBLEM at the gate — and (VIDEO 653) the film is delivered with the problem named, never as if it had a picture", () => {
    const placeholder = clipFor("p", { start: 0, end: 4, approval: "generic_footage", archive: 43 });
    placeholder.source = { ...placeholder.source, provider: SYNTHETIC_PLACEHOLDER_PROVIDER, providerAssetId: "synthetic-p0-5s" };
    const t = timelineWith([placeholder], [sentence(0, 0, 4)]);
    const r = sentenceCoverage(t);
    expect(r.sentences[0]).toMatchObject({ status: "uncovered", coveredSec: 0, genericFootageSec: 4, syntheticPlaceholderSec: 4, emptySec: 0, kinds: ["generic_footage", "synthetic_placeholder"] });
    expect(r.sentences[0]!.reasons).toContain("synthetic placeholder (colour field, not footage) 4.00s");
    expect(r.covered).toBe(0);
    expect(r.problems.some((p) => p.includes("synthetic placeholder") && p.includes("NOT footage") && p.includes("quality problem"))).toBe(true);
    const v = deliveryGate({
      videoId: 650, route: "cinematic_timeline", timelineExists: true, assetsOnly: true, delivered: null,
      clips: [{ clipId: "p", archiveAssetId: 43, provider: SYNTHETIC_PLACEHOLDER_PROVIDER, providerAssetId: "synthetic-p0-5s", resolved: true, fromArchive: true, isPlaceholder: false }],
      sentenceCoverage: r,
    });
    expect(v.allow).toBe(true);
    expect(v.allow && v.qualityProblems.some((f) => f.code === "SENTENCE_NOT_COVERED" && f.detail.includes("synthetic placeholder"))).toBe(true);
    expect(v.lines.some((l) => l.includes("QUALITY_PROBLEM SYNTHETIC_PLACEHOLDER sentences=1 sec=4.00 (s0b0)") && l.includes("EMERGENCY fallback") && l.includes("NOT footage") && l.includes("delivered anyway"))).toBe(true);
    /** half a sentence on a real clip, half on the colour field: partial, still not cover */
    const half = clipFor("p2", { start: 2, end: 4, approval: "generic_footage", archive: 44 });
    half.source = { ...half.source, provider: SYNTHETIC_PLACEHOLDER_PROVIDER, providerAssetId: "synthetic-p1-2s" };
    const mixed = sentenceCoverage(timelineWith([clipFor("a", { start: 0, end: 2, approval: "judge_fit", archive: 45 }), half], [sentence(0, 0, 4)]));
    expect(mixed.sentences[0]).toMatchObject({ status: "partial", coveredSec: 2, syntheticPlaceholderSec: 2 });
    /** a real generic archive clip is NOT a placeholder: no problem line */
    const real = sentenceCoverage(timelineWith([clipFor("g", { start: 0, end: 4, approval: "generic_footage", archive: 42 })], [sentence(0, 0, 4)]));
    expect(real.sentences[0]).toMatchObject({ syntheticPlaceholderSec: 0, kinds: ["generic_footage"] });
    expect(real.problems.some((p) => p.includes("synthetic placeholder"))).toBe(false);
    const realGate = deliveryGate({
      videoId: 650, route: "cinematic_timeline", timelineExists: true, assetsOnly: true, delivered: null,
      clips: [{ clipId: "g", archiveAssetId: 42, provider: GENERIC_FOOTAGE_PROVIDER, providerAssetId: "archive-42", resolved: true, fromArchive: true, isPlaceholder: false }],
      sentenceCoverage: real,
    });
    expect(realGate.lines.some((l) => l.includes("QUALITY_PROBLEM"))).toBe(false);
    /** the log analyser reads QUALITY_PROBLEM as a note, not as a gate failure code */
    expect(fs.readFileSync(path.join(__dirname, "railwayLogAnalyser.ts"), "utf8")).toContain("COVERAGE|PLACEHOLDER|QUALITY_NOTE|QUALITY_PROBLEM)$/");
  });

  it("the delivery gate names a generic clip without an archive handle (VIDEO 653: delivered, a quality problem)", () => {
    const t = timelineWith([clipFor("g", { start: 0, end: 4, approval: "generic_footage", archive: null })], [sentence(0, 0, 4)]);
    const v = deliveryGate({
      videoId: 650, route: "cinematic_timeline", timelineExists: true, assetsOnly: true, delivered: null,
      clips: [{ clipId: "g", archiveAssetId: null, provider: GENERIC_FOOTAGE_PROVIDER, providerAssetId: "x", resolved: true, fromArchive: false, isPlaceholder: false }],
      sentenceCoverage: sentenceCoverage(t),
    });
    expect(v.allow).toBe(true);
    expect(v.allow && v.qualityProblems.map((f) => f.code)).toContain("CLIP_WITHOUT_ARCHIVE_ASSET");
  });
});

/* ═══════════════ 4. the pipeline's wiring ═══════════════ */

describe("VIDEO 650 — the pipeline places generic footage and names it on the timeline", () => {
  const PIPELINE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("the pass runs after the generated-image pass, before the film-without-picture refusal", () => {
    const gen = PIPELINE.indexOf("await generateMissingBeatImages(scenes, sceneVisualResults, visualDedup, workDir, topicContext);");
    const generic = PIPELINE.indexOf("await placeGenericMovingFallbacks(scenes, sceneVisualResults, visualDedup, workDir, topicContext);");
    const refusal = PIPELINE.indexOf("const firstEmptySi = filmWithoutPictureRefusal(");
    expect(gen).toBeGreaterThan(0);
    expect(generic).toBeGreaterThan(gen);
    expect(refusal).toBeGreaterThan(generic);
  });

  it("the ledger mark reaches the timeline as contentApproval generic_footage, after judge_fit and before unverified", () => {
    const at = PIPELINE.indexOf("contentApproval: pictureApprovedForBeat(visualDedup, scene.index, beatIndex, clipContentKey(clipPath))");
    expect(at).toBeGreaterThan(0);
    const body = PIPELINE.slice(at, at + 1000);
    expect(body).toContain('("judge_fit" as const)');
    expect(body.indexOf("genericFootageForBeat(visualDedup, scene.index, beatIndex, clipContentKey(clipPath))")).toBeGreaterThan(body.indexOf('"judge_fit"'));
    expect(body.indexOf('("generic_footage" as const)')).toBeLessThan(body.indexOf('("unverified" as const)'));
  });

  it("every placed clip is measured (valid, long enough, not black, moving); an archive clip keeps its archive handle", () => {
    const at = PIPELINE.indexOf("async function placeGenericMovingFallbacks(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("async function fetchBeatGeneratedImage(", at));
    for (const needle of [
      "isValidVideoFile(outPath)", "probeVideoStreamMeta(outPath)", "isMostlyBlackClip(outPath", "clipHasMotion(FFMPEG_BIN, outPath)",
      "attachArchiveAssetToPath(outPath, archiveId", "markGenericFootageForBeat(dedup, scene.index, beat.index, clipContentKey(outPath))",
      "FAILED — no moving coverage for this sentence",
    ]) expect(body, needle).toContain(needle);
    /** archive first, synthetic second — the brief's order */
    expect(body.indexOf('["archive", "synthetic"]')).toBeGreaterThan(0);
    /** PRE-DEPLOY — the synthetic branch carries its own provider name and title */
    const synthetic = body.slice(body.indexOf("const id = syntheticAssetId(seed, neededSec);"));
    expect(synthetic).toContain("SYNTHETIC_PLACEHOLDER_PROVIDER, id, dedup.sourcingCache,");
    expect(synthetic).toContain("title: SYNTHETIC_PLACEHOLDER_TITLE");
    /** VIDEO 651 — and it is NEVER stored in the archive (render 651 filed one as asset 60649) */
    expect(body, "no route from the floor into the archive store").not.toContain("storeExternalClipForTimeline(");
    expect(synthetic).toContain("synthetic placeholder not archived");
    expect(synthetic).not.toContain("tags: [GENERIC_ARCHIVE_TAG]");
    /** the archive branch keeps the generic provider and the archive row's id */
    expect(body).toContain("GENERIC_FOOTAGE_PROVIDER, `archive-${pick.id}`, dedup.sourcingCache,");
  });

  it("the stock cap yields to a sentence's only picture instead of making it a card", () => {
    expect(PIPELINE).toContain("canUseLicensedStockBeat(dedup, { sentenceWithoutPicture: true, where: `s${scene.index}b${beat.index}` })");
    const at = PIPELINE.indexOf("function canUseLicensedStockBeat(");
    const body = PIPELINE.slice(at, at + 1600);
    expect(body).toContain("if (opts?.sentenceWithoutPicture) {");
    expect(body).toContain("[StockBudget] cap lifted for");
  });
});
