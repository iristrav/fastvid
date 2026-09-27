/**
 * RONDE 111 — a shortage of footage is answered with footage, not with a slower clock.
 *
 * RONDE 26 filled a montage shorter than its own voice track by holding the last frame. RONDE 85
 * measured the cost of that (render 536: a 10.6-second frozen frame, 30 frozen segments in the
 * delivered file) and replaced it with slowing the montage down — deliberately without a cap, on
 * the reasoning that a cap leaves a remainder and the only things that could fill a remainder were
 * the two it existed to remove.
 *
 * Right about the remainder, wrong about the cure. Measured against real ffmpeg on footage that
 * moves, with no interpolation anywhere in the chain:
 *
 *     1.5x → each picture stands still 0.10s      6x → 0.32s
 *     3.0x → 0.18s                                10x → 0.59s   (under two new pictures a second)
 *
 * Past about 2x that is a slideshow of held frames reached through a different filter — and the
 * render's own freezedetect never saw it, because it needs 2.5 seconds of stillness and a 0.6s
 * hold never gets there.
 *
 * So: slowing is capped at 2x, the searching that would have been skipped now happens exactly
 * where the cap would otherwise bite, short clips stop being refused from short slots, and a held
 * frame is what is left when all of that has genuinely run out — labelled as such.
 *
 * The relevance architecture is untouched. Every clip these rounds add still comes through the
 * same beat → search-query → vision chain; nothing is added because it is the right length.
 */
import { coverageOfAdoptEntry } from "./beatVisualStatus";
import { adoptionPolicyFor } from "./adoptionPolicy";
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  MAX_COVERAGE_SLOWDOWN,
  MIN_STITCHABLE_SOURCE_SEC,
  coverageFloorSec,
  planCoverageFill,
  stitchSourceFloorSec,
} from "./coverageFillPlan";

const PIPELINE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const CURATED = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
const DOCSTYLE = fs.readFileSync(path.join(__dirname, "documentaryStyle.ts"), "utf8");

/** The standalone floor the ordinary beat path still uses. */
const STANDALONE_FLOOR = 2.8;

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

/* ═══════════ 4. meerdere korte maar geschikte clips ═══════════ */

describe("RONDE 111 — a short clip is no longer refused from a short slot", () => {
  it("the floor is the slot's own length once the slot is shorter than the standalone floor", () => {
    expect(stitchSourceFloorSec(1.5, STANDALONE_FLOOR)).toBe(1.5);
    expect(stitchSourceFloorSec(2.0, STANDALONE_FLOOR)).toBe(2.0);
  });

  it("the ordinary beat path is UNCHANGED — a long slot still wants a standalone clip", () => {
    /**
     * The whole risk of this change is a montage of two-second fragments. It cannot happen on the
     * normal path: a beat asking for five seconds still measures candidates against 2.8s.
     */
    expect(stitchSourceFloorSec(5, STANDALONE_FLOOR)).toBe(STANDALONE_FLOOR);
    expect(stitchSourceFloorSec(8, STANDALONE_FLOOR)).toBe(STANDALONE_FLOOR);
    expect(stitchSourceFloorSec(2.8, STANDALONE_FLOOR)).toBe(STANDALONE_FLOOR);
  });

  it("there is still a technical floor — a flash frame is not an edit", () => {
    expect(stitchSourceFloorSec(0.4, STANDALONE_FLOOR)).toBe(MIN_STITCHABLE_SOURCE_SEC);
    expect(stitchSourceFloorSec(0, STANDALONE_FLOOR)).toBe(STANDALONE_FLOOR);
    expect(MIN_STITCHABLE_SOURCE_SEC).toBe(1.2);
  });

  it("the trim uses it for both the source and the result, and says which slot it judged", () => {
    expect(CURATED).toContain("const minSource = stitchSourceFloorSec(");
    expect(CURATED).toContain("if (sourceDur > 0 && sourceDur < minSource) {");
    expect(CURATED).toContain("if (outDur < minSource) {");
    expect(CURATED).toContain("for a ${duration.toFixed(2)}s slot");
  });
});

/* ═══════════ 5. geen geschikte kandidaten ═══════════ */

