/**
 * VIDEO 638 — two of the reasons the film showed drawn cards instead of pictures.
 *
 *   F2  s2b2's YouTube shot was approved 41 s after scene 2 closed and 110 s before the film was
 *       assembled; it was named APPROVED_NOT_PLACED and the sentence got a chapter card. A sentence's
 *       own approved answer that settled before its chunk is assembled now goes on THAT sentence,
 *       through the scene's own push — no look, no search, no wait, never another sentence.
 *   F5  the card titles "Follows Such" and "Discover Skepticism" were cuts of the sentence, not
 *       subjects: such a title is refused and the existing film-subject card stands in.
 */
import fs from "fs";
import path from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { intentFrom, type ProductionBeat } from "./cinematicPipelineInputs";
import {
  chapterCardFallbackFor,
  cutFromTheSentence,
  filmSubjectChapterCard,
} from "./cinematicEditingEngine/motionGraphicsPlanner";
import {
  beatNamedEntitiesByKind,
  extractActionCue,
  extractPersonNamesFromText,
  extractVisualPlacePhrase,
} from "./videoPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));
/** The last pass before the film's clips are read. */
const FINAL = { sceneReturned: true, final: true } as const;

type VP = typeof import("./videoPipeline");
let vp: VP;
beforeAll(async () => {
  vp = await import("./videoPipeline");
}, 60_000);
afterEach(() => vi.restoreAllMocks());

/* ═══════════════════════════════ F2 — late approved, own sentence only ═══════════════════════════════ */

