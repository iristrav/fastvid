/**
 * OCTOBER 2026 — the Remotion layer is written as PNG frames and stream-copied into the .mov
 * (`packPngFramesIntoMov`), instead of encoded to ProRes 4444, which was half its cost on every
 * frame. These tests hold the parts that make that safe: the alpha survives, the frames keep their
 * order and count, nothing is re-encoded, and a timeline with nothing to draw never reaches Remotion.
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { afterAll, describe, expect, it } from "vitest";

import { resolveFFmpegBin } from "./ffmpegBinary";
import { productionGraphicsOverlay } from "./graphicsOverlayDeps";
import { emptyTimeline } from "./projectTimeline";
import { hasGraphicsLayer, packPngFramesIntoMov } from "./remotionRenderer";

const run = promisify(execFile);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-png-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Three 64x36 RGBA frames: transparent, a half-transparent white box, fully opaque red. */
async function writeFrames(framesDir: string): Promise<void> {
  fs.mkdirSync(framesDir, { recursive: true });
  const colours = ["0x00000000", "0xFFFFFF80", "0xFF0000FF"];
  for (let i = 0; i < colours.length; i++) {
    await run(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=${colours[i]}:s=64x36,format=rgba`,
      "-frames:v", "1", path.join(framesDir, `element-${String(i).padStart(3, "0")}.png`),
    ]);
  }
}

async function alphaMeans(file: string): Promise<number[]> {
  const { stdout } = await run(
    resolveFFmpegBin(),
    ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "alphaextract,format=gray", "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 24 }
  );
  const buf = stdout as unknown as Buffer;
  const size = 64 * 36;
  return Array.from({ length: buf.length / size }, (_, f) => {
    let sum = 0;
    for (let i = f * size; i < (f + 1) * size; i++) sum += buf[i]!;
    return Math.round(sum / size);
  });
}

describe("the frames become one .mov, unchanged", () => {
  it("png codec, rgba, every frame in order, alpha exactly as drawn", async () => {
    const framesDir = path.join(dir, "frames");
    await writeFrames(framesDir);
    const mov = path.join(dir, "overlay.mov");
    await packPngFramesIntoMov(framesDir, 30, mov);
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-count_frames", "-show_entries", "stream=codec_name,pix_fmt,nb_read_frames,r_frame_rate", "-of", "default=nw=1", mov,
    ]);
    expect(stdout).toContain("codec_name=png");
    expect(stdout).toContain("pix_fmt=rgba");
    expect(stdout).toContain("nb_read_frames=3");
    expect(stdout).toContain("r_frame_rate=30/1");
    /** Transparent, half, opaque — lossless, so 0 / 128 / 255 exactly, in that order. */
    expect(await alphaMeans(mov)).toEqual([0, 128, 255]);
  });
  it("an empty frame folder is a failure, never an empty overlay", async () => {
    const empty = path.join(dir, "none");
    fs.mkdirSync(empty, { recursive: true });
    await expect(packPngFramesIntoMov(empty, 30, path.join(dir, "x.mov"))).rejects.toThrow(/no overlay frames/);
  });
  it("the renderer writes frames and copies them; ProRes is no longer encoded", () => {
    const src = fs.readFileSync(path.join(__dirname, "remotionRenderer.ts"), "utf8");
    expect(src).toContain("await renderFrames({");
    expect(src).toContain('imageFormat: "png"');
    expect(src).toContain('"-c:v", "copy"');
    expect(src).not.toContain('codec: "prores"');
    /** The frame folder is removed whether the render succeeds or fails. */
    expect(src).toContain("fs.rmSync(framesDir, { recursive: true, force: true });");
  });
});

describe("nothing to draw, no Remotion", () => {
  it("a timeline with no captions, texts or graphics skips the layer before any browser starts", async () => {
    const t = emptyTimeline(1);
    t.durationSec = 10;
    expect(hasGraphicsLayer(t)).toBe(false);
    const overlay = await productionGraphicsOverlay({ workDir: dir })(t);
    expect(overlay).toBeNull();
  });
});
