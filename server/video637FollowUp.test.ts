/**
 * VIDEO 637 — FOLLOW-UP ROUND: the proven causes behind the render's remaining log findings.
 *
 *   E   a web (or worker) boot put a render another replica was running back in the queue; a
 *       second replica claimed it, the first read itself as superseded and was cancelled
 *   10  a sentence with two clips was dressed (subtitles → word timing, graphics, sounds) over its
 *       FIRST clip's share only: the words of the second half reached no caption, so the A/A2 word
 *       timing could not find them; the same share gave the second decision's graphics their own
 *       ids, reported as DROPPED_NOT_TRANSLATED ("statistic_counter" on s0b0)
 *   3   "7 graphics were planned and 6 reached a render" counted a lower third switched off on
 *       purpose; the lifecycle counted a sentence's graphics once per clip
 *   9   a declared candidate refused by a gate before the editor was logged as "no verdict was ever
 *       filed" and the beat as POOL_DECLARED_NOTHING_REVIEWED
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { orphanedAtBoot, pipelineStallThresholdMs } from "./db";
import { buildCinematicSceneInputs, type ProductionBeat, type SceneFacts } from "./cinematicPipelineInputs";
import { formatCinematicGraphicsLifecycle, runCinematicPipeline } from "./cinematicPipeline";
import { timelineToRemotionProps } from "./remotionProps";
import { captionTrack, graphicsTrack, videoTrack, type ProjectTimeline } from "./projectTimeline";
import {
  createVisionReviewPoolState,
  declareVisionReviewPool,
  formatVisionSelection,
  neverReachedEditor,
  noteRefusedBeforeEditor,
  noteVisionReviewed,
  visionSelectionViolations,
} from "./visionAwareSelection";

const SRC = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

/* ═══════════════ E — a boot does not take back a run another worker is on ═══════════════ */

describe("E — boot recovery leaves a living run alone", () => {
  const NOW = Date.parse("2026-10-06T16:50:24Z");
  const threshold = pipelineStallThresholdMs("1", "generating_script");

  it("render 637's first attempt: claimed 6 s before the web booted — NOT orphaned", () => {
    expect(orphanedAtBoot({ status: "generating_script", updatedAt: new Date(NOW - 6_000), videoLength: "1" }, NOW)).toBe(false);
  });

  it("a run whose progress went stale as long as the stall check calls dead — orphaned, re-queued as before", () => {
    expect(
      orphanedAtBoot({ status: "generating_script", updatedAt: new Date(NOW - threshold - 1_000), videoLength: "1" }, NOW)
    ).toBe(true);
  });

  it("a run with no progress time at all is orphaned (nothing proves it alive)", () => {
    expect(orphanedAtBoot({ status: "generating_visuals", updatedAt: null, videoLength: "1" }, NOW)).toBe(true);
  });

  it("wired: the boot checks liveness before it re-queues; the stall check and the hand-back are untouched", () => {
    const db = SRC("db.ts");
    const fn = db.slice(db.indexOf("export async function recoverAllStuckVideos"), db.indexOf("export async function recoverAllStuckVideos") + 2600);
    expect(fn.indexOf("if (!orphanedAtBoot(rv))")).toBeGreaterThan(-1);
    expect(fn.indexOf("if (!orphanedAtBoot(rv))")).toBeLessThan(fn.indexOf('await updateVideoStatus(rv.id, "queued"'));
    /** The two routes that restart a really dead run are unchanged. */
    expect(db).toContain("export async function requeueInterruptedVideo(");
    expect(db).toContain("export async function failAllStalledPipelines(");
    expect(db).toContain("const staleProgress = Date.now() - updatedAt >= threshold;");
  });
});

/* ═══════════════ 10 — a two-clip sentence is dressed over the whole sentence ═══════════════ */

