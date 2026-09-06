/**
 * THE HALF OF THE ADOPTION RULE THAT FAILED IN SILENCE.
 *
 * ── What four renders could not say ─────────────────────────────────────────────────────────
 *
 *     [AdoptionGuard] scene=1 beat=6 route=archive eligible=false vision=APPROVED
 *                     blocked=FUNNEL_WITHOUT_EVIDENCE
 *
 * Nine times in one render, and in that same render `stage=ELIGIBLE status=OK` appeared exactly
 * zero times. Nine pictures the editor had APPROVED, refused because the OTHER half of the rule —
 * eligibility — was never recorded.
 *
 * REAL_FUNNEL requires both. `markEligible` returns false when the lineage ledger has never seen
 * the file, which is the correct answer (an asset with no provenance must not acquire one at the
 * vision gate) and was, until now, the whole of it: a bare `false`, discarded at the call site.
 *
 * So the route that never opened a lineage record stayed anonymous while the log blamed a missing
 * verdict the clip demonstrably had. This names it, once, on the false answer only.
 *
 * ── What these tests hold ───────────────────────────────────────────────────────────────────
 *
 * That the return value is read rather than dropped, that the line carries the two facts that
 * identify the culprit — which clip, which route — and that nothing about eligibility itself moved.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { adoptionGuardVerdict, adoptionPolicyFor } from "./adoptionPolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** The vision gate's eligibility write and the lines immediately around it. */
const site = (): string => {
  const at = PIPE.indexOf("const eligibleRecorded");
  expect(at, "the eligibility write moved or was renamed").toBeGreaterThan(-1);
  return PIPE.slice(at, at + 900);
};

describe("the false answer is no longer discarded", () => {
  it("the return value is captured", () => {
    expect(site()).toContain("const eligibleRecorded");
    expect(site()).toContain("markEligible(");
  });

  /**
   * `=== false` and not `!eligibleRecorded`: the ledger is optional, so an absent one yields
   * undefined, and a render with no ledger at all must not report a gap it cannot have.
   */
  it("reports only a real false, never an absent ledger", () => {
    expect(site()).toContain("eligibleRecorded === false");
    expect(site()).not.toContain("if (!eligibleRecorded)");
  });

  /** Which clip and which route — together they are the whole question. */
  it.each(["scene=", "beat=", "route=", "file=", "contentKey="])(
    "the line carries %s",
    (field) => {
      expect(site()).toContain(field);
    }
  );

  it("says what the consequence is, not just that something failed", () => {
    expect(site()).toContain("can never satisfy REAL_FUNNEL");
  });
});

describe("eligibility itself is unchanged", () => {
  const ENV = "ENFORCE_FUNNEL_ADOPTION";
  const guard = (eligible: boolean, vision: "APPROVED" | "REJECTED") => {
    const saved = process.env[ENV];
    try {
      delete process.env[ENV];
      return adoptionGuardVerdict({ source: "archive", eligible, vision });
    } finally {
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
    }
  };

  /**
   * THE RENDER'S OWN CASE, PINNED. An approved picture that is not eligible is still refused —
   * this round makes the refusal EXPLICABLE, it does not make it go away. Naming a gap and
   * papering over it are opposite acts, and the second is the one that would ship a film whose
   * provenance nobody can state.
   */
  it("an approved but ineligible clip is still refused", () => {
    const v = guard(false, "APPROVED");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.code).toBe("FUNNEL_WITHOUT_EVIDENCE");
  });

  it("and an eligible approved one is still adopted", () => {
    expect(guard(true, "APPROVED").allowed).toBe(true);
  });

  it("archive still requires both halves", () => {
    expect(adoptionPolicyFor("archive").requiresEligibility).toBe(true);
    expect(adoptionPolicyFor("archive").visionRequirement).toBe("approved");
  });

  /** The write is still the same one call, at the same place, to the same ledger. */
  it("no second eligibility registry appeared", () => {
    const writes = PIPE.split("lineage?.markEligible(").length - 1;
    expect(writes, "the vision gate remains the single central writer").toBe(1);
  });
});
