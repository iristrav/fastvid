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

describe("the ranking switch reports which switch it was", () => {
  it("an explicit true is explicit", () => {
    vi.stubEnv("POOL_RANKING_V2", "true");
    vi.stubEnv("CINEMATIC_EDITING_ENGINE", "false");
    expect(describePoolRankingV2()).toEqual({ on: true, decidedBy: "explicit" });
  });

  /** The override has to work in BOTH directions, or the cinematic route cannot be compared. */
  it("an explicit false beats a cinematic deployment", () => {
    vi.stubEnv("POOL_RANKING_V2", "false");
    vi.stubEnv("CINEMATIC_EDITING_ENGINE", "true");
    expect(describePoolRankingV2()).toEqual({ on: false, decidedBy: "explicit" });
  });

  it("unset means the cinematic route decides, and says so", () => {
    vi.stubEnv("POOL_RANKING_V2", "");
    vi.stubEnv("CINEMATIC_EDITING_ENGINE", "true");
    expect(describePoolRankingV2()).toEqual({ on: true, decidedBy: "cinematic_route" });
  });

  it("and off with it", () => {
    vi.stubEnv("POOL_RANKING_V2", "");
    vi.stubEnv("CINEMATIC_EDITING_ENGINE", "");
    expect(describePoolRankingV2()).toEqual({ on: false, decidedBy: "cinematic_route" });
  });

  /** Nonsense is not a setting. It falls through to the route, rather than reading as `false`. */
  it("an unparseable value is not treated as an answer", () => {
    vi.stubEnv("POOL_RANKING_V2", "yes");
    vi.stubEnv("CINEMATIC_EDITING_ENGINE", "true");
    expect(describePoolRankingV2()).toEqual({ on: true, decidedBy: "cinematic_route" });
  });

  /** One predicate, two callers. The boolean must not be able to disagree with the description. */
  it("the predicate is the description, not a second copy of the rule", () => {
    for (const [v2, cine] of [
      ["true", "false"],
      ["false", "true"],
      ["", "true"],
      ["", ""],
    ]) {
      vi.stubEnv("POOL_RANKING_V2", v2!);
      vi.stubEnv("CINEMATIC_EDITING_ENGINE", cine!);
      expect(poolRankingV2Enabled()).toBe(describePoolRankingV2().on);
    }
  });
});

describe("the route line names which switch decided", () => {
  it("says when an operator asked for this ranking", () => {
    vi.stubEnv("POOL_RANKING_V2", "true");
    expect(formatProductionRoute(7)).toContain("POOL_RANKING_V2=on(explicit)");
  });

  it("says when the render inherited it from the cinematic route", () => {
    vi.stubEnv("POOL_RANKING_V2", "");
    vi.stubEnv("CINEMATIC_EDITING_ENGINE", "true");
    expect(formatProductionRoute(7)).toContain("POOL_RANKING_V2=on(cinematic_route)");
  });

  /**
   * The case the coupling actually bites in: the engine is off, so the ranking is off too, and
   * nobody chose that. The line has to make it readable without a second variable lookup.
   */
  it("an inherited OFF is just as much a decision as an inherited on", () => {
    vi.stubEnv("POOL_RANKING_V2", "");
    vi.stubEnv("CINEMATIC_EDITING_ENGINE", "");
    expect(formatProductionRoute(7)).toContain("POOL_RANKING_V2=off(cinematic_route)");
  });
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

  /** The coupling itself, stated where someone changing either switch will meet it. */
  it("the docstring says what the inheritance costs", () => {
    const src = POOL();
    const at = src.indexOf("export function poolRankingV2Enabled(");
    const doc = src.slice(src.lastIndexOf("/**", at), at);
    expect(doc).toContain("CINEMATIC_EDITING_ENGINE");
    expect(doc).toContain("changes which asset every beat picks");
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
