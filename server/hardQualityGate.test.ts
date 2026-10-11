import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { emptyTimeline, graphicsTrack, videoTrack, type ProjectTimeline, type TimelineGraphic, type TimelineVideoClip } from "./projectTimeline";
import { chapterCardIntervals, formatSentenceCoverage, sentenceCoverage, sourceWindowSec } from "./sentenceCoverage";
import { deliveryGate, hardVisualRuleFailures, MAX_DELIVERABLE_FOOTAGE_SHARE, type PlaceholderCheckFacts } from "./deliveryGate";
import {
  PLACEHOLDER_BAND_FRACTION,
  PLACEHOLDER_BAND_MAX_STDDEV,
  PLACEHOLDER_FRAME_FRACTION,
  PLACEHOLDER_SCAN_HEIGHT,
  PLACEHOLDER_SCAN_WIDTH,
  isPrimaryGroundPixel,
  primaryGroundFraction,
  readGroundFrame,
  scanForPlaceholderGround,
  spotCheckFinalVideo,
} from "./postRenderSpotCheck";
import { analyseLogLines } from "./railwayLogAnalyser";

/**
 * HARD QUALITY GATE — every sentence under a picture that fits for all of its spoken time, and zero
 * seconds of the blue-grey chapter-card ground in the delivered MP4. Measured on the timeline
 * (sentenceCoverage.ts), read in EVERY frame of the file (postRenderSpotCheck.ts), decided by the DeliveryGate.
 * Everything here is local: synthetic timelines and ffmpeg-made MP4s. No network, no provider.
 */

/* ───────────── fixtures ───────────── */

type ClipOpts = Partial<TimelineVideoClip> & { approved?: boolean; start: number; end: number; sourceSec?: number | null; beat?: [number, number] };
function clip(id: string, o: ClipOpts): TimelineVideoClip {
  const { approved = true, start, end, sourceSec = end - start, beat = [0, 0], ...rest } = o;
  return {
    id,
    kind: "video",
    source: { provider: "youtube_cc", providerAssetId: id, archiveAssetId: 1, ...(approved ? { contentApproval: "judge_fit" as const } : {}) },
    ...(sourceSec == null ? {} : { sourceIn: 10, sourceOut: 10 + sourceSec }),
    timelineStart: start,
    timelineEnd: end,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
    sceneIndex: beat[0],
    beatIndex: beat[1],
    ...rest,
  } as TimelineVideoClip;
}
function graphic(id: string, type: string, start: number, end: number, beat: [number, number] = [0, 0], extra: Record<string, unknown> = {}): TimelineGraphic {
  return { id, graphicType: type, data: { primaryVisual: true, sceneIndex: beat[0], beatIndex: beat[1], ...extra }, start, end } as TimelineGraphic;
}
function timeline(opts: {
  sentences?: ProjectTimeline["sentences"];
  clips?: TimelineVideoClip[];
  graphics?: TimelineGraphic[];
  durationSec?: number;
}): ProjectTimeline {
  const t = emptyTimeline(77);
  t.durationSec = opts.durationSec ?? 10;
  videoTrack(t).push(...(opts.clips ?? []));
  graphicsTrack(t).push(...(opts.graphics ?? []));
  if (opts.sentences) t.sentences = opts.sentences;
  return t;
}
const sentence = (s: number, b: number, start: number, end: number, basis: "measured" | "estimated" = "measured", text = `Sentence ${s}-${b}.`) => ({
  sceneIndex: s,
  beatIndex: b,
  startSec: start,
  endSec: end,
  timingBasis: basis,
  text,
});

/* ═══════════════ A — sentence coverage, measured on the timeline ═══════════════ */

