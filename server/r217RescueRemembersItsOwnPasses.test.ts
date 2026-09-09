/**
 * RONDE 217 — NINE CALLERS, NO SHARED MEMORY, SIX IDENTICAL PASSES.
 *
 * ── What render 575 measured ────────────────────────────────────────────────────────────────
 *
 * In the ten minutes of log that survive, ONE scene ran the compose-time rescue six times:
 *
 *     [VisualCoverage] s0b1: rejected=132 … 140 … 148 … 156 … 167 … 175
 *
 * Those six passes account for 205 Pexels searches and 205 Pixabay searches. The searches
 * themselves are cheap — 49 seconds out of a render the watchdog stopped at 4127. What cost the
 * time was running the whole pass again, five more times, into the same wall.
 *
 * Nine separate call sites reach `recoverSceneClipsIfEmpty`, and none could see that another had
 * just run. RONDE 94's shape — a rule several routes must respect, respected by none — in its
 * performance form.
 *
 * ── The one thing that can legitimately change the answer ───────────────────────────────────
 *
 * A pass that yielded nothing did so because every candidate was refused or unusable. Asking the
 * same providers the same questions about the same beats cannot do better — UNLESS the render has
 * adopted something in the meantime. An adoption changes `usedContentKeys`, which is what the
 * dedup refuses on, so a beat previously blocked as a duplicate can become adoptable.
 *
 * So `usedContentKeys.size` is the discriminator: repeat freely while the render is still
 * adopting, decline only when the last pass found nothing AND nothing has been adopted since.
 *
 * This is not a cap and not a budget. A scene that has never been recovered is never skipped, and
 * nothing that could have succeeded is refused.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const wrapper = PIPE.slice(
  PIPE.indexOf("export async function recoverSceneClipsIfEmpty("),
  PIPE.indexOf("async function recoverSceneClipsIfEmptyInner(")
);

describe("R217 §1 — the rescue remembers what it already tried", () => {
  it("THE MEMORY LIVES ON THE RENDER, so all nine callers share it", () => {
    expect(PIPE).toContain(
      "sceneRecoveryAttempts: Map<number, { yielded: number; usedKeysAt: number }>;"
    );
    expect(PIPE).toContain("sceneRecoveryAttempts: new Map(),");
    expect(wrapper).toContain("dedup.sceneRecoveryAttempts.get(scene.index)");
  });

  it("it is checked in the ONE wrapper every caller passes through", () => {
    const callers = [...PIPE.matchAll(/recoverSceneClipsIfEmpty\(/g)].length;
    expect(callers, "the wrapper has no callers — this is measuring nothing").toBeGreaterThan(5);
    const check = wrapper.indexOf("const prior = dedup.sceneRecoveryAttempts.get");
    const work = wrapper.indexOf("recoverSceneClipsIfEmptyInner(");
    expect(check).toBeGreaterThan(0);
    expect(check, "the pass runs before anything asks whether it should").toBeLessThan(work);
  });

  it("A SCENE IS ONLY SKIPPED WHEN BOTH FACTS HOLD", () => {
    expect(wrapper).toContain(
      "prior && prior.yielded === 0 && prior.usedKeysAt === dedup.usedContentKeys.size"
    );
  });

  it("a scene that has never been rescued is never skipped", () => {
    // `prior` is undefined on the first pass, so the condition cannot hold.
    expect(wrapper).toContain("const prior = dedup.sceneRecoveryAttempts.get(scene.index);");
    expect(wrapper).toContain("if (prior &&");
  });

  it("A PASS THAT FOUND SOMETHING NEVER BLOCKS THE NEXT ONE", () => {
    // yielded > 0 fails the first conjunct.
    const at = wrapper.indexOf("prior.yielded === 0");
    expect(at).toBeGreaterThan(0);
  });

  it("AND NEITHER DOES AN ADOPTION ELSEWHERE IN THE RENDER", () => {
    /**
     * The whole safety of this round: an adoption moves `usedContentKeys`, which is what the dedup
     * refuses on, so a beat blocked as a duplicate can become adoptable. When that number has
     * changed the rescue runs again, however empty the previous pass was.
     */
    expect(wrapper).toContain("prior.usedKeysAt === dedup.usedContentKeys.size");
  });

  it("every outcome is recorded, including a pass the clock cut short", () => {
    expect(wrapper).toContain("return record(");
    expect(wrapper).toContain("return record({ clips, beatDurations });");
    expect(wrapper).toContain("yielded: result.clips.length");
    expect(wrapper).toContain("usedKeysAt: dedup.usedContentKeys.size");
  });

  it("IT IS NEVER SILENT — a skipped rescue says why", () => {
    expect(wrapper).toContain("[SceneRescue] scene ${scene.index}: skipped");
    // The sentence spans a string concatenation in the source; match the half that is literal.
    expect(wrapper).toContain("the previous pass found nothing");
    expect(wrapper).toContain("render has adopted nothing since");
  });

  it("NO BUDGET OR TIMEOUT IS CHANGED by this round", () => {
    const budget = fs.readFileSync(path.join(__dirname, "sceneSearchBudget.ts"), "utf8");
    expect(budget).toContain("export const SCENE_SEARCH_MIN_MS = 60_000;");
    expect(budget).toContain("export const SCENE_SEARCH_MAX_FACTOR = 2.5;");
    expect(wrapper).toContain("composeRescueWallClockMs(dedup.videoLength)");
  });
});
