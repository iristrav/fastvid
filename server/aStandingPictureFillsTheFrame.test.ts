/**
 * A STANDING PICTURE FILLS THE FRAME WITH ITSELF, NOT WITH BLACK — RONDE 647.
 *
 * Video 604: archive asset 57804 (a YouTube segment, 720×1280) held 15.8 s between two black bars.
 * The renderer now measures the file, and a standing picture with no chosen fit is kept whole and
 * centred over a blurred, darkened copy of itself. Landscape footage and any explicit fit are
 * rendered exactly as before.
 *
 * Measured on real renders: the brightness of the left edge, where the bar used to be.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyTimeline, timelineElementId, type ProjectTimeline } from "./projectTimeline";
import { probeIsPortrait, renderTimeline } from "./timelineRenderer";
import { blurFillChain, buildVideoFilter, containChain } from "./timelineFilters";
import { resolveFFmpegBin } from "./ffmpegBinary";

const run = promisify(execFile);
const FFMPEG = resolveFFmpegBin();
const FMT = { widthPx: 320, heightPx: 180, fps: 25 };
let dir = "";
let standing = "";
let lying = "";

function timeline(fit?: "contain"): ProjectTimeline {
  const t = emptyTimeline(647, FMT);
  t.durationSec = 2;
  t.tracks = [
    {
      kind: "VIDEO",
      clips: [{
        id: timelineElementId("clip", "r647p", 0),
        kind: "video",
        source: { provider: "ww2", archiveAssetId: 57804 },
        sourceIn: 0,
        timelineStart: 0,
        timelineEnd: 2,
        transitionIn: "hard_cut",
        transitionOut: "hard_cut",
        previewSource: "asset",
        ...(fit ? { transform: { fit } } : {}),
      }],
    },
    { kind: "VOICE", clips: [] },
    { kind: "MUSIC", clips: [] },
    { kind: "SFX", clips: [] },
    { kind: "CAPTIONS", captions: [] },
    { kind: "AMBIENT", clips: [] },
    { kind: "TEXT", texts: [] },
    { kind: "GRAPHICS", graphics: [] },
  ] as never;
  return t;
}

/** Mean luma of the leftmost 30 px column at 1 s — where a pillarbox bar would be. */
async function leftEdgeLuma(file: string): Promise<number> {
  const { stderr } = await run(FFMPEG, [
    "-hide_banner", "-ss", "1", "-i", file, "-frames:v", "1",
    "-vf", "crop=30:ih:0:0,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    "-f", "null", "-",
  ]);
  const m = /YAVG=([0-9.]+)/.exec(stderr);
  if (!m) throw new Error("no YAVG in ffmpeg output");
  return Number(m[1]);
}

async function render(source: string, name: string, fit?: "contain"): Promise<string> {
  const out = path.join(dir, `${name}.mp4`);
  await renderTimeline({
    timeline: timeline(fit),
    workDir: path.join(dir, `w_${name}`),
    outputPath: out,
    resolveMedia: async () => source,
  });
  return out;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "r647-portrait-"));
  standing = path.join(dir, "standing.mp4");
  lying = path.join(dir, "lying.mp4");
  for (const [file, size] of [[standing, "180x320"], [lying, "320x180"]] as const) {
    await run(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=25:duration=3`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file,
    ]);
  }
}, 120_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the measurement", () => {
  it("a 180×320 file stands, a 320×180 file does not", async () => {
    expect(await probeIsPortrait(standing)).toBe(true);
    expect(await probeIsPortrait(lying)).toBe(false);
    expect(await probeIsPortrait(path.join(dir, "missing.mp4"))).toBeNull();
  });
});

describe("the filter", () => {
  const clip = timeline().tracks[0] as unknown as { clips: Parameters<typeof buildVideoFilter>[0][] };

  it("a standing source with no chosen fit gets the blurred fill", () => {
    expect(buildVideoFilter(clip.clips[0]!, FMT, 2, undefined, { portraitSource: true })).toContain(
      blurFillChain(FMT)
    );
  });

  it("anything else is byte-for-byte what it was", () => {
    expect(buildVideoFilter(clip.clips[0]!, FMT, 2)).toBe(containChain(FMT));
    expect(buildVideoFilter(clip.clips[0]!, FMT, 2, undefined, { portraitSource: false })).toBe(containChain(FMT));
  });

  it("an explicit fit is the editor's choice and is kept, even on a standing source", () => {
    const chosen = timeline("contain").tracks[0] as unknown as { clips: Parameters<typeof buildVideoFilter>[0][] };
    expect(buildVideoFilter(chosen.clips[0]!, FMT, 2, undefined, { portraitSource: true })).toBe(containChain(FMT));
  });
});

describe("real renders", () => {
  it("VIDEO 604's shape: the bars are filled, and the frame is the timeline's size", async () => {
    const filled = await render(standing, "filled");
    const barred = await render(standing, "barred", "contain");
    const filledEdge = await leftEdgeLuma(filled);
    const barredEdge = await leftEdgeLuma(barred);
    /** A black bar is ~16 in limited-range luma; the blurred fill carries the picture's own light. */
    expect(barredEdge).toBeLessThan(20);
    expect(filledEdge).toBeGreaterThan(barredEdge + 15);
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
      "-of", "csv=p=0", filled,
    ]);
    expect(stdout.trim()).toBe("320,180");
  }, 180_000);

  it("a landscape source renders exactly as before", async () => {
    const a = await render(lying, "lying_a");
    const b = await render(lying, "lying_b", "contain");
    expect(Math.abs((await leftEdgeLuma(a)) - (await leftEdgeLuma(b)))).toBeLessThan(0.5);
  }, 180_000);
});
