/**
 * VIDEO 647 — ENOUGH TIME FOR REAL PICTURES, NEVER THE BLUE-GREY GROUND INSTEAD.
 *
 * Render 646 printed, for the scenes that found nothing:
 *
 *     [Pipeline] Visual stage cap hit chunk 1/1 (2/3 scenes done) — Timeout … exceeded 270s
 *     [MainSubject] video=646 scene(s) 1 found nothing — searching on "…" only, 60s
 *     [SceneFetchScope] SCOPE_EXPIRED label="youtube-first s0 b0" — opened 29s after the budget …
 *
 * The rescue of the empty scenes got `max(deadline left, 60 s)`: the deadline had passed, so
 * twelve sentences shared one minute and their per-sentence scopes opened inside an ended
 * budget. That was the last budget in the picture stage that cut a usable YouTube route short
 * on an internal estimate. These tests pin the widened window against 646's own numbers and
 * pin the rest of the chain around it: the stage deadline of a long film, what happens to an
 * approved picture when a later phase runs long, that no budget overrun ever puts the blue-grey
 * chapter-card ground under a sentence, that a provider that never answers cannot hang the
 * render, that the rescue walks the same source ladder as the first search, and that the final
 * gate refuses a film that is not complete.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  EMPTY_SCENE_RESCUE_MIN_MS,
  JUDGED_BEAT_TURN_MS,
  PICTURE_SEC_PER_VIDEO_SEC,
  emptySceneRescueWindowMs,
  judgeableVisualDeadlineMs,
  sceneClipsKeptAtDeadline,
  visualDeadlineForVideoMs,
  withSceneFetchTimeout,
} from "./videoPipeline";
import {
  YOUTUBE_FIRST_BEAT_WORST_MS,
  YOUTUBE_FIRST_TURN_MS,
  maxPipelineWallClockHardMin,
  pictureStageWallClockCeilingMs,
  visualStageWallClockMin,
  youtubeDownloadTimeoutMs,
} from "./sourcingPolicy";
import { deliveryGate, type PlaceholderCheckFacts } from "./deliveryGate";
import { sentenceCoverage } from "./sentenceCoverage";
import { emptyTimeline, graphicsTrack, videoTrack, type ProjectTimeline, type TimelineGraphic, type TimelineVideoClip } from "./projectTimeline";
import { stripComments } from "./sourceScan.test.support";

const RAW = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const PIPE = stripComments(RAW);

/** The rescue block as the pipeline runs it: from its heading to the line that leaves a scene empty. */
function rescueBlock(): string {
  const a = RAW.indexOf("VIDEO 621 — A SCENE THAT FOUND NOTHING SEARCHES ONCE MORE");
  const b = RAW.indexOf("no picture found — the timeline holds the previous shot", a);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  return stripComments(RAW.slice(a, b));
}

/** Render 646: three scenes, 6 + 4 + 2 sentences, the deadline 29 s gone when the rescue opened. */
const R646 = { sentences: [6, 4, 2], deadlineLeftMs: -29_000, sceneParallelism: 3, oldWindowMs: 60_000 };

