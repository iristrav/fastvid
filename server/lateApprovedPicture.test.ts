/**
 * VIDEO 631 RE-RUN (360046e) — AN APPROVED PICTURE IS NEVER LOST TO ITS SENTENCE'S CAP.
 *
 *     19:11:44.852  video search s1 b3 capped → s1b3: no picture — gap
 *     19:11:44.853  [BeatRelevance] s1b3 adopt fits … border guards observing a checkpoint
 *     19:11:46      transformed, ADOPTED — never pushed; s1b3 got a drawn chapter card
 *
 *   A   a missing picture does not block the export        (releaseRuleAlwaysDeliver.test.ts)
 *   B   an approved answer that never reached the scene is handed back to it
 *   C   received → approved → pushed through the one push gate → the sentence's clip list
 *   D   a FIT landing after the cap is placed; a picture still preparing is waited for at the end
 *   E   unapproved or technically refused answers are never placed, and say why
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("D — a FIT that lands after the cap is still the sentence's picture", () => {
  it("D1. the look under way gives FIT 1 ms after the cap → the cap hands the running ladder back, the scene gets it as approved", async () => {
    const vp = await import("./videoPipeline");
    const dedup = {};
    const clip = "/tmp/scene_1_b3_primary_hist_archive_0__pid_internet_archive-c4525744bff05895_transformed.mp4";
    const approvedBefore = vp.approvedPicksForBeat(dedup, 1, 3);
    const capped = await vp.ladderWithinCap<string>(dedup, 1, 3, (track) =>
      vp.withSceneFetchTimeout(
        () => track((async () => {
          await wait(60); // the Judge answers after the cap
          vp.noteApprovedPickForBeat(dedup, 1, 3, vp.clipContentKey(clip));
          await wait(20); // fair-use transform
          return clip;
        })()),
        30,
        "video search s1 b3"
      )
    );
    expect(capped.value, "the sentence moves on at once, as before").toBeNull();
    expect(capped.late, "the running ladder is handed back").toBeDefined();
    vp.noteLadderForBeat(dedup, 1, 3, approvedBefore, capped.late!);
    await wait(120);
    const late = await vp.takeLateApprovedPicks(dedup, 1, 0);
    expect(late).toEqual([{ beatIndex: 3, clip, approved: true }]);
    expect(await vp.takeLateApprovedPicks(dedup, 1, 0), "taken once").toEqual([]);
  });

  it("D2. at the scene's end a picture approved but still preparing is waited for (within the scene's time)", async () => {
    const vp = await import("./videoPipeline");
    const dedup = {};
    const clip = "/tmp/scene_0_b1_yt_transformed.mp4";
    let resolve!: (v: string) => void;
    const ladder = new Promise<string | null>((r) => { resolve = r; });
    vp.noteLadderForBeat(dedup, 0, 1, 0, ladder);
    vp.noteApprovedPickForBeat(dedup, 0, 1, vp.clipContentKey(clip));
    setTimeout(() => resolve(clip), 40);
    expect(await vp.takeLateApprovedPicks(dedup, 0, 0), "between sentences: not waited for").toEqual([]);
    expect(await vp.takeLateApprovedPicks(dedup, 0, 5_000)).toEqual([{ beatIndex: 1, clip, approved: true }]);
  });

  it("D3. a search still running without any approval is not waited for at the scene's end — and is named", async () => {
    const vp = await import("./videoPipeline");
    const dedup = {};
    vp.noteLadderForBeat(dedup, 2, 0, 0, new Promise<string | null>(() => {}));
    const started = Date.now();
    expect(await vp.takeLateApprovedPicks(dedup, 2, 5_000)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(PIPE).toContain("its search was still running when the scene closed");
  });
});

describe("B/C — an answer reaches the scene exactly once, through the one push gate", () => {
  it("B. an answer that already reached the scene is not handed back again", async () => {
    const vp = await import("./videoPipeline");
    const dedup = {};
    const clip = "/tmp/scene_0_b0_curated_a1.mp4";
    vp.noteLadderForBeat(dedup, 0, 0, 0, Promise.resolve(clip));
    vp.noteApprovedPickForBeat(dedup, 0, 0, vp.clipContentKey(clip));
    vp.noteOfferedToScene(dedup, 0, 0, clip);
    await wait(5);
    expect(await vp.takeLateApprovedPicks(dedup, 0, 0)).toEqual([]);
  });

  it("C. wiring: every push notes it reached the scene; the scene places late answers through `pushSceneClip`, between sentences and at its end", () => {
    const push = PIPE.slice(PIPE.indexOf("const pushSceneClip = async ("));
    expect(push.slice(0, 400)).toContain("noteOfferedToScene(dedup, scene.index, beatIndex, clipPath);");
    const place = PIPE.slice(PIPE.indexOf("const placeLateApprovedPicks = async"), PIPE.indexOf("const placeLateApprovedPicks = async") + 2_000);
    expect(place).toContain("pushSceneClip(late.clip, beat.holdSec, late.beatIndex)");
    expect(place).toContain("if (clipBeatIndices.includes(late.beatIndex))");
    expect(place).toContain("if (!late.approved)");
    expect(PIPE).toContain("await placeLateApprovedPicks(false);\n    await fillBeatWithMoreClips();");
    expect(PIPE).toContain("await placeLateApprovedPicks(true);\n    await fillBeatWithMoreClips();");
  });

  it("C. the ladder's answer is registered for the scene; the sentence itself never waits for a late one", () => {
    const body = PIPE.slice(PIPE.indexOf("async function resolveBeatClipForBeat("), PIPE.indexOf("// ─── Unified beat-clip retrieval entry point"));
    expect(body).toContain("noteLadderForBeat(dedup, sceneIndex, beat.index, approvedBefore, forScene);");
    expect(body).toContain("return answer;");
    expect(body).toContain("late = capped.late;");
    /** The literal capped call stays at the call site (the YouTube-turn walker reads it). */
    expect(body).toContain("withSceneFetchTimeout(\n        () => track(beatPrimaryFetch(");
  });

  it("C. FIT acceptances record WHICH picture was approved for which sentence", () => {
    expect(PIPE).toContain(
      'if (beatEvidence === "FIT" && !requeuedAfterRefusal.has(p)) noteApprovedPickForBeat(dedup, sceneIndex, beatIndex, contentKey);'
    );
  });
});