describe("sentence coverage (Eis A)", () => {
  it("1. a sentence fully under approved footage is covered — and the report is proven", () => {
    const r = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4)], clips: [clip("a", { start: 0, end: 4 })] }));
    expect(r.sentences[0]).toMatchObject({ status: "covered", coveredSec: 4, approvedFootageSec: 4, cardSec: 0, kinds: ["approved_footage"], reasons: [] });
    expect(r).toMatchObject({ total: 1, covered: 1, uncovered: 0, unknown: 0, plannedCardSec: 0, proven: true });
  });

  it("2. a sentence with no picture at all is uncovered, with the reason", () => {
    const r = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4)] }));
    expect(r.sentences[0]).toMatchObject({ status: "uncovered", coveredSec: 0, emptySec: 4, kinds: ["none"] });
    expect(r.sentences[0]!.reasons).toEqual(["no picture 4.00s"]);
    expect(r.proven).toBe(false);
  });

  it("3. a clip that covers only the start of the sentence leaves it partial — a picture at the start does not cover the rest", () => {
    const r = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 6)], clips: [clip("a", { start: 0, end: 2.5 })] }));
    expect(r.sentences[0]).toMatchObject({ status: "partial", coveredSec: 2.5, emptySec: 3.5 });
    expect(r.covered).toBe(0);
    expect(r.partial).toBe(1);
  });

  it("4. a chapter card as the sentence's picture is a placeholder: uncovered, card seconds counted, the interval named for the MP4 scan", () => {
    const t = timeline({
      sentences: [sentence(0, 0, 0, 4.42)],
      clips: [{ ...clip("ground_graphic1", { start: 0, end: 4.42, approved: true }), transform: { opacity: 0 } }],
      graphics: [graphic("gfx1", "chapter_card", 0, 4.42)],
    });
    const r = sentenceCoverage(t);
    expect(r.sentences[0]).toMatchObject({ status: "uncovered", coveredSec: 0, cardSec: 4.42, emptySec: 0, kinds: ["chapter_card"] });
    expect(r.sentences[0]!.reasons[0]).toBe("chapter card placeholder 4.42s");
    expect(r.plannedCardSec).toBe(4.42);
    expect(chapterCardIntervals(t)).toEqual([{ startSec: 0, endSec: 4.42, graphicId: "gfx1", sceneIndex: 0, beatIndex: 0 }]);
    expect(r.proven).toBe(false);
  });

  it("5. a content graphic (chart, map, timeline) as the sentence's picture is cover", () => {
    for (const type of ["bar_chart", "map", "timeline", "counter"]) {
      const r = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 5)], graphics: [graphic("g", type, 0, 5)] }));
      expect(r.sentences[0]).toMatchObject({ status: "covered", contentGraphicSec: 5, kinds: ["content_graphic"] });
      expect(r.plannedCardSec).toBe(0);
    }
    /** a card next to a content graphic: the card part is not cover */
    const mixed = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 6)], graphics: [graphic("g", "bar_chart", 0, 3), graphic("c", "chapter_card", 3, 6)] }));
    expect(mixed.sentences[0]).toMatchObject({ status: "partial", contentGraphicSec: 3, cardSec: 3 });
  });

  it("6. a clip without the picture editor's approval is technically present but not cover: status unknown, never covered", () => {
    const r = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4)], clips: [clip("a", { start: 0, end: 4, approved: false })] }));
    expect(r.sentences[0]).toMatchObject({ status: "unknown", coveredSec: 0, unverifiedSec: 4, kinds: ["unverified_footage"] });
    expect(r.sentences[0]!.reasons).toContain("footage without the picture editor's approval 4.00s");
    expect(r.unknown).toBe(1);
    expect(r.proven).toBe(false);
  });

  it("7. a clip held past its source window: the frozen seconds are not cover (645's '6.080s planned from 3.560s of source')", () => {
    const r = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 6.08)], clips: [clip("a", { start: 0, end: 6.08, sourceSec: 3.56 })] }));
    expect(r.sentences[0]).toMatchObject({ status: "partial", coveredSec: 3.56, stretchedSec: 2.52 });
    expect(r.sentences[0]!.reasons).toContain("clip held past its source 2.52s");
    expect(r.stretchedClips).toBe(1);
    expect(sourceWindowSec({ kind: "video", sourceIn: 10, sourceOut: 13.56 })).toBeCloseTo(3.56, 5);
    expect(sourceWindowSec({ kind: "video" })).toBeNull();
    expect(sourceWindowSec({ kind: "image" })).toBe(Number.POSITIVE_INFINITY);
  });

  it("8. missing or invalid timeline data never becomes a false success: no sentences, no spoken window, estimated timing, unknown source window", () => {
    expect(sentenceCoverage(timeline({ clips: [clip("a", { start: 0, end: 4 })] }))).toMatchObject({ total: 0, proven: false });
    const noWindow = sentenceCoverage(timeline({ sentences: [{ sceneIndex: 0, beatIndex: 0, startSec: null, endSec: null, timingBasis: "estimated" }], clips: [clip("a", { start: 0, end: 4 })] }));
    expect(noWindow.sentences[0]).toMatchObject({ status: "unknown", timingBasis: "missing" });
    const estimated = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4, "estimated")], clips: [clip("a", { start: 0, end: 4 })] }));
    expect(estimated.sentences[0]!.status).toBe("unknown");
    expect(estimated.sentences[0]!.reasons).toContain("spoken window is the planner's estimate, not measured narration");
    expect(estimated.proven).toBe(false);
    expect(estimated.problems[0]).toContain("estimated");
    const noSource = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4)], clips: [clip("a", { start: 0, end: 4, sourceSec: null })] }));
    expect(noSource.sentences[0]!.status).toBe("unknown");
    expect(noSource.sentences[0]!.reasons).toContain("clip without a known source window 4.00s");
  });

  it("two sentences, one covered by two clips and a graphic, one with a gap in the middle", () => {
    const r = sentenceCoverage(
      timeline({
        sentences: [sentence(0, 0, 0, 6), sentence(0, 1, 6, 12)],
        clips: [clip("a", { start: 0, end: 3 }), clip("b", { start: 6, end: 8, beat: [0, 1] }), clip("c", { start: 10, end: 12, beat: [0, 1] })],
        graphics: [graphic("g", "map", 3, 6)],
      })
    );
    expect(r.sentences[0]).toMatchObject({ status: "covered", approvedFootageSec: 3, contentGraphicSec: 3 });
    expect(r.sentences[1]).toMatchObject({ status: "partial", coveredSec: 4, emptySec: 2 });
    const lines = formatSentenceCoverage(77, r);
    expect(lines[0]).toContain("[SentenceCoverage] video=77 s0b0 spoken=0.00-6.00s timing=measured status=covered covered=6.00s kinds=approved_footage+content_graphic");
    expect(lines[1]).toContain('s0b1 spoken=6.00-12.00s timing=measured status=partial covered=4.00s');
    expect(lines[1]).toContain('reason="no picture 2.00s"');
    expect(lines[2]).toContain("[SentenceCoverage] video=77 TOTAL sentences=2 covered=1 partial=1 uncovered=0 unknown=0 stretchedClips=0 plannedCardSec=0.00 proven=no");
  });

  it("9. the source order, budgets and cost limits are untouched", () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
    expect(read("judgeBudget.ts")).toContain("export const JUDGE_MS_PER_LOOK = 7_500;");
    expect(read("judgeBudget.ts")).toContain("export const JUDGE_BASE_SCALE = 1.5;");
    expect(read("tunelioDownloader.ts")).toContain("export const TUNELIO_PAID_CALLS_PER_RENDER = 3;");
    expect(read("videoPipeline.ts")).toContain("export const SECOND_SECTIONS_PER_RENDER = 3;");
    expect(read("youtubeShotStock.ts")).toMatch(/export const MAX_STOCK_VIDEOS = 10;/);
    expect(read("youtubeShotStock.ts")).toMatch(/export const STOCK_FIRST_BATCH = 6;/);
    expect(read("beatImageRelevanceGate.ts")).toContain('export const MAX_JUDGEMENTS_PER_BEAT = envInt("MAX_BEAT_IMAGE_JUDGEMENTS_PER_BEAT", 4, 1, 12);');
    expect(MAX_DELIVERABLE_FOOTAGE_SHARE).toBe(0.5);
    /** the card placement itself is not changed: only the graphic now names its sentence */
    const edl = read("edlToTimeline.ts");
    expect(edl).toContain("data: { ...payload, primaryVisual: true, ...(owner ? { sceneIndex: owner.sceneIndex, beatIndex: owner.beatIndex } : {}) },");
    expect(edl).toContain("export const MAX_HOLD_SEC = 1.5;");
  });
});

