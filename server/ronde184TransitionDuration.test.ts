/**
 * RONDE 184 — a video with transitions is exactly as long as the timeline says, voice included.
 *
 * ── The defect, as R182 measured it ──────────────────────────────────────────────────────────
 *
 *     timeline duration   12.00 s
 *     voice-over          12.00 s
 *     rendered MP4        10.70 s
 *     lost                 1.30 s  =  2 dissolves × 0.65 s
 *
 * ── Where the 1.30 s went ────────────────────────────────────────────────────────────────────
 *
 * `renderSegment` rendered every clip at exactly `timelineEnd - timelineStart`, and then the xfade
 * graph overlapped each join by the transition's own duration. A crossfade needs HANDLES — extra
 * material either side of the cut for the two pictures to blend over — and nothing was rendering
 * them, so the fade ate the programme instead. The loss was cumulative: after the first transition
 * every clip was out of step with the narration it had been cut to.
 *
 * The timeline was never wrong. The renderer was short of material.
 *
 * ── Why the fix keeps the look ───────────────────────────────────────────────────────────────
 *
 * The look is decided by `offset = elapsed - d`: the dissolve occupies the last `d` seconds before
 * the cut and the incoming clip is fully visible from the cut onward. That line is untouched.
 * Giving the INCOMING clip a `d`-second pre-roll keeps the same geometry and restores the total:
 * L₀ − d + (L₁ + d) = L₀ + L₁. Same place, same duration, same frames — the missing material is
 * simply there now.
 *
 * These tests measure the finished file with ffprobe. A filter string proves nothing about a
 * duration, which is exactly how the defect survived this long.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyTimeline, timelineElementId, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { renderTimeline } from "./timelineRenderer";
import { buildTransitionGraph, effectiveTransitionSec } from "./timelineFilters";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);
const FFMPEG = resolveFFmpegBin();

/* ═══════════════════════ the fixture ═══════════════════════ */

const CLIP_SEC = 4;
const CLIP_COUNT = 3;
const TRANSITION_SEC = 0.65;
const PLANNED_SEC = CLIP_SEC * CLIP_COUNT;

let dir = "";
const media: string[] = [];
let voicePath = "";

async function makeClip(colour: string, out: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${colour}:s=640x360:d=12:r=25`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out,
  ]);
}

/** A narration of EXACTLY the planned length, so "voice and picture agree" is measurable. */
async function makeVoice(out: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=220:duration=${PLANNED_SEC}`,
    "-c:a", "aac", "-b:a", "96k", out,
  ]);
}

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  return Number(stdout.trim());
}

function clip(i: number, transitionIn: string): TimelineVideoClip {
  return {
    id: timelineElementId("clip", "r184", i),
    kind: "video",
    source: { provider: "internet_archive", providerAssetId: `r184-${i}` },
    /**
     * A real in-point, several seconds in, so the pre-roll handle has material to read BEFORE it —
     * which is the case the fix is designed around. The zero-in-point case has its own test below.
     */
    sourceIn: 3,
    timelineStart: i * CLIP_SEC,
    timelineEnd: (i + 1) * CLIP_SEC,
    transitionIn: i === 0 ? "hard_cut" : transitionIn,
    transitionInSec: TRANSITION_SEC,
    transitionOut: "hard_cut",
    previewSource: "asset",
  } as TimelineVideoClip;
}

function timelineWith(transitionIn: string, opts: { voice?: boolean } = {}): ProjectTimeline {
  const t = emptyTimeline(184);
  t.durationSec = PLANNED_SEC;
  t.tracks = [
    { kind: "VIDEO", clips: Array.from({ length: CLIP_COUNT }, (_, i) => clip(i, transitionIn)) },
    {
      kind: "VOICE",
      clips: opts.voice
        ? [{
            id: "voice-1",
            source: { provider: "narration", canonicalUrl: "file://voice" },
            start: 0,
            end: PLANNED_SEC,
            gain: 1,
          }]
        : [],
    },
    { kind: "MUSIC", clips: [] },
    { kind: "SFX", clips: [] },
    { kind: "CAPTIONS", captions: [] },
    { kind: "AMBIENT", clips: [] },
    { kind: "TEXT", texts: [] },
    { kind: "GRAPHICS", graphics: [] },
  ] as never;
  return t;
}

async function render(t: ProjectTimeline, name: string) {
  const out = path.join(dir, `${name}.mp4`);
  const result = await renderTimeline({
    timeline: t,
    workDir: path.join(dir, `work_${name}`),
    outputPath: out,
    resolveMedia: async (c) => {
      const i = Number((c.source.providerAssetId ?? "").replace("r184-", ""));
      return Number.isFinite(i) ? media[i] ?? null : null;
    },
    resolveAudio: async () => voicePath,
  });
  return { out, result, durationSec: await probeDuration(out) };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "r184-"));
  for (const [i, colour] of ["red", "green", "blue"].entries()) {
    const p = path.join(dir, `src_${i}.mp4`);
    await makeClip(colour, p);
    media.push(p);
  }
  voicePath = path.join(dir, "voice.m4a");
  await makeVoice(voicePath);
}, 300_000);

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ═══════════════════════ the arithmetic, before the render ═══════════════════════ */

