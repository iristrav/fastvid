/**
 * R196 — THE THREE R195 LEFT OPEN, AND WHY TWO OF THEM WERE NEVER NEW RULES.
 *
 * R195 reported these as needing a new scoring or reporting rule and left them. Reading further
 * changed the answer for the motion chain, and the correction is worth more than the change:
 *
 * ── The motion chain had FOUR parts and no joins ─────────────────────────────────────────────
 *
 *   · `RetrievalContract.motionRange` — computed by `motionRangeForAct`, printed in the plan log,
 *     read by no scorer. `scoreRetrievalContract` weighs mustContain, shouldContain, targetEmotion
 *     and forbiddenContent and steps straight past the band.
 *   · `RhythmProfile.motionTargets` — the second producer, written into `beatRhythmTargets` during
 *     COMPOSE with the comment "so AssetDirector can use them during retrieval". Retrieval for that
 *     scene had finished, so the reader always saw an empty map.
 *   · `AssetDirectorContext.targetMotionLevel` — set from that empty map, read by nothing.
 *   · `inferMotionLevel` — declared in assetDirector.ts and never called once.
 *
 * A target with no reader, a second target that arrives too late, a context field nobody consults,
 * and a candidate measurement nobody asks for. Every piece of a motion-matching feature existed.
 * Joining them is a carry, not an invention: both sides are already 0–100 on the same scale, which
 * is why `motionRange` is a pair of them and `motionLevel` is one of them.
 *
 * ── The two expectation lists had producers too ─────────────────────────────────────────────
 *
 * `expectedCinematicTags` wanted the canonical phrasing of a framing; `shotSearchTerms` is exactly
 * that vocabulary and is already asserted gate-safe elsewhere. `expectedAudioTypes` wanted the
 * sound categories that belong under a beat; `planSceneAudio` is the ambience planner's own
 * classifier and returns precisely that. Neither needed a mapping invented here.
 *
 * ── The feature matrix genuinely needed a decision ──────────────────────────────────────────
 *
 * That one was correctly described: fifteen features times five states. It is built now, in one
 * place, from facts this render recorded — and `verified` stays false everywhere except
 * `deliveredQC`, because nothing reads the finished MP4 back to confirm a caption is on it.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  buildRenderFeatureMatrix,
  featureMatrixViolations,
  formatFeatureMatrix,
  musicFeatureStatus,
  type RenderFeatureFacts,
} from "./renderContract";
import { buildRhythmProfile } from "./visualRhythmEngine";
import { shotSearchTerms } from "./shotVocabulary";
import { planSceneAudio } from "./cinematicAudio/planner";

const PIPE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const DIRECTOR = readFileSync(path.join(__dirname, "assetDirector.ts"), "utf8");

/* ═══════════════ 1. the planned movement band reaches the ranking ═══════════════ */