describe("1. an expired picture budget does not skip the rescue's meaningful chances", () => {
  it("646 replayed: the empty scenes get one YouTube worst case per sentence, not 60 s between them", () => {
    const w = emptySceneRescueWindowMs({ ...R646, sentencesPerEmptyScene: R646.sentences, ceilingLeftMs: Number.POSITIVE_INFINITY });
    expect(w).toBe(6 * YOUTUBE_FIRST_BEAT_WORST_MS);
    expect(w).toBeGreaterThan(R646.oldWindowMs * 10);
  });

  it("never less than before: the deadline left and the 60 s floor are still inside the window", () => {
    for (const left of [-600_000, -29_000, 0, 1, 30_000, 59_999, 60_000, 400_000, 2_000_000]) {
      const w = emptySceneRescueWindowMs({ deadlineLeftMs: left, sentencesPerEmptyScene: [1], sceneParallelism: 3, ceilingLeftMs: Number.POSITIVE_INFINITY });
      expect(w, `deadline left ${left}`).toBeGreaterThanOrEqual(Math.max(left, EMPTY_SCENE_RESCUE_MIN_MS));
    }
  });

  it("scenes queue `sceneParallelism` at a time: six two-sentence scenes on three lanes are two rounds", () => {
    const w = emptySceneRescueWindowMs({ deadlineLeftMs: 0, sentencesPerEmptyScene: [2, 2, 2, 2, 2, 2], sceneParallelism: 3, ceilingLeftMs: Number.POSITIVE_INFINITY });
    expect(w).toBe(2 * 2 * YOUTUBE_FIRST_BEAT_WORST_MS);
    /** A scene whose text split into no sentence still gets one turn. */
    expect(emptySceneRescueWindowMs({ deadlineLeftMs: 0, sentencesPerEmptyScene: [0], sceneParallelism: 1, ceilingLeftMs: Number.POSITIVE_INFINITY })).toBe(YOUTUBE_FIRST_BEAT_WORST_MS);
  });

  it("wiring: the pipeline sizes the window on the empty scenes' sentences and the render's own clocks", () => {
    const block = rescueBlock();
    expect(block).toContain("const windowMs = emptySceneRescueWindowMs({");
    expect(block).toContain("deadlineLeftMs: visualDeadlineAtMs - Date.now(),");
    expect(block).toContain("sentencesPerEmptyScene: empty.map((si) => sentencesOf(scenes[si]!.text ?? \"\").length),");
    expect(block).toContain("sceneParallelism: perf.sceneParallelism,");
    expect(block).toContain("ceilingLeftMs: pictureStageLeftMs(),");
    expect(block).not.toContain("pipelineEmergencyFinishMs");
    expect(PIPE).not.toContain("Math.max(visualDeadlineAtMs - Date.now(), EMPTY_SCENE_RESCUE_MIN_MS)");
  });
});

describe("2. a long film is not cut by a per-second budget", () => {
  it.each([
    ["8-10", 600, 30, 5, 6],
    ["10-15", 900, 45, 5, 6],
    ["30", 1_800, 90, 4, 6],
  ])("length %s: every scene's sentences get their judged turns, inside the stage cap", (len, videoSec, scenes, perScene, chunkSize) => {
    const byLength = visualDeadlineForVideoMs(35_000 * scenes, videoSec);
    expect(byLength).toBeCloseTo(videoSec * PICTURE_SEC_PER_VIDEO_SEC * 1000, -2);
    const chunks: number[][] = [];
    for (let i = 0; i < scenes; i += chunkSize) chunks.push(Array(Math.min(chunkSize, scenes - i)).fill(perScene));
    const floor = chunks.length * perScene * JUDGED_BEAT_TURN_MS;
    /** VIDEO 647 (F3): the cap is the picture stage's own, never force-export */
    const cap = Math.min(visualStageWallClockMin(len) * 60_000, pictureStageWallClockCeilingMs(len));
    const deadline = judgeableVisualDeadlineMs(byLength, chunks, cap);
    expect(deadline).toBeGreaterThan(byLength);
    expect(deadline).toBe(Math.max(byLength, Math.min(floor, cap)));
    expect(floor).toBeLessThanOrEqual(cap);
    /** And the hard wall-clock fail stays after the whole picture stage and its rescue. */
    expect(maxPipelineWallClockHardMin(len) * 60_000).toBeGreaterThan(cap + EMPTY_SCENE_RESCUE_MIN_MS);
  });
});

