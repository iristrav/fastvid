/**
 * RONDE 121 — three seconds of picture after the last word.
 *
 * The film used to end on the final syllable: voiceover stops, last scene stops with it, file
 * over. This adds a closing hold — and the whole risk of it is that a "hold" is exactly the thing
 * this pipeline spent RONDE 111 and RONDE 112 removing. A frozen last frame would be the banned
 * behaviour, reintroduced at the most visible moment in the video.
 *
 * So the tests below are mostly about one question: does the picture actually move. They render a
 * real tail with real ffmpeg and compare its first frame against its last.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import {
  CLOSING_TAIL_SEC,
  buildClosingTail,
  closingTailEndVelocityPx,
  closingTailSeconds,
  closingTailZoomExpr,
  formatClosingTailPlan,
  planClosingTail,
} from "./closingTail";

let tmpDir: string;
let scenePath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.CLOSING_TAIL_SEC = process.env.CLOSING_TAIL_SEC;
  delete process.env.CLOSING_TAIL_SEC;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ronde121-"));
  scenePath = path.join(tmpDir, "scene_last.mp4");
  // A real composed-scene stand-in: moving picture plus an audio track, which is what the concat
  // demuxer sees and therefore what the tail has to match.
  execSync(
    `ffmpeg -y -f lavfi -i "testsrc=size=640x360:rate=25:duration=4" ` +
      `-f lavfi -i "sine=frequency=440:duration=4" ` +
      `-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "${scenePath}" 2>/dev/null`
  );
}, 60_000);

afterEach(() => {
  if (savedEnv.CLOSING_TAIL_SEC === undefined) delete process.env.CLOSING_TAIL_SEC;
  else process.env.CLOSING_TAIL_SEC = savedEnv.CLOSING_TAIL_SEC;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = async (cmd: string) => {
  execSync(`${cmd} 2>/dev/null`, { maxBuffer: 64 * 1024 * 1024 });
};

const exists = (p: string) => {
  try { return fs.existsSync(p) && fs.statSync(p).size > 1000; } catch { return false; }
};

function probe(file: string, entries: string): string {
  return execSync(
    `ffprobe -v error -show_entries ${entries} -of default=nw=1:nk=1 "${file}"`,
    { encoding: "utf8" }
  ).trim();
}

/* ═══════════ 1. the length that was asked for ═══════════ */

describe("RONDE 121 — how long the picture stays", () => {
  it("three seconds, which is the default nobody has to configure", () => {
    expect(CLOSING_TAIL_SEC).toBe(3);
    expect(closingTailSeconds()).toBe(3);
  });

  it("it can be changed, and turned off entirely, without a redeploy", () => {
    process.env.CLOSING_TAIL_SEC = "5";
    expect(closingTailSeconds()).toBe(5);
    process.env.CLOSING_TAIL_SEC = "0";
    expect(closingTailSeconds()).toBe(0);
    // ...and off means off: no plan, so nothing is appended to the concat.
    expect(planClosingTail({ tailSec: 0, widthPx: 1920, heightPx: 1080, fps: 25 })).toBeNull();
  });

  it("a nonsense override falls back to three rather than breaking the render", () => {
    for (const bad of ["", "abc", "-2", "  "]) {
      process.env.CLOSING_TAIL_SEC = bad;
      expect(closingTailSeconds()).toBe(3);
    }
  });

  it("and a fat-fingered one is capped — no minute-long still on every video", () => {
    process.env.CLOSING_TAIL_SEC = "600";
    expect(closingTailSeconds()).toBe(10);
  });
});

/* ═══════════ 2. the part that must not be a freeze ═══════════ */

