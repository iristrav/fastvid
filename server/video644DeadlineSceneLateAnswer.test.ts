/**
 * VIDEO 644 — A SCENE THE DEADLINE CUT OFF STILL TAKES ITS OWN LATE ANSWERS, ONCE ITS LOOP IS OVER.
 *
 * Render 644 (10 October, 08:08–08:33 UTC):
 *
 *     08:20:10  "[Pipeline] Visual stage cap hit chunk 1/1 (2/3 scenes done)" — scene 1 still running;
 *               "Scene 1: visual deadline reached while it was still running — keeping 1 clip(s)"
 *     08:20:19  "[LateApproved] s1b3: its search was still running when the scene closed"
 *     08:26:10  "[BeatRelevance] s1b3 adopt fits clip=scene_1_ytfu_0m1_t5497d40…" — ADOPTED at 08:26:32
 *     08:27:06  "[APPROVED_NOT_PLACED] s1b3 reason=approved after scene closed — not placed"
 *     08:28:23  "[CHAPTER_CARD_FALLBACK] s1b3 4.39s" / "[GRAPHIC_ONLY_REASON] s1b3 … PLACEMENT_WINDOW_CLOSED"
 *
 * The ladder had settled, the picture editor had approved the clip for THAT sentence, the scene's
 * push was open and the sentence had no picture. The last pass refused it for one reason only: the
 * scene had not returned before the chunk's deadline (`sceneReturned=false`), so the film held a
 * deadline copy. A deadline copy is the film's result too; once the scene's loop is over, its own
 * late answers go on it exactly as they do for a scene that returned in time.
 */
import fs from "fs";
import path from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));

type VP = typeof import("./videoPipeline");
let vp: VP;
beforeAll(async () => {
  vp = await import("./videoPipeline");
}, 60_000);
afterEach(() => vi.restoreAllMocks());

describe("644 — the rule: which scene results take their own late answers", () => {
  it("a scene that returned in time is unchanged: always", () => {
    expect(vp.lateAnswersUseSceneResult({ returnedInTime: true, keptAtDeadline: false, failed: false, closed: false })).toBe(true);
    expect(vp.lateAnswersUseSceneResult({ returnedInTime: true, keptAtDeadline: true, failed: true, closed: true })).toBe(true);
  });

  it("644's scene 1: a deadline copy of a scene whose loop is over, not failed — takes its late answers", () => {
    expect(vp.lateAnswersUseSceneResult({ returnedInTime: false, keptAtDeadline: true, failed: false, closed: true })).toBe(true);
  });

  it("a deadline copy of a scene whose loop is still running does not (its push is still its own)", () => {
    expect(vp.lateAnswersUseSceneResult({ returnedInTime: false, keptAtDeadline: true, failed: false, closed: false })).toBe(false);
  });

  it("a failed scene still places nothing late, closed or not", () => {
    expect(vp.lateAnswersUseSceneResult({ returnedInTime: false, keptAtDeadline: true, failed: true, closed: true })).toBe(false);
    expect(vp.lateAnswersUseSceneResult({ returnedInTime: false, keptAtDeadline: false, failed: true, closed: true })).toBe(false);
  });

  it("a scene that neither returned nor was kept at the deadline is not the film's result: nothing", () => {
    expect(vp.lateAnswersUseSceneResult({ returnedInTime: false, keptAtDeadline: false, failed: false, closed: true })).toBe(false);
  });
});

