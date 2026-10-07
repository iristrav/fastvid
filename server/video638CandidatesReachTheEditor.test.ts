/**
 * VIDEO 638 — candidates FastVid already had never reached the picture editor.
 *
 *   1  s0b0 / s2b0 — the first sentence of a scene spends its turn in the own archive (45 s, then
 *      "archive beat budget exceeded"), waits 3–4 s for its YouTube lookahead and gives up; the
 *      lookahead delivers only as a whole, so moments READY at 08:15:22 (s0b0: three) and 08:15:51
 *      (s2b0: six) went to the next sentence. Now the sentence takes what is already prepared.
 *   2  s1b0 — "…yet he became its iconic face…": `rejected_stock` read "icon" inside "iconic" and
 *      refused all six of its YouTube moments before the picture editor saw one.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";

import { hasBlockedStockTags, isRejectedStockClip } from "./visualJudge";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
type VP = typeof import("./videoPipeline");
let vp: VP;
beforeAll(async () => {
  vp = await import("./videoPipeline");
}, 60_000);

const onDisk = (name: string) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "v638-")), name);
  fs.writeFileSync(p, "x");
  return p;
};

/* ═══════════════════════ 1 — a candidate already prepared reaches its own sentence ═══════════════════════ */

describe("1 — the moments a lookahead already prepared are this sentence's, even while it runs on", () => {
  it("A/B. s0b0: three moments ready → the sentence's own turn takes those three (once), not nothing", () => {
    const dedup = {};
    const moments = ["t1674d23", "t1756d21", "t1874d23"].map((t) => onDisk(`scene_0_ytfu_0m0_${t}__pid_youtube_cc-bab7b347261e7be9.mp4`));
    for (const m of moments) vp.noteLookaheadCandidateReady(dedup, "0:0", m);
    expect(vp.takeReadyLookaheadCandidates(dedup, "0:0")).toEqual(moments);
    expect(vp.takeReadyLookaheadCandidates(dedup, "0:0"), "handed out once").toEqual([]);
  });

  it("only this sentence's own: another sentence's ready moments are not handed over", () => {
    const dedup = {};
    const theirs = onDisk("scene_0_ytfu_1m0_t1607d33__pid_youtube_cc-72f845c990660d8f.mp4");
    vp.noteLookaheadCandidateReady(dedup, "0:2", theirs);
    expect(vp.takeReadyLookaheadCandidates(dedup, "0:0")).toEqual([]);
    expect(vp.takeReadyLookaheadCandidates(dedup, "0:2")).toEqual([theirs]);
  });

  it("a file no longer on disk is never handed out; the same file noted twice is one candidate", () => {
    const dedup = {};
    const kept = onDisk("scene_2_ytfu_0m0_t5533d40__pid_youtube_cc-acc0dfc922f30224.mp4");
    vp.noteLookaheadCandidateReady(dedup, "2:0", kept);
    vp.noteLookaheadCandidateReady(dedup, "2:0", kept);
    vp.noteLookaheadCandidateReady(dedup, "2:0", "/nowhere/scene_2_gone.mp4");
    expect(vp.takeReadyLookaheadCandidates(dedup, "2:0")).toEqual([kept]);
  });

  it("wiring: when the turn's wait ends, the ready ones are taken; only the rest goes to the next sentence", () => {
    const at = PIPE.indexOf("the beat's own turn is over; the lookahead keeps running without it");
    const branch = PIPE.slice(at, PIPE.indexOf("return found;", at) + 20);
    expect(branch).toContain("const ready = takeReadyLookaheadCandidates(dedup, youtubeTurnKey(sceneIndex, beat.index));");
    expect(branch).toContain("found = found.concat(ready);");
    expect(branch).toContain("const rest = late.paths.filter((p) => !ready.includes(p));");
    expect(branch.indexOf("takeReadyLookaheadCandidates")).toBeLessThan(branch.indexOf("return found;"));
  });

  it("wiring: only a lookahead reports ready candidates, from both places a candidate is accepted", () => {
    expect(PIPE).toContain(
      "...(req.lookahead ? { onCandidateReady: (p: string) => noteLookaheadCandidateReady(dedup, youtubeTurnKey(sceneIndex, beat.index), p) } : {}),"
    );
    expect(PIPE.match(/scriptGuided\?\.onCandidateReady\?\.\((momentPath|outPath)\);/g)?.length).toBe(2);
  });

  it("no extra search, wait or look: the helpers start nothing, and the turn's own wait is unchanged", () => {
    const helpers = PIPE.slice(
      PIPE.indexOf("export function noteLookaheadCandidateReady("),
      PIPE.indexOf("/** VIDEO 623 — keep what a lookahead delivered too late for its own sentence. */")
    );
    expect(helpers).not.toMatch(/fetch|search|setTimeout|withSceneFetchTimeout|judge|Promise/);
    expect(PIPE).toContain("const got = await lookaheadWithinTurn(ahead.result, waitMs, sceneFetchScopeStorage.getStore()?.controller.signal);");
    expect(PIPE).toContain("const waitMs = remainingScopeMs();");
  });

  it("the candidates go to the same judging as every candidate: the cascade's picture editor, nothing adopted here", () => {
    const at = PIPE.indexOf("the beat's own turn is over; the lookahead keeps running without it");
    const branch = PIPE.slice(at, PIPE.indexOf("return found;", at));
    expect(branch).not.toMatch(/adoptClip|pushSceneClip|noteApprovedPickForBeat/);
  });
});