describe("RONDE 121 — the tail moves, and keeps moving to the last frame", () => {
  it("the zoom is LINEAR, so the final frame moves as fast as the first", () => {
    /**
     * RONDE 111 measured the trap: `sin(PI/2 * on/N)` has derivative zero at the end, so an eased
     * push creeps to a halt in its last moments — 0.30px per frame, which reads as a still. In the
     * final three seconds of a film that is the whole thing being avoided, so the expression here
     * is a straight line and this asserts its shape rather than trusting the comment.
     */
    const expr = closingTailZoomExpr(75);
    expect(expr).toBe("1+0.06*on/74");
    expect(expr).not.toMatch(/sin|cos|pow|sqrt/);
  });

  it("the arithmetic says the movement is visible, not technically-nonzero", () => {
    // 3s at 25fps over a 1080-high frame.
    const px = closingTailEndVelocityPx(75, 1080);
    expect(px).toBeGreaterThan(0.7);
  });

  it("THE REAL TEST: a rendered tail's last frame differs from its first", async () => {
    /**
     * Everything above is arithmetic about a filter string. This renders the actual segment and
     * compares pixels — the only check that would catch a filter that silently does nothing.
     */
    const built = await buildClosingTail({
      lastScenePath: scenePath,
      outputPath: path.join(tmpDir, "tail.mp4"),
      framePath: path.join(tmpDir, "tailframe.jpg"),
      ffmpegBin: "ffmpeg",
      run: async (cmd) => run(cmd),
      lastSceneDurationSec: 4,
      widthPx: 640,
      heightPx: 360,
      fileExists: exists,
    });
    expect(built).not.toBeNull();

    const first = path.join(tmpDir, "first.png");
    const last = path.join(tmpDir, "last.png");
    await run(`ffmpeg -y -i "${built!.path}" -vf "select=eq(n\\,0)" -frames:v 1 "${first}"`);
    await run(`ffmpeg -y -sseof -0.1 -i "${built!.path}" -frames:v 1 "${last}"`);
    expect(fs.existsSync(first) && fs.existsSync(last)).toBe(true);

    // A frozen tail would produce two identical pictures.
    const a = fs.readFileSync(first);
    const b = fs.readFileSync(last);
    expect(a.equals(b)).toBe(false);
  }, 120_000);
});

/* ═══════════ 3. the segment the concat has to swallow ═══════════ */

describe("RONDE 121 — the tail is a segment the concat can take", () => {
  it("it is the requested length, at the film's own resolution", async () => {
    const built = await buildClosingTail({
      lastScenePath: scenePath,
      outputPath: path.join(tmpDir, "tail.mp4"),
      framePath: path.join(tmpDir, "tailframe.jpg"),
      ffmpegBin: "ffmpeg",
      run: async (cmd) => run(cmd),
      lastSceneDurationSec: 4,
      widthPx: 640,
      heightPx: 360,
      fileExists: exists,
    });
    expect(built).not.toBeNull();
    const dur = Number(probe(built!.path, "format=duration"));
    expect(dur).toBeGreaterThan(2.8);
    expect(dur).toBeLessThan(3.3);
    expect(probe(built!.path, "stream=width,height").split("\n").slice(0, 2)).toEqual(["640", "360"]);
  }, 120_000);

  it("it carries a SILENT audio track — the narration is over, but the streams must match", async () => {
    /**
     * The concat demuxer needs every input to have the same streams. A video-only tail would be
     * refused, or would end the film's audio three seconds early. Silence is also the right
     * content: the voiceover has finished, and the music is mixed over the finished concat, so it
     * plays across the tail on its own.
     */
    const built = await buildClosingTail({
      lastScenePath: scenePath,
      outputPath: path.join(tmpDir, "tail.mp4"),
      framePath: path.join(tmpDir, "tailframe.jpg"),
      ffmpegBin: "ffmpeg",
      run: async (cmd) => run(cmd),
      lastSceneDurationSec: 4,
      widthPx: 640,
      heightPx: 360,
      fileExists: exists,
    });
    expect(probe(built!.path, "stream=codec_type")).toContain("audio");

    // ...and it really is silent, not a copy of the last words.
    const vol = execSync(
      `ffmpeg -i "${built!.path}" -af volumedetect -f null - 2>&1 | grep max_volume || true`,
      { encoding: "utf8" }
    );
    expect(vol).toMatch(/-91|-inf|max_volume: -\d{2,}/);
  }, 120_000);

  it("a real concat of scene + tail produces one file of both lengths together", async () => {
    const built = await buildClosingTail({
      lastScenePath: scenePath,
      outputPath: path.join(tmpDir, "tail.mp4"),
      framePath: path.join(tmpDir, "tailframe.jpg"),
      ffmpegBin: "ffmpeg",
      run: async (cmd) => run(cmd),
      lastSceneDurationSec: 4,
      widthPx: 640,
      heightPx: 360,
      fileExists: exists,
    });
    const listFile = path.join(tmpDir, "list.txt");
    fs.writeFileSync(listFile, `file '${scenePath}'\nfile '${built!.path}'\n`);
    const out = path.join(tmpDir, "joined.mp4");
    await run(
      `ffmpeg -y -f concat -safe 0 -i "${listFile}" -vsync cfr -c:v libx264 -preset veryfast ` +
        `-crf 23 -c:a aac -b:a 192k "${out}"`
    );
    /**
     * The VIDEO stream, deliberately, not the container. Concat's re-encoded AAC runs a little
     * past the last picture (7.65s here for 7.04s of video) — that padding exists with or without
     * a tail, and "three seconds of picture" is a claim about frames.
     */
    const videoDur = Number(probe(out, "stream=duration").split("\n")[0]);
    // 4s of scene + 3s of tail, give or take a frame at the join.
    expect(videoDur).toBeGreaterThan(6.9);
    expect(videoDur).toBeLessThan(7.3);
  }, 180_000);
});

