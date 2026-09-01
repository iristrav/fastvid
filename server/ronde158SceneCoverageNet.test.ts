/**
 * RONDE 158 — the net under every compose route: a scene whose picture is shorter than its sound.
 *
 * ── What RONDE 157 left open ─────────────────────────────────────────────────────────────────
 *
 * R157 fixed the route production takes, by measuring the montage before muxing it. Two gaps
 * remained, and the owner asked for both:
 *
 *   2. Five other pad sites cannot measure. They build the montage inline in one filter graph, so
 *      there is no file to probe and they pass an ESTIMATE of its length. An estimate that runs
 *      long makes the pad too small — and video 552 shows it running long:
 *
 *          scene 1   gap predicted from the estimate 26.0s, gap actually measured 27.25s
 *          scene 2   gap predicted from the estimate 12.7s, gap actually measured 12.75s
 *
 *      so scene 1's real montage was about 1.25s shorter than the estimate believed.
 *
 *   3. R157's montage replay falls back to the previous behaviour when it fails, which means a
 *      frozen tail was still reachable through an ffmpeg error.
 *
 * ── Why one net instead of five more pads ────────────────────────────────────────────────────
 *
 * Both have the same symptom and it is visible in one place: the finished scene, where the real
 * length can simply be read instead of estimated. So the check sits at returnComposed — the single
 * point every compose route leaves through — rather than becoming a sixth pad site with a sixth
 * estimate. It also catches causes nobody has thought of yet, which five more pads would not.
 *
 * ── The measurement that makes it possible ───────────────────────────────────────────────────
 *
 * `format=duration` reports the CONTAINER, and a scene with this defect has a full-length
 * container. That is why every earlier check saw nothing: the file really is the right length; it
 * is the picture inside it that stops early. probeVideoStreamDurationSec reads the video stream.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  probeVideoDurationSec,
  probeVideoStreamDurationSec,
  repairShortSceneVideo,
} from "./videoPipeline";
import { auditVideoStillness, checkStillnessLimit } from "./videoStillnessAudit";
import { stillImageMaxSec } from "./stillImagePolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

let dir: string;
const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", ...args], { stdio: "ignore" });

/**
 * A scene with the defect: `pictureSec` of moving picture inside a `sceneSec` container.
 *
 * Built the way the pipeline builds one — a short montage muxed against a full-length voice track
 * with `-vsync cfr -t sceneSec` — so this is the real shape, not an approximation of it.
 */
function makeShortScene(name: string, pictureSec: number, sceneSec: number): string {
  const montage = path.join(dir, `${name}_m.mp4`);
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", String(pictureSec),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", montage]);
  const audio = path.join(dir, `${name}_a.mp3`);
  ff(["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-t", String(sceneSec), "-c:a", "libmp3lame", audio]);
  const scene = path.join(dir, `${name}_scene.mp4`);
  ff(["-i", montage, "-i", audio,
      "-filter_complex", "[0:v]fps=25,format=yuv420p,setsar=1,setpts=PTS-STARTPTS[vout]",
      "-map", "[vout]", "-map", "1:a", "-vsync", "cfr", "-t", String(sceneSec),
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-pix_fmt", "yuv420p", scene]);
  return scene;
}

/** Two scenes end to end, which is where a gap becomes duplicated frames a viewer sees. */
async function filmOf(name: string, scene: string) {
  const list = path.join(dir, `${name}.txt`);
  fs.writeFileSync(list, `file '${scene}'\nfile '${scene}'\n`);
  const film = path.join(dir, `${name}_film.mp4`);
  ff(["-fflags", "+discardcorrupt", "-f", "concat", "-safe", "0", "-i", list, "-vsync", "cfr",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac",
      "-movflags", "+faststart", film]);
  const stillness = await auditVideoStillness({ videoPath: film });
  return { film, stillness, verdict: checkStillnessLimit(stillness, stillImageMaxSec()) };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r158-"));
}, 60_000);

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("RONDE 158 — the measurement the old checks could not make", () => {
  it("the container says one length and the picture another", async () => {
    const scene = makeShortScene("split", 8.5, 21.2);
    const container = await probeVideoDurationSec(scene);
    const picture = await probeVideoStreamDurationSec(scene);
    // The file is the right length. That is exactly why nothing caught this.
    expect(container).toBeGreaterThan(21);
    // The picture is not.
    expect(picture).toBeLessThan(9);
    expect(container - picture).toBeGreaterThan(12);
  }, 180_000);

  it("a healthy scene reads the same on both", async () => {
    const scene = makeShortScene("whole", 12, 12);
    const container = await probeVideoDurationSec(scene);
    const picture = await probeVideoStreamDurationSec(scene);
    expect(Math.abs(container - picture)).toBeLessThan(0.3);
  }, 180_000);

  it("an unreadable file returns 0 rather than a guess", async () => {
    const junk = path.join(dir, "junk.mp4");
    fs.writeFileSync(junk, "not a video");
    expect(await probeVideoStreamDurationSec(junk)).toBe(0);
  }, 120_000);
});

