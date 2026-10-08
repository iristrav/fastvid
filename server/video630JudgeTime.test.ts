/**
 * P5 / VIDEO 630 — THE PICTURE EDITOR GETS THE TIME TO LOOK, AND A LOOK UNDER WAY IS NOT LOST.
 *
 * Render 630: stock ready before the picture clock, 255 s for 17 sentences, sentences opening with
 * 2–13 s, and the one fit for scene 0 arriving 10 s after its sentence's search had been cut. These
 * tests run the real allocation functions (chunk share → scene → sentence → search share) and the
 * real `resolveWithinBeatTurn`; seconds are scaled to milliseconds where a clock actually runs.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  BEAT_RESOLVE_SHARE,
  JUDGED_BEAT_TURN_MS,
  YOUTUBE_STOCK_WAIT_MAX_MS,
  beatShareOfSceneTimeMs,
  chunkShareOfVisualTimeMs,
  judgeableVisualDeadlineMs,
  resolveWithinBeatTurn,
  visualDeadlineForVideoMs,
  withSceneFetchTimeout,
} from "./videoPipeline";
import { MAX_STOCK_VIDEOS } from "./youtubeShotStock";
import { maxPipelineWallClockHardMin, pipelineEmergencyFinishMs, visualStageWallClockMin, youtubeDownloadTimeoutMs, youtubeMaxDownloadsPerRender } from "./sourcingPolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The short-video cap the pipeline passes: the visual stage wall clock, never past force-export. */
const SHORT_CAP = Math.min(visualStageWallClockMin("1") * 60_000, pipelineEmergencyFinishMs("1"));

/**
 * What one sentence's own search gets, by the pipeline's own allocation: the chunk's share of the
 * picture time, the scene inside it (scenes in a chunk run side by side), the sentence's share of
 * its scene (sentences run one after another), and the search share of that turn.
 */
function searchShareOfFirstSentence(deadlineMs: number, chunkScenes: number, scenesTotal: number, sentencesInScene: number): number {
  const chunkMs = chunkShareOfVisualTimeMs(deadlineMs, chunkScenes, scenesTotal);
  const turnMs = beatShareOfSceneTimeMs(chunkMs, 5, 5 * sentencesInScene);
  return turnMs * BEAT_RESOLVE_SHARE;
}

describe("A — a short video with several sentences gets time to judge", () => {
  it("a 60 s film of three scenes in one chunk: every sentence has a judged turn", () => {
    const base = visualDeadlineForVideoMs(35_000 * 3, 60);
    const deadline = judgeableVisualDeadlineMs(base, [[3, 4, 3]], SHORT_CAP);
    expect(deadline).toBe(Math.max(base, 4 * JUDGED_BEAT_TURN_MS));
    expect(searchShareOfFirstSentence(deadline, 3, 3, 4)).toBeGreaterThanOrEqual(30_000);
  });

  it("video 630's shape (scenes of 4 and 8 sentences, then 5): 255 s became 480 s", () => {
    const base = visualDeadlineForVideoMs(85_000 * 3, 89.5);
    expect(Math.round(base / 1000)).toBe(255);
    const deadline = judgeableVisualDeadlineMs(base, [[4, 8], [5]], SHORT_CAP);
    expect(deadline).toBe(480_000);
    /** The eight-sentence scene: about 16 s of search per sentence before, 30 s now. */
    expect(searchShareOfFirstSentence(base, 2, 3, 8)).toBeLessThan(16_000);
    expect(searchShareOfFirstSentence(deadline, 2, 3, 8)).toBeGreaterThanOrEqual(30_000);
  });
});

