/**
 * GRAPHICS INTELLIGENCE FIX — a graphic that IS a sentence's picture, in a real MP4.
 *
 * The real route (adapter → EDL → translation with `placePrimaryGraphics`) plans three sentences:
 * the first and last have a clip, the middle one ("Inflation reached 10% in 2022.") has none. The
 * timeline is then rendered by the production renderer with the production Remotion overlay, the
 * clips' source being one flat red picture.
 *
 * So in the finished file "red" can only mean "the borrowed shot is visible", and anything that is
 * neither red nor black was drawn by the graphics layer. Under the middle sentence there must be no
 * red at all and real ink; under the other two the red picture is still there.
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
import { isGraphicBackdrop } from "./edlToTimeline";
import {
  beatNamedEntitiesByKind,
  extractActionCue,
  extractPersonNamesFromText,
  extractVisualPlacePhrase,
} from "./videoPipeline";
import type { ProjectTimeline } from "./projectTimeline";

const execFileAsync = promisify(execFile);
const W = 1920;
const H = 1080;
const FPS = 12;
const TEXTS = [
  "The economy grew slowly through the decade.",
  "Inflation reached 10% in 2022.",
  "Families felt it in every shop.",
];

const beat = (index: number, text: string): ProductionBeat => ({
  index, text, searchQuery: "", powerWord: "", keywords: [], holdSec: 4, visualDescription: "",
  voiceStartSec: index * 4, voiceEndSec: index * 4 + 4,
});

function plannedTimeline(): ProjectTimeline {
  const beats = TEXTS.map((t, i) => beat(i, t));
  const facts: SceneFacts = {
    scene: { index: 0, text: TEXTS.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 12 },
    beats,
    clips: beats.map((_, i) =>
      i === 1
        ? null
        : {
            facts: { localPath: `/tmp/gfxpic-${i}.mp4`, durationSec: 10, widthPx: W, heightPx: H },
            adoption: { provider: "internet_archive", providerAssetId: `ia-${i}`, sourceUrl: `https://archive.invalid/${i}.mp4`, assetTitle: "shot", query: "shot" },
          }
    ) as SceneFacts["clips"],
  };
  const built = buildCinematicSceneInputs({
    scenes: [facts],
    extractors: {
      people: (t) => extractPersonNamesFromText(t),
      place: (t) => extractVisualPlacePhrase(t),
      action: (t) => extractActionCue(t),
      namedEntities: (t) => beatNamedEntitiesByKind(t),
    },
  });
  const { timeline } = runCinematicPipeline({
    videoId: 1, scenes: built.scenes, includeSubtitles: false,
    ...(built.primaryGraphics?.length ? { primaryGraphics: built.primaryGraphics } : {}),
  });
  const t = timeline as ProjectTimeline;
  /** Picture and graphics only: the sound tracks have nothing to do with what this file proves. */
  for (const track of t.tracks) {
    if (track.kind === "SFX" || track.kind === "AMBIENT" || track.kind === "MUSIC" || track.kind === "VOICE") track.clips = [];
    if (track.kind === "TEXT") track.texts = [];
    if (track.kind === "CAPTIONS") track.captions = [];
  }
  return t;
}

/** Share of pixels that are red, near-black, and "other" (drawn), in a small frame at `sec`. */
async function frameAt(file: string, sec: number, raw: string): Promise<{ red: number; black: number; other: number }> {
  await execFileAsync(resolveFFmpegBin(), [
    "-y", "-hide_banner", "-loglevel", "error", "-ss", sec.toFixed(2), "-i", file,
    "-frames:v", "1", "-vf", "scale=192:108", "-f", "rawvideo", "-pix_fmt", "rgb24", raw,
  ]);
  const px = fs.readFileSync(raw);
  let red = 0, black = 0, other = 0;
  for (let i = 0; i + 2 < px.length; i += 3) {
    const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
    if (r > 180 && g < 70 && b < 70) red++;
    else if (r < 40 && g < 40 && b < 40) black++;
    else other++;
  }
  const n = red + black + other;
  return { red: red / n, black: black / n, other: other / n };
}

const describeRender = resolveRemotionBrowser() ? describe : describe.skip;

describeRender("a graphic as a sentence's picture reaches the delivered MP4", () => {
  let dir = "";
  let out = "";
  let timeline: ProjectTimeline;
  let result: RenderedTimeline;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gfx-as-picture-"));
    const red = path.join(dir, "red.mp4");
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=red:s=${W}x${H}:d=12:r=${FPS}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", red,
    ]);
    timeline = plannedTimeline();
    timeline.format = { ...timeline.format, fps: FPS };
    /** No grade: a graded red is no longer "red", and the colour is what this file measures. */
    delete timeline.look;
    out = path.join(dir, "film.mp4");
    result = await renderTimeline({
      timeline,
      workDir: path.join(dir, "work"),
      outputPath: out,
      resolveMedia: async () => red,
      graphicsOverlay: productionGraphicsOverlay({ workDir: path.join(dir, "work"), cacheDir: path.join(dir, "bundle") }),
    });
  }, 1_800_000);

  afterAll(() => {
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp dir is not a test failure */
    }
  });

  it("the plan puts a dark ground and a progress graphic under the middle sentence", () => {
    const video = timeline.tracks.find((t) => t.kind === "VIDEO");
    const ground = video && video.kind === "VIDEO" ? video.clips.find(isGraphicBackdrop) : undefined;
    expect(ground?.transform?.opacity).toBe(0);
    const gfx = timeline.tracks.find((t) => t.kind === "GRAPHICS");
    expect(gfx && gfx.kind === "GRAPHICS" ? gfx.graphics.some((g) => g.graphicType === "progress" && g.start === ground?.timelineStart) : false).toBe(true);
  });

  it("rendered through the Remotion overlay route", () => {
    expect(fs.existsSync(out)).toBe(true);
    expect(result.graphicsRenderer).toBe("remotion");
    expect(result.graphicsOverlayInk?.status).toBe("ink");
  });

  it("under the sentence without a clip: no borrowed picture, the graphic is the picture", async () => {
    const f = await frameAt(out, 7.0, path.join(dir, "mid.raw"));
    expect(f.red, `red share ${f.red}`).toBeLessThan(0.005);
    expect(f.other, `drawn share ${f.other}`).toBeGreaterThan(0.005);
    expect(f.black, `black share ${f.black}`).toBeGreaterThan(0.5);
  });

  it("under the sentences with a clip: their own picture, as before", async () => {
    for (const [sec, name] of [[2, "first"], [10, "last"]] as const) {
      const f = await frameAt(out, sec, path.join(dir, `${name}.raw`));
      expect(f.red, `${name}: red share ${f.red}`).toBeGreaterThan(0.6);
    }
  });
});