/* ═══════════════════════ 2 — rejected_stock reads words, not runs of letters ═══════════════════════ */

describe("2 — rejected_stock: a blocked term is a word", () => {
  const S1B0 = "Elon Musk wasn't Tesla's founder, yet he became its iconic face by investing $6.5 million";
  const MOMENTS = [
    "/w/scene_1_ytfu_0m0_t1674d23__pid_youtube_cc-bab7b347261e7be9.mp4",
    "/w/scene_1_ytfu_0m1_t1710d25__pid_youtube_cc-bab7b347261e7be9.mp4",
    "/w/scene_1_ytfu_1m0_t1607d33__pid_youtube_cc-72f845c990660d8f.mp4",
  ];

  it("638 s1b0: its six moments are no longer refused for the word \"iconic\" in its sentence", () => {
    for (const m of MOMENTS) expect(isRejectedStockClip(m, S1B0), m).toBe(false);
  });

  it("C. icon ≠ silicon/iconic, toy ≠ Toyota, graphic ≠ infographic", () => {
    expect(hasBlockedStockTags("silicon valley")).toBe(false);
    expect(hasBlockedStockTags("its iconic face")).toBe(false);
    expect(hasBlockedStockTags("toyota prius")).toBe(false);
    expect(hasBlockedStockTags("infographic about sales")).toBe(false);
  });

  it("D. the real terms are still refused — singular, plural, any case, inside file names", () => {
    for (const t of [
      "cartoon", "Cartoons", "icons pack", "3D graphics", "toys on a table", "emojis", "glitches",
      "pexels-dashcam-motorway.mp4", "my_cartoon_clip.mp4", "old-nasa-archival-reel.mp4",
      "motion graphics intro", "3d render city", "sci-fi city", "miniature diorama", "seamless loop",
    ]) {
      expect(hasBlockedStockTags(t), t).toBe(true);
    }
    expect(isRejectedStockClip("/x/old-nasa-archival-reel.mp4", "rocket")).toBe(true);
  });

  it("FastVid's own \"archival footage\" in a query still does not refuse a YouTube clip (Video 613)", () => {
    expect(isRejectedStockClip(MOMENTS[0]!, "space shuttle launch archival footage")).toBe(false);
  });
});