describe("F2 — a sentence's own picture approved after its scene closed, before the film is assembled", () => {
  /** Scene 2 of 638: its loop ends with s2b2's search still running, then closes. */
  const closeSceneWithRunningLadder = async (dedup: object, sceneIndex: number, beatIndex: number) => {
    let resolve!: (v: string | null) => void;
    const ladder = new Promise<string | null>((r) => { resolve = r; });
    vp.noteLadderForBeat(dedup, sceneIndex, beatIndex, vp.approvedPicksForBeat(dedup, sceneIndex, beatIndex), ladder);
    expect(await vp.takeLateApprovedPicks(dedup, sceneIndex, 1), "the scene's end does not get it").toEqual([]);
    return resolve;
  };
  const clip = "/w/scene_2_ytfu_1m0_t5533d40__pid_youtube_cc-acc0dfc922f30224_transformed.mp4";
  const notPlacedLines = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("APPROVED_NOT_PLACED"));

  it("1. approved BEFORE the scene closed: the existing path is unchanged — the scene takes it, nothing is named", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    vp.noteLadderForBeat(dedup, 2, 2, 0, Promise.resolve(clip));
    vp.noteApprovedPickForBeat(dedup, 2, 2, vp.clipContentKey(clip));
    await tick();
    expect(await vp.takeLateApprovedPicks(dedup, 2, 0)).toEqual([{ beatIndex: 2, clip, approved: true }]);
    expect(notPlacedLines(warn)).toEqual([]);
  });

  it("2. 638 s2b2: approved after the close, settled before assembly → placed on s2b2 only, through the scene's push", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const resolve = await closeSceneWithRunningLadder(dedup, 2, 2);
    const placer = vi.fn(async (_clip: string, _beat: number) => ({ hold: 3.17 }));
    vp.openLatePlacement(dedup, 2, placer);
    vp.markSceneClosed(dedup, 2);

    vp.noteApprovedPickForBeat(dedup, 2, 2, vp.clipContentKey(clip));
    expect(notPlacedLines(warn), "not named while the film is not assembled").toEqual([]);
    resolve(clip);
    await tick();

    const placed = await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL);
    expect(placed).toEqual([{ beatIndex: 2, clip, hold: 3.17 }]);
    expect(placer).toHaveBeenCalledTimes(1);
    expect(placer).toHaveBeenCalledWith(clip, 2);
    expect(notPlacedLines(warn)).toEqual([]);
  });

  it("3. a late clip approved for ANOTHER sentence is not placed — never handed to the next sentence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const resolve = await closeSceneWithRunningLadder(dedup, 2, 2);
    const placer = vi.fn(async () => ({ hold: 3 }));
    vp.openLatePlacement(dedup, 2, placer);
    vp.markSceneClosed(dedup, 2);
    /** approved for s2b3, while s2b2's ladder settles with it */
    vp.noteApprovedPickForBeat(dedup, 2, 3, vp.clipContentKey(clip));
    vp.noteApprovedPickForBeat(dedup, 2, 2, "youtube_cc:some-other-picture");
    resolve(clip);
    await tick();

    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL)).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
    expect(notPlacedLines(warn)).toContain("[APPROVED_NOT_PLACED] s2b2 reason=approved after scene closed — not placed");
  });

  it("4. never placed twice: the answer is taken once, and a duplicate refused by the push is named", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const resolve = await closeSceneWithRunningLadder(dedup, 2, 2);
    /** the push's own dedup refuses it (already in the film) */
    const placer = vi.fn(async () => null);
    vp.openLatePlacement(dedup, 2, placer);
    vp.markSceneClosed(dedup, 2);
    vp.noteApprovedPickForBeat(dedup, 2, 2, vp.clipContentKey(clip));
    resolve(clip);
    await tick();

    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL)).toEqual([]);
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL), "taken once").toEqual([]);
    expect(placer).toHaveBeenCalledTimes(1);
    expect(notPlacedLines(warn)).toEqual(["[APPROVED_NOT_PLACED] s2b2 reason=refused at the push (reason logged by [PushTrace])"]);
  });

  it("5/6. a sentence that already has its picture keeps it — the late clip does not replace it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const resolve = await closeSceneWithRunningLadder(dedup, 2, 2);
    vp.openLatePlacement(dedup, 2, async () => "has_picture" as const);
    vp.markSceneClosed(dedup, 2);
    vp.noteApprovedPickForBeat(dedup, 2, 2, vp.clipContentKey(clip));
    resolve(clip);
    await tick();

    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL)).toEqual([]);
    expect(notPlacedLines(warn)).toEqual([
      "[APPROVED_NOT_PLACED] s2b2 reason=approved after scene closed — not placed: the sentence already has its picture",
    ]);
  });

  it("7. no wait: a picture still being prepared when the chunk is assembled is not waited for — named instead", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    await closeSceneWithRunningLadder(dedup, 2, 2); // never resolves
    const placer = vi.fn(async () => ({ hold: 3 }));
    vp.openLatePlacement(dedup, 2, placer);
    vp.markSceneClosed(dedup, 2);
    vp.noteApprovedPickForBeat(dedup, 2, 2, vp.clipContentKey(clip));

    const t0 = Date.now();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(placer).not.toHaveBeenCalled();
    expect(notPlacedLines(warn)).toEqual(["[APPROVED_NOT_PLACED] s2b2 reason=approved after scene closed — not placed"]);
  });

  it("a scene whose own result the film does not use (deadline copy, failure) places nothing late", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    const resolve = await closeSceneWithRunningLadder(dedup, 2, 2);
    const placer = vi.fn(async () => ({ hold: 3 }));
    vp.openLatePlacement(dedup, 2, placer);
    vp.markSceneClosed(dedup, 2);
    vp.noteApprovedPickForBeat(dedup, 2, 2, vp.clipContentKey(clip));
    resolve(clip);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, { sceneReturned: false, final: true })).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
  });

  it("after assembly the window is shut: a later approval is named at once, and no scene can reopen it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    vp.openLatePlacement(dedup, 2, async () => ({ hold: 3 }));
    vp.markSceneClosed(dedup, 2);
    await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL);
    vp.openLatePlacement(dedup, 2, async () => ({ hold: 3 }));
    expect(vp.latePlacementOpen(dedup, 2)).toBe(false);
    vp.noteApprovedPickForBeat(dedup, 2, 1, vp.clipContentKey(clip));
    expect(notPlacedLines(warn)).toEqual(["[APPROVED_NOT_PLACED] s2b1 reason=approved after scene closed — not placed"]);
  });

  it("an approval after the close that no ladder carried is still named, never silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    vp.openLatePlacement(dedup, 0, async () => ({ hold: 3 }));
    vp.markSceneClosed(dedup, 0);
    vp.noteApprovedPickForBeat(dedup, 0, 4, "archive:1");
    expect(notPlacedLines(warn)).toEqual([]);
    await vp.placeApprovedAfterSceneClosed(dedup, 0, FINAL);
    expect(notPlacedLines(warn)).toEqual(["[APPROVED_NOT_PLACED] s0b4 reason=approved after scene closed — not placed"]);
  });

  it("8. wiring: the late push is the scene's own push (relevance gate, archive, dedup) — no look, no search", () => {
    const open = PIPE.indexOf("openLatePlacement(dedup, scene.index, async (clipPath, beatIndex) => {");
    expect(open).toBeGreaterThan(0);
    const body = PIPE.slice(open, PIPE.indexOf("markSceneClosed(dedup, scene.index);", open));
    expect(body).toContain('if (clipBeatIndices.includes(beatIndex)) return "has_picture";');
    expect(body).toContain('withAdoptionIntent("beat_fetch", () => pushSceneClip(clipPath, beat.holdSec, beatIndex))');
    expect(body).not.toMatch(/beatPrimaryFetch|fetchYouTube|search|scoreFrame|judge/i);
    /** pushSceneClip is the one gate every clip passes */
    const push = PIPE.slice(PIPE.indexOf("const pushSceneClip = async"), PIPE.indexOf("const pushSceneClip = async") + 1500);
    expect(push).toContain("beatClipRefusedByRelevanceGate(dedup, clipPath, scene.index, beatIndex)");
    expect(push).toContain("assetUsedInVideo(dedup, identity)");
  });

  it("wiring: placed when the chunk is assembled — after its scenes are in, before the main-subject rescue", () => {
    /** a pass per chunk once its scenes are in, before the main-subject rescue … */
    const chunkPass = PIPE.indexOf("for (let si = chunk.start; si < chunk.end; si++) await placeLate(si, false);");
    expect(chunkPass).toBeGreaterThan(PIPE.indexOf("sceneVisualResults[si] ??= { clips: [], beatDurations: [] };"));
    expect(chunkPass).toBeLessThan(PIPE.indexOf("const windowMs = Math.max(visualDeadlineAtMs - Date.now(), EMPTY_SCENE_RESCUE_MIN_MS);"));
    /** … and the hard boundary: the last pass, before a generated image and before the planner reads the clips */
    const finalPass = PIPE.indexOf("for (let si = 0; si < scenes.length; si++) await placeLate(si, true);");
    expect(finalPass).toBeGreaterThan(chunkPass);
    expect(finalPass).toBeLessThan(PIPE.indexOf("await generateMissingBeatImages(scenes, sceneVisualResults"));
    expect(finalPass).toBeLessThan(PIPE.indexOf("const clipsForScene = (i: number): string[] => sceneVisualResults[i]?.clips ?? [];"));
    expect(PIPE).toContain("hasPicture: (beatIndex) => (sceneVisualResults[si]?.clipBeatIndices ?? []).includes(beatIndex),");
    expect(PIPE).toContain("clipBeatIndices: [...(vr.clipBeatIndices ?? []), ...placedLate.map((p) => p.beatIndex)],");
  });

  it("the helper itself starts nothing: no fetch, no search, no timer", () => {
    const fn = PIPE.slice(
      PIPE.indexOf("export async function placeApprovedAfterSceneClosed("),
      PIPE.indexOf("export function noteApprovedPickForBeat(")
    );
    expect(fn).not.toMatch(/setTimeout|withSceneFetchTimeout|fetch|search|Promise\.race/);
  });
});

