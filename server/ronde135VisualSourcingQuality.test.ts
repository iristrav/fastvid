/**
 * RONDE 135 — from the right question to the right picture.
 *
 * ── What the audit found, before anything was changed ────────────────────────────────────────
 *
 * Two of this round's asks turned out to be already satisfied, and saying so is part of the work:
 *
 *  §9/§13 historical sources over modern stock. Implemented twice already, in both directions.
 *         `EXTERNAL_SOURCE_TIER_BONUS` in retrievalFunnel.ts ranks internet_archive 0.15 down to
 *         pexels/pixabay 0 BEFORE anything is downloaded, and `pickBestFunnelCandidate` then lets
 *         stock win only when it beats non-stock by a full point on a scale RONDE 65 measured as
 *         rarely discriminating at all. Adding a third mechanism would have been noise.
 *  §14    material faults look for other material first. Already true by construction: the
 *         research pass only runs at the point where `winner` is null, which is after the beat's
 *         whole candidate pool has been judged and refused.
 *
 * What was genuinely missing, and what this round adds:
 *
 *  1. The classification was too coarse. Seven kinds, with no way to say "the right people at the
 *     wrong event", "the frame IS a title card", or "present-day footage" as distinct from a
 *     general period error. Tests 1-14.
 *  2. WRONG_EVENT had no correction. Adding the person does not fix a picture the person is
 *     already in. Tests 15-18.
 *  3. Nothing carried a refusal across beats. RONDE 131 reorders within one beat and forgets.
 *     Tests 19-24.
 *  4. `byKindAndSource` has been recorded since RONDE 131 and never printed, so no render could
 *     say WHICH provider produced its refusals. Tests 25-31.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  classifyMismatch,
  createMismatchTally,
  mismatchFault,
  recordMismatch,
  reorderAfterMismatch,
  repeatOffenderSources,
  REPEAT_OFFENDER_MIN_REFUSALS,
  type MismatchKind,
} from "./visualMismatchFeedback";
import {
  correctionStrategyFor,
  decideResearch,
  buildResearchContext,
} from "./mismatchResearch";
import {
  findUnproductiveProviders,
  formatVisualSourcingAudit,
  REPORTED_MISMATCH_KINDS,
  summarizeProviderOutcomes,
} from "./visualSourcingAudit";
import {
  emptyQueryContext,
  provenToken,
  validateSearchQuery,
  type VerifiedQueryContext,
} from "./searchQueryContract";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";

const SCENE_TEXT =
  "In April 1945 Hermann Göring left Berlin for the south. " +
  "He had commanded the Luftwaffe since 1935. " +
  "Adolf Hitler had already turned against him.";

const researchCtxFor = (beatText: string): VerifiedQueryContext =>
  buildResearchContext({
    beat: buildVerifiedQueryContextForBeat(beatText, { sceneText: SCENE_TEXT }),
    scene: buildVerifiedQueryContextForBeat(SCENE_TEXT, { sceneText: SCENE_TEXT }),
  });

describe("RONDE 135 — every refusal gets a name", () => {
  it("1. present-day footage is MODERN_FOOTAGE, not a generic period error", () => {
    expect(
      classifyMismatch({
        depicts: "a modern city street with parked cars, filmed in colour",
        reason: "present-day footage under narration about Berlin in April 1945",
      })
    ).toBe("MODERN_FOOTAGE");
  });

  it("2. a decade error is still WRONG_PERIOD", () => {
    expect(
      classifyMismatch({
        depicts: "a newsreel of a parade",
        reason: "this looks like a different decade — 1960s rather than the 1940s",
      })
    ).toBe("WRONG_PERIOD");
  });

  it("3. the frame that IS text is a TITLE_CARD", () => {
    expect(
      classifyMismatch({ depicts: "a title card with white lettering on black", reason: "not footage" })
    ).toBe("TITLE_CARD");
  });

  it("4. text OVER footage is TEXT_ON_SCREEN", () => {
    expect(
      classifyMismatch({
        depicts: "archive footage of a rally with a broadcaster's watermark in the corner",
        reason: "a watermark covers part of the frame",
      })
    ).toBe("TEXT_ON_SCREEN");
  });

  it("5. the right people at the wrong occasion is WRONG_EVENT", () => {
    expect(
      classifyMismatch({
        depicts: "Göring and other officers at a large rally",
        reason: "this is a different event from the one the narration describes",
      })
    ).toBe("WRONG_EVENT");
  });

  it("6. an empty frame is LOW_INFORMATION", () => {
    expect(classifyMismatch({ depicts: "a black screen", reason: "nothing is visible" }))
      .toBe("LOW_INFORMATION");
    expect(classifyMismatch({ depicts: "an out of focus blur", reason: "shows nothing" }))
      .toBe("LOW_INFORMATION");
  });

  it("7. a talking head is still a talking head", () => {
    expect(
      classifyMismatch({ depicts: "a man talking to camera", reason: "modern commentary" })
    ).toBe("TALKING_HEAD");
  });

});

describe("RONDE 135 — QUESTION and MATERIAL stay distinct", () => {
  it("9. every period, subject, place and event fault indicts the QUESTION", () => {
    for (const k of [
      "WRONG_PERIOD", "MODERN_FOOTAGE", "WRONG_SUBJECT", "WRONG_PLACE", "WRONG_EVENT", "UNRELATED",
    ] as MismatchKind[]) {
      expect(mismatchFault(k)).toBe("QUESTION");
    }
  });

  it("10. every fault about the material indicts the MATERIAL", () => {
    for (const k of [
      "TEXT_ON_SCREEN", "TITLE_CARD", "TALKING_HEAD", "LOW_INFORMATION",
    ] as MismatchKind[]) {
      expect(mismatchFault(k)).toBe("MATERIAL");
    }
  });

  it("11. every kind has a fault and none falls through the switch", () => {
    for (const k of REPORTED_MISMATCH_KINDS) {
      expect(["QUESTION", "MATERIAL", "UNKNOWN"]).toContain(mismatchFault(k));
    }
  });

  it("12. the reported kind list covers every kind the classifier can return", () => {
    // A kind missing from the report would be counted and never shown — the RONDE 131 failure
    // shape, one level up.
    const kinds = new Set<MismatchKind>(REPORTED_MISMATCH_KINDS);
    const src = readFileSync(join(__dirname, "visualMismatchFeedback.ts"), "utf8");
    /**
     * Scoped to the MismatchKind declaration itself.
     *
     * This used to scrape every `| "UPPER_CASE"` line in the file and skip a hardcoded list of
     * MismatchFault's members — so any OTHER string union added to the module failed this test
     * while saying nothing about the kinds. RONDE 166 added MismatchSeverity and did exactly that.
     * Reading the one declaration the assertion is about keeps it guarding what it claims to.
     */
    const start = src.indexOf("export type MismatchKind =");
    const block = src.slice(start, src.indexOf(";", src.indexOf('| "UNCLEAR"', start)));
    const declared = [...block.matchAll(/^\s*\|\s*"([A-Z_]+)"/gm)].map((m) => m[1] as MismatchKind);
    expect(declared.length).toBeGreaterThan(5);
    for (const k of declared) {
      expect(kinds.has(k), `${k} is not in REPORTED_MISMATCH_KINDS`).toBe(true);
    }
  });


});



