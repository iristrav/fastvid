/**
 * RONDE 123 — the three root causes behind video 544's held frames.
 *
 * From the worker log:
 *
 *     Scene 0   clips=4   dur=20.0s    visuals (all beats):  60.8s
 *     Scene 1   clips=1   dur=38.1s    visuals (all beats): 180.0s   ← the ceiling, to the tenth
 *     Scene 2   clips=4   dur=21.4s    visuals (all beats):  86.0s
 *
 *     Scene 0/1/2 Compose montage backfill: 0ms
 *     [Coverage] Scene 1 single-clip montage: short 34.40s (would need 10.88x)
 *     → slowed to the 2x cap, 30.92s STILL UNCOVERED → held frame (last resort)
 *
 *     [persons: Adolf Hitler, Carin, Join Hitler, Influential Choice Hermann]
 *
 * Three separate faults, each measurable:
 *
 *  1. the per-scene search budget is flat, so the longest scene is the one starved;
 *  2. the coverage backfill — every rung of RONDE 111 and 112 — was switched off for short videos,
 *     which is why the backfill measured 0ms and scene 1 fell straight to the last resort;
 *  3. the person patterns are ASCII, so a diacritic deletes the real subject AND manufactures two
 *     fake ones out of the halves it splits the sentence into.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  SCENE_SEARCH_BASELINE_SEC,
  SCENE_SEARCH_MAX_FACTOR,
  formatSceneSearchBudget,
  sceneSearchBudgetMs,
} from "./sceneSearchBudget";
import {
  isNameShapedToken,
  nameRunRegex,
  singleNameTokenRegex,
  stripToNameSafeText,
} from "./personNameChars";
import { extractPersonNamesFromText } from "./videoPipeline";

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), "server", f), "utf8");

/* ═══════════ 1. the scene that ran out of clock, not of material ═══════════ */

describe("RONDE 123 — a longer scene gets longer to find its pictures", () => {
  const FLAT = 180_000;

  it("THE PRODUCTION CASE: scene 1 was 38.1s and hit the flat ceiling to the tenth", () => {
    /**
     * 180.0s in the log is `sceneVisualTimeoutMs` exactly. Scenes 0 and 2 finished in 60.8s and
     * 86.0s, so the ceiling only ever bound the long one — and the long one is the one that came
     * out with a single clip.
     */
    const scene1 = sceneSearchBudgetMs({ flatMs: FLAT, sceneDurationSec: 38.1 });
    expect(scene1).toBeGreaterThan(FLAT);
    // 38.1 / 22 ≈ 1.73x
    expect(scene1).toBeGreaterThan(290_000);
  });

  it("the scenes that already fitted are unchanged — this takes nothing away", () => {
    // Both finished well inside the flat share; neither may now get less than it had.
    expect(sceneSearchBudgetMs({ flatMs: FLAT, sceneDurationSec: 20.0 })).toBe(FLAT);
    expect(sceneSearchBudgetMs({ flatMs: FLAT, sceneDurationSec: 21.4 })).toBe(FLAT);
    expect(sceneSearchBudgetMs({ flatMs: FLAT, sceneDurationSec: SCENE_SEARCH_BASELINE_SEC })).toBe(FLAT);
  });

  it("it is bounded — one enormous scene cannot eat the render", () => {
    const huge = sceneSearchBudgetMs({ flatMs: FLAT, sceneDurationSec: 600 });
    expect(huge).toBe(FLAT * SCENE_SEARCH_MAX_FACTOR);
  });

  it("beats count too, because each beat is its own search", () => {
    // Same short duration, many more beats: the work is real even though the scene is not longer.
    const fewBeats = sceneSearchBudgetMs({ flatMs: FLAT, sceneDurationSec: 20, beatCount: 4 });
    const manyBeats = sceneSearchBudgetMs({ flatMs: FLAT, sceneDurationSec: 20, beatCount: 12 });
    expect(manyBeats).toBeGreaterThan(fewBeats);
  });

  it("duration and beats do not compound — the larger claim wins, they are not multiplied", () => {
    /**
     * A long scene usually also has more beats. Multiplying the two would count the same fact
     * twice and blow past the ceiling on ordinary material.
     */
    const both = sceneSearchBudgetMs({ flatMs: FLAT, sceneDurationSec: 38.1, beatCount: 9 });
    const byDurationAlone = sceneSearchBudgetMs({ flatMs: FLAT, sceneDurationSec: 38.1 });
    const byBeatsAlone = sceneSearchBudgetMs({ flatMs: FLAT, sceneDurationSec: 1, beatCount: 9 });
    expect(both).toBe(Math.max(byDurationAlone, byBeatsAlone));
  });

  it("nonsense inputs fall back to something a scene can still work with", () => {
    expect(sceneSearchBudgetMs({ flatMs: 0, sceneDurationSec: 30 })).toBeGreaterThan(0);
    expect(sceneSearchBudgetMs({ flatMs: FLAT, sceneDurationSec: NaN })).toBe(FLAT);
    expect(sceneSearchBudgetMs({ flatMs: FLAT, sceneDurationSec: -5 })).toBe(FLAT);
  });

  it("both search call sites use it — a helper nothing calls changes nothing", () => {
    const pipeline = src("videoPipeline.ts");
    const uses = pipeline.split("sceneSearchBudgetMs({").length - 1;
    expect(uses).toBe(2);
    expect(pipeline).not.toContain("                    perf.sceneVisualTimeoutMs,");
  });

  it("the log line says what was granted and why", () => {
    const line = formatSceneSearchBudget(1, 180_000, 312_000, 38.1, 9);
    expect(line).toContain("[SceneBudget]");
    expect(line).toContain("312s");
    expect(line).toContain("38.1s of narration");
  });
});