/* ═══════════════ A′ — approved for THIS sentence, not a neighbour's ═══════════════ */

describe("Eis A — the approval is per sentence: a neighbour's approved picture under this sentence is not its cover", () => {
  it("a clip approved for s0b1 that runs under s0b0's last 1.5 s does not cover them: partial, named", () => {
    /** found by the end-to-end test: sentence 0 ran to 4.5 s, its own clip to 3 s, and the next sentence's clip was counted as cover */
    const t = timeline({
      sentences: [sentence(0, 0, 0, 4.5), sentence(0, 1, 4.5, 6)],
      clips: [clip("yt", { start: 0, end: 3, beat: [0, 0] }), clip("two", { start: 3, end: 6, beat: [0, 1] })],
    });
    const r = sentenceCoverage(t);
    expect(r.sentences[0]).toMatchObject({ key: "s0b0", status: "partial", coveredSec: 3, approvedFootageSec: 3, unverifiedSec: 0, otherSentenceSec: 1.5, emptySec: 0 });
    expect(r.sentences[0]!.kinds).toEqual(["approved_footage", "other_sentence_picture"]);
    expect(r.sentences[0]!.reasons).toEqual(["picture approved for another sentence 1.50s"]);
    expect(r.sentences[1]).toMatchObject({ key: "s0b1", status: "covered", coveredSec: 1.5 });
    expect(r.proven).toBe(false);
    expect(hardVisualRuleFailures({ sentenceCoverage: r }).map((f) => f.code)).toEqual(["SENTENCE_NOT_COVERED"]);
  });

  it("an approved clip WITHOUT a sentence mark is not established for any sentence: unknown, named", () => {
    const unmarked = { ...clip("x", { start: 0, end: 4 }) } as TimelineVideoClip;
    delete (unmarked as { sceneIndex?: number }).sceneIndex;
    delete (unmarked as { beatIndex?: number }).beatIndex;
    const r = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4)], clips: [unmarked] }));
    expect(r.sentences[0]).toMatchObject({ status: "unknown", coveredSec: 0, unverifiedSec: 4 });
    expect(r.sentences[0]!.reasons).toEqual(["approved picture without a sentence mark 4.00s"]);
  });

  it("the same rule for a content graphic: a chart drawn for s0b1 is not s0b0's picture", () => {
    const r = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4), sentence(0, 1, 4, 8)], graphics: [graphic("g", "bar_chart", 0, 8, [0, 1])] }));
    expect(r.sentences[0]).toMatchObject({ status: "uncovered", coveredSec: 0, contentGraphicSec: 0, otherSentenceSec: 4 });
    expect(r.sentences[0]!.reasons).toEqual(["picture approved for another sentence 4.00s"]);
    expect(r.sentences[1]).toMatchObject({ status: "covered", contentGraphicSec: 4 });
  });

  it("two approved clips of the SAME sentence add up to its cover", () => {
    const r = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 6)], clips: [clip("a", { start: 0, end: 2.5 }), clip("b", { start: 2.5, end: 6 })] }));
    expect(r.sentences[0]).toMatchObject({ status: "covered", coveredSec: 6 });
  });
});

/* ═══════════════ B — the blue-grey ground in the MP4 ═══════════════ */

