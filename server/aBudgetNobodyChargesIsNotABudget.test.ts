/**
 * A LIMIT THAT IS NEVER ASKED IS NOT A LIMIT.
 *
 * ── What was declared ───────────────────────────────────────────────────────────────────────
 *
 * RONDE 97 §10 gave every beat four budgets, each with a default, an env var, and a paragraph
 * arguing the number:
 *
 *     queries       MAX_BEAT_QUERIES       24
 *     downloads     MAX_BEAT_DOWNLOADS     12   "100 downloads for 10 used clips"
 *     preparations  MAX_BEAT_PREPARATIONS  10
 *     rescues       MAX_BEAT_RESCUES        3   "the infinite-rescue case"
 *
 * ── What was charged ────────────────────────────────────────────────────────────────────────
 *
 *     $ grep -n 'budgetAllows(' server/*.ts | grep -v test
 *     server/retrievalBudget.ts:90:export function budgetAllows(    ← the definition
 *     server/videoPipeline.ts:32169: ... "queries")                 ← one caller
 *
 * One of four, for four rounds. And `retrievalBudgetIsEnforced.test.ts` was green throughout: its
 * tests call `budgetAllows` directly and prove the MECHANISM counts correctly, which it always
 * did. Only its last block looks at the pipeline, and that block checks the query charge alone.
 * A test can pass a hundred assertions about a limit that nothing in production consults.
 *
 * ── The receipt ─────────────────────────────────────────────────────────────────────────────
 *
 *     [VisualFunnel]   pexels retrieved=2228 … pixabay retrieved=2228 … adopted=0
 *     [Pipeline] Scene 0: skipping YouTube download of 5h8DEBAWMjI — 0s left in the scene budget
 *
 * 382 stock files written for beats that used none, and YouTube reaching the scene budget at zero
 * on 28 of 32 attempts. The spend that starved it was bounded on paper the entire time.
 *
 * So the first test here is the one that would have caught it: every declared budget must have a
 * charge somewhere in production code. Not "the four are counted separately" — that was already
 * true and proved nothing.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUDGETS,
  type BudgetKind,
  activeRetrievalBudget,
  chargeAmbientBudget,
  createRetrievalBudgetState,
  formatRetrievalBudgets,
  setBudgetResolver,
} from "./retrievalBudget";
import { withQueryScope } from "./searchQueryContract";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
const PIPE = read("videoPipeline.ts");
const PREP = read("preparationCache.ts");

const ENVS = ["MAX_BEAT_QUERIES", "MAX_BEAT_DOWNLOADS", "MAX_BEAT_PREPARATIONS", "MAX_BEAT_RESCUES"];
const savedEnv = ENVS.map((e) => [e, process.env[e]] as const);
afterEach(() => {
  for (const [e, v] of savedEnv) {
    if (v === undefined) delete process.env[e];
    else process.env[e] = v;
  }
  setBudgetResolver(null);
});

/* ═════════════ 1. every declared budget is charged somewhere ═════════════ */

describe("1. a budget with no call site is a budget that does not exist", () => {
  /**
   * THE TEST THE LAST FOUR ROUNDS DID NOT HAVE.
   *
   * Enumerated from `BUDGETS` rather than written out, so a fifth budget added later is covered
   * the moment it is declared — the failure mode being closed is precisely "declared, documented,
   * and never wired".
   */
  it("every kind in BUDGETS is charged in production code", () => {
    const production = ["videoPipeline.ts", "preparationCache.ts", "retrievalBudget.ts"]
      .map(read)
      .join("\n");
    const kinds = Object.keys(BUDGETS) as BudgetKind[];
    expect(kinds.length).toBeGreaterThanOrEqual(4);
    for (const kind of kinds) {
      const charged =
        production.includes(`budgetAllows(dedup.beatBudget, scene.index, beat.index, "${kind}")`) ||
        production.includes(`chargeAmbientBudget("${kind}")`);
      expect(charged, `budget "${kind}" is declared but nothing charges it`).toBe(true);
    }
  });

  /** Named individually too, so a failure says WHICH limit went back to being decorative. */
  it("downloads are charged at the download choke point", () => {
    const at = PIPE.indexOf("export async function downloadToFileStreaming(");
    const body = PIPE.slice(at, PIPE.indexOf("async function downloadToFileStreamingInner", at));
    expect(body).toContain('chargeAmbientBudget("downloads")');
  });

  it("preparations are charged where a real preparation starts", () => {
    expect(PREP).toContain('chargeAmbientBudget("preparations")');
  });

  it("rescues are charged where the ladder is entered", () => {
    const at = PIPE.indexOf("async function rescueBeatVisualWhenEmpty(");
    const body = PIPE.slice(at, PIPE.indexOf("async function rescueBeatVisualWhenEmptyInner", at));
    expect(body).toContain('budgetAllows(dedup.beatBudget, scene.index, beat.index, "rescues")');
  });

  /**
   * A cache hit is not work. Charging it would make the budget measure how often a beat asked
   * rather than how much it caused, and a beat could be refused for work already on disk.
   */
  it("a reused preparation is NOT charged — the charge sits below both cache checks", () => {
    const reused = PREP.indexOf('scope.counters.reused += 1');
    const inFlight = PREP.indexOf('scope.counters.skippedDuplicate += 1');
    const charge = PREP.indexOf('chargeAmbientBudget("preparations")');
    expect(charge).toBeGreaterThan(reused);
    expect(charge).toBeGreaterThan(inFlight);
  });
});