describe("3. a YouTube result and its download get enough time, inside the technical bounds", () => {
  it("each sentence's share of the rescue holds a full search + pool wait + download timeout", () => {
    for (const n of [1, 2, 4, 6, 9]) {
      const w = emptySceneRescueWindowMs({ deadlineLeftMs: -1, sentencesPerEmptyScene: [n], sceneParallelism: 3, ceilingLeftMs: Number.POSITIVE_INFINITY });
      expect(w / n).toBeGreaterThanOrEqual(YOUTUBE_FIRST_BEAT_WORST_MS);
      expect(w / n).toBeGreaterThanOrEqual(youtubeDownloadTimeoutMs());
      expect(w / n).toBeGreaterThanOrEqual(YOUTUBE_FIRST_TURN_MS + 60_000);
    }
  });

  it("the picture stage's ceiling (the target wall clock) bounds it; past it the 60 s floor holds as it did", () => {
    const wide = { deadlineLeftMs: -29_000, sentencesPerEmptyScene: [6, 4, 2], sceneParallelism: 3 };
    expect(emptySceneRescueWindowMs({ ...wide, ceilingLeftMs: 600_000 })).toBe(600_000);
    expect(emptySceneRescueWindowMs({ ...wide, ceilingLeftMs: 90_000 })).toBe(90_000);
    expect(emptySceneRescueWindowMs({ ...wide, ceilingLeftMs: 10_000 })).toBe(EMPTY_SCENE_RESCUE_MIN_MS);
    expect(emptySceneRescueWindowMs({ ...wide, ceilingLeftMs: -120_000 })).toBe(EMPTY_SCENE_RESCUE_MIN_MS);
    /** The window is a scope, not a wait: the pipeline still opens it with `withSceneFetchTimeout`. */
    const block = rescueBlock();
    expect(block).toContain("await withSceneFetchTimeout(");
    expect(block).toContain("`Main-subject search chunk ${chunkIdx + 1}/${chunks.length}`");
  });

  it("the technical timeouts around a download are untouched", () => {
    expect(youtubeDownloadTimeoutMs()).toBe(180_000);
    expect(PIPE).toContain("const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = 12_000;");
    expect(PIPE).toContain("const YOUTUBE_COOLDOWN_MS = 3 * 60_000;");
    expect(PIPE).toContain("const VISUAL_PROVIDER_FAILURE_STREAK_TRIP = 3;");
  });
});

describe("4. an approved YouTube picture is kept when another phase runs longer", () => {
  it("what a scene had approved before its clock ran out stays with its sentence", () => {
    const kept = sceneClipsKeptAtDeadline({
      clips: ["/w/youtube_cc_abc.mp4", "/w/scene1_fallback.mp4", "/w/youtube_cc_def.mp4"],
      beatDurations: [4.2, 3, 5.1],
      clipBeatIndices: [0, 1, 2],
    });
    expect(kept.clips).toEqual(["/w/youtube_cc_abc.mp4", "/w/youtube_cc_def.mp4"]);
    expect(kept.beatDurations).toEqual([4.2, 5.1]);
    expect(kept.clipBeatIndices).toEqual([0, 2]);
    /** A clip whose sentence is not known is not handed to any sentence. */
    expect(sceneClipsKeptAtDeadline({ clips: ["/w/youtube_cc_x.mp4"], beatDurations: [3] }).clips).toEqual([]);
  });

  it("wiring: when the rescue's time is up, the approved pictures it found are kept — after the catch, before the scene is left empty", () => {
    const block = rescueBlock();
    const timeUp = block.indexOf("time is up:");
    const kept = block.indexOf("const kept = sceneClipsKeptAtDeadline(visualDedup.sceneClipsSoFar?.get(scenes[si]!.index));");
    expect(timeUp).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(timeUp);
    expect(block).toContain("if (kept.clips.length > 0) sceneVisualResults[si] = kept;");
    /** The same keep stands at the chunk deadline, before the rescue. */
    const chunkKeep = PIPE.indexOf("keptAtDeadline.add(si);");
    expect(chunkKeep).toBeGreaterThan(0);
    expect(chunkKeep).toBeLessThan(PIPE.indexOf("const windowMs = emptySceneRescueWindowMs({"));
  });
});

/* ───────────── gate fixtures (local, synthetic; no network, no provider) ───────────── */