describe("644 — s1b3 replayed through the real late placement", () => {
  const clip = "/w/scene_1_ytfu_0m1_t5497d40__pid_youtube_cc-acc0dfc922f30224_transformed.mp4";
  const notPlacedLines = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("APPROVED_NOT_PLACED"));

  /** Scene 1 of 644: its loop ends with s1b3's search still running; the deadline copy is the film's result. */
  const sceneOneAtTheDeadline = async (dedup: object, placer: Parameters<VP["openLatePlacement"]>[2]) => {
    let resolve!: (v: string | null) => void;
    vp.noteLadderForBeat(dedup, 1, 3, 0, new Promise<string | null>((r) => { resolve = r; }));
    expect(await vp.takeLateApprovedPicks(dedup, 1, 1, { sceneEnd: true }), "the scene's end does not get it").toEqual([]);
    vp.openLatePlacement(dedup, 1, placer);
    vp.markSceneClosed(dedup, 1);
    return resolve;
  };
  /** What `placeLate` now passes for a scene the chunk's deadline cut off. */
  const deadlineScene = (dedup: object, failed = false) =>
    vp.lateAnswersUseSceneResult({ returnedInTime: false, keptAtDeadline: true, failed, closed: vp.sceneIsClosed(dedup, 1) });

  it("approved and settled after the deadline copy, loop over, no picture → placed on s1b3 by the last pass", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const placer = vi.fn(async () => ({ hold: 4.39 }));
    const resolve = await sceneOneAtTheDeadline(dedup, placer);
    /** 08:26:10 — the picture editor approves; the ladder settles with the clip. */
    vp.noteApprovedPickForBeat(dedup, 1, 3, vp.clipContentKey(clip));
    resolve(clip);
    await tick();

    const placed = await vp.placeApprovedAfterSceneClosed(dedup, 1, {
      sceneReturned: deadlineScene(dedup),
      final: true,
      hasPicture: () => false,
    });
    expect(placed).toEqual([{ beatIndex: 3, clip, hold: 4.39 }]);
    expect(placer).toHaveBeenCalledWith(clip, 3);
    expect(notPlacedLines(warn)).toEqual([]);
  });

  it("the same sentence under the old rule (scene not returned) is what 644 showed: not placed, named", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const placer = vi.fn(async () => ({ hold: 4.39 }));
    const resolve = await sceneOneAtTheDeadline(dedup, placer);
    vp.noteApprovedPickForBeat(dedup, 1, 3, vp.clipContentKey(clip));
    resolve(clip);
    await tick();

    expect(await vp.placeApprovedAfterSceneClosed(dedup, 1, { sceneReturned: false, final: true })).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
    expect(notPlacedLines(warn)).toEqual(["[APPROVED_NOT_PLACED] s1b3 reason=approved after scene closed — not placed"]);
  });

  it("the chunk's pass while the scene's loop still runs defers it; the last pass, loop over, places it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const placer = vi.fn(async () => ({ hold: 4.39 }));
    let resolve!: (v: string | null) => void;
    vp.noteLadderForBeat(dedup, 1, 3, 0, new Promise<string | null>((r) => { resolve = r; }));
    await vp.takeLateApprovedPicks(dedup, 1, 1, { sceneEnd: true });
    vp.openLatePlacement(dedup, 1, placer);
    /** the loop is NOT closed yet when the chunk is assembled */
    vp.noteApprovedPickForBeat(dedup, 1, 3, vp.clipContentKey(clip));
    resolve(clip);
    await tick();
    expect(vp.sceneIsClosed(dedup, 1)).toBe(false);
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 1, { sceneReturned: deadlineScene(dedup), final: false, hasPicture: () => false })).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
    expect(notPlacedLines(warn)).toEqual([]);

    vp.markSceneClosed(dedup, 1);
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 1, { sceneReturned: deadlineScene(dedup), final: true, hasPicture: () => false })).toEqual([
      { beatIndex: 3, clip, hold: 4.39 },
    ]);
    expect(placer).toHaveBeenCalledTimes(1);
  });

  it("a scene whose search threw places nothing late: its approval stays named as lost", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const placer = vi.fn(async () => ({ hold: 4.39 }));
    const resolve = await sceneOneAtTheDeadline(dedup, placer);
    vp.noteApprovedPickForBeat(dedup, 1, 3, vp.clipContentKey(clip));
    resolve(clip);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 1, { sceneReturned: deadlineScene(dedup, true), final: true, hasPicture: () => false })).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
    expect(notPlacedLines(warn)).toEqual(["[APPROVED_NOT_PLACED] s1b3 reason=approved after scene closed — not placed"]);
  });

  it("the deadline copy already gives the sentence its picture → the late clip does not displace it (unchanged)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const placer = vi.fn(async () => ({ hold: 4.39 }));
    const resolve = await sceneOneAtTheDeadline(dedup, placer);
    vp.noteApprovedPickForBeat(dedup, 1, 3, vp.clipContentKey(clip));
    resolve(clip);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 1, { sceneReturned: deadlineScene(dedup), final: true, hasPicture: (b) => b === 3 })).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
    expect(notPlacedLines(warn)).toEqual([
      "[APPROVED_NOT_PLACED] s1b3 reason=approved after scene closed — not placed: the sentence already has its picture",
    ]);
  });

  it("the scene's own push can still refuse it, as before: named as refused at the push", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup = {};
    const placer = vi.fn(async () => null);
    const resolve = await sceneOneAtTheDeadline(dedup, placer);
    vp.noteApprovedPickForBeat(dedup, 1, 3, vp.clipContentKey(clip));
    resolve(clip);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 1, { sceneReturned: deadlineScene(dedup), final: true, hasPicture: () => false })).toEqual([]);
    expect(placer).toHaveBeenCalledWith(clip, 3);
    expect(notPlacedLines(warn)).toEqual(["[APPROVED_NOT_PLACED] s1b3 reason=refused at the push (reason logged by [PushTrace])"]);
  });
});