describe("10 — a sentence with two clips keeps all its words, graphics and picture timing", () => {
  const TEXTS = [
    "Tesla was founded as a small company with a bold plan.",
    "It survived the storm, and Tesla teetered on bankruptcy during the 2008 financial crisis.",
  ];
  function twoClipPlan(showSubtitles = false) {
    const beats: ProductionBeat[] = TEXTS.map((text, index) => ({
      index, text, searchQuery: "", powerWord: "", keywords: [], holdSec: 6, visualDescription: "",
      voiceStartSec: index * 6, voiceEndSec: index * 6 + 6,
    }));
    const mk = (i: number, d: number) => ({
      facts: { localPath: `/tmp/fu-${i}.mp4`, durationSec: d, widthPx: 1920, heightPx: 1080 },
      adoption: { provider: "internet_archive", providerAssetId: `ia-${i}`, sourceUrl: `https://archive.invalid/${i}.mp4`, assetTitle: "shot", query: "shot" },
    });
    const facts = {
      scene: { index: 0, text: TEXTS.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 12 },
      beats,
      clips: [mk(0, 10), mk(1, 3)],
      /** The second sentence gets a second clip: two decisions, one sentence. */
      moreClips: { 1: [mk(2, 3)] },
    } as unknown as SceneFacts;
    /** One word every 0.4 s from each sentence's start; "2008" is said at 10.4 s, in the second clip's half. */
    const words = TEXTS.flatMap((t, i) =>
      t.split(" ").map((word, j) => ({ word, startSec: i * 6 + j * 0.4, endSec: i * 6 + j * 0.4 + 0.35 }))
    );
    const built = buildCinematicSceneInputs({ scenes: [facts] });
    const result = runCinematicPipeline({ videoId: 9004, scenes: built.scenes, includeSubtitles: true, showSubtitles, words });
    return { result, timeline: result.timeline as ProjectTimeline, words };
  }

  it("every spoken word reaches the timeline's word timing (it lost the second half's six before)", () => {
    const { timeline, words } = twoClipPlan();
    const props = timelineToRemotionProps({ timeline });
    expect(props.words.length).toBe(words.length);
    expect(props.words.some((w) => w.word === "2008")).toBe(true);
  });

  it("a year said in the second clip's half gets its card on the spoken word", () => {
    const { timeline, words } = twoClipPlan();
    const props = timelineToRemotionProps({ timeline });
    const card = graphicsTrack(timeline).find((g) => g.graphicType === "date_card" && !g.disabled)!;
    const drawn = props.graphics.find((g) => g.id === card.id)!;
    const spoken = words.find((w) => w.word === "2008")!;
    expect(spoken.startSec).toBeGreaterThan(9);
    expect(drawn.fromFrame / props.fps).toBeCloseTo(spoken.startSec, 1);
  });

  it("the PICTURE is timed exactly as before: each clip keeps its own share", () => {
    const { timeline } = twoClipPlan();
    expect(videoTrack(timeline).map((c) => [c.timelineStart, c.timelineEnd])).toEqual([
      [0, 6],
      [6, 9],
      [9, 12],
    ]);
  });

  it("the subtitles stay off, and switched on they cover the whole sentence", () => {
    expect(timelineToRemotionProps({ timeline: twoClipPlan().timeline }).captions).toEqual([]);
    const on = captionTrack(twoClipPlan(true).timeline).filter((c) => c.start >= 6);
    expect(Math.max(...on.map((c) => c.end))).toBeCloseTo(12, 1);
  });

  it("the second clip's graphics are the sentence's own: nothing reported lost", () => {
    const lines = formatCinematicGraphicsLifecycle(twoClipPlan().result);
    expect(lines.join("\n")).not.toContain("DROPPED_NOT_TRANSLATED");
    expect(lines[0]).toContain("planned=1 translated=1");
  });

  it("a one-clip sentence is planned exactly as before (no sentence window is set)", () => {
    const inputs = SRC("cinematicPipelineInputs.ts");
    expect(inputs).toContain("...(shares.length > 1 ? { sentenceVoiceStartSec: start, sentenceVoiceDurationSec: durationSec } : {})");
    const gen = SRC("cinematicEditingEngine/edlGenerator.ts");
    expect(gen).toContain("const dressStartSec = input.sentenceVoiceStartSec ?? input.beatVoiceStartSec;");
    /** The picture's timing still reads the clip's own share. */
    expect(gen).toContain("input.beatVoiceStartSec,\n      input.beatVoiceDurationSec,\n      input.wordTimings");
  });
});

/* ═══════════════ 3 — a graphic switched off on purpose is not a loss ═══════════════ */

describe("3 — the feature matrix counts the graphics meant to play", () => {
  it("planned = graphics not switched off, the same set executed is counted against", () => {
    const pipe = SRC("videoPipeline.ts");
    expect(pipe).toContain("cinematicProgress.graphicsPlanned = graphicsTrack(t).filter((g) => !g.disabled).length;");
    expect(pipe).toContain("cinematicProgress.graphicsOnTimeline = graphicsTrack(t).filter((g) => !g.disabled).length;");
  });
});

/* ═══════════════ 9 — refused before the editor is not "never reached" ═══════════════ */

