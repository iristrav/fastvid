/**
 * WHICH SWITCH DECIDED HOW THIS FILM'S FOOTAGE WAS CHOSEN.
 *
 * ── The coupling ────────────────────────────────────────────────────────────────────────────
 *
 * `POOL_RANKING_V2` chooses between two completely different ways of picking a beat's picture: the
 * ranking engine, or a keyword-overlap counter. On a deployment that sets it, it decides. On a
 * deployment that does not — the normal case — it follows `CINEMATIC_EDITING_ENGINE`.
 *
 * That inheritance is deliberate (RONDE 170: the legacy compose path has years of tuning built
 * around the keyword scorer, and an integration round must not change what every existing render
 * picks as a side effect). It is also a coupling nothing in the name of either variable admits to:
 * turning the cinematic EDITING engine off also changes which asset every beat SELECTS.
 *
 * ── What was actually wrong ─────────────────────────────────────────────────────────────────
 *
 * Two things, both about what a reader is told rather than what the code does.
 *
 * The docstring above the predicate still read "Off by default … Set POOL_RANKING_V2=true to
 * activate" — written before RONDE 170, and untrue since. Anyone reading the function's own first
 * paragraph on a cinematic deployment was told the opposite of what runs.
 *
 * And `[ProductionRoute]` printed `POOL_RANKING_V2=on`, which cannot distinguish "an operator asked
 * for this" from "this render inherited it". When a film's footage choices look wrong those two
 * call for different actions — one is a setting to revisit, the other is a coupling to discover.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { describePoolRankingV2, poolRankingV2Enabled } from "./scenePool";
import { formatProductionRoute } from "./cinematicProduction";

afterEach(() => {
  vi.unstubAllEnvs();
});



describe("the code no longer tells a reader the opposite of what it does", () => {
  const POOL = () => fs.readFileSync(path.join(__dirname, "scenePool.ts"), "utf8");

  /**
   * The stale sentence, gone. It survived RONDE 170 because that round added its reasoning BELOW
   * the old paragraph instead of correcting it, so the function carried two answers.
   */
  it("the predicate does not still claim to be off by default", () => {
    expect(POOL()).not.toContain("Set POOL_RANKING_V2=true to activate");
  });


  /**
   * RONDE 206's justification named compose as "the route that actually ships". That stopped being
   * true when the cinematic route became the delivering one, and a stale reason for a live rule is
   * how a correct rule gets removed by someone who checks the reason and finds it false.
   */
  it("no comment still claims one branch is the route that ships", () => {
    expect(POOL()).not.toContain("the route that actually ships");
  });
});