describe("644 — the wiring in the pipeline (source text)", () => {
  it("the chunk's and the last pass decide with the one rule, from the four facts", () => {
    const at = PIPE.indexOf("const placeLate = async (si: number, final: boolean): Promise<void> => {");
    expect(at).toBeGreaterThan(0);
    const body = PIPE.slice(at, at + 1200);
    expect(body).toContain("sceneReturned: lateAnswersUseSceneResult({");
    expect(body).toContain("returnedInTime: returnedInTime.has(si),");
    expect(body).toContain("keptAtDeadline: keptAtDeadline.has(si),");
    expect(body).toContain("failed: failedScenes.has(si),");
    expect(body).toContain("closed: sceneIsClosed(visualDedup, scenes[si]!.index),");
  });

  it("a scene still running at the chunk's deadline is noted as kept, right where the deadline copy is made (617 line untouched)", () => {
    const at = PIPE.indexOf("keptAtDeadline.add(si);");
    expect(at).toBeGreaterThan(0);
    const around = PIPE.slice(at - 200, at + 300);
    expect(around).toContain("if (!sceneVisualResults[si]) {");
    expect(around).toContain("const kept = sceneClipsKeptAtDeadline(visualDedup.sceneClipsSoFar?.get(scenes[si]!.index));");
    expect(around.indexOf("if (!sceneVisualResults[si]) {")).toBeLessThan(around.indexOf("keptAtDeadline.add(si);"));
    expect(around.indexOf("keptAtDeadline.add(si);")).toBeLessThan(around.indexOf("const kept = sceneClipsKeptAtDeadline("));
  });

  it("a scene whose search threw is noted as failed beside the existing `sceneFailed = true`", () => {
    expect(PIPE).toContain("sceneFailed = true;\n          failedScenes.add(sceneIdx);");
  });

  it("the function-level rule is unchanged: `sceneReturned` false still places nothing", () => {
    const at = PIPE.indexOf("export async function placeApprovedAfterSceneClosed(");
    const body = PIPE.slice(at, at + 4000);
    expect(body).toContain("if (!final && (!placer || !sceneReturned)) {");
    expect(body).toContain("if (!placer || !sceneReturned || !e.settled) {");
  });
});