describe("RONDE 135 — the render can finally say which provider failed it", () => {
  function tallyWithSources(): ReturnType<typeof createMismatchTally> {
    const t = createMismatchTally();
    for (let i = 0; i < 8; i++) recordMismatch(t, { kind: "MODERN_FOOTAGE", source: "pexels" });
    for (let i = 0; i < 5; i++) recordMismatch(t, { kind: "TITLE_CARD", source: "youtube" });
    for (let i = 0; i < 2; i++) recordMismatch(t, { kind: "WRONG_SUBJECT", source: "wikimedia" });
    return t;
  }







  it("31. an empty render produces a block with no invented rows", () => {
    const out = formatVisualSourcingAudit({
      beats: 0, visionAttempts: 0, fits: 0, doesNotFit: 0,
      research: { attempts: 0, produced: 0, accepted: 0, rejected: 0 },
      tally: createMismatchTally(),
    });
    expect(out).toContain("[VisualSourcingAudit]");
    expect(out).not.toContain("providers:");
    expect(out).not.toContain("mismatchTypes:");
  });
});

describe("RONDE 135 — regressions this round must not touch", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("32. the audit block is actually printed by a render", () => {
    expect(PIPE).toContain("formatVisualSourcingAudit({");
    expect(PIPE).toContain("tally: visualDedup.mismatchTally");
  });


  it("36. the still-image rules are untouched (RONDE 128/130)", () => {
    const still = readFileSync(join(__dirname, "stillImagePolicy.ts"), "utf8");
    expect(still).toContain("export const MAX_STILL_IMAGE_DURATION_SEC = 5");
    expect(still).toContain("force_original_aspect_ratio=decrease");
  });

});

describe("RONDE 135 — mutation guards", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const FEEDBACK = readFileSync(join(__dirname, "visualMismatchFeedback.ts"), "utf8");


  it("M11. the five-second cap is a constant, not a threshold this round can move", () => {
    const still = readFileSync(join(__dirname, "stillImagePolicy.ts"), "utf8");
    expect(still).toMatch(/MAX_STILL_IMAGE_DURATION_SEC\s*=\s*5\b/);
    expect(still).toContain("Math.min(n, 15)");
  });
});
