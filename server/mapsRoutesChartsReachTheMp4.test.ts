/**
 * MAPS, ROUTES AND CHARTS REACH THE MP4 — through the production render, not a special route.
 *
 * A text graphic, a map point, a route and a bar chart on the GRAPHICS track of one timeline,
 * rendered by `renderTimeline` with `productionGraphicsOverlay` — the same overlay function the
 * render worker passes. Each graphic's slot must have ink in the delivered file, the slot after the
 * last graphic must be clean, and nothing may be reported as "not drawn".
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyTimeline, type ProjectTimeline } from "./projectTimeline";
import { productionGraphicsOverlay } from "./graphicsOverlayDeps";
import { renderTimeline, type RenderedTimeline } from "./timelineRenderer";
import { resolveRemotionBrowser } from "./remotionRenderer";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);
const WIDTH = 960;
const HEIGHT = 540;
const FPS = 12;
const SLOT = 1.5;

const GRAPHICS = [
  { id: "g-text", graphicType: "location_card", label: "Berlin", data: { place: "Berlin" } },
  { id: "g-map", graphicType: "map_point", data: { normX: 0.55, normY: 0.35, locationName: "Berlin" } },
  {
    id: "g-route",
    graphicType: "route",
    data: { points: [{ normX: 0.2, normY: 0.6, label: "Paris" }, { normX: 0.55, normY: 0.35, label: "Berlin" }, { normX: 0.8, normY: 0.3, label: "Warsaw" }] },
  },
  {
    id: "g-chart",
    graphicType: "bar_chart",
    data: { series: [{ label: "1939", value: 12 }, { label: "1942", value: 30 }, { label: "1945", value: 18 }] },
  },
].map((g, i) => ({ ...g, start: i * SLOT, end: (i + 1) * SLOT }));

const DURATION = (GRAPHICS.length + 1) * SLOT;
const mid = (i: number) => i * SLOT + SLOT / 2;

function timeline(): ProjectTimeline {
  const t = emptyTimeline(1, { widthPx: WIDTH, heightPx: HEIGHT, fps: FPS });
  t.durationSec = DURATION;
  for (const track of t.tracks) {
    if (track.kind === "GRAPHICS") track.graphics.push(...(GRAPHICS as never[]));
    if (track.kind === "VIDEO") {
      track.clips.push({
        id: "clip-1", kind: "video", source: { provider: "pexels", providerAssetId: "fixture" },
        sourceIn: 0, sourceOut: DURATION, timelineStart: 0, timelineEnd: DURATION,
        motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut",
      } as never);
    }
  }
  return t;
}

/** Pixels that are no longer the red source — what a graphic put there. */
async function inkAt(file: string, atSec: number, scratch: string): Promise<number> {
  await execFileAsync(resolveFFmpegBin(), [
    "-y", "-hide_banner", "-loglevel", "error", "-i", file, "-ss", atSec.toFixed(3),
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", scratch,
  ]);
  const rgb = fs.readFileSync(scratch);
  let ink = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    if (!(rgb[i]! > 170 && rgb[i + 1]! < 80 && rgb[i + 2]! < 80)) ink++;
  }
  return ink;
}

const describeRender = resolveRemotionBrowser() ? describe : describe.skip;

describeRender("graphics in the production render: text, map, route, chart", () => {
  let dir = "";
  let out = "";
  let result: RenderedTimeline;
  const ink: number[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "maps-charts-"));
    const source = path.join(dir, "red.mp4");
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", `color=c=red:s=${WIDTH}x${HEIGHT}:d=${DURATION}:r=${FPS}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
    ]);
    out = path.join(dir, "graphics.mp4");
    const workDir = path.join(dir, "work");
    result = await renderTimeline({
      timeline: timeline(),
      workDir,
      outputPath: out,
      resolveMedia: async () => source,
      graphicsOverlay: productionGraphicsOverlay({ workDir, cacheDir: path.join(dir, "bundle") }),
    });
    for (let i = 0; i <= GRAPHICS.length; i++) ink.push(await inkAt(out, mid(i), path.join(dir, `f${i}.raw`)));
  }, 1_800_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("went through the Remotion overlay of the normal render and refused nothing", () => {
    expect(fs.existsSync(out)).toBe(true);
    expect(result.skipped.filter((s) => /unsupported_graphic|fell back|not drawn|no visible ink/.test(s))).toEqual([]);
  });

  it("every graphic — text, map, route, chart — has visible ink in its own slot of the MP4", () => {
    const floor = Math.round(WIDTH * HEIGHT * 0.002);
    GRAPHICS.forEach((g, i) => expect(ink[i], `${g.graphicType} at ${mid(i)}s`).toBeGreaterThan(floor));
  });

  it("the slot after the last graphic is clean — each one ends when the timeline says", () => {
    expect(ink[GRAPHICS.length]).toBeLessThan(Math.round(WIDTH * HEIGHT * 0.0005));
  });

  it("the four slots differ: four different pictures, not one drawn four times", () => {
    expect(new Set(ink.slice(0, GRAPHICS.length)).size).toBe(GRAPHICS.length);
  });
});