describe("B — nothing starts with no time, and a turn that has ended is not waited for", () => {
  it("a sentence whose scene has no time left starts no search and no look", async () => {
    let started = false;
    await expect(
      withSceneFetchTimeout(
        async () => {
          await sleep(30);
          return resolveWithinBeatTurn(async () => { started = true; return "clip"; }, 20, Date.now() + 20, "late sentence");
        },
        10,
        "scene"
      )
    ).rejects.toThrow();
    await sleep(40);
    expect(started).toBe(false);
  });

  it("when the turn is already over at the cut, nothing is awaited", async () => {
    const t0 = Date.now();
    const r = await resolveWithinBeatTurn(() => sleep(500).then(() => "clip"), 20, Date.now() + 10, "beat");
    expect(r).toMatchObject({ value: null, late: false });
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

describe("C/D — a look that finishes inside the sentence's turn is used, never lost", () => {
  it("render 630's s0b3, at 1 s = 1 ms: turn 50, search cut at 37, verdict at 47 — the clip is used", async () => {
    const t0 = Date.now();
    const r = await resolveWithinBeatTurn(() => sleep(47).then(() => "s0b3_youtube_fit.mp4"), 37, t0 + 50, "s0b3");
    expect(r.value).toBe("s0b3_youtube_fit.mp4");
    expect(r.late).toBe(true);
    expect(r.error?.message).toContain("exceeded");
  });

  it("a look inside the search share is used at once, as before", async () => {
    const r = await resolveWithinBeatTurn(() => sleep(5).then(() => "clip"), 50, Date.now() + 100, "beat");
    expect(r).toEqual({ value: "clip", late: false });
  });

  it("the loop pushes what the late look returned through the same push as any clip", () => {
    const loop = PIPE.slice(PIPE.indexOf("const resolved = await resolveWithinBeatTurn("));
    expect(loop.indexOf("clip = resolved.value;")).toBeGreaterThan(-1);
    expect(loop.indexOf("clip = resolved.value;")).toBeLessThan(loop.indexOf('await withAdoptionIntent("beat_fetch", () => pushClip(clip!));'));
    expect(loop).toContain("beatDeadlineMs,");
  });
});

describe("G — never an unbounded wait for the picture editor", () => {
  it("a look that never answers is given up at the end of the sentence's turn", async () => {
    const t0 = Date.now();
    const r = await resolveWithinBeatTurn(() => new Promise<string>(() => {}), 20, t0 + 60, "hung look");
    expect(r).toMatchObject({ value: null, late: false });
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(55);
    expect(waited).toBeLessThan(400);
  });

  it("a look that fails is not waited for", async () => {
    const t0 = Date.now();
    const r = await resolveWithinBeatTurn(() => sleep(30).then(() => { throw new Error("vision down"); }), 10, t0 + 5_000, "beat");
    expect(r.value).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("E/F — the hard limits stay, and a long video is still bounded", () => {
  it("download, stock and search limits are unchanged", () => {
    expect(youtubeMaxDownloadsPerRender()).toBe(60);
    expect(youtubeDownloadTimeoutMs()).toBe(180_000);
    expect(MAX_STOCK_VIDEOS).toBe(10);
    expect(YOUTUBE_STOCK_WAIT_MAX_MS).toBe(180_000);
  });

  it("the picture time never passes the visual stage wall clock or force-export", () => {
    /** A long film: forty chunks of eight sentences would ask for four hours. */
    const longCap = Math.min(visualStageWallClockMin("8-10") * 60_000, pipelineEmergencyFinishMs("8-10"));
    const deadline = judgeableVisualDeadlineMs(0, Array.from({ length: 40 }, () => [8, 6]), longCap);
    expect(deadline).toBe(longCap);
    expect(deadline).toBeLessThan(maxPipelineWallClockHardMin("8-10") * 60_000);
    expect(judgeableVisualDeadlineMs(0, [[20, 20]], SHORT_CAP)).toBe(SHORT_CAP);
    expect(SHORT_CAP).toBeLessThan(maxPipelineWallClockHardMin("1") * 60_000);
  });

  it("a film whose length already asks for more keeps it: the floor never lowers a deadline", () => {
    expect(judgeableVisualDeadlineMs(900_000, [[2]], SHORT_CAP)).toBe(900_000);
  });

  it("the pipeline passes that cap, and the per-sentence floor is read from the chunks it walks", () => {
    expect(PIPE).toContain("Math.min(visualStageTimeoutMs(videoLength, perf), pipelineEmergencyFinishMs(videoLength))");
    expect(PIPE).toContain("chunks.map((c) =>");
  });
});

describe("H — video 629/630: YouTube is still gathered before the picture clock", () => {
  it("the stock wait comes first, then the clock, then the judged deadline", () => {
    const wait = PIPE.indexOf("await waitForYoutubeStockBeforePictures(videoId, {");
    const clock = PIPE.indexOf("visualDedup.pipelineStartedMs = Date.now();");
    const deadline = PIPE.indexOf("const visualDeadlineMs = judgeableVisualDeadlineMs(");
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(clock);
    expect(clock).toBeLessThan(deadline);
  });
});

/**
 * PRODUCTION-REALISTIC — render 630's shape at 1 s = 10 ms: chunk 1 runs scenes of 4 and 8 sentences
 * side by side, chunk 2 one scene of 3; 27 stock shots ready; every sentence needs 8 s to line up
 * its candidates and then the picture editor looks one candidate at a time, 10–20 s a look, until
 * one fits. Old and new deadline are run through the same loop.
 */
async function runFilm(deadlineMs: number): Promise<{ placed: number; keptLate: number; sentences: number }> {
  const scenes = [[4, 8], [3]];
  const scale = 1 / 100;
  /** Which look fits, per sentence: the first, second or third candidate. */
  const fitsAt = (s: number, b: number) => ((s * 7 + b * 3) % 3) + 1;
  const lookMs = (s: number, b: number, k: number) => 10_000 + (((s + b + k) * 37) % 11) * 1_000;
  let placed = 0;
  let keptLate = 0;
  let sentences = 0;
  let left = deadlineMs;
  const startAll = Date.now();
  let sceneId = 0;
  for (const chunk of scenes) {
    const chunkMs = chunkShareOfVisualTimeMs(left, chunk.length, scenes.flat().length - (sceneId));
    const chunkStart = Date.now();
    await Promise.all(
      chunk.map(async (n, i) => {
        const s = sceneId + i;
        const sceneEnd = chunkStart + chunkMs * scale;
        for (let b = 0; b < n; b++) {
          sentences++;
          const sceneLeft = (sceneEnd - Date.now()) / scale;
          const turn = beatShareOfSceneTimeMs(sceneLeft, 5, 5 * (n - b));
          const turnEnd = Date.now() + turn * scale;
          const search = async () => {
            await sleep(8_000 * scale);
            for (let k = 1; k <= 3; k++) {
              await sleep(lookMs(s, b, k) * scale);
              if (k === fitsAt(s, b)) return `s${s}b${b}`;
            }
            return null;
          };
          const r = await resolveWithinBeatTurn(search, Math.max(1, turn * BEAT_RESOLVE_SHARE * scale), turnEnd, `s${s}b${b}`);
          if (r.value) {
            placed++;
            if (r.late) keptLate++;
          }
          const rest = turnEnd - Date.now();
          if (rest > 0) await sleep(rest);
        }
      })
    );
    sceneId += chunk.length;
    left = deadlineMs - (Date.now() - startAll) / scale;
  }
  return { placed, keptLate, sentences };
}

describe("production-realistic: render 630's shape, old and new picture time", () => {
  it("the new deadline places a judged clip for most sentences; the old one for few", async () => {
    const base = visualDeadlineForVideoMs(85_000 * 3, 89.5);
    const before = await runFilm(base);
    const after = await runFilm(judgeableVisualDeadlineMs(base, [[4, 8], [3]], SHORT_CAP));
    expect(before.sentences).toBe(15);
    expect(after.sentences).toBe(15);
    /** Measured: 4 of 15 before, 10 of 15 after; the margin absorbs a loaded test machine's clock. */
    expect(before.placed).toBeLessThanOrEqual(5);
    expect(after.placed).toBeGreaterThanOrEqual(8);
    expect(after.placed - before.placed).toBeGreaterThanOrEqual(3);
    /** Some of those were looks that finished after the search share: kept, not lost. */
    expect(after.keptLate).toBeGreaterThan(0);
  }, 60_000);
});

/* ═══════════ SAFETY — a clip enters the film only on the picture editor's yes ═══════════ */

import { adoptionGuardVerdict, visionVerdictFromGate } from "./adoptionPolicy";

/**
 * Every clip a sentence places — its own search, the look that finished late inside its turn, the
 * fill — goes through `pushSceneClip` under the adoption intent `beat_fetch` (REAL_FUNNEL). At that
 * push `visualJudgeRefusesPush` reads the verdict and this rule decides. A look that was declined,
 * timed out, answered nothing or failed is not a yes, and is refused.
 */
describe("SAFETY — only an approved verdict places a clip", () => {
  const atPush = (verdict: string | null, evaluated?: boolean) =>
    adoptionGuardVerdict({ source: "beat_fetch", eligible: true, vision: visionVerdictFromGate(verdict, evaluated) });

  it("a look declined before it started (nobody looked) → not placed", () => {
    expect(atPush("unknown", false)).toMatchObject({ allowed: false, code: "FUNNEL_WITHOUT_EVIDENCE" });
    expect(atPush(null, false).allowed).toBe(false);
  });

  it("a look that timed out, answered nothing or failed (no usable answer) → not placed", () => {
    expect(atPush("unknown", true)).toMatchObject({ allowed: false, code: "FUNNEL_WITHOUT_EVIDENCE" });
    expect(atPush(null).allowed).toBe(false);
  });

  it("a refusal → not placed; an approval → placed through the normal push", () => {
    expect(atPush("does_not_fit", true).allowed).toBe(false);
    expect(atPush("fits", true)).toMatchObject({ allowed: true, visionEvidence: "APPROVED" });
  });

  it("an approved clip still needs eligibility: the fit alone does not let a clip in", () => {
    expect(adoptionGuardVerdict({ source: "beat_fetch", eligible: false, vision: "APPROVED" }).allowed).toBe(false);
  });

  it("the late look and the fill reach the film only through that same push", () => {
    const fn = PIPE.slice(PIPE.indexOf("const pushSceneClip = async"), PIPE.indexOf("return { clips: usable, beatDurations: usableDurations, clipBeatIndices: usableBeatIndices };"));
    /** One writer of the scene's clips, and it asks the gate first. */
    expect(fn.match(/clips\.push\(/g)).toHaveLength(1);
    expect(fn.indexOf("if (await beatClipRefusedByRelevanceGate(dedup, clipPath, scene.index, beatIndex)) return false;"))
      .toBeLessThan(fn.indexOf("clips.push(clipPath);"));
    expect(fn).toContain('await withAdoptionIntent("beat_fetch", () => pushClip(clip!));');
    expect(fn).toContain('const ok = await withAdoptionIntent("beat_fetch", () => pushSceneClip(clipPath, rest, f.beat.index));');
    expect(fn.match(/pushSceneClip\(clipPath, holdSec, beat\.index\)/g)).toHaveLength(1);
  });

  it("a look that finishes after the sentence's turn is not used: nothing is returned to place", async () => {
    const t0 = Date.now();
    const r = await resolveWithinBeatTurn(() => sleep(80).then(() => "approved_too_late.mp4"), 10, t0 + 30, "beat");
    expect(r.value).toBeNull();
    await sleep(70);
    expect(r.value).toBeNull();
  });
});