describe("9 — a gate's refusal is classified as such", () => {
  const KEY = (i: number) => `youtube_cc:5aa25a1b1072341b@t${4114 + i}d40`;
  function s2b0(refuse: number[], review: number[] = []) {
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 2, 0, [0, 1, 2].map((i) => ({ contentKey: KEY(i), cheapRank: i })), 8);
    for (const i of refuse) noteRefusedBeforeEditor(state, 2, 0, KEY(i), "entity_evidence");
    for (const i of review) noteVisionReviewed(state, 2, 0, { contentKey: KEY(i), cheapRank: i, evidence: "MISMATCH" });
    return state;
  }

  it("render 637's s2b0: every declared moment refused by entity_evidence — none is 'never reached'", () => {
    const state = s2b0([0, 1, 2]);
    expect(neverReachedEditor([...state.beats.values()][0]!)).toEqual([]);
    const lines = formatVisionSelection(state);
    expect(lines.find((l) => l.includes("s2b0 cap="))).toContain("neverReached=0 refusedBeforeEditor=3");
    expect(lines.filter((l) => l.includes("refusedBeforeEditor youtube_cc:"))[0]).toContain("refused by entity_evidence before the picture editor");
    expect(visionSelectionViolations(state).find((v) => v.includes("POOL_DECLARED_NOTHING_REVIEWED"))).toBeUndefined();
  });

  it("one candidate with no answer and no refusal is still 'never reached', and the violation still fires", () => {
    const state = s2b0([0, 1]);
    expect(neverReachedEditor([...state.beats.values()][0]!)).toEqual([KEY(2)]);
    expect(visionSelectionViolations(state).find((v) => v.includes("POOL_DECLARED_NOTHING_REVIEWED"))).toBeTruthy();
  });

  it("a candidate the editor answered stays an answer, and an undeclared refusal is not recorded", () => {
    const state = s2b0([], [0]);
    noteRefusedBeforeEditor(state, 2, 0, KEY(0), "entity_evidence");
    noteRefusedBeforeEditor(state, 2, 0, "pexels:999", "stock_without_person");
    const pool = [...state.beats.values()][0]!;
    expect(pool.refusedBeforeEditor?.size ?? 0).toBe(0);
    expect(neverReachedEditor(pool)).toEqual([KEY(1), KEY(2)]);
  });

  it("wired in the ONE refusal path of the adoption loop; no gate changed", () => {
    const pipe = SRC("videoPipeline.ts");
    const at = pipe.indexOf("const refuse = (reason: string): true => {");
    expect(pipe.slice(at, at + 500)).toContain(
      "noteRefusedBeforeEditor(dedup.visionReviewPool, sceneIndex, beatIndex, clipContentKey(p), reason);"
    );
    expect(pipe).toContain('if (judgedOnMetadata.decision === "REJECT" && refuse(judgedOnMetadata.reason)) continue;');
  });
});

/* ═══════════════ 10 (final check) — the anchor word's bounds in a two-clip sentence ═══════════════ */