/* ═══════════════════════════════ F5 — a card title is a subject, not a cut ═══════════════════════════════ */

const EXTRACTORS = {
  people: (t: string) => extractPersonNamesFromText(t),
  place: (t: string) => extractVisualPlacePhrase(t),
  action: (t: string) => extractActionCue(t),
  namedEntities: (t: string) => beatNamedEntitiesByKind(t),
};
const beat = (text: string, powerWord: string): ProductionBeat => ({
  index: 2, text, searchQuery: "", powerWord, keywords: [], holdSec: 4,
  visualDescription: "", voiceStartSec: 0, voiceEndSec: 4,
});
const intentFor = (text: string, powerWord: string) => intentFrom(beat(text, powerWord), 2, 2, null, EXTRACTORS);

describe("F5 — a chapter card never carries a broken cut of the sentence", () => {
  it("1. 638 s2b2 \"Follows Such\": refused — the title ends on a word waiting for its noun", () => {
    const intent = intentFor("But what follows such unexpected success?", "follows such");
    expect(intent.visualSubject).toBe("follows such");
    expect(chapterCardFallbackFor(intent, 62.45, 3.77)).toBeNull();
    expect(cutFromTheSentence(["follows", "such"], intent.spokenText)).toBe(true);
  });

  it("1b. 638 s1b2 \"Discover Skepticism\": refused — the voice says \"discover THE skepticism\"", () => {
    const intent = intentFor("Discover the skepticism and resistance from traditional automakers.", "discover the skepticism");
    expect(chapterCardFallbackFor(intent, 31.47, 4.64)).toBeNull();
  });

  it("…and the existing film-subject card stands in, over exactly the same window", () => {
    const card = filmSubjectChapterCard("Elon Musk", 62.45, 3.77);
    expect(card?.data.title).toBe("Elon Musk");
    expect(card?.startSec).toBe(62.45);
    expect(card?.durationSec).toBe(3.77);
  });

  it("2. a meaningful phrase the voice says unbroken is still a title", () => {
    const intent = intentFor("Critics began to discover skepticism everywhere.", "discover skepticism");
    expect(chapterCardFallbackFor(intent, 0, 4)?.data.title).toBe("Discover Skepticism");
    const plant = intentFor("Tesla opened the Nevada gigafactory in 2016.", "nevada gigafactory");
    expect(chapterCardFallbackFor(plant, 0, 4)?.data.title).toBe("Nevada Gigafactory · 2016");
  });

  it("3. existing titles are unchanged: a subject with words of its own, a named event, a person", () => {
    const gene = { ...intentFor("Scientists cut a single gene inside a living cell.", ""), visualSubject: "gene editing laboratory" };
    expect(chapterCardFallbackFor(gene, 0, 4)?.data.title).toBe("Gene Editing Laboratory");
    const marshall = { ...intentFor("In 1948 the Marshall Plan began to rebuild Europe.", ""), events: ["Marshall Plan"] };
    expect(chapterCardFallbackFor(marshall, 0, 4)?.data.title).toBe("Marshall Plan · 1948");
    expect(chapterCardFallbackFor(intentFor("Lionel Messi wept on the pitch.", ""), 0, 4)?.data.title).toBe("Lionel Messi");
  });

  it("4. timing is untouched: a card that is drawn keeps the window it was asked for", () => {
    const intent = intentFor("Critics began to discover skepticism everywhere.", "discover skepticism");
    const card = chapterCardFallbackFor(intent, 31.47, 4.64);
    expect(card?.startSec).toBe(31.47);
    expect(card?.durationSec).toBe(4.64);
    expect(card?.graphicType).toBe("chapter_card");
  });

  it("5. no effect on A/A2: the spoken-word timing code does not read the card title rule", () => {
    const props = fs.readFileSync(path.join(__dirname, "remotionProps.ts"), "utf8");
    expect(props).not.toContain("cutFromTheSentence");
    expect(props).toContain("graphicWindowOnWord");
  });
});

