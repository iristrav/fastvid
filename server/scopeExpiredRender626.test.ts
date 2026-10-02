/**
 * OCTOBER 2026 — render 626: the sixth sentence of scene 1 opened with 0 s (SCOPE_EXPIRED) and got
 * no picture. Two causes, both fixed without adding a search, a download or a quota:
 *
 *   1. the scene budget never heard how many sentences it had (`beatCount` was not passed), so a
 *      six-sentence scene had the time of a three-sentence one (199 s each);
 *   2. one sentence's share could eat the whole remainder — the later ones had 7 s, 3 s, 0 s.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { sceneSearchBudgetMs } from "./sceneSearchBudget";
import { BEAT_MIN_TURN_MS, beatShareOfSceneTimeMs, beatTurnAfterReserveMs, sceneSentenceCount } from "./videoPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("the scene's budget knows its sentences", () => {
  it("counts sentences", () => {
    expect(sceneSentenceCount("One. Two! Three? Four.")).toBe(4);
    expect(sceneSentenceCount("No full stop")).toBe(1);
    expect(sceneSentenceCount("")).toBe(0);
    expect(sceneSentenceCount("It cost $3.5 billion. Then it fell.")).toBe(2);
  });
  it("a six-sentence scene gets more time than a three-sentence one of the same length", () => {
    const flat = 199_000;
    expect(sceneSearchBudgetMs({ flatMs: flat, sceneDurationSec: 20, beatCount: 6 })).toBeGreaterThan(
      sceneSearchBudgetMs({ flatMs: flat, sceneDurationSec: 20, beatCount: 3 })
    );
  });
  it("the pipeline passes the count", () => {
    expect(PIPE).toContain("beatCount: Math.min(perf.maxBeatsPerScene, sceneSentenceCount(scene.text)),");
  });
});

describe("no sentence eats the turns of the sentences after it", () => {
  it("a sentence's turn leaves every later sentence its minimum", () => {
    expect(beatTurnAfterReserveMs(60_000, 80_000, 4)).toBe(80_000 - 4 * BEAT_MIN_TURN_MS);
    expect(beatTurnAfterReserveMs(20_000, 200_000, 4)).toBe(20_000);
    /** Too little for every reserve: split evenly, never 0 for the one that is asking. */
    expect(beatTurnAfterReserveMs(30_000, 20_000, 3)).toBe(5_000);
    expect(beatTurnAfterReserveMs(30_000, Number.POSITIVE_INFINITY, 3)).toBe(30_000);
  });
  it("replays scene 1 of render 626: every sentence keeps a turn even when each overruns by 50%", () => {
    let left = 199_000;
    const holds = [5, 6, 5, 4, 6, 5];
    const turns: number[] = [];
    for (let i = 0; i < holds.length; i++) {
      const share = beatShareOfSceneTimeMs(left, holds[i]!, holds.slice(i).reduce((a, b) => a + b, 0));
      const turn = beatTurnAfterReserveMs(share, left, holds.length - i - 1);
      turns.push(turn);
      left -= Math.min(left, turn * 1.5);
    }
    expect(turns.every((t) => t > 0)).toBe(true);
    expect(turns[turns.length - 1]).toBeGreaterThan(0);
  });
  it("the beat loop uses it", () => {
    expect(PIPE).toContain("beatTurnAfterReserveMs(beatShareMs, sceneLeftMs, beats.length - bi - 1)");
  });
});
