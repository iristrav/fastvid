/**
 * FULLSCREEN PRIMARY — a graphic that IS a sentence's picture fills the frame on its own ground.
 *
 * One real render through the production route (adapter → EDL → `placePrimaryGraphics` → timeline
 * → `timelineToRemotionProps` → Remotion PNG/RGBA → ffmpeg), seven sentences of 5 s:
 *
 *   0 map · 1 counter · 2 ring · 3 line chart · 4 chapter card   (no clip: the graphic is the picture)
 *   5 a red shot with a stat in its sentence                      (an overlay ON footage, as before)
 *   6 a black shot                                                (real black, for the spot check)
 *
 * Measured in the finished MP4: where the ink is, how much of the frame is ground, the mean luma
 * the post-render spot check would read. Plus the two DeliveryGate rules the graphics touch.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildCinematicSceneInputs, type ProductionBeat, type SceneFacts } from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import { productionGraphicsOverlay } from "./graphicsOverlayDeps";
import { renderTimeline, type RenderedTimeline } from "./timelineRenderer";
import { resolveRemotionBrowser } from "./remotionRenderer";
import { resolveFFmpegBin } from "./ffmpegBinary";
import { spotCheckFinalVideo } from "./postRenderSpotCheck";
import {
  blankPictureFinding,
  finalTimelineFootageRefusal,
  primaryGraphicSeconds,
  type FinalTimelineClip,
} from "./deliveryGate";
import { graphicsTrack, videoTrack, type ProjectTimeline } from "./projectTimeline";
import { ringLabelRestatesFigure } from "./remotion/components/Charts";
import {
  beatNamedEntitiesByKind,
  extractActionCue,
  extractPersonNamesFromText,
  extractVisualPlacePhrase,
} from "./videoPipeline";

const run = promisify(execFile);
const W = 1920;
const H = 1080;
const FPS = 12;
const S = 5;
const TEXTS = [
  "Allied troops landed in Normandy in June 1944.",
  "By 1945, more than 60 million people had died in the war.",
  "Inflation reached 10% in 2022.",
  "Output rose from 1.2 billion in 2015 to 2.4 billion in 2019 and 3.1 billion in 2023.",
  "Scientists cut a single gene inside a living cell.",
  "Prices rose by 40% that winter.",
  "Families felt it in every shop.",
];
const NO_PICTURE = new Set([0, 1, 2, 3, 4]);
const EXTRACTORS = {
  people: (t: string) => extractPersonNamesFromText(t),
  place: (t: string) => extractVisualPlacePhrase(t),
  action: (t: string) => extractActionCue(t),
  namedEntities: (t: string) => beatNamedEntitiesByKind(t),
};

function plannedTimeline(red: string, black: string): ProjectTimeline {
  const beats: ProductionBeat[] = TEXTS.map((text, index) => ({
    index, text, searchQuery: "", powerWord: "", keywords: [], holdSec: S, visualDescription: "",
    voiceStartSec: index * S, voiceEndSec: index * S + S,
  }));
  beats[4] = { ...beats[4]!, powerWord: "gene editing laboratory", searchQuery: "gene editing laboratory" };
  const facts: SceneFacts = {
    scene: { index: 0, text: TEXTS.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: TEXTS.length * S },
    beats,
    clips: beats.map((_, i) =>
      NO_PICTURE.has(i)
        ? null
        : {
            facts: { localPath: i === 5 ? red : black, durationSec: 10, widthPx: W, heightPx: H },
            adoption: { provider: "internet_archive", providerAssetId: `ia-${i}`, sourceUrl: `https://archive.invalid/${i}.mp4`, assetTitle: "shot", query: "shot" },
          }
    ) as SceneFacts["clips"],
  };
  const built = buildCinematicSceneInputs({ scenes: [facts], extractors: EXTRACTORS });
  const { timeline } = runCinematicPipeline({
    videoId: 1, scenes: built.scenes, includeSubtitles: false,
    ...(built.primaryGraphics?.length ? { primaryGraphics: built.primaryGraphics } : {}),
  });
  const t = timeline as ProjectTimeline;
  t.format = { ...t.format, fps: FPS };
  delete t.look;
  for (const track of t.tracks) {
    if (track.kind === "SFX" || track.kind === "AMBIENT" || track.kind === "MUSIC" || track.kind === "VOICE") track.clips = [];
    if (track.kind === "TEXT") track.texts = [];
    if (track.kind === "CAPTIONS") track.captions = [];
  }
  return t;
}

type Frame = { luma: number; groundShare: number; blackShare: number; redShare: number; box: { x0: number; y0: number; x1: number; y1: number } | null };

/**
 * One frame at 192×108: its mean luma (the spot check's own measure), the share of plain ground,
 * of black and of the red shot, and the box around everything that is neither ground nor black.
 */
