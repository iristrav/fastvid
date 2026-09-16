/**
 * RONDE 263 §2 — DOES THE CONTRACT ACTUALLY CHANGE A DECISION?
 *
 * `658e421` repaired the reason the Documentary Planning Engine's contracts map was always empty:
 * `Scene` has no `beats` field, so `buildDocumentaryPlan` was handed `[]` every render.
 *
 * "The map is no longer empty" is not the claim that matters. The claim that matters is the one
 * the repair spec asks for in as many words:
 *
 *     niet alleen:   contract bestaat
 *     maar:          contract beinvloedt daadwerkelijk selectie
 *
 * A contract that is derived, stored, carried through four call frames and then read by nobody is
 * this codebase's signature defect wearing a fix. So this file walks the whole chain and checks
 * each link, ending at the arithmetic that ranks one candidate above another.
 *
 *     plan.contracts                    documentaryPlanningEngine
 *       → getRetrievalContract(s, b)    the lookup adoptClip performs
 *       → _contract                     videoPipeline, before the ranking sort (RONDE 96)
 *       → ctx.retrievalContract         handed to the AssetDirector
 *       → scoreRetrievalContract        bonus and penalty on the weighted sum
 *
 * ── What was true before the repair ─────────────────────────────────────────────────────────
 *
 * Link 1 produced null on every beat of every render. `assetDirector`'s branch is guarded on
 * `ctx.retrievalContract` being truthy, so the scorer below it has never once run in production —
 * not because it is wrong, but because it was never reachable. §1 pins that guard, because a later
 * round that "simplifies" it away would silently restore the old behaviour.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  attachSceneContracts,
  buildDocumentaryPlan,
  getRetrievalContract,
  scoreRetrievalContract,
} from "./documentaryPlanningEngine";
import { stripComments } from "./sourceScan.test.support";

const PIPE = stripComments(fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8"));
const DIRECTOR = stripComments(fs.readFileSync(path.join(__dirname, "assetDirector.ts"), "utf8"));

const planWithBeats = () => {
  const p = buildDocumentaryPlan("586", "documentary", [], null);
  attachSceneContracts(p, 2, [
    { index: 0, text: "Soviet troops closed in on the Berlin bunker in 1945." },
  ]);
  return p;
};

/* ═══════════ 1. the link that was broken, and the guard it feeds ═══════════ */

describe("R263 §2.1 — the lookup that returned null on every beat", () => {
  it("BEFORE: a plan built the way the render built it answers null", () => {
    const empty = buildDocumentaryPlan("586", "documentary", [], null);
    expect(getRetrievalContract(empty, 2, 0)).toBeNull();
  });

  it("AFTER: the same lookup, on the same key, answers with a contract", () => {
    expect(getRetrievalContract(planWithBeats(), 2, 0)).not.toBeNull();
  });

  it("THE SCORER IS GUARDED ON EXACTLY THAT VALUE — which is why it never ran", () => {
    expect(DIRECTOR).toContain("if (documentaryPlanningEnabled() && ctx.retrievalContract) {");
    expect(
      DIRECTOR,
      "the scorer stopped being reached through the contract the plan supplies"
    ).toContain("const cs = scoreRetrievalContract(");
  });
});

/* ═══════════ 2. the carriage through videoPipeline ═══════════ */

describe("R263 §2.2 — the contract reaches the ranking, not just the render", () => {
  it("adoptClip resolves it from the plan the render holds", () => {
    expect(PIPE).toContain("const _contract = dedup.documentaryPlan");
    expect(PIPE).toContain("getRetrievalContract(");
  });

  it("AND HANDS IT ON: the AssetDirector context carries the same object", () => {
    expect(PIPE).toContain("retrievalContract: _contract,");
  });

  it("it is resolved BEFORE the ordering decision, which is RONDE 96's whole point", () => {
    const resolve = PIPE.indexOf("const _contract = dedup.documentaryPlan");
    const handOn = PIPE.indexOf("retrievalContract: _contract,");
    expect(resolve).toBeGreaterThan(-1);
    expect(handOn).toBeGreaterThan(resolve);
  });

  it("and the planner's preferred shot reaches the shot decision too", () => {
    expect(PIPE).toContain("const _plannedShot = _shot?.shotType ?? _contract?.preferredShot ?? null;");
    expect(PIPE).toContain("targetMotionRange: _contract?.motionRange ?? _rhythmBand ?? null,");
  });
});