/* ═════════════ 2. the ambient charge finds the right beat ═════════════ */

describe("2. the charge reaches the beat that is actually running", () => {
  it("charges the beat named by the ambient query scope", () => {
    const state = createRetrievalBudgetState();
    setBudgetResolver(() => state);
    withQueryScope({ sceneIndex: 2, beatIndex: 3 }, () => {
      expect(chargeAmbientBudget("downloads")).toBe(true);
    });
    expect(state.byBeat.get("2:3")?.downloads).toBe(1);
    expect(state.byBeat.has("0:0")).toBe(false);
  });

  it("refuses once that beat's budget is gone, and not before", () => {
    process.env.MAX_BEAT_DOWNLOADS = "2";
    const state = createRetrievalBudgetState();
    setBudgetResolver(() => state);
    withQueryScope({ sceneIndex: 0, beatIndex: 0 }, () => {
      expect(chargeAmbientBudget("downloads")).toBe(true);
      expect(chargeAmbientBudget("downloads")).toBe(true);
      expect(chargeAmbientBudget("downloads")).toBe(false);
    });
  });

  /** A spent beat must not take its neighbour's downloads with it. */
  it("one beat's exhaustion does not refuse another's download", () => {
    process.env.MAX_BEAT_DOWNLOADS = "1";
    const state = createRetrievalBudgetState();
    setBudgetResolver(() => state);
    withQueryScope({ sceneIndex: 0, beatIndex: 0 }, () => {
      chargeAmbientBudget("downloads");
      expect(chargeAmbientBudget("downloads")).toBe(false);
    });
    withQueryScope({ sceneIndex: 0, beatIndex: 1 }, () => {
      expect(chargeAmbientBudget("downloads")).toBe(true);
    });
  });

  it("the render's own budget object is the one spent — not a copy", () => {
    const state = createRetrievalBudgetState();
    setBudgetResolver(() => state);
    withQueryScope({ sceneIndex: 1, beatIndex: 1 }, () => chargeAmbientBudget("preparations"));
    expect(activeRetrievalBudget()).toBe(state);
    expect(state.byBeat.get("1:1")?.preparations).toBe(1);
  });
});

/* ═════════════ 3. the holes are counted, not assumed away ═════════════ */

describe("3. work that cannot be charged is counted, never refused", () => {
  /**
   * Refusing a download because the plumbing did not reach it would turn a wiring gap into lost
   * footage. Allowing it silently is how this went unnoticed for four rounds. So: allowed, and
   * counted where a reader will see it.
   */
  it("a charge outside any beat scope is allowed and recorded as unscoped", () => {
    const state = createRetrievalBudgetState();
    setBudgetResolver(() => state);
    expect(chargeAmbientBudget("downloads")).toBe(true);
    expect(state.unscoped.downloads).toBe(1);
    expect(state.byBeat.size).toBe(0);
  });

  it("a half-identified beat is unscoped too — a scene is not a beat", () => {
    const state = createRetrievalBudgetState();
    setBudgetResolver(() => state);
    withQueryScope({ sceneIndex: 4 }, () => {
      expect(chargeAmbientBudget("downloads")).toBe(true);
    });
    expect(state.unscoped.downloads).toBe(1);
  });

  it("the unscoped total is reported, so the hole is visible", () => {
    const state = createRetrievalBudgetState();
    setBudgetResolver(() => state);
    chargeAmbientBudget("downloads");
    const lines = formatRetrievalBudgets(state).join(" ");
    expect(lines).toContain("UNSCOPED");
    expect(lines).toContain("downloads=1");
    expect(lines).toContain("no per-beat cap applied to it");
  });

  it("a render with no unscoped spend says nothing about it", () => {
    const state = createRetrievalBudgetState();
    setBudgetResolver(() => state);
    withQueryScope({ sceneIndex: 0, beatIndex: 0 }, () => chargeAmbientBudget("queries"));
    expect(formatRetrievalBudgets(state).join(" ")).not.toContain("UNSCOPED");
  });

  /** No render in scope at all: the budget is inert, never a refusal. */
  it("no resolver means no refusal", () => {
    setBudgetResolver(null);
    expect(chargeAmbientBudget("downloads")).toBe(true);
    expect(activeRetrievalBudget()).toBeUndefined();
  });

  it("a resolver that throws does not fail the download", () => {
    setBudgetResolver(() => {
      throw new Error("no render context");
    });
    expect(chargeAmbientBudget("downloads")).toBe(true);
  });
});

