/**
 * RONDE 157 — the frozen picture that survived RONDE 152, 154, 155 and 156.
 *
 * ── What video 552 measured ──────────────────────────────────────────────────────────────────
 *
 * The first production render carrying the whole no-frozen-frame chain still reported:
 *
 *     longest still   27.25s at 34.25s      imagesOver5Sec 2      passed NO
 *     second still    12.75s at 69.88s
 *
 * and, in the same log, the reason, printed by the compose stage itself:
 *
 *     Scene 1: montage est 16.9s < voice 42.9s — gray pad will fill gap     → gap 26.0s
 *     Scene 2: montage est  8.5s < voice 21.2s — gray pad will fill gap     → gap 12.7s
 *
 * 26.0 against a measured 27.25, and 12.7 against a measured 12.75. The gap IS the freeze.
 *
 * ── Why every earlier round missed it ────────────────────────────────────────────────────────
 *
 * R152/154/155 each removed a frozen SOURCE — a still with no motion, two cards sharing a colour,
 * a card that was a flat colour. This is not a source. It is the end of the montage: the mux asks
 * ffmpeg for `-t voiceDuration` seconds of a montage that is shorter than that, and the file comes
 * out at full length with its picture stopped where the montage stopped.
 *
 * The filler for exactly this existed and was correct — R85 slows, R111 caps the slowdown, R130
 * loops past the cap. Only two of the three routes through composePlainMontageScene reached it:
 * the inline xfade route calls montageTailPadVF, and renderSequentialArchiveMontage pads only its
 * SINGLE-clip branch. The `if (IS_RAILWAY)` route — the one production takes — went straight to
 * the mux, and a scene with two or more clips got no filler at all.
 *
 * ── And why wiring it in was not enough ──────────────────────────────────────────────────────
 *
 * With the pad wired in, the two real shapes still end on a held frame:
 *
 *     8.5s → 21.2s   slow 2x to 17.0s, then hold 4.16s
 *     16.9s → 42.9s  slow 2x to 33.8s, hold capped at 5.0s, 9.1s still uncovered
 *
 * because past the 2x cap the chain loops only if the montage fits a 300-frame decode buffer, and
 * 16.9s is 422 frames. So the montage FILE is replayed first with `-stream_loop`, which has no
 * frame budget, up to the shortest length from which the 2x cap reaches the voice by itself. The
 * filler is then a slowdown and the hold is never reached.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extendMontageForCoverage, montageTailPadVF } from "./videoPipeline";
import { auditVideoStillness, checkStillnessLimit } from "./videoStillnessAudit";
import { stillImageMaxSec } from "./stillImagePolicy";
import { MAX_COVERAGE_SLOWDOWN } from "./coverageFillPlan";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

let dir: string;
const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", ...args], { stdio: "ignore" });

/** A montage of `sec` seconds of genuinely moving picture, as the real one would be. */
function makeMontage(name: string, sec: number): string {
  const p = path.join(dir, name);
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", String(sec),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", p]);
  return p;
}

const PLAIN_HEAD = "[0:v]fps=25,format=yuv420p,setsar=1,setpts=PTS-STARTPTS[vmont]";

/**
 * The two production steps that turn a short montage into a frozen picture, run for real.
 *
 * 1. the mux: montage + voice, `-vsync cfr -t <voice>`. A montage shorter than the voice gives a
 *    file whose CONTAINER is the full length and whose video stream stops early.
 * 2. the final concat of the scenes. This is where the gap becomes frames: with a scene after it,
 *    cfr fills the hole by duplicating the last picture, which is what the viewer sees and what
 *    the stillness audit measures.
 *
 * Measured on the shape below, before the fix: a 21.2s container holding 8.5s of video, and after
 * concatenation 29.8s of video in a 42.4s film — 12.7s of it one repeated frame.
 */