function clip(id: string, start: number, end: number, beat: [number, number] = [0, 0], approved = true): TimelineVideoClip {
  return {
    id,
    kind: "video",
    source: { provider: "youtube_cc", providerAssetId: id, archiveAssetId: 1, ...(approved ? { contentApproval: "judge_fit" as const } : {}) },
    sourceIn: 10,
    sourceOut: 10 + (end - start),
    timelineStart: start,
    timelineEnd: end,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
    sceneIndex: beat[0],
    beatIndex: beat[1],
  } as TimelineVideoClip;
}
function card(id: string, start: number, end: number, beat: [number, number] = [0, 0]): TimelineGraphic {
  return { id, graphicType: "chapter_card", data: { primaryVisual: true, sceneIndex: beat[0], beatIndex: beat[1] }, start, end } as TimelineGraphic;
}
function timeline(o: { sentences: ProjectTimeline["sentences"]; clips?: TimelineVideoClip[]; graphics?: TimelineGraphic[] }): ProjectTimeline {
  const t = emptyTimeline(647);
  t.durationSec = 10;
  videoTrack(t).push(...(o.clips ?? []));
  graphicsTrack(t).push(...(o.graphics ?? []));
  t.sentences = o.sentences;
  return t;
}
const sentence = (s: number, b: number, start: number, end: number) => ({ sceneIndex: s, beatIndex: b, startSec: start, endSec: end, timingBasis: "measured" as const, text: `Sentence ${s}-${b}.` });
const base = { videoId: 647, route: "cinematic_timeline" as const, timelineExists: true, clips: [], delivered: null, assetsOnly: true };
const cleanScan: PlaceholderCheckFacts = { method: "all_frames", complete: true, framesSampled: 250, placeholderFrames: 0, placeholderSec: 0, plannedCardSec: 0, confirmedPlaceholderSec: 0, indicatedPlaceholderSec: 0, unplannedPlaceholderFrames: 0, contentGraphicGroundSec: 0, decodedSec: 10 };
/** VIDEO 653 — every finding is still measured and named; a picture finding no longer refuses the film. */
const codesOf = (v: ReturnType<typeof deliveryGate>) => (v.allow ? v.qualityProblems : v.failures).map((f) => f.code);

describe("5. a budget overrun never puts the blue-grey ground under a sentence", () => {
  it("the rescue block searches; it plans no card, no filler and no generated picture when time runs out", () => {
    const block = rescueBlock();
    expect(block).toContain("fetchSceneVisuals(");
    for (const forbidden of ["chapterCardFallbackFor", "chapter_card", "PRIMARY_GROUND", "generateImage", "stock", "_fallback.mp4"]) {
      expect(block.toLowerCase(), `rescue block must not reach for "${forbidden}"`).not.toContain(forbidden.toLowerCase());
    }
    /** The only "fallback" the block knows is the predicate that keeps a filler file OUT of "found something". */
    expect(block.replace(/isPipelineFallbackClip/g, "")).not.toMatch(/fallback/i);
    /** What stood after the rescue — sweep, refill loop, polish — is gone; the scene stays empty and is refused. */
    expect(PIPE).toContain("no picture found — the timeline holds the previous shot");
  });

  it("a chapter card planned as a sentence's picture is named by the gate on the plan alone — before any frame is read", () => {
    const t = timeline({ sentences: [sentence(0, 0, 0, 4.42)], graphics: [card("gfx1", 0, 4.42)] });
    const cov = sentenceCoverage(t);
    expect(cov.plannedCardSec).toBe(4.42);
    const v = deliveryGate({ ...base, sentenceCoverage: cov, placeholderCheck: { ...cleanScan, plannedCardSec: 4.42 } });
    expect(v.allow).toBe(true);
    expect(codesOf(v)).toEqual(expect.arrayContaining(["CHAPTER_CARD_PLACEHOLDER", "SENTENCE_NOT_COVERED"]));
  });

  it("frames of the ground in the delivered file are named even when nothing planned them", () => {
    const t = timeline({ sentences: [sentence(0, 0, 0, 4)], clips: [clip("a", 0, 4)] });
    const v = deliveryGate({ ...base, sentenceCoverage: sentenceCoverage(t), placeholderCheck: { ...cleanScan, placeholderFrames: 12, placeholderSec: 0.48, unplannedPlaceholderFrames: 12 } });
    expect(v.allow).toBe(true);
    expect(codesOf(v)).toContain("PLACEHOLDER_IN_FILE");
  });
});

