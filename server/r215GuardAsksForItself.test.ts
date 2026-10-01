/**
 * RONDE 215 — A READER TIGHTENED WITHOUT ITS WRITER, AND A PRODUCTION FILM CAME OUT EMPTY.
 *
 * ── What render 575 measured ────────────────────────────────────────────────────────────────
 *
 *     [AdoptionGuard] scene=0 beat=1 route=rescue_wikimedia eligible=true vision=NOT_ASKED
 *         blocked=FUNNEL_WITHOUT_EVIDENCE reason=route "rescue_wikimedia" claims RESCUE_REAL
 *         without vision (NOT_ASKED)
 *     [AdoptionGuard] scene=0 beat=1 route=fallback           ... 28 times
 *     [AdoptionGuard] scene=0 beat=1 route=rescue_placeholder ... 24 times
 *
 *     [Video Generation] Error: Scene 0: 4 zinnen maar 0 voice/script-matchende clips
 *                        — export geblokkeerd
 *
 * Real Wikimedia footage, already ELIGIBLE, refused — not because the picture editor disliked it,
 * but because nobody had asked it anything.
 *
 * ── The defect ──────────────────────────────────────────────────────────────────────────────
 *
 * RONDE 199 made `adoptionGuardRefusesPush` REQUIRE a verdict: "nobody looked" stopped counting as
 * an answer. The asking lives in `beatClipRefusedByRelevanceGate`, and that is called at 5 of the
 * guard's 17 call sites. At the other 12 the verdict was NOT_ASKED by construction, so after
 * RONDE 199 every adoption through them was refused.
 *
 * A rule 17 routes must follow, wired into 5 of them. RONDE 94 named that shape and RONDE 201 fixed
 * an instance of it; this is the same fault, introduced by RONDE 199 itself.
 *
 * ── Two different silences ──────────────────────────────────────────────────────────────────
 *
 * They must not be treated alike:
 *
 *   nobody tried            → still a refusal. That is what RONDE 199 is for and it stays.
 *   nothing to try against  → not a refusal. `fillSceneToMinimumClips` passes `2000 + slot` as the
 *                             beat index and its own comment says it is "NOT a real narrative beat
 *                             index". No sentence stands behind it, so no verdict about "does this
 *                             picture fit this sentence" can exist. Demanding one is the
 *                             `askImpossible` lesson again: a requirement that cannot be met does
 *                             not raise the standard, it empties the film.
 */
import { describe, expect, it } from "vitest";

import {
  nothingToJudgeAgainst,
  type ComposeJudgeOutcome,
} from "./beatVisualRelevance";
import fs from "fs";
import path from "path";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** The body of one top-level function, by name. */
const bodyOf = (name: string): string => {
  const at = PIPE.indexOf(`async function ${name}(`);
  if (at < 0) throw new Error(`${name} not found`);
  const next = PIPE.indexOf("\nasync function ", at + 10);
  const alt = PIPE.indexOf("\nfunction ", at + 10);
  const end = Math.min(next < 0 ? PIPE.length : next, alt < 0 ? PIPE.length : alt);
  return PIPE.slice(at, end);
};

/* ═══════════ 1. the guard obtains what it demands ═══════════ */

