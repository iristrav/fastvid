/**
 * RONDE 648 — black bars baked into a shot are cropped and the frame refilled, measured on real
 * files made with ffmpeg: a 4:3 picture pillarboxed into 16:9, the way an uploader ships archival
 * footage.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cropEmbeddedBarsInPlace, cropIsWorthMaking, detectEmbeddedBarsCrop, parseCropdetect } from "./embeddedBarsCrop";
import { resolveFFmpegBin } from "./ffmpegBinary";

const run = promisify(execFile);
const FF = resolveFFmpegBin();
let dir = "";

async function make(name: string, vf: string): Promise<string> {
  const out = path.join(dir, name);
  await run(FF, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=480x360:rate=25:duration=4",
    "-vf", vf, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out,
  ]);
  return out;
}

/** Mean luma of the leftmost 20 px at 1 s — where a pillar bar is. */
async function leftLuma(file: string): Promise<number> {
  const { stderr } = await run(FF, [
    "-hide_banner", "-ss", "1", "-i", file, "-frames:v", "1",
    "-vf", "crop=20:ih:0:0,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    "-f", "null", "-",
  ]);
  return Number(/YAVG=([0-9.]+)/.exec(stderr)?.[1] ?? NaN);
}

async function size(file: string): Promise<string> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file,
  ]);
  return stdout.trim();
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "r648-bars-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the measurement", () => {
  it("reads cropdetect's settled answer", () => {
    expect(parseCropdetect("x crop=100:80:10:0\ny crop=96:80:12:0\n")).toEqual({ w: 96, h: 80, x: 12, y: 0 });
    expect(parseCropdetect("nothing here")).toBeNull();
  });

  it("a crop is made only when something is removed and a real picture remains", () => {
    expect(cropIsWorthMaking({ w: 480, h: 360, x: 80, y: 0, srcW: 640, srcH: 360 })).toBe(true);
    expect(cropIsWorthMaking({ w: 636, h: 360, x: 2, y: 0, srcW: 640, srcH: 360 })).toBe(false);
    expect(cropIsWorthMaking({ w: 100, h: 360, x: 270, y: 0, srcW: 640, srcH: 360 })).toBe(false);
  });

  it("a 4:3 picture pillarboxed into 16:9 measures as its 4:3 middle", async () => {
    const boxed = await make("boxed.mp4", "pad=640:360:80:0:black");
    const crop = await detectEmbeddedBarsCrop(boxed);
    expect(crop).not.toBeNull();
    expect(crop!.srcW).toBe(640);
    expect(Math.abs(crop!.w - 480)).toBeLessThanOrEqual(8);
    expect(Math.abs(crop!.x - 80)).toBeLessThanOrEqual(8);
  }, 60_000);
});

describe("the crop, on real files", () => {
  it("the bars are gone, the frame keeps its size, and its sides carry the picture's own light", async () => {
    const boxed = await make("boxed2.mp4", "pad=640:360:80:0:black");
    const before = await leftLuma(boxed);
    expect(before).toBeLessThan(20);
    const crop = await cropEmbeddedBarsInPlace(boxed);
    expect(crop).not.toBeNull();
    expect(await size(boxed)).toBe("640,360");
    expect(await leftLuma(boxed)).toBeGreaterThan(before + 15);
  }, 120_000);

  it("a full-frame picture is left exactly as it is", async () => {
    const full = await make("full.mp4", "scale=640:360");
    const bytes = fs.readFileSync(full);
    expect(await cropEmbeddedBarsInPlace(full)).toBeNull();
    expect(fs.readFileSync(full).equals(bytes)).toBe(true);
  }, 60_000);
});

describe("the wiring", () => {
  it("the pipeline crops before it refuses, and refuses only when the crop was not made", () => {
    const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    const at = SRC.indexOf("const cropped = await cropEmbeddedBarsInPlace(filePath)");
    const refuse = SRC.indexOf("Rejecting clip with embedded black bars", at);
    expect(at).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(at);
    expect(SRC.slice(at, refuse)).toContain("if (!cropped) {");
  });
});
