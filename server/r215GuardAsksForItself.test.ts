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
  const guard = bodyOf("adoptionGuardRefusesPush");

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

  it("EVERY CALL SITE IS NOW COVERED — the count that made this a production outage", () => {
    /**
     * The original fault in one number: 17 places call the guard, 5 of them asked. Pinning the
     * exact ratio would break on any new route; what must hold is that coverage no longer depends
     * on the caller at all, so a site that does not call the judge itself is still covered.
     */
    const callers = [...PIPE.matchAll(/adoptionGuardRefusesPush\(/g)].length;
    const judges = [...PIPE.matchAll(/beatClipRefusedByRelevanceGate\(/g)].length;
    expect(callers, "the guard has no callers — the sweep is measuring nothing").toBeGreaterThan(5);
    expect(
      judges < callers,
      "if every caller judged separately this round would be unnecessary — but the guard must " +
        "still carry the rule itself"
    ).toBe(true);
    expect(guard).toContain("ensureVerdictBeforeCompose({");
  });
});

/* ═══════════ 2. the two silences stay different ═══════════ */

describe("R215 §2 — 'nobody tried' and 'nothing to try against' are not the same answer", () => {
  const guard = bodyOf("adoptionGuardRefusesPush");

  it("only the three outcomes that mean NO NARRATION EXISTS suspend the requirement", () => {
    const at = guard.indexOf("askWasPossible = false;\n      console.warn");
    expect(at, "the suspension is not conditional on the outcome any more").toBeGreaterThan(0);
    const test = guard.slice(guard.indexOf("const ensured = await"), at);
    for (const outcome of ["no_scope", "beat_unknown", "no_narration"]) {
      expect(test, `${outcome} no longer suspends`).toContain(`"${outcome}"`);
    }
    // A verdict the model actually produced must NOT appear in that list.
    for (const verdict of ["already_judged", "does_not_fit", "unknown"]) {
      expect(test, `${verdict} must never suspend the requirement`).not.toContain(`"${verdict}"`);
    }
  });

  it("A MISSING BEAT INDEX IS NOT AN ANSWER EITHER", () => {
    expect(guard).toContain("if (beatIndex == null) {");
    const at = guard.indexOf("if (beatIndex == null) {");
    expect(guard.slice(at, at + 90)).toContain("askWasPossible = false");
  });

  it("the suspension reaches the verdict through visionAvailable, beside the other two latches", () => {
    expect(guard).toContain("!visionPipelineIsUnavailable()");
    expect(guard).toContain("!dedup.beatImageGate?.askImpossible");
    expect(guard).toContain("askWasPossible");
  });

  it("IT IS NEVER SILENT — a suspended requirement is printed with its reason", () => {
    expect(guard).toContain("[AdoptionGuard] s${sceneIndex}b${beatIndex}: nothing to judge against");
    expect(guard).toContain("suspended for this adoption, not waived for the render");
  });

  it("the guard still refuses when the editor was asked and said no", () => {
    /**
     * The point of RONDE 199 must survive: this round widens who gets ASKED, never what counts as
     * a pass. `adoptionGuardVerdict` is untouched and remains the only place that decides.
     */
    expect(guard).toContain("adoptionGuardVerdict({ source, eligible, vision, visionAvailable })");
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
    expect(contract).toContain('return process.env.SEARCH_GATE_STRICT !== "false";');
    // RONDE 89's two export blocks live where the quality report is assembled, not in the pipeline.
    const report = fs.readFileSync(path.join(__dirname, "videoQualityReport.ts"), "utf8");
    expect(report).toContain("NO_VERIFIED_OWN_VISUAL");
    expect(report).toContain("MOSTLY_UNVERIFIED_CLIPS");
  });
});