/* ═══════════ 4. it can never cost a render ═══════════ */

describe("RONDE 121 — a closing touch that cannot break a finished film", () => {
  it("an unreadable last scene returns null instead of throwing", async () => {
    const broken = path.join(tmpDir, "broken.mp4");
    fs.writeFileSync(broken, Buffer.alloc(4000, 7));
    const built = await buildClosingTail({
      lastScenePath: broken,
      outputPath: path.join(tmpDir, "tail.mp4"),
      framePath: path.join(tmpDir, "tailframe.jpg"),
      ffmpegBin: "ffmpeg",
      run: async (cmd) => run(cmd),
      lastSceneDurationSec: 4,
      widthPx: 640,
      heightPx: 360,
      fileExists: exists,
    });
    expect(built).toBeNull();
  }, 60_000);

  it("an ffmpeg that fails outright returns null instead of throwing", async () => {
    const built = await buildClosingTail({
      lastScenePath: scenePath,
      outputPath: path.join(tmpDir, "tail.mp4"),
      framePath: path.join(tmpDir, "tailframe.jpg"),
      ffmpegBin: "ffmpeg",
      run: async () => { throw new Error("ffmpeg exploded"); },
      lastSceneDurationSec: 4,
      widthPx: 640,
      heightPx: 360,
      fileExists: exists,
    });
    expect(built).toBeNull();
  });

  it("the pipeline appends it to the concat list and lets the render continue when it is null", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "server", "videoPipeline.ts"), "utf8");
    // It goes in as one more concat segment, not by stretching the last scene — so no stage that
    // reasons about scenes sees anything new.
    expect(src).toContain("allClips.push(built.path)");
    expect(src).toContain("the video ends on the last word, as before");
    // And the music is generated for the longer film, or the last three seconds fall silent.
    expect(src).toContain("const totalWithCards = totalDuration + closingTailSec;");
  });

  it("the log says what it did, including that the motion does not stop", () => {
    const plan = planClosingTail({ tailSec: 3, widthPx: 1920, heightPx: 1080, fps: 25 })!;
    const line = formatClosingTailPlan(plan, 1920, 1080);
    expect(line).toContain("[ClosingTail]");
    expect(line).toContain("3.0s");
    expect(line).toMatch(/same at the last frame as the first/);
  });
});