/* ═══════════════════════ the boundary is the film's clips being read, not the scene closing ═══════════════════════ */

describe("the hard boundary — placement stops when the film's clips are read, not when the scene closes", () => {
  const clip = "/w/scene_2_ytfu_1m0_t5533d40__pid_youtube_cc-acc0dfc922f30224_transformed.mp4";
  const setUp = async (dedup: object, placer: Parameters<VP["openLatePlacement"]>[2]) => {
    let resolve!: (v: string | null) => void;
    vp.noteLadderForBeat(dedup, 2, 2, 0, new Promise<string | null>((r) => { resolve = r; }));
    await vp.takeLateApprovedPicks(dedup, 2, 1);
    vp.openLatePlacement(dedup, 2, placer);
    vp.markSceneClosed(dedup, 2);
    return resolve;
  };

  it("still on its way at the chunk's pass → not lost: approved and settled before the last pass → placed there", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const placer = vi.fn(async () => ({ hold: 3.17 }));
    const resolve = await setUp(dedup, placer);
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, { sceneReturned: true, final: false })).toEqual([]);
    expect(vp.latePlacementOpen(dedup, 2), "the chunk's pass does not shut the window").toBe(true);
    /** approved and prepared while the rest of the film is still being searched */
    vp.noteApprovedPickForBeat(dedup, 2, 2, vp.clipContentKey(clip));
    resolve(clip);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL)).toEqual([{ beatIndex: 2, clip, hold: 3.17 }]);
    expect(placer).toHaveBeenCalledWith(clip, 2);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("APPROVED_NOT_PLACED");
  });

  it("settled before the chunk's pass → placed by that pass, once; the last pass finds nothing left to place", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const placer = vi.fn(async () => ({ hold: 3.17 }));
    const resolve = await setUp(dedup, placer);
    vp.noteApprovedPickForBeat(dedup, 2, 2, vp.clipContentKey(clip));
    resolve(clip);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, { sceneReturned: true, final: false })).toHaveLength(1);
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL)).toEqual([]);
    expect(placer).toHaveBeenCalledTimes(1);
  });

  it("the result the film reads already gives the sentence a picture → the late clip does not displace it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    const placer = vi.fn(async () => ({ hold: 3 }));
    const resolve = await setUp(dedup, placer);
    vp.noteApprovedPickForBeat(dedup, 2, 2, vp.clipContentKey(clip));
    resolve(clip);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, { ...FINAL, hasPicture: (b) => b === 2 })).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      "[APPROVED_NOT_PLACED] s2b2 reason=approved after scene closed — not placed: the sentence already has its picture"
    );
  });

  it("a scene not yet using its own result (it may still be rescued) is decided by the last pass, not dropped early", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const placer = vi.fn(async () => ({ hold: 3 }));
    const resolve = await setUp(dedup, placer);
    vp.noteApprovedPickForBeat(dedup, 2, 2, vp.clipContentKey(clip));
    resolve(clip);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, { sceneReturned: false, final: false })).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
    /** the rescue gave the scene its own result: the last pass places it */
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL)).toHaveLength(1);
  });

  it("the same late clip twice for one sentence (two answers, one callback each) → placed once, never two pictures", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const placer = vi.fn(async () => ({ hold: 3.17 }));
    const resolve1 = await setUp(dedup, placer);
    let resolve2!: (v: string | null) => void;
    vp.noteLadderForBeat(dedup, 2, 2, 0, new Promise<string | null>((r) => { resolve2 = r; }));
    await vp.takeLateApprovedPicks(dedup, 2, 1);
    vp.noteApprovedPickForBeat(dedup, 2, 2, vp.clipContentKey(clip));
    resolve1(clip);
    resolve2(clip);
    await tick();
    const placed = await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL);
    expect(placed).toEqual([{ beatIndex: 2, clip, hold: 3.17 }]);
    expect(placer).toHaveBeenCalledTimes(1);
  });

  it("an approval that lands while the last pass runs is not placed and is named — the clips are not changed after it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    let lateApproval: (() => void) | null = null;
    const placer = vi.fn(async () => {
      lateApproval?.();
      return { hold: 3 };
    });
    const resolve = await setUp(dedup, placer);
    vp.noteApprovedPickForBeat(dedup, 2, 2, vp.clipContentKey(clip));
    resolve(clip);
    await tick();
    lateApproval = () => vp.noteApprovedPickForBeat(dedup, 2, 3, "youtube_cc:other@t1d40");
    await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain("[APPROVED_NOT_PLACED] s2b3 reason=approved after scene closed — not placed");
    expect(placer).toHaveBeenCalledTimes(1);
  });

  it("approved AFTER the last pass → not placed, named (the film's clips are already read)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    const placer = vi.fn(async () => ({ hold: 3 }));
    await setUp(dedup, placer);
    await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL);
    vp.noteApprovedPickForBeat(dedup, 2, 2, vp.clipContentKey(clip));
    expect(placer).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain("[APPROVED_NOT_PLACED] s2b2 reason=approved after scene closed — not placed");
  });
});

