/**
 * VIDEO 647 — THE FOUR FAULTS THE FIRST PRACTICE RENDER SHOWED, EACH PINNED AT ITS CAUSE.
 *
 * Render 647 (74.7 s, 12 sentences, 3 scenes; ElevenLabs timing measured, budgets never binding)
 * was refused by the DeliveryGate with 8 failures:
 *
 *   F1  s0b2, s1b2, s1b3, s2b1 — "footage without the picture editor's approval": the own-archive
 *       clips the fill pushed were approved AT THE PUSH ("[BeatRelevance] s0b2 push fits") and the
 *       approval never reached the ledger the timeline reads.
 *   F2  s1b1 — eight candidates refused, then a chapter card: the rescue only runs for EMPTY scenes,
 *       and scene 1 had pictures for its other five sentences, so s1b1 was never searched again.
 *   F3  "SCOPE_EXPIRED archive s1 b1 — opened 1s after the enclosing budget had already ended"
 *       (also youtube-first, script image, person stock; s1b2, s1b3): a 70 s share of the scene's
 *       600 s was spent by the YouTube phase and the fallback rungs got nothing, with 4 min left.
 *   F4  s0b2 — two YouTube FITs, both filed "replaced_by_candidate winner=curated:asset:60278": the
 *       fill ran before either was placed and pushed an archive clip over them.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  ARCHIVE_JUDGE_MIN_MS,
  BEAT_RESOLVE_SHARE,
  JUDGED_BEAT_TURN_MS,
  approvedPicksForBeat,
  beatShareOfSceneTimeMs,
  judgeableVisualDeadlineMs,
  noteApprovedKeyForBeat,
  noteApprovedPickForBeat,
  pictureApprovedForBeat,
  youtubeTurnLeavingRoomForArchive,
} from "./videoPipeline";
import { YOUTUBE_FIRST_BEAT_WORST_MS, YOUTUBE_FIRST_TURN_MS, pictureStageWallClockCeilingMs, visualStageWallClockMin } from "./sourcingPolicy";
import { beatsWithoutPicture } from "./generatedImageFallback";
import { stripComments } from "./sourceScan.test.support";

const RAW = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const PIPE = stripComments(RAW);
const between = (from: string, to: string): string => {
  const a = PIPE.indexOf(from);
  const b = PIPE.indexOf(to, a);
  expect(a, from).toBeGreaterThan(0);
  expect(b, to).toBeGreaterThan(a);
  return PIPE.slice(a, b);
};

describe("F1 — a FIT given at the push is an approval the timeline reads", () => {
  it("the push-time approval is filed under the sentence and read back as this sentence's approved picture", () => {
    const dedup = {};
    expect(pictureApprovedForBeat(dedup, 0, 2, "curated:asset:60278")).toBe(false);
    noteApprovedKeyForBeat(dedup, 0, 2, "curated:asset:60278");
    expect(pictureApprovedForBeat(dedup, 0, 2, "curated:asset:60278")).toBe(true);
    /** for THIS sentence only */
    expect(pictureApprovedForBeat(dedup, 0, 1, "curated:asset:60278")).toBe(false);
    expect(pictureApprovedForBeat(dedup, 1, 2, "curated:asset:60278")).toBe(false);
    expect(approvedPicksForBeat(dedup, 0, 2)).toBe(1);
  });

  it("the same key approved twice (adopt, then push) is one approved pick, not two", () => {
    const dedup = {};
    noteApprovedPickForBeat(dedup, 1, 3, "youtube_cc:abc@t1d4");
    noteApprovedKeyForBeat(dedup, 1, 3, "youtube_cc:abc@t1d4");
    expect(approvedPicksForBeat(dedup, 1, 3)).toBe(1);
    noteApprovedKeyForBeat(dedup, 1, 3, "youtube_cc:def@t2d4");
    expect(approvedPicksForBeat(dedup, 1, 3)).toBe(2);
    /** a pick without a key still counts (as before) */
    noteApprovedKeyForBeat(dedup, 1, 3);
    expect(approvedPicksForBeat(dedup, 1, 3)).toBe(3);
  });

  it("wiring: the one door every push passes through files the editor's APPROVED before it lets the picture in", () => {
    const guard = between("export async function visualJudgeRefusesPush(", "export function formatSuspendedVisionAdoptions");
    const accept = guard.indexOf('if (verdict.decision === "ACCEPT") {');
    const filed = guard.indexOf('if (beatIndex != null && vision === "APPROVED" && contentKey) noteApprovedKeyForBeat(dedup, sceneIndex, beatIndex, contentKey);');
    const letIn = guard.indexOf("    return false;\n  }", accept);
    expect(accept).toBeGreaterThan(0);
    expect(filed).toBeGreaterThan(accept);
    expect(filed).toBeLessThan(letIn);
    /** the adopt loop and the archive-first route still write the same ledger */
    expect(PIPE).toContain("noteApprovedKeyForBeat(dedup, sceneIndex, beatIndex, contentKey);\n}");
    expect(PIPE.match(/noteApprovedPickForBeat\(dedup, sceneIndex, beatIndex, contentKey\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("F2 — a sentence without a picture in a scene with pictures gets its own rescue", () => {
  it("only the sentences without a picture are asked", () => {
    const beats = [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }];
    expect(beatsWithoutPicture(beats, [0, 2, 2]).map((b) => b.index)).toEqual([1, 3]);
    expect(beatsWithoutPicture(beats, [0, 1, 2, 3])).toEqual([]);
  });

  it("wiring: the scene search takes the sentences to search, keeps the scene's other clips, and the chunk runs it after the empty-scene rescue", () => {
    expect(PIPE).toContain("onlyBeatIndices?: ReadonlySet<number>");
    expect(PIPE).toContain("scene, workDir, videoTitle, dedup, onBeatProgress, sceneAudioPath, rescueSubject, onlyBeatIndices");
    const inner = between("async function fetchSceneVisualsInner(", "const archiveBeatFilled = new Set<number>();");
    /** the beats are filtered AFTER the scene's beats are recorded in full, and the working lists are seeded */
    expect(inner.indexOf("await applyVoiceAlignmentToBeats(beats, sceneAudioPath, scene.duration, dedup, scene.index);")).toBeLessThan(
      inner.indexOf("beats = beats.filter((b) => onlyBeatIndices.has(b.index));")
    );
    expect(inner).toContain("const clips: string[] = [...(soFar?.clips ?? [])];");
    expect(inner).toContain("const clipBeatIndices: number[] = [...(soFar?.clipBeatIndices ?? [])];");

    const emptyRescue = PIPE.indexOf("const windowMs = emptySceneRescueWindowMs({");
    const sentenceRescue = PIPE.indexOf("`Sentence rescue chunk ${chunkIdx + 1}/${chunks.length}`");
    const leftEmpty = PIPE.indexOf("no picture found — the timeline holds the previous shot");
    expect(emptyRescue).toBeGreaterThan(0);
    expect(sentenceRescue).toBeGreaterThan(emptyRescue);
    expect(sentenceRescue).toBeLessThan(leftEmpty);
    const block = PIPE.slice(emptyRescue, leftEmpty);
    /** same window rule, same scene search on the main subject, narrowed to the missing sentences */
    expect(block.match(/emptySceneRescueWindowMs\(\{/g)).toHaveLength(2);
    expect(block).toContain("sentencesPerEmptyScene: missingByScene.map((m) => m.beatIdx.length),");
    expect(block).toContain("audioPaths[si], mainSubject, new Set(beatIdx)");
    /** merged under the sentence, never over another sentence's clip; the deadline keep stays */
    expect(block).toContain("if (!c || beatIndex == null || target.clips.includes(c)) return;");
    expect(block).toContain("mergeInto(si, sceneClipsKeptAtDeadline(visualDedup.sceneClipsSoFar?.get(scenes[si]!.index)));");
    /** and still no card, filler or generated picture in either rescue */
    expect(block.replace(/isPipelineFallbackClip/g, "")).not.toMatch(/fallback|chapter_card|PRIMARY_GROUND|generateImage/i);
  });
});

describe("F3 — a judged sentence's turn holds the whole YouTube-first worst case", () => {
  it("the judged turn is the YouTube turn plus the fallback minimum", () => {
    expect(JUDGED_BEAT_TURN_MS).toBe(YOUTUBE_FIRST_BEAT_WORST_MS);
    expect(JUDGED_BEAT_TURN_MS).toBe(YOUTUBE_FIRST_TURN_MS + 60_000);
  });

  it("647's scene 1 (6 sentences) now gets a deadline that leaves every sentence's fallback rungs a window", () => {
    const sentencesByChunk = [[3, 6, 3]];
    const cap = Math.min(visualStageWallClockMin("1") * 60_000, pictureStageWallClockCeilingMs("1"));
    const deadline = judgeableVisualDeadlineMs(74.71 * 2.85 * 1000, sentencesByChunk, cap);
    expect(deadline).toBeGreaterThan(600_000);
    expect(deadline).toBe(Math.min(6 * JUDGED_BEAT_TURN_MS, cap));
    /** the first of six equal sentences: its share, its search share, and what the fallbacks keep */
    const share = beatShareOfSceneTimeMs(deadline, 6, 36);
    const searchMs = Math.round(share * BEAT_RESOLVE_SHARE);
    const youtubeTurn = youtubeTurnLeavingRoomForArchive(YOUTUBE_FIRST_TURN_MS, searchMs);
    const fallbackMs = searchMs - youtubeTurn;
    expect(share).toBeGreaterThanOrEqual(150_000);
    expect(fallbackMs).toBeGreaterThanOrEqual(45_000);
    expect(fallbackMs).toBeGreaterThanOrEqual(ARCHIVE_JUDGE_MIN_MS);
    /** 647 as it ran: a 70 s share left the fallbacks 21 s on paper and nothing in practice */
    const oldSearch = Math.round(70_000 * BEAT_RESOLVE_SHARE);
    expect(oldSearch - youtubeTurnLeavingRoomForArchive(YOUTUBE_FIRST_TURN_MS, oldSearch)).toBeLessThan(fallbackMs / 2);
  });
});

describe("F4 — an approved picture on its way is not pre-empted by the archive fill", () => {
  it("wiring: the fill reads the sentence's approved picks before asking the own archive", () => {
    const fill = between("const fillBeatWithMoreClips = async (): Promise<void> => {", "const ok = await withAdoptionIntent(\"beat_fetch\", () => pushSceneClip(clipPath, rest, f.beat.index));");
    const found = fill.indexOf("const found = clipBeatIndices.includes(f.beat.index);");
    const guard = fill.indexOf("if (!found && approvedPicksForBeat(dedup, scene.index, f.beat.index) > 0) {");
    const archive = fill.indexOf("ownArchiveBeatClip({ ...asked, holdSec: rest }");
    expect(found).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(found);
    expect(guard).toBeLessThan(archive);
    expect(fill).toContain("an approved picture is on its way — not filled from the own archive");
  });

  it("the count the fill reads: one FIT noted for the sentence is enough to hold the archive off", () => {
    const dedup = {};
    expect(approvedPicksForBeat(dedup, 0, 2)).toBe(0);
    noteApprovedPickForBeat(dedup, 0, 2, "youtube_cc:tj7Sd7fs6JQ@t7599d40");
    expect(approvedPicksForBeat(dedup, 0, 2)).toBe(1);
    /** a sentence that already has a placed clip is `found` and the guard does not apply — the fill still tops it up */
    expect(approvedPicksForBeat(dedup, 0, 3)).toBe(0);
  });
});