/* ═══════════ 2. the ladder that was switched off ═══════════ */

describe("RONDE 123 — the coverage backfill runs for short videos too", () => {
  it("REGRESSION: the fast-path early return is gone", () => {
    /**
     * `if (isFastShortVideoLength(dedup.videoLength)) return;` at the top of
     * backfillComposeMontageIfShort switched off every rung of RONDE 111 and 112 for a one-minute
     * video: the short-clip search, the subject fallback, and re-using the scene's own footage in
     * motion. Every scene in video 544 logged `Compose montage backfill: 0ms`.
     */
    const pipeline = src("videoPipeline.ts");
    const fn = pipeline.slice(
      pipeline.indexOf("async function backfillComposeMontageIfShort("),
      pipeline.indexOf("async function backfillComposeMontageIfShort(") + 9000
    );
    expect(fn).not.toContain("if (isFastShortVideoLength(dedup.videoLength)) return;");
    // It is bounded instead of skipped.
    expect(fn).toContain("const fastShort = isFastShortVideoLength(dedup.videoLength);");
    expect(fn).toContain("const roundAAttempts = fastShort ? 3 : 8;");
  });

  it("the long-video path keeps exactly the attempts it had", () => {
    const pipeline = src("videoPipeline.ts");
    expect(pipeline).toContain("fastShort ? 3 : 8");
    // The other coverage routine (ensureArchiveMontageVoiceCoverage) is untouched — it was never
    // gated on the fast path and must not start being.
    expect(pipeline).toContain("for (let attempt = 0; attempt < 8 && coverage < minCoverage; attempt++) {");
  });

  it("the rungs above the held frame are all still there, in order", () => {
    /**
     * The point of this round is that the last resort stays last. These are RONDE 111/112's
     * rungs, and a fix that quietly removed one of them would be worse than the bug.
     */
    const pipeline = src("videoPipeline.ts");
    const roundA = pipeline.indexOf("Round A — ask for SHORT holds");
    const roundA2 = pipeline.indexOf("Round A2: footage of what the shortest beats are ABOUT");
    const roundB = pipeline.indexOf("Round B — re-use this scene's OWN footage, in motion");
    expect(roundA).toBeGreaterThan(0);
    expect(roundA2).toBeGreaterThan(roundA);
    expect(roundB).toBeGreaterThan(roundA2);
  });

  it("the 2x slow-motion cap and the 1.2s stitch floor are untouched", async () => {
    const { MAX_COVERAGE_SLOWDOWN, MIN_STITCHABLE_SOURCE_SEC, stitchSourceFloorSec } = await import(
      "./coverageFillPlan"
    );
    expect(MAX_COVERAGE_SLOWDOWN).toBe(2);
    expect(MIN_STITCHABLE_SOURCE_SEC).toBe(1.2);
    // A 2s clip still cannot carry a 3.5s slot alone — that refusal was correct and stays.
    expect(stitchSourceFloorSec(3.5, 2.8)).toBe(2.8);
    // ...but asked for a short hold, the floor drops to where stitching becomes possible.
    expect(stitchSourceFloorSec(1.5, 2.8)).toBe(1.5);
    expect(stitchSourceFloorSec(0.5, 2.8)).toBe(1.2);
  });
});