describe("RONDE 111 — when no new candidate exists, the scene's own footage moves", () => {

  it("it is recorded as a rescue, never as a verified fit for the beat", () => {
    // rescue_extend maps to held_frame coverage in the quality report — it counts as a stand-in.
    //
    // RONDE 91: this used to grep beatVisualStatus.ts for the literal table entry
    // `["rescue_extend", "held_frame"]`. That table is gone — the twelve-entry map fell through to
    // `own_footage` for everything else, and the coverage is now derived from the declared adoption
    // policy instead. The CLAIM is unchanged and is asserted directly against the function, which
    // is stronger than reading the source for a string: a future edit that keeps the literal but
    // breaks the behaviour would have passed the old form and fails this one.
    expect(coverageOfAdoptEntry({ source: "rescue_extend", basename: "extend_s1b2.mp4" }))
      .toBe("held_frame");
    // And a held frame can never be the beat's verified own visual, whatever the gate said.
    expect(adoptionPolicyFor("rescue_extend").countsAsVerifiedVisual).toBe(false);
  });
});

/* ═══════════ 7. foto's met Ken Burns ═══════════ */

describe("RONDE 111 — a photo keeps moving all the way to its last frame", () => {
  it("the easing no longer ends at zero velocity", () => {
    /**
     * Pure sin(PI/2*t) has derivative cos(PI/2) = 0 at t=1. Measured on a six-second still, the
     * crop window moved 71.8 px in the first second and 7.5 px in the last — 0.30 px/frame, which
     * the eye reads as a stopped picture. Every photo ended on a small freeze.
     */
    const share = 0.35;
    const velocity = (t: number) => share * (Math.PI / 2) * Math.cos((Math.PI / 2) * t) + (1 - share);
    expect(velocity(1)).toBeCloseTo(1 - share, 5);
    expect(velocity(1)).toBeGreaterThan(0.6);
    // The old curve, for contrast.
    const old = (t: number) => (Math.PI / 2) * Math.cos((Math.PI / 2) * t);
    expect(old(1)).toBeCloseTo(0, 6);
  });

  it("it is still an ease, not the linear motion that read as machine-made", () => {
    const share = 0.35;
    const velocity = (t: number) => share * (Math.PI / 2) * Math.cos((Math.PI / 2) * t) + (1 - share);
    expect(velocity(0)).toBeGreaterThan(velocity(1));
    expect(velocity(0)).toBeCloseTo(1.1996, 3);
  });

  it("the source carries the blend, not a bare sine", () => {
    expect(DOCSTYLE).toContain("const KEN_BURNS_EASE_SHARE = 0.35;");
    expect(DOCSTYLE).toContain("`(${eased}*sin(PI/2*${t})+${linear}*${t})`");
    // The unblended version is gone from the code.
    const code = DOCSTYLE.split("\n")
      .filter((l) => {
        const t = l.trim();
        return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toContain("return `sin(PI/2*min(on/${totalFrames},1))`;");
  });

  it("the total travel is unchanged — this moved the velocity curve, not the framing", () => {
    // progress(1) must still be exactly 1, or the photo would stop short of its target zoom.
    const share = 0.35;
    const progress = (t: number) => share * Math.sin((Math.PI / 2) * t) + (1 - share) * t;
    expect(progress(1)).toBeCloseTo(1, 10);
    expect(progress(0)).toBeCloseTo(0, 10);
  });

  it("stills are never rendered without motion in the first place", () => {
    // Both the styled path and its fallback go through a zoompan.
    expect(DOCSTYLE).toContain("export function buildSimpleKenBurnsVF(");
    expect(DOCSTYLE).toContain("export function buildKenBurnsTail(");
    expect(PIPELINE).toContain("buildSimpleKenBurnsVF(duration, personPortrait)");
  });
});

/* ═══════════ logging ═══════════ */

describe("RONDE 111 — the decision is visible afterwards, per video", () => {

  it("it reaches the stored pipeline report the admin reads", () => {
    expect(PIPELINE).toContain('pipelineReport.addAll("warnings", visualDedup.coverageDecisions);');
  });

  it("a clip refused for length says the floor AND the slot it was judged against", () => {
    expect(CURATED).toContain(
      "`source video too short (${sourceDur.toFixed(2)}s < ${minSource.toFixed(2)}s for a ${duration.toFixed(2)}s slot)`"
    );
  });
});

/* ═══════════ the relevance architecture is untouched ═══════════ */

describe("RONDE 111 — nothing about relevance changed", () => {
  it("no new judge, no new query builder, no second gate", () => {
    const plan = fs.readFileSync(path.join(__dirname, "coverageFillPlan.ts"), "utf8");
    // The rules module is pure arithmetic: it must not reach for anything.
    expect(plan).not.toContain("import ");
    for (const forbidden of ["judgeBeatImage", "evaluateClipVisionGate", "buildSearchQuery", "openai"]) {
      expect(plan, forbidden).not.toContain(forbidden);
    }
  });

  it("the single content decider is still the only content decider", () => {
    expect(PIPELINE).toContain("beatClipRefusedByRelevanceGate(");
  });
});