/* ═══════════ 3. the arithmetic actually moves ═══════════ */

describe("R263 §2.3 — a contract changes the number, or it changes nothing", () => {
  const contract = {
    beatId: "s2b0",
    visualGoal: "establish" as const,
    mustContain: ["berlin"],
    shouldContain: ["soviet"],
    preferredShot: "wide",
    fallbackShot: "medium",
    motionRange: [0, 40] as [number, number],
    targetEmotion: "tense",
    forbiddenContent: ["modern city"],
  };

  it("NO CONTRACT SCORES NOTHING — which is what every render has been doing", () => {
    expect(scoreRetrievalContract(null, ["berlin"], [], [], "tense")).toEqual({
      bonus: 0,
      penalty: 0,
      explanation: "",
    });
    expect(scoreRetrievalContract(undefined, ["berlin"], [], [], "tense").bonus).toBe(0);
  });

  it("A CANDIDATE THAT MEETS THE CONTRACT SCORES ABOVE ONE THAT DOES NOT", () => {
    const meets = scoreRetrievalContract(contract, ["Berlin"], ["soviet tanks"], [], "tense");
    const misses = scoreRetrievalContract(contract, ["Los Angeles"], ["palm trees"], [], "calm");
    expect(
      meets.bonus - meets.penalty,
      "the contract is carried all the way to a scorer that cannot tell the two apart"
    ).toBeGreaterThan(misses.bonus - misses.penalty);
  });

  it("and the scorer says why, so a ranking can be read back", () => {
    const meets = scoreRetrievalContract(contract, ["Berlin"], [], [], "tense");
    expect(meets.explanation.length).toBeGreaterThan(0);
  });
});

/* ═══════════ 4. the chain, end to end, with no empty link ═══════════ */

describe("R263 §2.4 — plan to decision, every link", () => {
  it("THE FULL CHAIN: real beats produce a contract that changes a candidate's score", () => {
    const plan = planWithBeats();
    const c = getRetrievalContract(plan, 2, 0);
    expect(c, "link 1 — the lookup").not.toBeNull();
    expect(c!.beatId, "link 2 — the contract knows which beat it belongs to").toBe("s2b0");

    /** Link 3 — the same object the AssetDirector would receive, scored the same way. */
    const scored = scoreRetrievalContract(c, c!.mustContain, [], [], c!.targetEmotion);
    const unrelated = scoreRetrievalContract(c, ["something else entirely"], [], [], "calm");
    expect(scored.bonus).toBeGreaterThanOrEqual(unrelated.bonus);
    expect(
      scored.bonus - scored.penalty,
      "a candidate meeting its own contract scores no better than one ignoring it"
    ).toBeGreaterThan(unrelated.bonus - unrelated.penalty);
  });

  it("a beat with no contract still ranks — the planner informs, it does not gate", () => {
    /**
     * Important and deliberate: this round makes the planner reachable, not mandatory. A beat the
     * plan has nothing to say about must still be able to adopt a clip, or a planning gap would
     * become a coverage gap.
     */
    expect(scoreRetrievalContract(null, ["anything"], [], [], "any")).toEqual({
      bonus: 0,
      penalty: 0,
      explanation: "",
    });
    expect(DIRECTOR, "the contract became a precondition rather than a signal").toContain(
      "let contractBonus = 0;"
    );
  });
});