describe("RONDE 158 — the repair, measured end to end", () => {
  it("the defect really does freeze the finished film", async () => {
    const scene = makeShortScene("bug", 8.5, 21.2);
    const { stillness } = await filmOf("bug", scene);
    expect(stillness.longestStillSec).toBeGreaterThan(stillImageMaxSec());
  }, 300_000);

  it("after the repair the same scene never freezes", async () => {
    const scene = makeShortScene("fix", 8.5, 21.2);
    const repaired = await repairShortSceneVideo(scene, 21.2, 7, dir, 120_000, "-threads 2");
    expect(repaired).not.toBe(scene);
    const picture = await probeVideoStreamDurationSec(repaired);
    expect(picture).toBeGreaterThan(21.2 - 0.3);
    const { verdict, stillness } = await filmOf("fix", repaired);
    expect(stillness.longestStillSec).toBeLessThanOrEqual(stillImageMaxSec());
    expect(verdict.ok).toBe(true);
  }, 300_000);

  it("the small shortfall an estimate leaves is repaired too", async () => {
    /**
     * Video 552's scene 1: the estimate was about 1.25s long, so the pad was 1.25s short. Not a
     * dramatic number and still a frozen second, which is the thing the owner asked to never see.
     */
    const scene = makeShortScene("small", 18.0, 19.25);
    const repaired = await repairShortSceneVideo(scene, 19.25, 3, dir, 120_000, "-threads 2");
    expect(repaired).not.toBe(scene);
    expect(await probeVideoStreamDurationSec(repaired)).toBeGreaterThan(19.0);
  }, 300_000);

  it("a scene that already covers its voice is left untouched — no needless re-encode", async () => {
    const scene = makeShortScene("ok", 12, 12);
    const same = await repairShortSceneVideo(scene, 12, 4, dir, 120_000, "-threads 2");
    expect(same).toBe(scene);
  }, 180_000);

  it("the voice is copied, not re-timed — only the picture is adjusted", async () => {
    const scene = makeShortScene("audio", 8.5, 21.2);
    const repaired = await repairShortSceneVideo(scene, 21.2, 5, dir, 120_000, "-threads 2");
    const before = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=duration", "-of", "csv=p=0", scene]).toString().trim();
    const after = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=duration", "-of", "csv=p=0", repaired]).toString().trim();
    expect(Math.abs(parseFloat(after) - parseFloat(before))).toBeLessThan(0.3);
    expect(PIPE).toContain('-map "0:a?" -c:a copy');
  }, 300_000);
});

describe("RONDE 158 — wired at the single exit, not at five more pads", () => {
  it("every compose route leaves through the same checked function", () => {
    const sites = PIPE.match(/return await returnComposed\(outputPath, outDur\);/g) ?? [];
    expect(sites.length).toBe(7);
    // No route slips out with the check skipped.
    expect(PIPE).not.toContain("return returnComposed(outputPath);");
  });

  it("the exit knows the scene's own length, and skips the check without one", () => {
    expect(PIPE).toContain("const returnComposed = async (composedPath: string, targetDur?: number)");
    const idx = PIPE.indexOf("const returnComposed = async (");
    const body = PIPE.slice(idx, idx + 1600);
    expect(body).toContain("if (targetDur != null && targetDur > 0 && composedPath === outputPath) {");
  });

  it("it repairs with the existing pad chain, not a new one", () => {
    const idx = PIPE.indexOf("export async function repairShortSceneVideo(");
    const body = PIPE.slice(idx, idx + 2600);
    expect(body).toContain("montageTailPadFilterChain(");
  });

  it("a failed repair keeps the scene rather than losing it", () => {
    const idx = PIPE.indexOf("export async function repairShortSceneVideo(");
    const body = PIPE.slice(idx, idx + 3200);
    expect(body).toContain("return scenePath;");
    expect(body).toContain("} catch (err) {");
  });

  it("an unmeasurable scene is reported, never assumed complete", () => {
    const idx = PIPE.indexOf("export async function repairShortSceneVideo(");
    const body = PIPE.slice(idx, idx + 1400);
    expect(body).toContain("could not read the picture's length");
  });
});

describe("RONDE 158 — RONDE 157's own fallbacks are covered", () => {
  it("a montage replay that fails now says the net will catch it", () => {
    // It used to say a frame may be held, which is no longer what happens.
    expect(PIPE).toContain("montage replay failed — the finished scene is checked");
    expect(PIPE).not.toContain("coverage filler may hold a frame");
  });

  it("an unprobeable montage says the same", () => {
    expect(PIPE).toContain("could not probe montage length — tail pad skipped here");
  });

  it("no new hold site was introduced", () => {
    const holds = PIPE.match(/tpad=stop_mode=clone/g) ?? [];
    expect(holds.length).toBe(2);
  });
});