/* ═══════════════════════ F4b — what a late answer needs before it goes on its own sentence ═══════════════════════ */

describe("F4b — only an APPROVED late answer of the sentence itself is placed (no new look after the turn)", () => {
  const clip = "/w/scene_0_ytfu_0m0_t1674d23__pid_youtube_cc-bab7b347261e7be9_transformed.mp4";
  const closeWith = async (dedup: object) => {
    let resolve!: (v: string | null) => void;
    vp.noteLadderForBeat(dedup, 0, 0, 0, new Promise<string | null>((r) => { resolve = r; }));
    await vp.takeLateApprovedPicks(dedup, 0, 1);
    return resolve;
  };

  it("9. a late clip the picture editor never approved (638 s0b0's LATE lookahead files) is never placed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    const resolve = await closeWith(dedup);
    const placer = vi.fn(async () => ({ hold: 4 }));
    vp.openLatePlacement(dedup, 0, placer);
    vp.markSceneClosed(dedup, 0);
    resolve(clip); // arrived, but no verdict was ever given for s0b0
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 0, FINAL)).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
  });

  it("10/11. approved, but the file could not be used (technical check / no identity): the ladder settles empty → named, not placed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    const resolve = await closeWith(dedup);
    const placer = vi.fn(async () => ({ hold: 4 }));
    vp.openLatePlacement(dedup, 0, placer);
    vp.markSceneClosed(dedup, 0);
    vp.noteApprovedPickForBeat(dedup, 0, 0, vp.clipContentKey(clip));
    resolve(null);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 0, FINAL)).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      "[APPROVED_NOT_PLACED] s0b0 reason=approved picture never reached the scene — the sentence's ladder settled without a clip"
    );
  });

  it("4/12. the late push uses the sentence's own window and the push that records screen time per footage", () => {
    const open = PIPE.indexOf("openLatePlacement(dedup, scene.index, async (clipPath, beatIndex) => {");
    const body = PIPE.slice(open, open + 700);
    expect(body).toContain("const beat = beats.find((b) => b.index === beatIndex);");
    expect(body).toContain("pushSceneClip(clipPath, beat.holdSec, beatIndex)");
    const push = PIPE.slice(PIPE.indexOf("const pushSceneClip = async"), PIPE.indexOf("const pushSceneClip = async") + 2600);
    expect(push).toContain("actualHold = Math.min(holdSec, probed - 0.04);");
    expect(push).toContain("noteFootageOnScreen(dedup, key, actualHold);");
  });

  it("the turn rule is unchanged: what a lookahead prepares after the turn still goes to the NEXT sentence's own look", () => {
    expect(PIPE).toContain("if (rest.length > 0) offerLateYoutubeCandidates(dedup, rest, `s${sceneIndex}b${beat.index}`);");
    expect(PIPE).toContain("export function sceneTurnIsOver(): boolean {");
  });
});