describe("movement is planned, measured and scored", () => {
  /** The candidate measurement that was declared and never called. */
  it("the candidate's own motion level is finally read", () => {
    const at = DIRECTOR.indexOf("function computeMotionModifier(");
    expect(at, "the motion modifier is gone").toBeGreaterThan(-1);
    expect(DIRECTOR.slice(at, at + 900)).toContain("inferMotionLevel(clipPath, meta)");
    expect(
      (DIRECTOR.match(/inferMotionLevel\(/g) ?? []).length,
      "inferMotionLevel is declared and called exactly once"
    ).toBe(2);
  });

  /** And the modifier is part of the score, not a number computed beside it. */
  it("the modifier is in the sum and in the breakdown", () => {
    expect(DIRECTOR).toContain("+ motion.modifier +");
    expect(DIRECTOR).toContain("motionModifier:   motion.modifier,");
    expect(DIRECTOR).toContain("motionLevel:      motion.measured,");
  });

  /** The band, from whichever planner produced one, in stated precedence. */
  it("the context is given a band, not a midpoint", () => {
    expect(DIRECTOR).toContain("targetMotionRange?: readonly [number, number] | null;");
    expect(PIPE).toContain("targetMotionRange: _contract?.motionRange ?? _rhythmBand ?? null,");
    expect(
      DIRECTOR.includes("targetMotionLevel"),
      "the lossy midpoint field is gone rather than kept beside the band"
    ).toBe(false);
  });

  /**
   * The ordering defect. The rhythm engine's own writer runs after the retrieval that reads it, so
   * the band is derived on first use from the pure profile builder instead of waited for.
   */
  it("the band is derived at read time rather than waiting for the compose-stage write", () => {
    const at = PIPE.indexOf("const _rhythmBand = ((): readonly [number, number] | null => {");
    expect(at, "the lazy band is gone").toBeGreaterThan(-1);
    const block = PIPE.slice(at, at + 900);
    expect(block).toContain("buildRhythmProfile(beats.map((b) => b.text))");
    expect(block).toContain("dedup.beatRhythmTargets.set(");
  });

  it("and the compose-stage writer stores the band it was given, not half of it", () => {
    expect(PIPE).toContain("visualDedup.beatRhythmTargets.set(`s${scene.index}b${bi}`, band);");
    expect(
      PIPE.includes("const mid = Math.round((min + max) / 2);"),
      "the midpoint that threw the width away is gone"
    ).toBe(false);
  });

  /** `buildRhythmProfile` is documented as pure, which is what makes deriving it here safe. */
  it("the profile builder really is pure and gives a band per beat", () => {
    const profile = buildRhythmProfile([
      "The bombardment began at dawn.",
      "The city lay silent afterwards.",
    ]);
    expect(profile.motionTargets).toHaveLength(2);
    for (const [lo, hi] of profile.motionTargets) {
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(100);
      expect(hi).toBeGreaterThanOrEqual(lo);
    }
    /** A beat about an attack asks for more movement than a beat about silence. */
    expect(profile.motionTargets[0]![1]).toBeGreaterThan(profile.motionTargets[1]![0]);
  });

  /** Both beats' bands are memoised, so a scene is profiled once and not once per beat. */
  it("deriving one beat's band fills the whole scene's", () => {
    const at = PIPE.indexOf("const _rhythmBand = ((): readonly [number, number] | null => {");
    expect(PIPE.slice(at, at + 900)).toContain("profile.motionTargets.forEach((band, bi)");
  });

  /** Silence when either side is unknown — a modifier is never a guess. */
  it("no band or no measurement means no modifier", () => {
    const at = DIRECTOR.indexOf("function computeMotionModifier(");
    const body = DIRECTOR.slice(at, at + 1400);
    expect(body).toContain("if (!band || measured == null) return { modifier: 0, measured, detail: \"\" };");
  });

  /** Bounded, and smaller than the diversity modifier beside it: a slip, not a veto. */
  it("the modifier stays inside the family it sits in", () => {
    const at = DIRECTOR.indexOf("function computeMotionModifier(");
    const body = DIRECTOR.slice(at, at + 1400);
    expect(body).toContain("return { modifier: 4, measured");
    expect(body).toContain("-Math.min(6, Math.ceil(miss / 20) * 2)");
  });

  /** Two counters, because "nobody planned" and "nothing measurable" need opposite fixes. */
  it("the render records whether the plan reached a candidate", () => {
    expect(PIPE).toContain("dedup.motionBandBeats.add(`s${sceneIndex}b${beatIndex}`)");
    expect(PIPE).toContain("dedup.motionScoredBeats.add(`s${sceneIndex}b${beatIndex}`)");
  });
});

/* ═══════════════ 2. the two expectation lists have producers ═══════════════ */

describe("the ranking is told what the beat should look and sound like", () => {
  /** The framing, in the annotation's own vocabulary rather than a mapping invented here. */
  it("the planned shot supplies the expected cinematic tags", () => {
    expect(PIPE).toContain("expectedCinematicTags: [...shotSearchTerms(_plannedShot)],");
    expect(shotSearchTerms("establishing")).toContain("establishing shot");
    expect(shotSearchTerms("aerial")).toContain("aerial");
  });

  /** A framing with no phrasing gives an empty list, which the scorer reads as nothing to say. */
  it("a framing nobody can phrase produces no expectation", () => {
    expect(shotSearchTerms(null)).toEqual([]);
    expect(shotSearchTerms("something the planner made up")).toEqual([]);
  });

  /** The sound, from the classifier the ambience planner already uses on the same text. */
  it("the scene's own sound plan supplies the expected audio types", () => {
    expect(PIPE).toContain(
      "expectedAudioTypes: beatExpectedAudioTypes(dedup, sceneIndex, beatIndex, opts.sceneText),"
    );
    const at = PIPE.indexOf("function beatExpectedAudioTypes(");
    expect(at, "the producer is gone").toBeGreaterThan(-1);
    expect(PIPE.slice(at, at + 1400)).toContain("planSceneAudio({");
  });

  /** It classifies nothing itself — the existing planner answers, on real narration. */
  it("the planner it asks really names sound categories from narration", () => {
    const plan = planSceneAudio({
      index: 0,
      text: "A vast crowd filled the square as the rain came down.",
      duration: 12,
      beats: [{ text: "A vast crowd filled the square.", holdSec: 6, voiceStartSec: 0 }],
    });
    expect(plan.ambience.length).toBeGreaterThan(0);
    expect(plan.ambience.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
  });

  /** Asked once per scene, not once per candidate. */
  it("the answer is memoised on the render's own state", () => {
    expect(PIPE).toContain("sceneSoundPlans: Map<number,");
    expect(PIPE).toContain("dedup.sceneSoundPlans.set(sceneIndex, plan);");
    const at = PIPE.indexOf("function beatExpectedAudioTypes(");
    expect(PIPE.slice(at, at + 400)).toContain("dedup.sceneSoundPlans.get(sceneIndex)");
  });

  /** An object sound belongs to the beat it was scheduled on, matched by its voice window. */
  it("a beat gets the scene's room tone plus its own object sounds", () => {
    const at = PIPE.indexOf("function beatExpectedAudioTypes(");
    const body = PIPE.slice(at, at + 2200);
    expect(body).toContain("Math.abs(o.startSec - start) < 0.001");
    expect(body).toContain("new Set([...plan.ambience, ...onThisBeat])");
  });

  it("nothing to read means an empty list, not a wrong expectation", () => {
    const at = PIPE.indexOf("function beatExpectedAudioTypes(");
    expect(PIPE.slice(at, at + 1200)).toContain("if (!text && beats.length === 0) return [];");
  });
});

/* ═══════════════ 3. the feature matrix a render can actually break ═══════════════ */

function facts(over: Partial<RenderFeatureFacts> = {}): RenderFeatureFacts {
  return {
    beatsWithIntent: 12,
    beatsTotal: 12,
    retrieved: 400,
    eligible: 40,
    shortlisted: 24,
    visionEnabled: true,
    visionReviewPool: 24,
    visionAsked: 20,
    visionApproved: 8,
    motionBandsPlanned: 12,
    motionScored: 11,
    cinematicEnabled: true,
    cinematicPlanned: true,
    cinematicRendered: true,
    captionsEnabled: true,
    captionsPlanned: 12,
    graphicsEnabled: true,
    graphicsPlanned: 4,
    /** RONDE 203: measured where they are emitted, not one per scene join. */
    transitionsApplied: 3,
    musicCatalogueAvailable: false,
    ambiencePlanned: 3,
    ambienceUnavailable: 0,
    sfxPlanned: 2,
    duckingApplied: true,
    ...over,
    delivery: {
      fileExists: true,
      hasVideoStream: true,
      hasAudioStream: true,
      fromCinematicRender: true,
      assetsInFinalVideo: 14,
      captionsOnTimeline: 12,
      graphicsOnTimeline: 4,
      ambientClipsOnTimeline: 3,
      sfxClipsOnTimeline: 2,
      musicClipsOnTimeline: 0,
      graphicsBurnedInByCompose: 0,
      avSyncMeasured: true,
      spotChecked: true,
      ...(over.delivery ?? {}),
    },
  };
}

describe("the matrix says what was promised and what arrived", () => {
  it("a healthy render breaks no rule", () => {
    expect(featureMatrixViolations(buildRenderFeatureMatrix(facts()))).toEqual([]);
  });

  /** The monotonicity the module was written for, now reachable from a real render. */
  it("a plan that never rendered is named, and says which half is missing", () => {
    const m = buildRenderFeatureMatrix(
      facts({ cinematicPlanned: true, cinematicRendered: false, delivery: { fromCinematicRender: false } as RenderFeatureFacts["delivery"] })
    );
    expect(m.cinematic?.reason).toContain("no render ran from it");
    expect(featureMatrixViolations(m)).toEqual([]);
  });

  it("a render that ran and did not deliver is a different sentence", () => {
    const m = buildRenderFeatureMatrix(facts({ delivery: { fromCinematicRender: false } as RenderFeatureFacts["delivery"] }));
    expect(m.cinematic?.reason).toContain("its output was not the delivered file");
  });

  it("graphics that were made and never used are counted, not implied", () => {
    const m = buildRenderFeatureMatrix(facts({ graphicsPlanned: 6, delivery: { graphicsOnTimeline: 2 } as RenderFeatureFacts["delivery"] }));
    expect(m.graphics?.reason).toContain("6 graphics were planned and 2 reached a render");
    expect(m.graphics?.delivered).toBe(true);
  });

  /** §Y — music is an external blocker and says so in its own words. */
  it("music states the external blocker rather than reporting a defect", () => {
    const m = buildRenderFeatureMatrix(facts());
    expect(m.music).toEqual(musicFeatureStatus(false));
    expect(m.music?.reason).toContain("musicSourceUnavailable");
    expect(m.music?.enabled).toBe(true);
    expect(m.music?.planned).toBe(false);
    expect(featureMatrixViolations(m)).toEqual([]);
  });

  /** Only the feature that inspects the delivered file may claim to have verified anything. */
  it("verified is claimed exactly once, and only on both measurements", () => {
    const m = buildRenderFeatureMatrix(facts());
    const verified = Object.entries(m).filter(([, s]) => s.verified).map(([n]) => n);
    expect(verified).toEqual(["deliveredQC"]);
    const half = buildRenderFeatureMatrix(facts({ delivery: { spotChecked: false } as RenderFeatureFacts["delivery"] }));
    expect(half.deliveredQC?.verified).toBe(false);
    expect(half.deliveredQC?.reason).toContain("spotCheck=not run");
  });

  it("a vision gate that approved nothing does not read as delivered", () => {
    const m = buildRenderFeatureMatrix(facts({ visionApproved: 0 }));
    expect(m.vision?.delivered).toBe(false);
    expect(m.vision?.reason).toContain("approved=0");
    expect(featureMatrixViolations(m)).toEqual([]);
  });

  /** The gap the movement chain used to be: bands planned, nothing measurable against them. */
  it("bands with no measurable candidate is its own finding", () => {
    const m = buildRenderFeatureMatrix(facts({ motionScored: 0 }));
    expect(m.movement?.reason).toContain("no candidate could be measured");
    const none = buildRenderFeatureMatrix(facts({ motionBandsPlanned: 0, motionScored: 0 }));
    expect(none.movement?.reason).toContain("no planner produced a movement band");
  });

  it("a render that delivered nothing claims nothing delivered", () => {
    const m = buildRenderFeatureMatrix(facts({ delivery: { fileExists: false } as RenderFeatureFacts["delivery"] }));
    for (const [name, s] of Object.entries(m)) {
      expect(s.delivered, `${name} claims delivery with no file`).toBe(false);
    }
  });

  /** The formatter prints the rows and appends whatever the check found. */
  it("the printed table carries every feature and its violations", () => {
    const lines = formatFeatureMatrix(buildRenderFeatureMatrix(facts()));
    expect(lines[0]).toContain("feature enabled planned executed delivered verified");
    expect(lines.join("\n")).toContain("[FeatureMatrix] music");
    expect(lines.join("\n")).toContain("[FeatureMatrix] deliveredQC");
  });

  /** THE WIRING — it is built from a real render, at the point every state is settled. */
  it("the pipeline builds one, after the cutover and before the final merge", () => {
    const build = PIPE.indexOf("const matrix = buildRenderFeatureMatrix({");
    const cutover = PIPE.indexOf('measuredOn: "delivered_render"');
    const merge = PIPE.lastIndexOf("      pipelineReport: pipelineReport.build(),");
    expect(build, "no render builds a feature matrix").toBeGreaterThan(-1);
    expect(build, "built before the delivery is decided").toBeGreaterThan(cutover);
    expect(build, "built after the report it belongs in was stored").toBeLessThan(merge);
  });

  it("its facts come from what the render recorded, not from the flags", () => {
    const at = PIPE.indexOf("const matrix = buildRenderFeatureMatrix({");
    const block = PIPE.slice(at, at + 3200);
    expect(block).toContain("avSyncMeasured: qualityReport.avSync != null,");
    expect(block).toContain("fromCinematicRender: cinematicDeliveredUrl != null,");
    expect(block).toContain("motionScored: visualDedup.motionScoredBeats.size,");
  });

  /** A report that cannot be built may never cost a render that is otherwise complete. */
  it("building it is wrapped", () => {
    const at = PIPE.indexOf("const matrix = buildRenderFeatureMatrix({");
    expect(PIPE.slice(at - 600, at)).toContain("try {");
    expect(PIPE.slice(at, at + 3800)).toContain("[FeatureMatrix] video=${videoId} not built");
  });
});