describe("the chapter-card ground in the delivered file (Eis B)", () => {
  let dir: string;
  const mp4 = (name: string, args: string[]) => {
    const out = path.join(dir, name);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args, "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", out]);
    return out;
  };
  let ground: string;
  let groundEdge: string;
  let content: string;
  let letterbox: string;
  let sequence: string;
  let single: string;
  let realCard: string;
  const FIXTURES = path.join(__dirname, "..", "tests", "fixtures", "video-quality");
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-hard-gate-"));
    /** PRIMARY_GROUND centre rgb(43,52,66) and edge rgb(26,32,41) — Graphics.tsx */
    ground = mp4("ground.mp4", ["-f", "lavfi", "-i", "color=c=0x2b3442:s=320x180:d=6:r=25"]);
    groundEdge = mp4("ground-edge.mp4", ["-f", "lavfi", "-i", "color=c=0x1a2029:s=320x180:d=6:r=25"]);
    content = mp4("content.mp4", ["-f", "lavfi", "-i", "testsrc=s=320x180:d=6:r=25"]);
    /** a 4:3 picture padded to 16:9 with the pipeline's letterbox colour 0x2a2a2a (SCALE_PAD_VF) */
    letterbox = mp4("letterbox.mp4", ["-f", "lavfi", "-i", "testsrc=s=240x180:d=6:r=25", "-vf", "pad=320:180:(ow-iw)/2:(oh-ih)/2:color=0x2a2a2a"]);
    /** content 0–2 s, ONE frame of the ground (0.04 s at 25 fps), content 2.04–4.04 s */
    single = mp4("single.mp4", [
      "-f", "lavfi", "-i", "testsrc=s=320x180:d=2:r=25",
      "-f", "lavfi", "-i", "color=c=0x2b3442:s=320x180:d=0.04:r=25",
      "-f", "lavfi", "-i", "testsrc=s=320x180:d=2:r=25",
      "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0,format=yuv420p[v]", "-map", "[v]",
    ]);
    /** content 0–2 s, a REAL chapter card (rendered by the project's Remotion bundle, see the fixture) 2–5 s, content 5–7 s */
    realCard = mp4("real-card.mp4", [
      "-f", "lavfi", "-i", "testsrc=s=320x180:d=2:r=25",
      "-loop", "1", "-framerate", "25", "-t", "3", "-i", path.join(FIXTURES, "primary-card-wide-title.png"),
      "-f", "lavfi", "-i", "testsrc=s=320x180:d=2:r=25",
      "-filter_complex", "[1]format=yuv420p,setsar=1[c];[0][c][2]concat=n=3:v=1:a=0,format=yuv420p[v]", "-map", "[v]",
    ]);
    /** content 0–2 s, the ground 2–5 s, content 5–7 s */
    sequence = mp4("sequence.mp4", [
      "-f", "lavfi", "-i", "testsrc=s=320x180:d=2:r=25",
      "-f", "lavfi", "-i", "color=c=0x2b3442:s=320x180:d=3:r=25",
      "-f", "lavfi", "-i", "testsrc=s=320x180:d=2:r=25",
      "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0,format=yuv420p[v]", "-map", "[v]",
    ]);
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("the palette: the ground's centre and edge colours match; letterbox grey, the light mat, black and white do not", () => {
    expect(isPrimaryGroundPixel(43, 52, 66)).toBe(true);
    expect(isPrimaryGroundPixel(30, 37, 47)).toBe(true);
    expect(isPrimaryGroundPixel(26, 32, 41)).toBe(true);
    expect(isPrimaryGroundPixel(0x2a, 0x2a, 0x2a)).toBe(false);
    expect(isPrimaryGroundPixel(0xcf, 0xcf, 0xcf)).toBe(false);
    expect(isPrimaryGroundPixel(0, 0, 0)).toBe(false);
    expect(isPrimaryGroundPixel(255, 255, 255)).toBe(false);
    expect(isPrimaryGroundPixel(10, 26, 58)).toBe(false);
    const frame = Buffer.alloc(32 * 18 * 3);
    for (let i = 0; i < 32 * 18; i++) frame.set([43, 52, 66], i * 3);
    expect(primaryGroundFraction(frame)).toBe(1);
    expect(primaryGroundFraction(Buffer.alloc(0))).toBe(0);
    expect(PLACEHOLDER_FRAME_FRACTION).toBe(0.6);
    expect(PLACEHOLDER_BAND_FRACTION).toBe(0.95);
    expect(PLACEHOLDER_BAND_MAX_STDDEV).toBe(8);
    expect([PLACEHOLDER_SCAN_WIDTH, PLACEHOLDER_SCAN_HEIGHT]).toEqual([48, 27]);
  });

  const toRgb = (args: string[]) =>
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args, "-frames:v", "1", "-vf", `scale=${PLACEHOLDER_SCAN_WIDTH}:${PLACEHOLDER_SCAN_HEIGHT}:flags=area,format=rgb24`, "-f", "rawvideo", "pipe:1"]);

  it("the frame rule, on cards the project's own Remotion bundle rendered: a short title and a title wide enough to reach the frame's sides are the ground; dark pictures of a similar colour are not", () => {
    for (const f of ["primary-card-short-title.png", "primary-card-wide-title.png"]) {
      const r = readGroundFrame(toRgb(["-i", path.join(FIXTURES, f)]));
      expect(r.ground, f).toBe(true);
      expect(r.bandFraction, f).toBeGreaterThanOrEqual(PLACEHOLDER_BAND_FRACTION);
      expect(Math.max(...r.bandStddev), f).toBeLessThanOrEqual(PLACEHOLDER_BAND_MAX_STDDEV);
      /** the wide title measured 0.818 against the earlier 0.8 whole-frame line: the bands, not that line, carry the verdict */
      expect(r.frameFraction, f).toBeGreaterThan(0.8);
    }
    /** dark PICTURES of the ground's own colour: a light or an object near the edge breaks the bands */
    const moon = readGroundFrame(toRgb(["-f", "lavfi", "-i", "color=c=0x2b3442:s=1920x1080:d=1,drawbox=x=200:y=30:w=500:h=110:color=white:t=fill"]));
    expect(moon.frameFraction).toBeGreaterThan(0.9);
    expect(moon.bandFraction).toBeLessThan(PLACEHOLDER_BAND_FRACTION);
    expect(moon.ground).toBe(false);
    const light = readGroundFrame(toRgb(["-f", "lavfi", "-i", "color=c=0x2b3442:s=1920x1080:d=1,drawbox=x=200:y=30:w=200:h=60:color=white:t=fill"]));
    expect(light.frameFraction).toBeGreaterThan(0.9);
    expect(Math.max(...light.bandStddev)).toBeGreaterThan(PLACEHOLDER_BAND_MAX_STDDEV);
    expect(light.ground).toBe(false);
    /** a vertical sky gradient in the ground's two colours: the bands are not flat */
    expect(readGroundFrame(toRgb(["-f", "lavfi", "-i", "gradients=s=1920x1080:c0=0x1a2029:c1=0x2b3442:nb_colors=2:d=1:x0=0:y0=0:x1=0:y1=1080"])).ground).toBe(false);
    /** a tinted test pattern, a plain test pattern, the letterbox grey, black, white */
    expect(readGroundFrame(toRgb(["-f", "lavfi", "-i", "testsrc2=s=1920x1080:d=1,colorchannelmixer=rr=0.15:gg=0.2:bb=0.25"])).ground).toBe(false);
    expect(readGroundFrame(toRgb(["-f", "lavfi", "-i", "testsrc2=s=1920x1080:d=1"])).ground).toBe(false);
    expect(readGroundFrame(toRgb(["-f", "lavfi", "-i", "color=c=0x2a2a2a:s=320x180:d=1"])).ground).toBe(false);
    expect(readGroundFrame(toRgb(["-f", "lavfi", "-i", "color=c=black:s=320x180:d=1"])).ground).toBe(false);
    expect(readGroundFrame(toRgb(["-f", "lavfi", "-i", "color=c=white:s=320x180:d=1"])).ground).toBe(false);
    /** low-resolution blue-grey noise does not average to the slate: picture */
    expect(readGroundFrame(toRgb(["-f", "lavfi", "-i", "color=c=0x2b3442:s=320x180:d=1,noise=alls=40:allf=t+u:all_seed=7"])).ground).toBe(false);
    /**
     * The one thing the rule does NOT tell apart, by design: a 1080p frame of uniform blue-grey noise
     * averages, across both bands, to the slate itself — on screen it IS a blue-grey slate. Documented,
     * not hidden: this is the only kind of "picture" the scan would refuse.
     */
    expect(readGroundFrame(toRgb(["-f", "lavfi", "-i", "color=c=0x2b3442:s=1920x1080:d=1,noise=alls=40:allf=t+u:all_seed=1"])).ground).toBe(true);
  }, 60_000);

  it("1. a synthetic MP4 of the PRIMARY_GROUND colour — centre and edge shades: every frame read, every frame the ground, the seconds the frames' own", async () => {
    for (const file of [ground, groundEdge]) {
      const scan = await scanForPlaceholderGround(file, [{ startSec: 0, endSec: 6, id: "gfx1" }], 6);
      expect(scan.method).toBe("all_frames");
      expect(scan.framesSampled).toBe(150);
      expect(scan.placeholderFrames).toBe(150);
      expect(scan.placeholderSec).toBe(6);
      expect(scan.confirmedPlaceholderSec).toBe(6);
      expect(scan.indicatedPlaceholderSec).toBe(6);
      expect(scan.decodedSec).toBe(6);
      expect(scan.intervals[0]).toMatchObject({ status: "placeholder", frames: 150, hits: 150 });
      expect(scan.complete).toBe(true);
    }
  }, 60_000);

  it("2. an ordinary picture is not a placeholder: zero frames, zero seconds, the planned interval clear", async () => {
    const scan = await scanForPlaceholderGround(content, [{ startSec: 0, endSec: 6, id: "gfx1" }], 6);
    expect(scan.framesSampled).toBe(150);
    expect(scan.intervals[0]).toMatchObject({ status: "clear", frames: 150, hits: 0 });
    expect(scan.placeholderFrames).toBe(0);
    expect(scan.placeholderSec).toBe(0);
    expect(scan.unplannedPlaceholderFrames).toBe(0);
    expect(scan.complete).toBe(true);
  }, 60_000);

  it("3. letterbox padding in the pipeline's grey (0x2a2a2a) around a picture is not a chapter card", async () => {
    const scan = await scanForPlaceholderGround(letterbox, [{ startSec: 0, endSec: 6, id: "gfx1" }], 6);
    expect(scan.intervals[0]!.status).toBe("clear");
    expect(scan.placeholderFrames).toBe(0);
  }, 60_000);

  it("4. a card in the middle of a film: all 75 of its frames, exactly 3.00 s, none of the content around it — planned or not; a planned window over content AND card is partial", async () => {
    const scan = await scanForPlaceholderGround(sequence, [{ startSec: 2, endSec: 5, id: "gfx1" }], 7);
    expect(scan).toMatchObject({ framesSampled: 175, placeholderFrames: 75, placeholderSec: 3, unplannedPlaceholderFrames: 0, plannedCardSec: 3, complete: true, decodedSec: 7 });
    expect(scan.intervals[0]).toMatchObject({ status: "placeholder", frames: 75, hits: 75 });
    /** the SAME file with the card NOT planned anywhere: the same frames, now all unplanned */
    const unplanned = await scanForPlaceholderGround(sequence, [], 7);
    expect(unplanned).toMatchObject({ placeholderFrames: 75, placeholderSec: 3, unplannedPlaceholderFrames: 75, plannedCardSec: 0 });
    /** a planned interval that is content is 'clear'; one that covers content AND the card is 'partial' — the seconds do not change */
    const partial = await scanForPlaceholderGround(sequence, [{ startSec: 0, endSec: 5, id: "gfx1" }, { startSec: 5.2, endSec: 7, id: "b" }], 7);
    expect(partial.intervals.map((i) => i.status)).toEqual(["partial", "clear"]);
    expect(partial.intervals[0]).toMatchObject({ frames: 125, hits: 75 });
    expect(partial.placeholderSec).toBe(3);
    expect(partial.plannedCardSec).toBe(6.8);
  }, 90_000);

  it("5. ONE frame of the ground inside a film is found and counts its own 0.04 s — a sample would have missed it", async () => {
    const scan = await scanForPlaceholderGround(single, [], 4.04);
    expect(scan.framesSampled).toBe(101);
    expect(scan.placeholderFrames).toBe(1);
    expect(scan.placeholderSec).toBe(0.04);
    expect(scan.unplannedPlaceholderFrames).toBe(1);
    expect(scan.complete).toBe(true);
    /** and the gate refuses it on that one frame */
    const v = hardVisualRuleFailures({ placeholderCheck: scan });
    expect(v.map((f) => f.code)).toEqual(["PLACEHOLDER_IN_FILE"]);
    expect(v[0]!.detail).toContain("1 of 101 frame(s)");
    expect(v[0]!.detail).toContain("0.04s where exactly 0.00s is allowed");
  }, 60_000);

  it("6. a REAL chapter card, as Remotion drew it, encoded into the film: all 75 frames, 3.00 s", async () => {
    const scan = await scanForPlaceholderGround(realCard, [{ startSec: 2, endSec: 5, id: "gfx1" }], 7);
    expect(scan).toMatchObject({ framesSampled: 175, placeholderFrames: 75, placeholderSec: 3, complete: true });
    expect(scan.intervals[0]).toMatchObject({ status: "placeholder", frames: 75, hits: 75 });
  }, 60_000);

  it("7. a planned CONTENT graphic's ground is its own — reported, not placeholder; frames outside its window still are", async () => {
    const chart = await scanForPlaceholderGround(sequence, [{ startSec: 2, endSec: 5, id: "chart", kind: "content_graphic" }], 7);
    expect(chart).toMatchObject({ placeholderFrames: 0, placeholderSec: 0, contentGraphicGroundFrames: 75, contentGraphicGroundSec: 3, complete: true });
    expect(hardVisualRuleFailures({ placeholderCheck: chart })).toEqual([]);
    /** the window covers only the first second of the ground: two seconds of it are placeholder */
    const short = await scanForPlaceholderGround(sequence, [{ startSec: 2, endSec: 3, id: "chart", kind: "content_graphic" }], 7);
    expect(short).toMatchObject({ placeholderFrames: 50, placeholderSec: 2, contentGraphicGroundFrames: 25, contentGraphicGroundSec: 1, unplannedPlaceholderFrames: 50 });
    expect(hardVisualRuleFailures({ placeholderCheck: short }).map((f) => f.code)).toEqual(["PLACEHOLDER_IN_FILE"]);
  }, 60_000);

  it("8. a scan that could not read the file is not complete — missing, truncated, a planned interval with no frame — and the gate will not pass it", async () => {
    const missing = await scanForPlaceholderGround(path.join(dir, "nope.mp4"), [{ startSec: 0, endSec: 2, id: "x" }], 6);
    expect(missing.complete).toBe(false);
    expect(missing.framesSampled).toBe(0);
    expect(missing.detail).toContain("decode failed");
    expect(hardVisualRuleFailures({ placeholderCheck: missing }).map((f) => f.code)).toEqual(["PLACEHOLDER_CHECK_INCOMPLETE"]);
    /** a file cut off half-way: whatever ffmpeg can decode, it is not the whole 7 s */
    const whole = fs.readFileSync(sequence);
    const truncPath = path.join(dir, "trunc.mp4");
    fs.writeFileSync(truncPath, whole.subarray(0, Math.floor(whole.length * 0.6)));
    const trunc = await scanForPlaceholderGround(truncPath, [], 7);
    expect(trunc.complete).toBe(false);
    /** a planned interval past the end of the file holds no frame */
    const late = await scanForPlaceholderGround(content, [{ startSec: 10, endSec: 12, id: "late" }], 6);
    expect(late.intervals[0]!.status).toBe("unsampled");
    expect(late.complete).toBe(false);
    expect(late.detail).toContain("late: no frame inside the planned interval");
  }, 60_000);

  it("9. the existing black / freeze / silence checks still run, and the scan rides along in the result", async () => {
    const r = await spotCheckFinalVideo(content, { placeholderIntervals: [] });
    expect(r.framesChecked).toBe(4);
    expect(typeof r.blackSegments).toBe("number");
    expect(typeof r.freezeSegments).toBe("number");
    expect(typeof r.silentSegments).toBe("number");
    expect(r.placeholder).toBeDefined();
    expect(r.placeholder!.method).toBe("all_frames");
    expect(r.placeholder!.placeholderFrames).toBe(0);
    expect(r.placeholder!.framesSampled).toBe(150);
    expect(r.ok).toBe(true);
    const g = await spotCheckFinalVideo(sequence, { placeholderIntervals: [{ startSec: 2, endSec: 5, id: "gfx1" }] });
    expect(g.placeholder!.placeholderSec).toBe(3);
    expect(g.warnings.some((w) => w.startsWith("placeholder: 75/175 frame(s) (3.00s)"))).toBe(true);
    /** the spot check reports; the DeliveryGate decides — `ok` is not what blocks */
    expect(g.ok).toBe(true);
  }, 120_000);
});