/* ═══════════════════════ F3 + F4b — a late FIT shorter than the archive's minimum ═══════════════════════ */

describe("F3 + F4b — a late FIT of 2.09 s (638 s1b2) is refused by the archive gate, on the late path too", () => {
  it("the late push goes through the same gate that refused it: picture editor first, then the archive", () => {
    const gate = PIPE.slice(PIPE.indexOf("async function beatClipRefusedByRelevanceGate("), PIPE.indexOf("async function beatClipRefusedByRelevanceGate(") + 1400);
    expect(gate).toContain("if (await visualJudgeRefusesPush(dedup, clipPath, sceneIndex, beatIndex)) return true;");
    expect(gate).toContain("const archived = await ensureArchiveBackedBeforePush(");
    const ingest = fs.readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");
    expect(ingest).toContain("const MIN_VIDEO_DURATION_SEC = 3;");
  });

  it("refused at the push → not placed, named, and nothing is stretched or repeated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    const clip = "/w/scene_0_ytfu_0m1_t1756d21__pid_youtube_cc-bab7b347261e7be9_transformed.mp4";
    let resolve!: (v: string | null) => void;
    vp.noteLadderForBeat(dedup, 1, 2, 0, new Promise<string | null>((r) => { resolve = r; }));
    await vp.takeLateApprovedPicks(dedup, 1, 1);
    vp.openLatePlacement(dedup, 1, async () => null); // INVALID_DURATION 2.09s < 3s at the push
    vp.markSceneClosed(dedup, 1);
    vp.noteApprovedPickForBeat(dedup, 1, 2, vp.clipContentKey(clip));
    resolve(clip);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 1, FINAL)).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      "[APPROVED_NOT_PLACED] s1b2 reason=refused at the push (reason logged by [PushTrace])"
    );
  });
});

/* ═══════════════════════════════ F1b — a designed ground under a sentence's graphic ═══════════════════════════════ */