async function composeAndConcat(
  name: string,
  montagePath: string,
  head: string,
  outDur: number
) {
  const audio = path.join(dir, `${name}_a.mp3`);
  ff(["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-t", outDur.toFixed(3), "-c:a", "libmp3lame", audio]);
  const scene = path.join(dir, `${name}_scene.mp4`);
  ff(["-i", montagePath, "-i", audio,
      "-filter_complex", `${head};[vmont]fps=25,format=yuv420p,setsar=1,setpts=PTS-STARTPTS[vout];` +
        `[1:a]atrim=0:${outDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]`,
      "-map", "[vout]", "-map", "[aout]", "-vsync", "cfr", "-t", outDur.toFixed(3),
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-pix_fmt", "yuv420p", scene]);

  // A second scene after it, because a gap at the very end of a film is never filled — it is the
  // gap BETWEEN scenes that becomes duplicated frames.
  const list = path.join(dir, `${name}.txt`);
  fs.writeFileSync(list, `file '${scene}'\nfile '${scene}'\n`);
  const film = path.join(dir, `${name}_film.mp4`);
  ff(["-fflags", "+discardcorrupt", "-f", "concat", "-safe", "0", "-i", list, "-vsync", "cfr",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac",
      "-movflags", "+faststart", film]);

  const stillness = await auditVideoStillness({ videoPath: film });
  return { film, stillness, verdict: checkStillnessLimit(stillness, stillImageMaxSec()) };
}

/** The production chain WITH the filler wired in. */
async function renderThroughChain(montagePath: string, montageDur: number, outDur: number) {
  return composeAndConcat(
    `fix_${path.basename(montagePath, ".mp4")}`,
    montagePath,
    montageTailPadVF("0:v", montageDur, outDur),
    outDur
  );
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r157-"));
}, 60_000);

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("RONDE 157 — the bug, reproduced from video 552's own numbers", () => {
  it("a montage shorter than the voice freezes when nothing fills the gap", async () => {
    // Scene 2's shape, at the size the pipeline actually produced it: 8.5s under 21.2s of voice.
    const montage = makeMontage("bug.mp4", 8.5);
    const { stillness } = await composeAndConcat("bug", montage, PLAIN_HEAD, 21.2);
    // This is the defect the viewer sees, measured end to end.
    expect(stillness.longestStillSec).toBeGreaterThan(stillImageMaxSec());
  }, 300_000);
});

describe("RONDE 157 — with the fix, the same shapes never freeze", () => {
  it("scene 2's shape: 8.5s of montage under 21.2s of voice", async () => {
    const montage = makeMontage("s2.mp4", 8.5);
    const ext = await extendMontageForCoverage(montage, 8.5, 21.2, 2, dir, 120_000, "-threads 2");
    // The 2x cap cannot reach 21.2s from 8.5s, so the montage is replayed first.
    expect(ext.dur).toBeGreaterThan(8.5);
    expect(ext.dur).toBeGreaterThanOrEqual(21.2 / MAX_COVERAGE_SLOWDOWN - 0.2);
    const { stillness, verdict } = await renderThroughChain(ext.path, ext.dur, 21.2);
    expect(verdict.ok).toBe(true);
    expect(stillness.longestStillSec).toBeLessThanOrEqual(stillImageMaxSec());
  }, 300_000);

  it("scene 1's shape: 16.9s of montage under 42.9s of voice — too big to loop in-filter", async () => {
    /**
     * 16.9s is 422 frames, past the 300-frame decode budget, so montageTailPadFilterChain would
     * hold a frame rather than loop. This is the case the file-level replay exists for.
     */
    const montage = makeMontage("s1.mp4", 16.9);
    const ext = await extendMontageForCoverage(montage, 16.9, 42.9, 1, dir, 180_000, "-threads 2");
    expect(ext.dur).toBeGreaterThan(16.9);
    const { stillness, verdict } = await renderThroughChain(ext.path, ext.dur, 42.9);
    expect(verdict.ok).toBe(true);
    expect(stillness.longestStillSec).toBeLessThanOrEqual(stillImageMaxSec());
  }, 300_000);

  it("a montage the cap can already cover is left alone — no needless repeat", async () => {
    // Scene 0's shape: 17.2s under 19.0s. Slowing 1.10x covers it, so nothing is replayed.
    const montage = makeMontage("s0.mp4", 17.2);
    const ext = await extendMontageForCoverage(montage, 17.2, 19.0, 0, dir, 120_000, "-threads 2");
    expect(ext.path).toBe(montage);
    expect(ext.dur).toBe(17.2);
  }, 180_000);

  it("it extends to the cap's reach, not to the full voice — the least repeat that works", () => {
    /**
     * Extending to outDur would put twice as much repeated picture on screen. RONDE 156 exists
     * because repetition is its own fault, so this takes the minimum that still avoids a freeze.
     */
    expect(PIPE).toContain("const needed = outDur / MAX_COVERAGE_SLOWDOWN;");
  });

  it("a failure leaves the montage untouched rather than leaving the scene blank", () => {
    const idx = PIPE.indexOf("export async function extendMontageForCoverage");
    const body = PIPE.slice(idx, idx + 3600);
    expect(body).toContain("const unchanged = { path: montagePath, dur: montageDur };");
    expect(body).toContain("} catch (err) {");
    expect(body).toContain("return unchanged;");
  });
});

describe("RONDE 157 — the mux is wired to the filler", () => {
  it("it probes the montage it is about to mux", () => {
    expect(PIPE).toContain("const probed = await probeVideoDurationSec(montageVideoPath);");
  });

  it("it uses the existing pad chain, not a new one", () => {
    // No second filler engine: montageTailPadVF is R85/111/130's single decision point.
    expect(PIPE).toContain('headChain = montageTailPadVF("0:v", montageDur, outDur);');
  });

  it("an unprobeable montage is reported, never silently skipped", () => {
    const idx = PIPE.indexOf("const probed = await probeVideoDurationSec(montageVideoPath);");
    const block = PIPE.slice(idx, idx + 1200);
    expect(block).toContain("could not probe montage length");
  });

  it("the mux reads the extended montage, not the original", () => {
    expect(PIPE).toContain('-y -i "${montageVideoIn}" -i "${safeAudioPath}"');
  });
});

describe("RONDE 157 — why every video used the same footage", () => {
  /**
   * The owner's second report: "alle video's die ik nu genereer hebben dezelfde beelden".
   *
   * Measured across the two most recent production renders on the same topic, from the archive
   * asset ids in their own logs:
   *
   *     video 551   21 archive assets
   *     video 552   47 archive assets
   *     shared      12 — 57% of video 551's footage came back in video 552
   *
   * The machinery against this exists: recordArchiveVideoUsage remembers what a video used, and
   * getCrossVideoExcludeAssetIds hands the next same-topic render a set to avoid. The READ side is
   * gated on archiveCrossVideoVarietyEnabled alone; the WRITE side carried a second condition,
   * curatedArchiveOnlyVisuals(), which is off in production. So nothing was ever written, the
   * exclude set was empty every time, and the ranking — deterministic by design — returned the
   * same top-scoring assets on every render.
   *
   * Neither production log contains a single [ArchiveVariety] line, which is what a write that
   * never happens looks like.
   */
  it("the write is gated on variety alone, like the read", () => {
    expect(PIPE).toContain("if (archiveCrossVideoVarietyEnabled(videoLength)) {\n      recordArchiveVideoUsage(");
  });

  it("the condition that silenced it is gone from the write", () => {
    const idx = PIPE.indexOf("recordArchiveVideoUsage(videoId,");
    const block = PIPE.slice(Math.max(0, idx - 400), idx);
    expect(block).not.toContain("curatedArchiveOnlyVisuals()");
  });

  it("under production's own flags, the old condition really was false", async () => {
    const { archiveCrossVideoVarietyEnabled, curatedArchiveOnlyVisuals } = await import("./sourcingPolicy");
    const prev = process.env.CURATED_ARCHIVE_ONLY;
    try {
      // The value production runs with, so the external cascade stays reachable (see F3-39).
      process.env.CURATED_ARCHIVE_ONLY = "false";
      expect(curatedArchiveOnlyVisuals()).toBe(false);
      expect(archiveCrossVideoVarietyEnabled("1-2")).toBe(true);
      // Old: variety AND archive-only → false, so nothing was recorded. New: variety alone → true.
      expect(archiveCrossVideoVarietyEnabled("1-2") && curatedArchiveOnlyVisuals()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CURATED_ARCHIVE_ONLY;
      else process.env.CURATED_ARCHIVE_ONLY = prev;
    }
  });

  it("what a render remembers is what the next one avoids", async () => {
    const { recordArchiveVideoUsage, getCrossVideoExcludeAssetIds } = await import("./archiveUsageMemory");
    const { applyCrossVideoVarietyDegrade } = await import("./curatedMediaSourcing");
    recordArchiveVideoUsage(95571, [56045, 56054, 56102], "What we didn't know about Hitler and WW2");
    const excluded = getCrossVideoExcludeAssetIds("Hitler and the Third Reich", 95572, 6);
    expect(excluded.has(56045)).toBe(true);
    // And the pool actually drops them, rather than merely knowing about them.
    const pool = [56045, 56054, 56102, 57001, 57002, 57003, 57004, 57005, 57006, 57007].map(
      (id) => ({ asset: { id } })
    ) as Parameters<typeof applyCrossVideoVarietyDegrade>[0];
    const kept = applyCrossVideoVarietyDegrade(pool, excluded).map((c) => c.asset.id);
    expect(kept).not.toContain(56045);
    expect(kept).toContain(57001);
  });
});

describe("RONDE 157 — no new hold site was introduced", () => {
  it("the clone-mode pad still lives in exactly the places earlier rounds counted", () => {
    /**
     * Five rounds (85-89) count clone-mode tpad sites as a guard against a freeze site appearing
     * unnoticed. This round adds none: it gives the existing site a longer montage so it is not
     * reached, rather than adding another way to hold a frame.
     */
    const holds = PIPE.match(/tpad=stop_mode=clone/g) ?? [];
    expect(holds.length).toBe(2);
  });

  it("the replay is a file-level stream_loop, which has no decode buffer", () => {
    const idx = PIPE.indexOf("export async function extendMontageForCoverage");
    const body = PIPE.slice(idx, idx + 3600);
    expect(body).toContain("-stream_loop ${plays - 1}");
    // Not the in-filter loop, whose 300-frame budget is what made this necessary.
    expect(body).not.toContain("loop=loop=");
  });
});