describe("R184 — the handle arithmetic, stated plainly", () => {
  /**
   * The bug in one assertion. Three 4-second segments with two 0.65s dissolves come out at 10.70s,
   * which is what the renderer used to hand ffmpeg.
   */
  it("without handles, the chain is shorter than the slots by the sum of the fades", () => {
    const graph = buildTransitionGraph({
      durations: [4, 4, 4],
      transitions: [
        { kind: "hard_cut" },
        { kind: "dissolve", durationSec: TRANSITION_SEC },
        { kind: "dissolve", durationSec: TRANSITION_SEC },
      ],
    })!;
    expect(graph.totalSec).toBeCloseTo(12 - 2 * TRANSITION_SEC, 3);
  });

  /** And with the pre-roll on each incoming clip it comes back to the sum of the slots exactly. */
  it("with a handle on each incoming clip, the chain is exactly the sum of the slots", () => {
    const graph = buildTransitionGraph({
      durations: [4, 4 + TRANSITION_SEC, 4 + TRANSITION_SEC],
      transitions: [
        { kind: "hard_cut" },
        { kind: "dissolve", durationSec: TRANSITION_SEC },
        { kind: "dissolve", durationSec: TRANSITION_SEC },
      ],
    })!;
    expect(graph.totalSec).toBeCloseTo(12, 3);
  });

  /**
   * The look is decided here and it is unchanged: the first dissolve still ends at the cut, so the
   * incoming clip is fully visible from its own timelineStart.
   */
  it("the dissolve still ends exactly on the cut, which is what keeps the look", () => {
    const graph = buildTransitionGraph({
      durations: [4, 4 + TRANSITION_SEC, 4 + TRANSITION_SEC],
      transitions: [
        { kind: "hard_cut" },
        { kind: "dissolve", durationSec: TRANSITION_SEC },
        { kind: "dissolve", durationSec: TRANSITION_SEC },
      ],
    })!;
    /** offset = 4 − 0.65: the fade runs 3.35 → 4.00, and clip 2's slot starts at 4.00. */
    expect(graph.filter).toContain("offset=3.350");
    /** The second fade ends on the second cut, at 8.00. */
    expect(graph.filter).toContain("offset=7.350");
  });

  /**
   * One clamp, two callers. The renderer needs this number BEFORE it renders a segment and the
   * graph needs it after; two copies is how the handle and the fade drift apart.
   */
  it("the renderer and the graph share one clamp", () => {
    expect(effectiveTransitionSec("dissolve", 0.65, 4, 4)).toBeCloseTo(0.65, 5);
    /** Never more than the smaller neighbour's half-length, or xfade's offset goes negative. */
    expect(effectiveTransitionSec("dissolve", 5, 4, 1)).toBeCloseTo(0.5, 5);
    /** A hard cut is not an xfade at all, so there is no handle to render. */
    expect(effectiveTransitionSec("hard_cut", 0.65, 4, 4)).toBeNull();
  });
});

/* ═══════════════════════ the render ═══════════════════════ */

describe("R184 — the finished file, measured", () => {
  it("a plan with two dissolves renders at exactly the planned length", async () => {
    const t = timelineWith("dissolve");
    const { durationSec, result } = await render(t, "dissolve");
    expect(result.transitionsRendered, "no transition was rendered").toBe(2);
    const frame = 1 / t.format.fps;
    expect(
      Math.abs(durationSec - PLANNED_SEC),
      `planned ${PLANNED_SEC}s, rendered ${durationSec.toFixed(3)}s`
    ).toBeLessThan(2 * frame);
  }, 180_000);

  /** Voice and picture end together — the thing the 1.30s loss actually broke. */
  it("the picture does not end before the narration", async () => {
    const t = timelineWith("dissolve", { voice: true });
    const { durationSec } = await render(t, "voiced");
    const voiceSec = await probeDuration(voicePath);
    expect(voiceSec).toBeCloseTo(PLANNED_SEC, 1);
    expect(durationSec).toBeGreaterThan(voiceSec - 2 / t.format.fps);
  }, 180_000);

  /** The renderer's own guard agrees, and stays as the tripwire for a future regression. */
  it("reports no shortfall", async () => {
    const { result } = await render(timelineWith("dissolve"), "guard");
    const shortfall = result.skipped.filter((s) => s.startsWith("transition_overlap:"));
    expect(shortfall, shortfall.join("\n")).toEqual([]);
  }, 180_000);

  /**
   * A cuts-only timeline must still take the stream-copy path and be untouched by any of this —
   * that is the path RONDE 144's golden render measures bit for bit.
   */
  it("a cuts-only timeline is unaffected and still exactly its planned length", async () => {
    const t = timelineWith("hard_cut");
    const { durationSec, result } = await render(t, "cuts");
    expect(result.transitionsRendered).toBe(0);
    const frame = 1 / t.format.fps;
    expect(Math.abs(durationSec - PLANNED_SEC)).toBeLessThan(2 * frame);
  }, 180_000);

  /**
   * A source with nothing before its in-point cannot supply a pre-roll. The LENGTH must still be
   * right — that is the whole point — and the difference must be reported rather than absorbed.
   */
  it("still renders the full length when the source has no material before the in-point", async () => {
    const t = timelineWith("dissolve");
    for (const track of t.tracks) {
      if (track.kind === "VIDEO") for (const c of track.clips) c.sourceIn = 0;
    }
    const { durationSec, result } = await render(t, "nohandle");
    const frame = 1 / t.format.fps;
    expect(Math.abs(durationSec - PLANNED_SEC)).toBeLessThan(2 * frame);
    const reported = result.skipped.filter((s) => s.startsWith("transition_handle "));
    expect(reported.length, "the missing pre-roll was absorbed silently").toBe(2);
  }, 180_000);
});