describe("F1b — the ground under a full-frame graphic is designed, light and self-contained", () => {
  const GRAPHICS = fs.readFileSync(path.join(__dirname, "remotion", "components", "Graphics.tsx"), "utf8");
  let layers: typeof import("./remotion/components/Graphics").primaryGroundLayers;
  beforeAll(async () => {
    layers = (await import("./remotion/components/Graphics")).primaryGroundLayers;
  });

  it("1. the full-frame graphic gets the designed layers, on top of the unchanged opaque base", () => {
    const stage = GRAPHICS.slice(GRAPHICS.indexOf("const PrimaryStage"), GRAPHICS.indexOf("const GraphicBody"));
    expect(stage).toContain("background: PRIMARY_GROUND");
    expect(stage).toContain("primaryGroundLayers(frame, durationInFrames).map((style, i) => (");
    /** layers first, the graphic after them: drawn above */
    expect(stage.indexOf("primaryGroundLayers(")).toBeLessThan(stage.indexOf("opacity: state.opacity"));
  });

  it("2/9. every layer is translucent light over the base — never a dark or opaque layer, so no black frame", () => {
    const all = JSON.stringify(layers(0, 90)) + JSON.stringify(layers(89, 90));
    for (const a of all.match(/rgba\(255,255,255,([0-9.]+)\)/g) ?? []) {
      expect(Number(a.match(/,([0-9.]+)\)$/)![1])).toBeLessThan(0.1);
    }
    expect(all).not.toMatch(/rgba\(0,0,0/);
    /** gold accent with an alpha of at most 0x26 (15%) */
    for (const hex of all.match(/#d9b45a([0-9a-f]{2})/g) ?? []) {
      expect(parseInt(hex.slice(-2), 16)).toBeLessThanOrEqual(0x26);
    }
    expect(GRAPHICS).toContain('"radial-gradient(ellipse at 50% 45%, rgba(43,52,66,0.99) 0%, rgba(30,37,47,0.99) 70%, rgba(26,32,41,0.99) 100%)"');
  });

  it("deterministic and moving: the same frame is the same picture, later frames move the glow and the grain", () => {
    expect(layers(17, 90)).toEqual(layers(17, 90));
    expect(layers(0, 90)[0]!.background).not.toEqual(layers(89, 90)[0]!.background);
    expect(layers(1, 90)[2]!.backgroundPosition).not.toEqual(layers(2, 90)[2]!.backgroundPosition);
    expect(layers(0, 1)).toHaveLength(3);
  });

  it("8/10. no asset, no network, nothing from any shot: gradients from the frame number only", () => {
    const src = GRAPHICS.slice(GRAPHICS.indexOf("export function primaryGroundLayers"), GRAPHICS.indexOf("const PANEL_GRAPHICS"));
    expect(src).not.toMatch(/url\(|https?:|staticFile|<Img|<Video|OffthreadVideo|Math\.random/);
    expect(JSON.stringify(layers(5, 90))).not.toMatch(/url\(/);
  });

  it("3/5/6/7. the graphic, real video clips, subtitles and the spoken-word timing do not read the ground", () => {
    const overlay = GRAPHICS.slice(GRAPHICS.indexOf("const GraphicBody"));
    expect(overlay).not.toContain("primaryGroundLayers");
    for (const file of ["Text.tsx", "VideoClip.tsx"]) {
      const p = path.join(__dirname, "remotion", "components", file);
      if (fs.existsSync(p)) expect(fs.readFileSync(p, "utf8")).not.toContain("primaryGroundLayers");
    }
    expect(fs.readFileSync(path.join(__dirname, "remotionProps.ts"), "utf8")).not.toContain("primaryGroundLayers");
  });

  it("4. timing: the full-frame graphic still spans exactly its sentence's window", async () => {
    const { placePrimaryGraphics } = await import("./edlToTimeline");
    const shot = { id: "shot", source: { provider: "youtube", archiveAssetId: 1 }, timelineStart: 0, timelineEnd: 4, sourceIn: 0, sourceOut: 4 };
    const graphics: Array<{ start: number; end: number }> = [];
    placePrimaryGraphics([shot] as never, graphics as never, [
      { beatId: "s0b1", startSec: 4, endSec: 8, graphic: { graphicType: "chapter_card", data: { text: "Elon Musk" }, reason: "CHAPTER_CARD_FALLBACK" } },
    ] as never);
    expect(graphics[0]!.start).toBe(4);
    expect(graphics[0]!.end).toBe(8);
  });
});