describe("6. a provider that never answers cannot hang the render", () => {
  it("a scope whose work never settles is aborted at its window and rejects with a timeout", async () => {
    const started = Date.now();
    await expect(withSceneFetchTimeout(() => new Promise<never>(() => {}), 60, "video 647 hung provider")).rejects.toThrow(/Timeout: video 647 hung provider exceeded/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("the rescue window is finite whenever the picture stage's ceiling is known", () => {
    for (const left of [1, 60_000, 600_000, 3_600_000]) {
      const w = emptySceneRescueWindowMs({ deadlineLeftMs: -1, sentencesPerEmptyScene: Array(40).fill(9), sceneParallelism: 1, ceilingLeftMs: left });
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeLessThanOrEqual(Math.max(left, EMPTY_SCENE_RESCUE_MIN_MS));
    }
  });

  it("the breakers and the scope mechanics stay in place", () => {
    expect(PIPE).toContain("const YOUTUBE_RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;");
    expect(PIPE).toContain("if (deadlineAtMs <= openedAtMs) {");
    expect(PIPE).toContain("function hardAbortScope(");
    expect(PIPE).toContain("Killed ${killedCount} orphaned child process(es) for: ${label}");
  });
});

describe("7. the rescue walks the same source ladder as the first search", () => {
  it("the empty scene is searched by the one scene search, on the main subject, with its own audio timing", () => {
    const block = rescueBlock();
    expect(block).toContain("scenes[si]!, workDir, topicContext, visualDedup, undefined, audioPaths[si], mainSubject");
    /** One scene search in the file: the rescue does not own a second, shorter ladder. */
    expect(PIPE.match(/async function fetchSceneVisuals\(/g)).toHaveLength(1);
    expect(PIPE).toContain("const r = await fetchSceneVisuals(");
  });
});

describe("8. the final gate names what is missing in a film that is not complete (VIDEO 653: and delivers it)", () => {
  it("a sentence with no picture, a sentence only half pictured, and an unjudged picture are each named; a covered film passes clean", () => {
    const none = deliveryGate({ ...base, sentenceCoverage: sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4)] })), placeholderCheck: cleanScan });
    expect(codesOf(none)).toContain("SENTENCE_NOT_COVERED");

    const half = deliveryGate({ ...base, sentenceCoverage: sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 6)], clips: [clip("a", 0, 2.5)] })), placeholderCheck: cleanScan });
    expect(codesOf(half)).toContain("SENTENCE_NOT_COVERED");

    expect(none.allow && half.allow).toBe(true);
    const unjudged = deliveryGate({ ...base, sentenceCoverage: sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4)], clips: [clip("a", 0, 4, [0, 0], false)] })), placeholderCheck: cleanScan });
    expect(unjudged.allow).toBe(true);
    expect(codesOf(unjudged).length).toBeGreaterThan(0);

    const whole = deliveryGate({ ...base, sentenceCoverage: sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4), sentence(0, 1, 4, 8)], clips: [clip("a", 0, 4, [0, 0]), clip("b", 4, 8, [0, 1])] })), placeholderCheck: cleanScan });
    expect(whole.allow).toBe(true);
    expect(codesOf(whole)).toEqual([]);
  });

  it("a scan that could not read the whole file is never passed silently: it is named", () => {
    const v = deliveryGate({ ...base, sentenceCoverage: sentenceCoverage(timeline({ sentences: [sentence(0, 0, 0, 4)], clips: [clip("a", 0, 4)] })), placeholderCheck: { ...cleanScan, complete: false } });
    expect(v.allow).toBe(true);
    expect(codesOf(v)).toEqual(["PLACEHOLDER_CHECK_INCOMPLETE"]);
  });
});