describe("E — nothing unapproved or technically unusable is placed", () => {
  it("E1. a late answer the picture editor never approved for this sentence comes back marked unapproved", async () => {
    const vp = await import("./videoPipeline");
    const dedup = {};
    const clip = "/tmp/scene_1_b1_primary_hist_archive_0__pid_internet_archive-9b635ebd62d2dc2b_transformed.mp4";
    vp.noteLadderForBeat(dedup, 1, 1, 0, Promise.resolve(clip));
    /** approved for ANOTHER sentence only */
    vp.noteApprovedPickForBeat(dedup, 1, 2, vp.clipContentKey(clip));
    await wait(5);
    expect(await vp.takeLateApprovedPicks(dedup, 1, 0)).toEqual([{ beatIndex: 1, clip, approved: false }]);
    expect(PIPE).toContain("without the picture editor's approval for it — not placed");
  });

  it("E2. a late answer is checked for technical faults before the scene may see it", () => {
    expect(PIPE).toContain("return v && !(await technicalMediaRefusal(v, MEDIA_PROBES)) ? v : null;");
  });

  it("E3. no new look: a late picture is pushed only with the verdict already given (the turn-over guard is unchanged)", () => {
    const rel = fs.readFileSync(path.join(__dirname, "beatVisualRelevance.ts"), "utf8");
    expect(rel).toContain('if (!alreadyKnown && state.turnOver?.()) {');
  });
});
