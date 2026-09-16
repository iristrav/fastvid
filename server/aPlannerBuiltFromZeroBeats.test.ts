/**
 * RONDE 262 — THE PLANNER THAT WAS BUILT FROM ZERO BEATS, EVERY RENDER.
 *
 * ── The line, and what it always evaluated to ───────────────────────────────────────────────
 *
 *     const scenesForPlan = scenes.map((s) => ({
 *       index: s.index,
 *       beats: ((s as { beats?: Array<{ index: number; text: string }> }).beats ?? []).map(…),
 *     }));
 *
 * `Scene` has no `beats` field. Not an optional one — none at all, which is precisely why the cast
 * is there. So that expression is `[]` on every scene of every render, `buildDocumentaryPlan`
 * iterates an empty list, and `contracts` comes back empty.
 *
 * Every `getRetrievalContract(plan, s, b)` since has therefore been a lookup in an empty map, and
 * the whole Documentary Planning Engine — `preferredShot`, `mustContain`, `mustNotContain`, the
 * per-beat retrieval contract RONDE 96 deliberately wired into ranking before the sort — has been
 * inert for the entire life of the feature. The plan still logged itself as built, with
 * `hard=0 withPreferredShot=0`, which reads like a planner with nothing to say rather than one
 * that was handed nothing.
 *
 * This is the codebase's signature defect in its purest form: the answer is computed, written
 * down, and not carried to where the decision is made. Here it was not even computed — the field
 * it was read from never existed.
 *
 * ── Why the repair attaches contracts late rather than building beats early ─────────────────
 *
 * Beats do not exist when the plan is built; that is the whole reason the field was empty. They
 * are resolved later, per scene, and recorded once in `sceneBeatsBySceneIndex` — "the one function
 * every beat-resolving route calls".
 *
 * Deriving a second beat set early to fill the plan would key a contract `s2b3` to a different
 * beat 3 than the render goes on to use, and AN OBEYED WRONG CONTRACT IS WORSE THAN AN ABSENT ONE:
 * an empty map is ignored, a mistaken one is followed. §3 is that rule as a test.
 *
 * NOTHING IS LOOSENED. `deriveContract` is unchanged, the blueprint is unchanged, the keys are the
 * ones `getRetrievalContract` already reads. What changes is that the map is no longer empty.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  attachSceneContracts,
  buildDocumentaryPlan,
  getRetrievalContract,
} from "./documentaryPlanningEngine";
import { stripComments } from "./sourceScan.test.support";

const PIPE = stripComments(fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8"));
const ENGINE = fs.readFileSync(path.join(__dirname, "documentaryPlanningEngine.ts"), "utf8");

const plan = () => buildDocumentaryPlan("586", "documentary", [], null);

const BEATS = [
  { index: 0, text: "Kim Kardashian was involved in a 2024 defamation lawsuit." },
  { index: 1, text: "The case was heard in Los Angeles County." },
  { index: 2, text: "Blac Chyna brought the claim." },
];

/* ═══════════ 1. the field that never existed ═══════════ */

describe("R262 §1 — Scene has no beats, so the plan was handed none", () => {
  it("THE PROOF: the Scene interface carries no beats field", () => {
    const iface = PIPE.slice(
      PIPE.indexOf("export interface Scene {"),
      PIPE.indexOf("export interface PipelineProgress {")
    );
    expect(iface).toContain("index: number;");
    expect(iface, "if Scene gained beats, the cast at the plan call is the thing to remove").not
      .toMatch(/\n\s*beats\??:/);
  });

  it("and a plan built the way the render builds it has no contracts at all", () => {
    const p = plan();
    expect(p.contracts.size, "this is what every render has been running with").toBe(0);
    expect(getRetrievalContract(p, 2, 0)).toBeNull();
  });
});

/* ═══════════ 2. the beats the render actually resolved ═══════════ */

