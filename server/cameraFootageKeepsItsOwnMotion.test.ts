/**
 * CAMERA — REAL FOOTAGE KEEPS ITS OWN MOTION; A PHOTOGRAPH MOVES SUBTLY; A HELD LAST FRAME NEVER FREEZES.
 *
 * The camera planner laid a synthetic tilt, pan, push or dolly over real video on wide, detail and
 * dramatic/exciting shots. Footage now holds; a photograph still gets its subtle move. A video file
 * shorter than its slot shows its last frame for the rest (`tpad`): with no move of its own that
 * tail would be a frozen picture, so only then the renderer gives the clip a 4% push
 * (`holdTailCamera`). The planner is pure; the render is one real local ffmpeg render.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HOLD_TAIL_PUSH_SCALE, holdTailCamera, renderTimeline } from "./timelineRenderer";
import { emptyTimeline, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);
const W = 320;
const H = 180;
const FPS = 12;

const video = (over: Partial<TimelineVideoClip> = {}): TimelineVideoClip =>
  ({
    id: "vc", kind: "video", source: { provider: "pexels", providerAssetId: "fixture" },
    sourceIn: 0, sourceOut: 3, timelineStart: 0, timelineEnd: 3,
    motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut",
    camera: { type: "camera_hold", intensity: 0, startScale: 1, endScale: 1 },
    ...over,
  }) as TimelineVideoClip;

describe("holdTailCamera — only a held, unmoving tail gets the push", () => {
  it("a file that fills its slot keeps exactly what it had: no synthetic move on real footage", () => {
    expect(holdTailCamera(video(), 5, 3, 0, FPS)).toBeNull();
  });

  it("a file 1.5 s short of its slot, holding still: a subtle push for this render", () => {
    expect(holdTailCamera(video(), 1.5, 3, 0, FPS)).toEqual({ type: "slow_push", intensity: 0.3, startScale: 1, endScale: HOLD_TAIL_PUSH_SCALE });
    expect(HOLD_TAIL_PUSH_SCALE).toBeLessThanOrEqual(1.05);
  });

  it("a clip that already moves keeps its own move", () => {
    expect(holdTailCamera(video({ camera: { type: "slow_push", startScale: 1, endScale: 1.1 } }), 1.5, 3, 0, FPS)).toBeNull();
  });

  it("a held out-point (holdAtSourceOut) counts as a held tail; a sub-two-frame shortfall does not", () => {
    expect(holdTailCamera(video({ holdAtSourceOut: true, sourceOut: 1 }), 10, 3, 0, FPS)).not.toBeNull();
    expect(holdTailCamera(video(), 3 - 1 / FPS, 3, 0, FPS)).toBeNull();
  });

  it("a photograph, an unknown length or no slot: nothing to decide here", () => {
    expect(holdTailCamera(video({ kind: "image" }), 1, 3, 0, FPS)).toBeNull();
    expect(holdTailCamera(video(), null, 3, 0, FPS)).toBeNull();
  });
});

async function frame(file: string, at: number): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    resolveFFmpegBin(),
    ["-hide_banner", "-loglevel", "error", "-ss", at.toFixed(3), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 16 }
  );
  return stdout as unknown as Buffer;
}

const changed = (a: Buffer, b: Buffer): number => {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (Math.abs(a[i]! - b[i]!) > 12) n++;
  return n;
};

async function durationOf(file: string): Promise<number> {
  const { stdout } = await execFileAsync(resolveFFmpegBin().replace(/ffmpeg$/, "ffprobe"), [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ]).catch(async () => execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]));
  return Number(String(stdout).trim());
}

describe("one real render: a short real clip in a longer slot", () => {
  let dir = "";
  let held = "";
  let full = "";

  const film = (fileSec: number): ProjectTimeline => {
    const t = emptyTimeline(1, { widthPx: W, heightPx: H, fps: FPS });
    t.durationSec = 3;
    const track = t.tracks.find((k) => k.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips.push(video({ sourceOut: Math.min(3, fileSec) }));
    return t;
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-tail-"));
    const short = path.join(dir, "short.mp4");
    const long = path.join(dir, "long.mp4");
    for (const [f, d] of [[short, 1.5], [long, 4]] as const) {
      await execFileAsync(resolveFFmpegBin(), [
        "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=${FPS}:duration=${d}`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", f,
      ]);
    }
    held = path.join(dir, "held.mp4");
    full = path.join(dir, "full.mp4");
    await renderTimeline({ timeline: film(1.5), workDir: path.join(dir, "w1"), outputPath: held, resolveMedia: async () => short });
    await renderTimeline({ timeline: film(4), workDir: path.join(dir, "w2"), outputPath: full, resolveMedia: async () => long });
  }, 600_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the timing is unchanged: the film is as long as its slot", async () => {
    expect(Math.abs((await durationOf(held)) - 3)).toBeLessThan(0.15);
    expect(Math.abs((await durationOf(full)) - 3)).toBeLessThan(0.15);
  });

  it("the held last frame is alive: two moments of the tail differ (a frozen tail would be identical)", async () => {
    const a = await frame(held, 1.9);
    const b = await frame(held, 2.8);
    expect(changed(a, b)).toBeGreaterThan(W * H * 0.02);
  });

  it("the picture before the tail is the source's own (the push is subtle, not a zoom effect)", async () => {
    const first = await frame(held, 0.05);
    const ref = await frame(full, 0.05);
    expect(changed(first, ref)).toBeLessThan(W * H * 0.02);
  });
});