/* ═════════════ 4. a refusal is a refusal, in the shape callers already handle ═════════════ */

describe("4. exhaustion says so, in a shape the callers already know", () => {
  /**
   * The download refusal throws, exactly like the permanent-refusal check directly above it, so
   * every existing catch behaves as it did. A new return shape would need every caller audited.
   */
  it("the download refusal is thrown next to the one callers already catch", () => {
    const at = PIPE.indexOf("export async function downloadToFileStreaming(");
    const body = PIPE.slice(at, PIPE.indexOf("async function downloadToFileStreamingInner", at));
    const refusedBefore = body.indexOf("(already refused this render)");
    const budget = body.indexOf("has spent its download budget");
    expect(refusedBefore).toBeGreaterThan(-1);
    expect(budget).toBeGreaterThan(refusedBefore);
    expect(body).toContain("throw new Error(");
  });

  /** Never a silent stop: the refusal names the beat and the limit it hit. */
  it("the download refusal names the beat and the limit", () => {
    const at = PIPE.indexOf("export async function downloadToFileStreaming(");
    const body = PIPE.slice(at, PIPE.indexOf("async function downloadToFileStreamingInner", at));
    expect(body).toContain("BUDGETS.downloads()");
    expect(body).toContain("did not run out of candidates");
  });

  it("the preparation refusal is a FAILED outcome, not a throw", () => {
    const at = PREP.indexOf('chargeAmbientBudget("preparations")');
    const body = PREP.slice(at, at + 700);
    expect(body).toContain('status: "FAILED"');
    expect(body).toContain("BUDGETS.preparations()");
  });

  it("the rescue refusal stands aside out loud", () => {
    const at = PIPE.indexOf("async function rescueBeatVisualWhenEmpty(");
    const body = PIPE.slice(at, PIPE.indexOf("async function rescueBeatVisualWhenEmptyInner", at));
    expect(body).toContain("console.warn");
    expect(body).toContain("standing aside");
    expect(body).toContain("return false;");
  });

  /** The rescue charge is on the wrapper, so re-entry is counted however deep the ladder goes. */
  it("the rescue charge runs before the ladder is entered", () => {
    const at = PIPE.indexOf("async function rescueBeatVisualWhenEmpty(");
    const body = PIPE.slice(at, PIPE.indexOf("async function rescueBeatVisualWhenEmptyInner", at));
    expect(body.indexOf('"rescues"')).toBeLessThan(body.indexOf("withBeatProvenance(beat, scene"));
  });
});

/* ═════════════ 5. one budget object, reachable two ways ═════════════ */

describe("5. the render spends one budget, not two", () => {
  /**
   * The choke points read the render context; the beat code reads `dedup.beatBudget`. Those must
   * be the SAME object — two would be two opinions about one spend, and the report would show
   * whichever half it happened to read.
   */
  it("the context is handed the dedup state's own budget object", () => {
    expect(PIPE).toContain("getRenderCtx().beatBudget = visualDedup.beatBudget;");
  });

  it("the resolver reads it through the per-render context", () => {
    expect(PIPE).toContain("setBudgetResolver(() => getRenderCtx().beatBudget ?? undefined);");
  });

  /** Two concurrent renders may not share a budget — hence a resolver, not a module global. */
  it("retrievalBudget holds no budget state of its own", () => {
    const SRC = read("retrievalBudget.ts");
    expect(SRC).not.toMatch(/^let \w*[Ss]tate\w*\s*[:=]/m);
    expect(SRC).toContain("let resolveBudget");
  });

  it("the render still reports the budgets it spent", () => {
    expect(PIPE).toContain("formatRetrievalBudgets(visualDedup.beatBudget)");
  });
});