async function frameAt(file: string, sec: number, dir: string): Promise<Frame> {
  const raw = path.join(dir, `f${sec.toFixed(2)}.raw`);
  await run(resolveFFmpegBin(), [
    "-y", "-hide_banner", "-loglevel", "error", "-ss", sec.toFixed(2), "-i", file,
    "-frames:v", "1", "-vf", "scale=192:108", "-f", "rawvideo", "-pix_fmt", "rgb24", raw,
  ]);
  const px = fs.readFileSync(raw);
  let luma = 0, ground = 0, black = 0, red = 0, n = 0;
  let x0 = 192, y0 = 108, x1 = -1, y1 = -1;
  for (let i = 0; i + 2 < px.length; i += 3) {
    const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
    const p = i / 3, x = p % 192, y = Math.floor(p / 192);
    n++;
    luma += 0.299 * r + 0.587 * g + 0.114 * b;
    const isBlack = r < 14 && g < 14 && b < 14;
    /** The slate: dark, blue-grey (#1a2029 … #2b3442). */
    const isGround = !isBlack && r >= 18 && r <= 48 && g >= 24 && g <= 58 && b >= 32 && b <= 72 && b > r;
    if (r > 180 && g < 70 && b < 70) red++;
    if (isBlack) black++;
    else if (isGround) ground++;
    else {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return {
    luma: luma / n, groundShare: ground / n, blackShare: black / n, redShare: red / n,
    box: x1 >= 0 ? { x0: x0 / 192, y0: y0 / 108, x1: x1 / 192, y1: y1 / 108 } : null,
  };
}

/* ═══════════════════════ the DeliveryGate rules, on plain clips ═══════════════════════ */

const footage = (id: string, start: number, end: number, asset = "a"): FinalTimelineClip => ({
  id, timelineStart: start, timelineEnd: end, source: { provider: "internet_archive", providerAssetId: asset },
});
const backdrop = (id: string, start: number, end: number): FinalTimelineClip => ({
  ...footage(id, start, end), transform: { opacity: 0 },
});
const primary = (graphicType: string, start: number, end: number) => ({ graphicType, start, end, data: { primaryVisual: true } });

describe("7/8 — ONE_FOOTAGE_FILLS_FILM is taken of the whole film, graphics that explain included", () => {
  it("7 — one 16 s piece of footage beside 40 s of primary graphics is no longer '100% one footage'", () => {
    const clips = [footage("shot", 0, 16), backdrop("shot_graphic1", 16, 36), backdrop("shot_graphic2", 36, 56)];
    const graphics = [primary("map_point", 16, 36), primary("counter", 36, 56)];
    expect(finalTimelineFootageRefusal(clips)).toMatch(/fills 100%/);
    expect(primaryGraphicSeconds(graphics)).toBe(40);
    expect(finalTimelineFootageRefusal(clips, undefined, new Map(), primaryGraphicSeconds(graphics))).toBeNull();
  });

  it("8 — one shot beside drawn chapter cards only is still one shot: refused", () => {
    const clips = [footage("shot", 0, 16), backdrop("shot_graphic1", 16, 36), backdrop("shot_graphic2", 36, 56)];
    const cards = [primary("chapter_card", 16, 36), primary("chapter_card", 36, 56)];
    expect(primaryGraphicSeconds(cards)).toBe(0);
    expect(finalTimelineFootageRefusal(clips, undefined, new Map(), primaryGraphicSeconds(cards))).toMatch(/fills 100%/);
  });

  it("8 — real footage repeated through most of the film stays refused, graphics or not", () => {
    const clips = [footage("shot_p1", 0, 30), footage("shot_p2", 30, 60), backdrop("shot_graphic1", 60, 70)];
    const refusal = finalTimelineFootageRefusal(clips, undefined, new Map(), primaryGraphicSeconds([primary("map_point", 60, 70)]));
    expect(refusal).toMatch(/fills 86%/);
    expect(refusal).toMatch(/10\.0s of primary graphics counted/);
  });

  it("an overlay graphic on footage, or a switched-off one, is no primary picture", () => {
    expect(primaryGraphicSeconds([
      { graphicType: "counter", start: 0, end: 5, data: {} },
      { graphicType: "map_point", start: 5, end: 10, data: { primaryVisual: true }, disabled: true },
    ])).toBe(0);
  });

  it("both delivery checks (pipeline and render job) pass the film's primary graphics", () => {
    for (const file of ["videoPipeline.ts", "renderJobWorker.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(src, file).toMatch(/primaryGraphicSeconds\(graphicsTrack\((outcome\.)?timeline\)\)/);
    }
  });
});

describe("4 — the ring draws its figure once", () => {
  it("a label that only restates the figure is not drawn under it; one that says what it is still is", () => {
    expect(ringLabelRestatesFigure("10%", 10)).toBe(true);
    expect(ringLabelRestatesFigure("10 percent", 10)).toBe(true);
    expect(ringLabelRestatesFigure("3.5 %", 3.5)).toBe(true);
    expect(ringLabelRestatesFigure("Inflation 10%", 10)).toBe(false);
    expect(ringLabelRestatesFigure("12%", 10)).toBe(false);
  });
});

/* ═══════════════════════ one real render ═══════════════════════ */

const describeRender = resolveRemotionBrowser() ? describe : describe.skip;

describeRender("fullscreen primary graphics in a real MP4", () => {
  let dir = "";
  let out = "";
  let blackFilm = "";
  let timeline: ProjectTimeline;
  let result: RenderedTimeline;
  const frames = new Map<number, Frame>();

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "primary-gfx-"));
    const red = path.join(dir, "red.mp4");
    const black = path.join(dir, "black.mp4");
    for (const [file, colour] of [[red, "red"], [black, "black"]] as const) {
      await run(resolveFFmpegBin(), [
        "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${colour}:s=${W}x${H}:d=10:r=${FPS}`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
      ]);
    }
    timeline = plannedTimeline(red, black);
    out = path.join(dir, "film.mp4");
    result = await renderTimeline({
      timeline,
      workDir: path.join(dir, "work"),
      outputPath: out,
      resolveMedia: async (clip) => (clip.source.providerAssetId === "ia-5" ? red : black),
      graphicsOverlay: productionGraphicsOverlay({ workDir: path.join(dir, "work"), cacheDir: path.join(dir, "bundle") }),
    });
    for (let i = 0; i < TEXTS.length; i++) frames.set(i, await frameAt(out, i * S + 3, dir));
    /** Ten seconds of nothing but black, through the same encoder. */
    blackFilm = path.join(dir, "black_film.mp4");
    await run(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:d=12:r=${FPS}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", blackFilm,
    ]);
  }, 1_800_000);

  afterAll(() => {
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp dir is not a test failure */
    }
  });

  it("the plan marks the five sentences' graphics as primary, centred, from the sentence's first frame", () => {
    const graphics = graphicsTrack(timeline);
    const primaries = graphics.filter((g) => g.data?.primaryVisual === true);
    expect(primaries.map((g) => g.graphicType)).toEqual(["map_point", "counter", "progress", "line_chart", "chapter_card"]);
    for (const g of primaries) {
      expect(g.style?.position, g.graphicType).toBe("center");
      expect(g.data?.anchorWord, g.graphicType).toBeUndefined();
    }
    expect(result.graphicsRenderer).toBe("remotion");
    expect(result.graphicsOverlayInk?.status).toBe("ink");
  });

  it("1 — the map fills the frame on its ground, not a panel at the foot of black", () => {
    const f = frames.get(0)!;
    expect(f.blackShare, `black ${f.blackShare}`).toBeLessThan(0.02);
    expect(f.luma, `luma ${f.luma}`).toBeGreaterThan(22);
    expect(f.box!.x1 - f.box!.x0, "map width").toBeGreaterThan(0.8);
    expect(f.box!.y0, "map reaches the top of the frame").toBeLessThan(0.1);
    expect(f.box!.y1 - f.box!.y0, "map height").toBeGreaterThan(0.8);
  });

  it("2 — the counter is a figure in the middle of the frame, large", () => {
    const f = frames.get(1)!;
    expect(f.luma).toBeGreaterThan(22);
    expect(f.groundShare, `ground ${f.groundShare}`).toBeGreaterThan(0.7);
    const mid = (f.box!.y0 + f.box!.y1) / 2;
    expect(mid, "vertically centred").toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
    expect(f.box!.y1 - f.box!.y0, "figure height").toBeGreaterThan(0.1);
    expect(f.box!.x1 - f.box!.x0, "figure width").toBeGreaterThan(0.35);
  });

  it("3 — the ring is large and centred", () => {
    const f = frames.get(2)!;
    expect(f.luma).toBeGreaterThan(22);
    expect(f.box!.y1 - f.box!.y0, "ring height").toBeGreaterThan(0.45);
    expect(f.box!.y0, "ring starts in the upper half").toBeLessThan(0.3);
    expect(Math.abs((f.box!.x0 + f.box!.x1) / 2 - 0.5), "horizontally centred").toBeLessThan(0.05);
  });

  it("4 — the line chart fills the frame", () => {
    const f = frames.get(3)!;
    expect(f.luma).toBeGreaterThan(22);
    expect(f.box!.x1 - f.box!.x0).toBeGreaterThan(0.8);
    expect(f.box!.y1 - f.box!.y0).toBeGreaterThan(0.8);
  });

  it("5 — the chapter card still draws, centred, on the same ground", () => {
    const f = frames.get(4)!;
    expect(f.luma).toBeGreaterThan(22);
    expect(f.blackShare).toBeLessThan(0.02);
    const mid = (f.box!.y0 + f.box!.y1) / 2;
    expect(mid).toBeGreaterThan(0.35);
    expect(mid).toBeLessThan(0.65);
  });

  it("6 — a graphic over footage is unchanged: an overlay, the shot still the picture", () => {
    const overlay = graphicsTrack(timeline).find((g) => g.start >= 5 * S && g.start < 6 * S && g.data?.primaryVisual !== true);
    expect(overlay, "the sentence with a shot keeps its overlay graphic").toBeDefined();
    expect(overlay!.style?.position).not.toBe("center");
    const f = frames.get(5)!;
    expect(f.redShare, `red ${f.redShare}`).toBeGreaterThan(0.6);
    expect(f.groundShare, "no slate behind an overlay").toBeLessThan(0.01);
  });

  it("9 — a film whose spot-check samples land on primary graphics is not 'black'", async () => {
    const spot = await spotCheckFinalVideo(out);
    expect(spot.framesChecked).toBe(4);
    /** 12/38/62/88% of 35 s: the map, the ring, the chapter card — and the black shot at the end. */
    expect(spot.blackFrameCount, `black samples ${spot.blackFrameCount}`).toBe(1);
    expect(blankPictureFinding(spot)).toBeNull();
    for (const f of [frames.get(0)!, frames.get(2)!, frames.get(4)!]) expect(f.luma).toBeGreaterThan(22);
   }, 60_000);

  it("10 — a film that really is black is still refused", async () => {
    const spot = await spotCheckFinalVideo(blackFilm);
    expect(spot.blackFrameCount).toBe(spot.framesChecked);
    expect(blankPictureFinding(spot)).toMatch(/black/);
   }, 60_000);

  it("the delivery gate measures this film over its whole length, graphics included", () => {
    const sec = primaryGraphicSeconds(graphicsTrack(timeline));
    expect(sec, "map + counter + ring + chart, not the card").toBeCloseTo(4 * S, 0);
    expect(finalTimelineFootageRefusal(videoTrack(timeline), undefined, new Map(), sec)).toBeNull();
  });
});