/* ═══════════════ C — the DeliveryGate and the report ═══════════════ */

describe("the DeliveryGate decides (Eis A + B)", () => {
  const base = { videoId: 1, route: "cinematic_timeline" as const, timelineExists: true, clips: [], delivered: null, assetsOnly: true };
  const clean: PlaceholderCheckFacts = { method: "all_frames", complete: true, framesSampled: 150, placeholderFrames: 0, placeholderSec: 0, plannedCardSec: 0, confirmedPlaceholderSec: 0, indicatedPlaceholderSec: 0, unplannedPlaceholderFrames: 0, contentGraphicGroundSec: 0, decodedSec: 6 };
  const covered = () => sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4)], clips: [clip("a", { start: 0, end: 4 })] }));

  it("1. a render with a placeholder is refused: the planned card, and the frames the scan saw", () => {
    const t = timeline({ sentences: [sentence(0, 0, 0, 4.42)], clips: [{ ...clip("g_graphic1", { start: 0, end: 4.42 }), transform: { opacity: 0 } }], graphics: [graphic("gfx1", "chapter_card", 0, 4.42)] });
    const scan: PlaceholderCheckFacts = { ...clean, framesSampled: 150, placeholderFrames: 110, placeholderSec: 4.42, plannedCardSec: 4.42, confirmedPlaceholderSec: 4.42, indicatedPlaceholderSec: 4.42 };
    const v = deliveryGate({ ...base, sentenceCoverage: sentenceCoverage(t), placeholderCheck: scan });
    expect(v.allow).toBe(false);
    const codes = !v.allow ? v.failures.map((f) => f.code) : [];
    expect(codes).toEqual(expect.arrayContaining(["SENTENCE_NOT_COVERED", "CHAPTER_CARD_PLACEHOLDER", "PLACEHOLDER_IN_FILE"]));
    expect(v.lines.some((l) => l.includes("COVERAGE sentences=1 covered=0 partial=0 uncovered=1 unknown=0"))).toBe(true);
    expect(v.lines.some((l) => l.includes("PLACEHOLDER method=all_frames complete=yes frames=150 placeholderFrames=110 placeholderSec=4.42"))).toBe(true);
    expect(!v.allow && v.failures.find((f) => f.code === "PLACEHOLDER_IN_FILE")!.detail).toBe(
      "110 of 150 frame(s) show the blue-grey chapter-card ground: 4.42s where exactly 0.00s is allowed (planned cards 4.42s)"
    );
    /** a placeholder the scan saw where nothing was planned blocks on its own */
    const unplanned = deliveryGate({ ...base, sentenceCoverage: covered(), placeholderCheck: { ...clean, placeholderFrames: 1, unplannedPlaceholderFrames: 1 } });
    expect(unplanned.allow).toBe(false);
    expect(!unplanned.allow && unplanned.failures.map((f) => f.code)).toEqual(["PLACEHOLDER_IN_FILE"]);
  });

  it("2. a render with an uncovered or partially covered sentence is refused, naming the sentence and why", () => {
    const partial = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 6, "measured", "The Detroit Auto Show.")], clips: [clip("a", { start: 0, end: 2.5 })] }));
    const v = deliveryGate({ ...base, sentenceCoverage: partial, placeholderCheck: clean });
    expect(v.allow).toBe(false);
    expect(!v.allow && v.failures).toEqual([{ code: "SENTENCE_NOT_COVERED", detail: 's0b0 "The Detroit Auto Show.": 2.50s of 6.00s covered — no picture 3.50s' }]);
    const stretched = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 6.08)], clips: [clip("a", { start: 0, end: 6.08, sourceSec: 3.56 })] }));
    const w = deliveryGate({ ...base, sentenceCoverage: stretched, placeholderCheck: clean });
    expect(!w.allow && w.failures[0]!.detail).toContain("clip held past its source 2.52s");
  });

  it("3. unknown coverage is never passed silently: no measurement, no sentences, estimated timing, an unverified clip, or a scan that did not run / was incomplete", () => {
    const codes = (v: ReturnType<typeof deliveryGate>) => (v.allow ? [] : v.failures.map((f) => f.code));
    expect(codes(deliveryGate({ ...base, sentenceCoverage: null, placeholderCheck: clean }))).toEqual(["SENTENCE_COVERAGE_UNPROVEN"]);
    expect(codes(deliveryGate({ ...base, sentenceCoverage: sentenceCoverage(timeline({})), placeholderCheck: clean }))).toEqual(["SENTENCE_COVERAGE_UNPROVEN"]);
    const estimated = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4, "estimated")], clips: [clip("a", { start: 0, end: 4 })] }));
    expect(codes(deliveryGate({ ...base, sentenceCoverage: estimated, placeholderCheck: clean }))).toEqual(["SENTENCE_COVERAGE_UNPROVEN"]);
    const unverified = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4)], clips: [clip("a", { start: 0, end: 4, approved: false })] }));
    expect(codes(deliveryGate({ ...base, sentenceCoverage: unverified, placeholderCheck: clean }))).toEqual(["SENTENCE_COVERAGE_UNPROVEN"]);
    expect(codes(deliveryGate({ ...base, sentenceCoverage: covered(), placeholderCheck: null }))).toEqual(["PLACEHOLDER_CHECK_INCOMPLETE"]);
    expect(codes(deliveryGate({ ...base, sentenceCoverage: covered(), placeholderCheck: { ...clean, complete: false, detail: "decoded 3.00s of 7.00s" } }))).toEqual(["PLACEHOLDER_CHECK_INCOMPLETE"]);
    /** a scan that saw seconds but no frame count, or frames but no seconds, blocks either way */
    expect(codes(deliveryGate({ ...base, sentenceCoverage: covered(), placeholderCheck: { ...clean, placeholderSec: 0.04 } }))).toEqual(["PLACEHOLDER_IN_FILE"]);
    expect(codes(deliveryGate({ ...base, sentenceCoverage: covered(), placeholderCheck: { ...clean, placeholderFrames: 1 } }))).toEqual(["PLACEHOLDER_IN_FILE"]);
    /** the pure rule function answers the same */
    expect(hardVisualRuleFailures({ sentenceCoverage: null, placeholderCheck: null }).map((f) => f.code)).toEqual(["SENTENCE_COVERAGE_UNPROVEN", "PLACEHOLDER_CHECK_INCOMPLETE"]);
  });

  it("4. fully approved coverage on measured timing and a clean, complete scan passes — and the older rules still run beside it", () => {
    const v = deliveryGate({ ...base, sentenceCoverage: covered(), placeholderCheck: clean });
    expect(v.allow).toBe(true);
    expect(v.lines[0]).toContain("DELIVERY_GATE_PASS");
    expect(v.lines[1]).toContain("COVERAGE sentences=1");
    expect(v.lines.some((l) => l.includes("COVERAGE sentences=1 covered=1") && l.includes("proven=yes"))).toBe(true);
    /** a content graphic covering the sentence passes too */
    const graphicOnly = sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 5)], graphics: [graphic("g", "bar_chart", 0, 5)] }));
    expect(deliveryGate({ ...base, sentenceCoverage: graphicOnly, placeholderCheck: clean }).allow).toBe(true);
    /** callers that do not ask (older rules' tests) are unchanged */
    expect(deliveryGate({ ...base }).allow).toBe(true);
    /** the existing rules keep blocking */
    const blank = deliveryGate({ ...base, sentenceCoverage: covered(), placeholderCheck: clean, blankPicture: "all four frames black" });
    expect(!blank.allow && blank.failures[0]!.code).toBe("FINAL_PICTURE_IS_BLACK");
  });

  it("5. the analyser reads the new lines: per-sentence coverage, the total, the contentCheck placeholder fields and the gate's failures", () => {
    const a = analyseLogLines([
      "15:00:00.000 i [RenderLock] video=5 render=rG ACQUIRED",
      '15:00:01.000 i [SentenceCoverage] video=5 s0b0 spoken=0.00-4.42s timing=estimated status=unknown covered=0.00s kinds=chapter_card+none approvedFootage=0.00s graphic=0.00s card=4.42s unverified=0.00s stretched=0.00s empty=0.00s reason="chapter card placeholder 4.42s; spoken window is the planner\'s estimate, not measured narration"',
      "15:00:01.000 i [SentenceCoverage] video=5 s0b1 spoken=4.42-8.84s timing=measured status=covered covered=4.42s kinds=approved_footage approvedFootage=4.42s graphic=0.00s card=0.00s unverified=0.00s stretched=0.00s empty=0.00s",
      '15:00:01.001 i [SentenceCoverage] video=5 TOTAL sentences=2 covered=1 partial=0 uncovered=0 unknown=1 stretchedClips=0 plannedCardSec=4.42 proven=no problems="spoken windows are estimated (no narration alignment): coverage in time cannot be proven"',
      "15:00:02.000 i [RenderJob] video=5 job=9 contentCheck ok=true black=0 freeze=0 silent=0 frames=4 placeholderFrames=3 placeholderFramesChecked=175 placeholderSec=4.42 placeholderMethod=all_frames plannedCardSec=4.42 blueGrayConfirmedSec=4.42 blueGrayIndicatedSec=4.42 contentGraphicGroundSec=0.00 placeholderDetectionComplete=true",
      "15:00:03.000 e [DeliveryGate] DELIVERY_GATE_FAIL video=5 clips=3 fromArchive=3 route=cinematic_timeline timeline=present checks=assets+file failures=3",
      "15:00:03.000 e [DeliveryGate]   SENTENCE_COVERAGE_UNPROVEN — s0b0: chapter card placeholder 4.42s",
      "15:00:03.000 e [DeliveryGate]   CHAPTER_CARD_PLACEHOLDER — 1 chapter card(s) planned as a sentence's picture, 4.42s of blue-grey ground (0.00–4.42 s0b0)",
      "15:00:03.000 e [DeliveryGate]   PLACEHOLDER_IN_FILE — 3 of 175 frame(s) show the blue-grey chapter-card ground: 4.42s where exactly 0.00s is allowed (planned cards 4.42s)",
      "15:00:03.000 e [DeliveryGate]   COVERAGE sentences=2 covered=1 partial=0 uncovered=0 unknown=1 stretchedClips=0 plannedCardSec=4.42 proven=no",
      "15:00:04.000 i [RenderLock] video=5 render=rG RELEASED",
    ]);
    const r = a.reports[0]!;
    expect(r.hardGate).toMatchObject({
      sentences: 2,
      fullyCovered: 1,
      uncovered: 0,
      coverageUnknown: 1,
      plannedPlaceholderSeconds: 4.42,
      mp4PlaceholderConfirmedSeconds: 4.42,
      mp4PlaceholderIndicatedSeconds: 4.42,
      mp4PlaceholderFrames: 3,
      placeholderDetectionComplete: true,
      coverageProven: false,
      gateDecision: "fail",
    });
    expect(r.hardGate.gateFailures).toHaveLength(3);
    expect(r.hardGate.gateFailures[1]).toContain("CHAPTER_CARD_PLACEHOLDER: 1 chapter card(s)");
    expect(r.hardGate.perSentence).toEqual([
      { sentence: "s0b0", status: "unknown", timing: "estimated", kinds: ["chapter_card", "none"], coveredSec: 0, cardSec: 4.42, reason: "chapter card placeholder 4.42s; spoken window is the planner's estimate, not measured narration" },
      { sentence: "s0b1", status: "covered", timing: "measured", kinds: ["approved_footage"], coveredSec: 4.42, cardSec: 0, reason: null },
    ]);
    expect(r.coverage.deliveredFileCheck).toEqual({ ok: true, black: 0, freeze: 0, silent: 0, frames: 4 });
    /** 645 was rendered before any of this existed: everything null, decision pass (the old gate) */
    const fixture = fs.readFileSync(path.join(__dirname, "..", "tests", "fixtures", "video-quality", "render-645.worker.log"), "utf8").split("\n");
    const old = analyseLogLines(fixture).reports.find((x) => x.identification.videoId === 645)!;
    expect(old.hardGate.sentences).toBeNull();
    expect(old.hardGate.placeholderDetectionComplete).toBeNull();
    expect(old.hardGate.gateDecision).toBe("pass");
  });

  it("6. wiring, pinned: the render worker measures coverage on the timeline, reads every frame of the file against the planned cards and content graphics, hands both to the gate and never passes undefined", () => {
    const worker = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
    expect(worker).toContain("const coverage = sentenceCoverage(timeline);");
    expect(worker).toContain('...chapterCardIntervals(timeline).map((c) => ({ startSec: c.startSec, endSec: c.endSec, id: c.graphicId, kind: "chapter_card" as const })),');
    expect(worker).toContain('...contentGraphicIntervals(timeline).map((c) => ({ startSec: c.startSec, endSec: c.endSec, id: c.graphicId, kind: "content_graphic" as const })),');
    expect(worker).toContain("placeholderSec=${p.placeholderSec.toFixed(2)} placeholderMethod=${p.method}");
    expect(worker).toContain("spotCheck = await spotCheckFinalVideo(outputPath, { placeholderIntervals: cardIntervals }).catch(() => null);");
    expect(worker).toContain("sentenceCoverage: coverage,");
    expect(worker).toContain("placeholderCheck: spotCheck?.placeholder ?? null,");
    expect(worker).toContain("return await fail(RENDER_ERROR.RENDER_FAILED, formatDeliveryBlock(gate, job.videoId));");
    const gate = fs.readFileSync(path.join(__dirname, "deliveryGate.ts"), "utf8");
    expect(gate).toContain("for (const f of hardVisualRuleFailures(input)) failures.push(f);");
    /** the sentences and the approval mark travel on the timeline from the pipeline */
    const inputs = fs.readFileSync(path.join(__dirname, "cinematicPipelineInputs.ts"), "utf8");
    expect(inputs).toContain('timingBasis: measured && beat.voiceEndSec != null ? "measured" : "estimated",');
    const vp = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(vp).toContain('contentApproval: pictureApprovedForBeat(visualDedup, scene.index, beatIndex, clipContentKey(clipPath)) ? ("judge_fit" as const) : ("unverified" as const),');
    expect(fs.readFileSync(path.join(__dirname, "cinematicPipeline.ts"), "utf8")).toContain("if (params.sentences?.length) timeline.sentences = params.sentences.map((s) => ({ ...s }));");
  });
});