describe("R215 §1 — the guard asks for the evidence it refuses adoptions over", () => {
  const guard = bodyOf("visualJudgeRefusesPush");

  it("THE ASK IS INSIDE THE GUARD, so no caller can forget it", () => {
    expect(guard, "the guard still only reads a verdict it never obtains").toContain(
      "ensureVerdictBeforeCompose({"
    );
  });

  it("and it asks as the beat's final say, not as one comparison among many", () => {
    const at = guard.indexOf("ensureVerdictBeforeCompose({");
    expect(guard.slice(at, at + 400)).toContain("finalSay: true");
  });

  it("it asks BEFORE it reads the verdict — otherwise the answer arrives too late", () => {
    const asks = guard.indexOf("ensureVerdictBeforeCompose({");
    const reads = guard.indexOf("relevanceVerdictForRenderedAsset(");
    expect(asks).toBeGreaterThan(0);
    expect(reads).toBeGreaterThan(0);
    expect(asks, "the guard reads the ledger before it has asked anything").toBeLessThan(reads);
  });

  it("EVERY CALL SITE IS NOW COVERED — the one push door asks for itself", () => {
    /**
     * The original fault in one number: 17 places called the guard, 5 of them asked. Since ONE
     * ROUTE the barrier and the route rule are one function, reached through the one push boundary,
     * so no caller can consult one without the other or without the ask.
     */
    const doors = [...PIPE.matchAll(/visualJudgeRefusesPush\(/g)].length;
    expect(doors, "the push judge has no caller — the sweep is measuring nothing").toBeGreaterThanOrEqual(2);
    expect(PIPE).not.toContain("adoptionGuardRefusesPush(");
    expect(guard).toContain("ensureVerdictBeforeCompose({");
  });
});

/* ═══════════ 2. the two silences stay different ═══════════ */

describe("R215 §2 — 'nobody tried' and 'nothing to try against' are not the same answer", () => {
  const guard = bodyOf("visualJudgeRefusesPush");

  /**
   * RENDER 592-B — THE SAME CLAIM, ASKED OF THE CODE INSTEAD OF THE TEXT.
   *
   * This read the guard's source for the three literals. That was the whole check, and it had a
   * blind spot the size of the defect 592-B cost: the literals lived HERE and nowhere else, so a
   * second route could make the same decision without them and this test would still pass. It did.
   * `beatClipRefusedByRelevanceGate` refused four files forty-six times for an approval that by
   * this very rule could not be earned, and scene 2 ended on text overlays the export gate rejects.
   *
   * The policy now lives in `nothingToJudgeAgainst`, which both routes consult. Neither half of the
   * original claim is dropped — the three that suspend and the verdicts that must never suspend are
   * both still asserted — and both are now asked of the function that decides rather than of the
   * characters around it. The structural half below keeps the guard tied to that function, so a
   * route that stops consulting it still fails here.
   */
  it("only the three outcomes that mean NO NARRATION EXISTS suspend the requirement", () => {
    const at = guard.indexOf("const nothingToJudge =");
    expect(at, "the suspension is not conditional on the outcome any more").toBeGreaterThan(0);

    for (const outcome of ["no_scope", "beat_unknown", "no_narration"] as ComposeJudgeOutcome[]) {
      expect(nothingToJudgeAgainst(outcome), `${outcome} no longer suspends`).toBe(true);
    }
    /** An answer the render actually obtained, or could still obtain, must never suspend it. */
    for (const outcome of [
      "judged",
      "already_judged",
      "budget_spent",
      "placeholder",
    ] as ComposeJudgeOutcome[]) {
      expect(
        nothingToJudgeAgainst(outcome),
        `${outcome} must never suspend the requirement`
      ).toBe(false);
    }
    /** And the push judge must still take its answer from that one predicate. */
    expect(guard.slice(at, at + 200), "the suspension is decided on something of its own again").toContain(
      "nothingToJudgeAgainst(lastLook)"
    );
  });

  it("A MISSING BEAT INDEX IS NOT AN ANSWER EITHER", () => {
    expect(guard).toContain("const nothingToJudge = beatIndex == null ||");
  });

  it("the suspension reaches the verdict through visionAvailable, beside the other two latches", () => {
    expect(guard).toContain("!visionPipelineIsUnavailable()");
    expect(guard).toContain("!dedup.beatImageGate?.askImpossible");
    expect(guard).toContain("!nothingToJudge");
  });

  it("IT IS NEVER SILENT — a suspended requirement is printed with its reason", () => {
    expect(guard).toContain("[AdoptionGuard] s${sceneIndex}b${beatIndex}: nothing to judge against");
    expect(guard).toContain("suspended for this adoption, not waived for the render");
  });

  it("the guard still refuses when the editor was asked and said no", () => {
    /**
     * The point of RONDE 199 must survive: this round widens who gets ASKED, never what counts as
     * a pass. `adoptionGuardVerdict` is untouched and reached only through `judgeAtPush`.
     */
    expect(guard).toContain("const route = source ? { source, eligible, vision, visionAvailable } : null;");
    expect(guard).toContain("judgeAtPush({");
    const vj = fs.readFileSync(path.join(__dirname, "visualJudge.ts"), "utf8");
    expect(vj).toContain("const guard = adoptionGuardVerdict(input.route);");
  });
});

/* ═══════════ 3. what RONDE 199 established and this round must not undo ═══════════ */

describe("R215 §3 — the tightening itself is unchanged", () => {
  it("the vision requirement still refuses NOT_ASKED where an ask was possible", async () => {
    const { visionRequirementMet } = await import("./adoptionPolicy");
    const policy = { visionRequirement: "not_rejected" } as never;
    expect(visionRequirementMet(policy, "NOT_ASKED")).toBe(false);
    expect(visionRequirementMet(policy, "REJECTED")).toBe(false);
    expect(visionRequirementMet(policy, "APPROVED")).toBe(true);
    expect(visionRequirementMet(policy, "UNCLEAR")).toBe(true);
  });

  it("a looked_at policy still needs the picture to have been seen", async () => {
    const { visionRequirementMet } = await import("./adoptionPolicy");
    const policy = { visionRequirement: "looked_at" } as never;
    expect(visionRequirementMet(policy, "NOT_ASKED")).toBe(false);
    expect(visionRequirementMet(policy, "REJECTED")).toBe(true);
  });

  it("SEARCH_GATE_STRICT and the export blocks are untouched by this round", () => {
    const contract = fs.readFileSync(path.join(__dirname, "searchQueryContract.ts"), "utf8");
    expect(require("fs").readFileSync(require("path").join(__dirname, "config.ts"), "utf8")).toContain('return process.env.SEARCH_GATE_STRICT !== "false";');
    // RONDE 89's two export blocks live where the quality report is assembled, not in the pipeline.
    const report = fs.readFileSync(path.join(__dirname, "videoQualityReport.ts"), "utf8");
    expect(report).toContain("NO_VERIFIED_OWN_VISUAL");
    expect(report).toContain("MOSTLY_UNVERIFIED_CLIPS");
  });
});