describe("10 — bounds of a year card in a sentence over two clips (clip 1 = 6–9 s, clip 2 = 9–12 s)", () => {
  /** The year as word `at` of a 14-word second sentence; words every 0.4 s from 6 s, so word k is said at 6 + 0.4·k. */
  function plan(at: number | null, withWords = true) {
    const filler = ["Tesla", "nearly", "went", "under", "and", "every", "investor", "doubted", "it", "badly", "then", "and", "there", "again"];
    const second = filler.slice();
    if (at != null) second[at] = "2008";
    const texts = ["Tesla was founded as a small company with a bold plan.", second.join(" ") + "."];
    const beats: ProductionBeat[] = texts.map((text, index) => ({
      index, text, searchQuery: "", powerWord: "", keywords: [], holdSec: 6, visualDescription: "",
      voiceStartSec: index * 6, voiceEndSec: index * 6 + 6,
    }));
    const mk = (i: number, d: number) => ({
      facts: { localPath: `/tmp/fb-${i}.mp4`, durationSec: d, widthPx: 1920, heightPx: 1080 },
      adoption: { provider: "internet_archive", providerAssetId: `ib-${i}`, sourceUrl: `https://archive.invalid/b${i}.mp4`, assetTitle: "shot", query: "shot" },
    });
    const facts = {
      scene: { index: 0, text: texts.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 12 },
      beats, clips: [mk(0, 10), mk(1, 3)], moreClips: { 1: [mk(2, 3)] },
    } as unknown as SceneFacts;
    const words = withWords
      ? texts.flatMap((t, i) => t.split(" ").map((word, j) => ({ word, startSec: i * 6 + j * 0.4, endSec: i * 6 + j * 0.4 + 0.35 })))
      : [];
    const built = buildCinematicSceneInputs({ scenes: [facts] });
    const timeline = runCinematicPipeline({ videoId: 9005, scenes: built.scenes, includeSubtitles: true, showSubtitles: false, words }).timeline as ProjectTimeline;
    const props = timelineToRemotionProps({ timeline });
    const card = graphicsTrack(timeline).find((g) => g.graphicType === "date_card" && !g.disabled)!;
    const drawn = props.graphics.find((g) => g.id === card.id)!;
    const typing = timeline.tracks.flatMap((t) => (t.kind === "SFX" ? t.clips : [])).find((c) => c.id === `sfx_type_${card.id}`);
    return {
      timeline, props, card, typing,
      start: drawn.fromFrame / props.fps,
      end: (drawn.fromFrame + drawn.durationInFrames) / props.fps,
      spoken: at != null ? 6 + 0.4 * at : null,
    };
  }
  const SENTENCE_START = 6;
  const SENTENCE_END = 12;

  it("the planned card is the sentence's own, its length unchanged by the longer window (3 s, not 6)", () => {
    const { card } = plan(8);
    expect(card.start).toBeCloseTo(SENTENCE_START, 3);
    expect(card.end - card.start).toBeCloseTo(3, 3);
  });

  it("anchor in clip 2 (9.2 s): the card starts on the word, ends at the sentence's end, not past it", () => {
    const { start, end, spoken } = plan(8);
    expect(spoken).toBeCloseTo(9.2, 3);
    expect(start).toBeCloseTo(spoken!, 1);
    expect(end).toBeLessThanOrEqual(SENTENCE_END + 1e-6);
    expect(end).toBeCloseTo(SENTENCE_END, 1);
  });

  it("anchor in clip 1 (7.2 s): the existing early rule — start on the word, planned end kept", () => {
    const { card, start, end } = plan(3);
    expect(start).toBeCloseTo(7.2, 1);
    expect(end).toBeCloseTo(card.end, 1);
  });

  it("anchor just before the sentence's end (10.4 s): moves, ends at the sentence end, still ≥ 1.5 s on screen", () => {
    const { start, end } = plan(11);
    expect(start).toBeCloseTo(10.4, 1);
    expect(end).toBeCloseTo(SENTENCE_END, 1);
    expect(end - start).toBeGreaterThanOrEqual(1.5 - 1e-6);
  });

  it("anchor too close to the end (10.8 s, < 1.5 s left): the planned window, never a flash", () => {
    const { card, start, end } = plan(12);
    expect(start).toBeCloseTo(card.start, 1);
    expect(end).toBeCloseTo(card.end, 1);
  });

  it("no word timing at all: the planned window, no crash", () => {
    const { card, start, end, props } = plan(8, false);
    expect(props.words).toEqual([]);
    expect(start).toBeCloseTo(card.start, 1);
    expect(end).toBeCloseTo(card.end, 1);
  });

  it("in every case: never before the planned start, never past the sentence, never longer than planned", () => {
    for (const at of [3, 8, 11, 12]) {
      const { card, start, end } = plan(at);
      expect(start, `at=${at}`).toBeGreaterThanOrEqual(card.start - 1e-6);
      expect(end, `at=${at}`).toBeLessThanOrEqual(SENTENCE_END + 1e-6);
      expect(end - start, `at=${at}`).toBeLessThanOrEqual(card.end - card.start + 1e-6);
    }
  });

  it("the typing sound starts with the card's effective start (A2), in clip 2 too", () => {
    for (const at of [3, 8, 11]) {
      const { typing, start } = plan(at);
      expect(typing, `at=${at}`).toBeDefined();
      expect(typing!.start, `at=${at}`).toBeGreaterThanOrEqual(start - 1e-6);
      expect(typing!.start, `at=${at}`).toBeLessThan(start + 0.5);
    }
  });

  it("subtitles stay off with every word's timing present; the picture windows are exactly 0–6, 6–9, 9–12", () => {
    const { timeline, props } = plan(8);
    expect(captionTrack(timeline).every((c) => c.disabled === true)).toBe(true);
    expect(props.captions).toEqual([]);
    expect(props.words.length).toBe(11 + 14);
    expect(videoTrack(timeline).map((c) => [c.timelineStart, c.timelineEnd])).toEqual([
      [0, 6],
      [6, 9],
      [9, 12],
    ]);
  });
});