/* ═══════════ 3. the diacritic that invented two people ═══════════ */

describe("RONDE 123 — Hermann Göring", () => {
  const TITLE_CASE_LINE =
    "The Influential Choice Hermann Göring Made To Join Hitler changed the war.";

  it("THE PRODUCTION CASE: the old pattern split the sentence AT the diacritic", () => {
    /**
     * This is the measurement the whole fix rests on. `[a-z]` does not contain `ö`, so the run
     * does not merely lose Göring — it breaks there, and both halves are then matched as names.
     */
    const oldPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
    expect(TITLE_CASE_LINE.match(oldPattern)).toEqual([
      "The Influential Choice Hermann",
      "Made To Join Hitler",
    ]);
    // Those two halves are, after the framing words are stripped, exactly the two fabricated
    // names production reported.

    // The new pattern keeps the sentence in one piece.
    expect(TITLE_CASE_LINE.match(nameRunRegex(1))).toEqual([
      "The Influential Choice Hermann Göring Made To Join Hitler",
    ]);
  });

  it("the real extractor no longer invents 'Join Hitler' or 'Influential Choice Hermann'", () => {
    const names = extractPersonNamesFromText(TITLE_CASE_LINE);
    expect(names).not.toContain("Join Hitler");
    expect(names).not.toContain("Influential Choice Hermann");
  });

  it("and a plain sentence naming him yields the person the film is about", () => {
    const names = extractPersonNamesFromText(
      "In 1922 Hermann Göring met Adolf Hitler at a rally in Munich."
    );
    expect(names).toContain("Hermann Göring");
    expect(names).toContain("Adolf Hitler");
  });

  it("other alphabets and other marks work for the same reason", () => {
    expect(isNameShapedToken("Göring")).toBe(true);
    expect(isNameShapedToken("Müller")).toBe(true);
    expect(isNameShapedToken("Đoković")).toBe(true);
    expect(isNameShapedToken("O'Neill")).toBe(true);
    expect(isNameShapedToken("Ben-Gurion")).toBe(true);
    expect(isNameShapedToken("Sant'Anna")).toBe(true);
    /**
     * A possessive is not a name. Caught by the full suite rather than by design: the first
     * version of this token allowed any lower-case run after an apostrophe, and
     * extractPersonSurnameAnchor("Hitler's Final Hours…") then returned "Hitler's". The ASCII
     * pattern excluded it accidentally, by stopping at every non-`[a-z]` character; it is now
     * excluded on purpose.
     */
    expect(isNameShapedToken("Hitler's")).toBe(false);
    // A lone capital is an initial, not a name — unchanged from the ASCII pattern.
    expect(isNameShapedToken("G")).toBe(false);
    expect(isNameShapedToken("BRAUN")).toBe(false);
    expect(isNameShapedToken("of")).toBe(false);
  });

  it("the cleaning step no longer destroys the name before matching", () => {
    // `\w` is ASCII, so the old strip handed the pattern "G ring".
    expect("Göring".replace(/[^\w\s:'-]/g, " ")).toBe("G ring");
    expect(stripToNameSafeText("Göring, 1935.")).toBe("Göring 1935");
    expect(stripToNameSafeText("Hermann Göring — Reichsmarschall")).toContain("Hermann Göring");
  });

  it("single-token candidates read diacritics too", () => {
    expect("Göring spoke.".match(singleNameTokenRegex(3))).toContain("Göring");
  });

  it("the existing refusals still refuse — this widens the alphabet, not the rules", () => {
    /**
     * The whole risk of this change is that a wider pattern lets junk through. It cannot: the
     * pattern only decides which characters are letters, and every judgement after it — the
     * framing-word split, checkPersonName's grammar rules, the thing and place vetoes — is
     * unchanged and still runs.
     */
    expect(extractPersonNamesFromText("Why Hitler Killed Himself")).not.toContain("Why Hitler");
    expect(extractPersonNamesFromText("The Eiffel Tower opened in 1889.")).not.toContain(
      "Eiffel Tower"
    );
    expect(extractPersonNamesFromText("He flew over New York in 1930.")).not.toContain("New York");
  });
});
