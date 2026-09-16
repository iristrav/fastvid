/**
 * RONDE 256 — WORK CHARGED TO NOBODY IS NOT ALL THE SAME WORK.
 *
 * ── What render 585 reported ────────────────────────────────────────────────────────────────
 *
 *     [RetrievalBudget] beats=15 queries=46 downloads=168 preparations=78 rescues=37
 *     [RetrievalBudget] UNSCOPED total=568 queries=0 downloads=227 preparations=341 rescues=0
 *                       — charged to no beat, so no per-beat cap applied to it
 *
 * Read plainly, that says a third of the render's work escaped every ceiling. Twenty beats were
 * refused by their download or preparation budget in the same render, so the rem was biting hard on
 * the part it could see and not at all on the rest.
 *
 * ── What it actually is ─────────────────────────────────────────────────────────────────────
 *
 * `queries=0` is the tell. RONDE 100B's test proves every provider search sits inside a scope, and
 * it holds — so the scope is not missing. It is INCOMPLETE:
 *
 *     scenePool.ts:1463   withQueryScope({ videoId, sceneIndex: req.sceneIndex }, …)
 *     retrievalBudget.ts  if (sceneIndex == null || beatIndex == null) { unscoped[kind] += 1; }
 *
 * The scene candidate pool runs at SCENE level. It has no beat, correctly — it is building a pool
 * several beats will draw from, and there is no single beat to charge. Guessing one would file the
 * spend against a beat that never asked, which this module's own comment forbids.
 *
 * So most of that 568 is not work that escaped a ceiling it should have had. It is work that never
 * had a per-beat ceiling to escape, reported in the same bucket as work that genuinely lost its
 * identity — and the two need opposite responses.
 *
 * ── What changes, and what deliberately does not ────────────────────────────────────────────
 *
 * The count is split. `sceneScoped` is work that named its scene and has no beat; `unscoped` keeps
 * its original meaning and becomes the number worth alarming on, because work that cannot name even
 * a scene has lost its provenance.
 *
 * NO BUDGET IS ADDED. A scene-level ceiling would be a number invented without evidence that a
 * ceiling is what is missing — the scene pool already bounds itself (POOL_MAX, the raw-candidate
 * target, the scene fetch timeout). Whether a real hole remains is exactly what this split lets the
 * next render answer, and it cannot be answered while both are one number.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  chargeAmbientBudget,
  createRetrievalBudgetState,
  formatRetrievalBudgets,
  setBudgetResolver,
  type RetrievalBudgetState,
} from "./retrievalBudget";
import { withQueryScope } from "./searchQueryContract";

let state: RetrievalBudgetState;

beforeEach(() => {
  state = createRetrievalBudgetState();
  setBudgetResolver(() => state);
});
afterEach(() => setBudgetResolver(null));

describe("1. the scene pool names its scene and has no beat", () => {
  /** The exact shape scenePool.ts opens: a videoId and a sceneIndex, deliberately no beat. */
  it("scene-level work is counted as scene-scoped, not as unaccounted", () => {
    withQueryScope({ videoId: 585, sceneIndex: 1 }, () => {
      chargeAmbientBudget("downloads");
      chargeAmbientBudget("preparations");
    });
    expect(state.sceneScoped.downloads).toBe(1);
    expect(state.sceneScoped.preparations).toBe(1);
    expect(
      state.unscoped.downloads,
      "render 585 filed this under UNSCOPED, beside work that named nothing"
    ).toBe(0);
  });

  /** It is still allowed through — refusing it would stop legitimate scene-level work. */
  it("and is still allowed, because there is no per-beat ceiling to apply", () => {
    const allowed = withQueryScope({ sceneIndex: 2 }, () => chargeAmbientBudget("downloads"));
    expect(allowed).toBe(true);
  });
});

describe("2. work that names nothing is still the finding", () => {
  it("a charge outside every scope is unscoped, as it always was", () => {
    chargeAmbientBudget("downloads");
    expect(state.unscoped.downloads).toBe(1);
    expect(state.sceneScoped.downloads).toBe(0);
  });

  /** A videoId alone is not a scene: it cannot say WHERE in the film the work happened. */
  it("a render-level scope with no scene is unscoped too", () => {
    withQueryScope({ videoId: 585 }, () => chargeAmbientBudget("preparations"));
    expect(state.unscoped.preparations).toBe(1);
    expect(state.sceneScoped.preparations).toBe(0);
  });
});

describe("3. beat-scoped work is untouched", () => {
  it("a full scope still charges the beat and still hits its ceiling", () => {
    const results: boolean[] = [];
    withQueryScope({ sceneIndex: 0, beatIndex: 0 }, () => {
      for (let i = 0; i < 14; i++) results.push(chargeAmbientBudget("downloads"));
    });
    expect(results.filter(Boolean).length, "MAX_BEAT_DOWNLOADS is 12 and did not move").toBe(12);
    expect(results.slice(-2)).toEqual([false, false]);
    expect(state.sceneScoped.downloads).toBe(0);
    expect(state.unscoped.downloads).toBe(0);
  });

  /**
   * A beat scope opened INSIDE a scene scope keeps its beat — `withQueryScope` merges outward, and
   * the scene pool's own note says a beat scope already open keeps its own.
   */
  it("a beat scope nested in a scene scope is beat-scoped", () => {
    withQueryScope({ sceneIndex: 3 }, () => {
      withQueryScope({ beatIndex: 2 }, () => chargeAmbientBudget("downloads"));
    });
    expect(state.sceneScoped.downloads).toBe(0);
    expect(state.unscoped.downloads).toBe(0);
  });
});

describe("4. the report says which is which", () => {
  it("scene-scoped work is named as scene-level, not as escaped", () => {
    withQueryScope({ sceneIndex: 1 }, () => {
      for (let i = 0; i < 5; i++) chargeAmbientBudget("downloads");
    });
    const line = formatRetrievalBudgets(state).find((l) => l.includes("SCENE_SCOPED"));
    expect(line, "render 585 had no way to say this").toBeTruthy();
    expect(line!).toContain("downloads=5");
  });

  it("and work that named nothing still reads as a hole in the ceiling", () => {
    chargeAmbientBudget("downloads");
    const line = formatRetrievalBudgets(state).find((l) => l.includes("UNSCOPED"));
    expect(line!).toContain("downloads=1");
    expect(line!).toContain("no per-beat cap applied to it");
  });

  it("a render with neither prints neither", () => {
    withQueryScope({ sceneIndex: 0, beatIndex: 0 }, () => chargeAmbientBudget("queries"));
    const lines = formatRetrievalBudgets(state);
    expect(lines.some((l) => l.includes("SCENE_SCOPED"))).toBe(false);
    expect(lines.some((l) => l.includes("UNSCOPED"))).toBe(false);
  });
});

describe("5. no budget was added, moved or invented", () => {
  it("the four ceilings are the numbers they were", async () => {
    const { BUDGETS } = await import("./retrievalBudget");
    expect(BUDGETS.queries()).toBe(24);
    expect(BUDGETS.downloads()).toBe(12);
    expect(BUDGETS.preparations()).toBe(10);
    expect(BUDGETS.rescues()).toBe(3);
  });

  it("and there is no scene-level ceiling pretending to be one", async () => {
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const src = readFileSync(path.join(__dirname, "retrievalBudget.ts"), "utf8");
    expect(src, "a scene budget would be a number nobody has evidence for").not.toMatch(
      /MAX_SCENE_(DOWNLOADS|PREPARATIONS|QUERIES|RESCUES)/
    );
  });
});