describe("R262 §2 — attached where the beats exist", () => {
  it("THE REPAIR: real beats produce real contracts, on the keys the reader uses", () => {
    const p = plan();
    expect(attachSceneContracts(p, 2, BEATS)).toBe(3);
    expect(p.contracts.size).toBe(3);
    for (const b of BEATS) {
      expect(getRetrievalContract(p, 2, b.index), `s2b${b.index} has no contract`).not.toBeNull();
    }
  });

  it("the contract is derived from THIS beat's own sentence", () => {
    const p = plan();
    attachSceneContracts(p, 2, BEATS);
    const a = getRetrievalContract(p, 2, 0);
    const b = getRetrievalContract(p, 2, 1);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(
      JSON.stringify(a) === JSON.stringify(b),
      "every beat got the same contract, which means the text was not read"
    ).toBe(false);
  });

  it("scenes do not overwrite each other", () => {
    const p = plan();
    attachSceneContracts(p, 0, BEATS);
    attachSceneContracts(p, 2, BEATS);
    expect(p.contracts.size).toBe(6);
    expect(getRetrievalContract(p, 0, 1)).not.toBeNull();
    expect(getRetrievalContract(p, 2, 1)).not.toBeNull();
  });

  it("no plan, no beats, or an empty scene changes nothing and throws nothing", () => {
    expect(attachSceneContracts(null, 0, BEATS)).toBe(0);
    expect(attachSceneContracts(undefined, 0, BEATS)).toBe(0);
    const p = plan();
    expect(attachSceneContracts(p, 0, [])).toBe(0);
    expect(p.contracts.size).toBe(0);
  });
});

/* ═══════════ 3. one reading of one sentence ═══════════ */

describe("R262 §3 — a wrong contract is worse than no contract", () => {
  it("FIRST WRITER WINS: a re-recorded scene does not acquire a second reading", () => {
    const p = plan();
    attachSceneContracts(p, 2, BEATS);
    const first = JSON.stringify(getRetrievalContract(p, 2, 0));
    const again = attachSceneContracts(p, 2, [
      { index: 0, text: "Something else entirely about a bunker in Berlin." },
    ]);
    expect(again, "the second pass rewrote a beat the render had already read").toBe(0);
    expect(JSON.stringify(getRetrievalContract(p, 2, 0))).toBe(first);
  });

  it("and the repair does NOT derive its own beats — that is the whole point", () => {
    const fn = ENGINE.slice(
      ENGINE.indexOf("export function attachSceneContracts("),
      ENGINE.indexOf("export function getRetrievalContract(")
    );
    expect(fn, "a second beat set would key contracts to the wrong sentences").not.toContain(
      "buildSceneBeats"
    );
    expect(fn).toContain("deriveContract(sceneIndex, beat.index, directive, shot, beat.text)");
  });
});

/* ═══════════ 4. wired to the one beat store ═══════════ */

describe("R262 §4 — attached at the single point of record", () => {
  it("THE CALL SITS WITH sceneBeatsBySceneIndex.set, not somewhere that guesses", () => {
    const store = PIPE.indexOf("dedup.sceneBeatsBySceneIndex.set(sceneIndex, beats);");
    expect(store).toBeGreaterThan(-1);
    const after = PIPE.slice(store, store + 1400);
    expect(after).toContain("attachSceneContracts(dedup.documentaryPlan, sceneIndex, beats)");
  });

  it("it is guarded on the plan existing, so a render without one is untouched", () => {
    const store = PIPE.indexOf("dedup.sceneBeatsBySceneIndex.set(sceneIndex, beats);");
    const after = PIPE.slice(store, store + 1400);
    expect(after).toContain("if (dedup.documentaryPlan) {");
  });

  it("and it says so, because a planner that finally has input should be visible", () => {
    expect(PIPE).toContain("[DocumentaryPlan] scene ${sceneIndex}: ${added} retrieval contract(s)");
  });

  it("the reader is unchanged — same map, same key shape", () => {
    expect(ENGINE).toContain("return plan?.contracts.get(`s${sceneIndex}b${beatIndex}`) ?? null;");
    expect(PIPE).toContain("getRetrievalContract(");
  });
});

/* ═══════════ 5. nothing was loosened ═══════════ */

describe("R262 §5 — the engine's own rules are untouched", () => {
  it("deriveContract still takes the beat's text and the blueprint's directive", () => {
    expect(ENGINE).toContain("function deriveContract(");
    expect(ENGINE).toContain("beatText: string");
  });

  it("the plan is still validated the way it was", () => {
    expect(ENGINE).toContain("const validation       = validatePlan(");
  });

  it("and the feature flag still decides whether any of this runs", () => {
    expect(ENGINE).toContain("export function documentaryPlanningEnabled()");
    expect(PIPE).toContain("if (documentaryPlanningEnabled()) {");
  });
});
