/**
 * R197 — DO THE NEW SIGNALS ACTUALLY MOVE A CANDIDATE?
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────────
 *
 * R196 joined four dead parts of a motion-matching feature and gave the two expectation lists
 * their producers, and it proved that with STRUCTURAL tests: the modifier is in the sum, the field
 * is on the context, the producer is called. Every one of those can be true while the ranking
 * comes out in exactly the same order it did before — which is the failure mode the whole project
 * keeps finding, one level up.
 *
 * So these run the real ranker. `rankCandidatesWithContext` is the entry point `adoptClip` calls,
 * with the context `adoptClip` builds, and the assertion is on the ORDER it returns.
 *
 * ── How a single signal is isolated ─────────────────────────────────────────────────────────
 *
 * Two candidates that are identical in every input the ranker reads except the one under test.
 * Same annotation object, same provider family in the filename (so the shot-type regexes, the
 * visual-type budget and the diversity modifier see the same thing), same beat, same context.
 * `rankCandidatesWithContext` sorts on `finalScore`, so if the order changes when one field
 * changes, that field reached the score — and if it does not, it did not.
 *
 * The control in each case is the same pair with the signal absent. A test that only asserts "A
 * beats B" can pass because A is better for an unrelated reason; asserting that the same pair
 * comes back in the OTHER order without the signal is what makes it about the signal.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  buildRenderFeatureMatrix,
  featureMatrixViolations,
  type RenderFeatureFacts,
} from "./renderContract";

import {
  rankCandidatesWithContext,
  type AssetDirectorContext,
  type CandidateMeta,
} from "./assetDirector";
import type { ClipAnnotation } from "../drizzle/annotationTypes";

/* ═══════════════════════ a candidate pair that differs in one field ═══════════════════════ */

/**
 * A structurally complete annotation with neutral content.
 *
 * Neutral on purpose: nothing here should match or contradict the beat, so the 40% fingerprint,
 * the editorial score and the archive bonuses land identically on both candidates and the only
 * thing left to separate them is the field under test.
 */
function annotation(over: Partial<ClipAnnotation> = {}): ClipAnnotation {
  return {
    version: "5",
    persons: { named: [], categories: [] },
    objects: [],
    actions: [],
    environment: { setting: "", isInterior: false, lighting: "" },
    historicalContext: { event: "", period: "", year: "", decade: "", century: "" },
    location: { continent: "", country: "", region: "", city: "", confidence: "" },
    cinematography: {
      shotType: "medium",
      cameraMovement: "static",
      composition: "",
      visualStyle: "archival",
    },
    emotion: "neutral",
    motionLevel: 50,
    quality: { overall: 60, sharpness: 60, exposure: 60, stability: 60, compression: 60 },
    editorialScore: {
      total: 60,
      historicalUsability: 60,
      cinematicQuality: 60,
      storytellingPotential: 60,
      emotionalValue: 60,
      movementQuality: 60,
      originality: 60,
    },
    usageHints: { bestUsedAs: "", topicAffinity: [], avoid: [] },
    ...over,
  } as unknown as ClipAnnotation;
}

/**
 * Two paths from the same provider family, so every filename-derived signal reads the same for
 * both. Only the leading letter differs, and nothing in the ranker looks at that.
 */
const A = "/w/scene_0_b0_pexels_alpha.mp4";
const B = "/w/scene_0_b0_pexels_bravo.mp4";

function context(over: Partial<AssetDirectorContext> = {}): AssetDirectorContext {
  return {
    usedPaths: new Set<string>(),
    usedCategories: new Map<string, number>(),
    sceneAdoptedClips: [],
    prevSceneClips: [],
    callbacksPlaced: new Map<string, number>(),
    ...over,
  };
}

const BEAT = "The column moved through the ruined street.";

/** The ranked order, as `adoptClip` would receive it. */
function order(meta: Map<string, CandidateMeta>, ctx: AssetDirectorContext): string[] {
  return rankCandidatesWithContext([A, B], BEAT, 0, 0, ctx, meta).rankedPaths;
}

/* ═══════════════════════ FASE 4 — motion really decides ═══════════════════════ */

describe("the planned movement band changes which candidate wins", () => {
  const movingA = new Map<string, CandidateMeta>([
    [A, { annotation: annotation({ motionLevel: 85 }) }],
    [B, { annotation: annotation({ motionLevel: 10 }) }],
  ]);

  /** Scenario 1 from the round: a band of 70–100 must prefer the moving clip. */
  it("a beat that wants movement prefers the moving clip", () => {
    expect(order(movingA, context({ targetMotionRange: [70, 100] }))[0]).toBe(A);
  });

  /** Scenario 2: the SAME pair, the opposite band, the opposite winner. */
  it("a beat that wants stillness prefers the still one — same pair, same everything else", () => {
    expect(order(movingA, context({ targetMotionRange: [0, 25] }))[0]).toBe(B);
  });

  /**
   * THE CONTROL. Without a band the pair is a tie on every input, and the ranker's stable sort
   * leaves them in the order they arrived. So the two results above are the band's doing and not
   * an accident of the fixture.
   */
  it("with no band the same pair does not reorder at all", () => {
    const ranked = rankCandidatesWithContext([A, B], BEAT, 0, 0, context(), movingA);
    expect(ranked.rankedPaths[0]).toBe(A);
    expect(ranked.reordered).toBe(false);
  });

  /**
   * FASE 4 case 3 — a candidate nothing can measure is neither rewarded nor punished.
   *
   * Asserted on the SCORE rather than the order, and deliberately so. A candidate with no
   * annotation is worse than an annotated one on the fingerprint, the editorial score and every
   * archive bonus, so an order comparison between them would prove nothing about motion. The
   * breakdown says exactly what the modifier was, which is the claim.
   */
  it("an unmeasurable candidate gets no modifier, even under a band", () => {
    /** `inferMotionLevel` also reads filename cues, so neither name may carry one. */
    const unmeasurable = new Map<string, CandidateMeta>();
    const ranked = rankCandidatesWithContext(
      [A, B], BEAT, 0, 0, context({ targetMotionRange: [0, 25] }), unmeasurable
    );
    expect(ranked.topScore?.breakdown.motionLevel).toBeNull();
    expect(ranked.topScore?.breakdown.motionModifier).toBe(0);
    expect(ranked.reordered).toBe(false);
  });

  /** And a beat with no band leaves a perfectly measurable candidate alone too. */
  it("a measured candidate with no band gets no modifier", () => {
    const measured = new Map<string, CandidateMeta>([
      [A, { annotation: annotation({ motionLevel: 85 }) }],
      [B, { annotation: annotation({ motionLevel: 85 }) }],
    ]);
    const ranked = rankCandidatesWithContext([A, B], BEAT, 0, 0, context(), measured);
    expect(ranked.topScore?.breakdown.motionLevel).toBe(85);
    expect(ranked.topScore?.breakdown.motionModifier).toBe(0);
  });

  /** The R196 rule itself, read off the score rather than inferred from an order. */
  it("in band is +4 and a wild miss is the floor of -6", () => {
    const inBand = new Map<string, CandidateMeta>([
      [A, { annotation: annotation({ motionLevel: 80 }) }],
      [B, { annotation: annotation({ motionLevel: 80 }) }],
    ]);
    expect(
      rankCandidatesWithContext(
        [A, B], BEAT, 0, 0, context({ targetMotionRange: [70, 100] }), inBand
      ).topScore?.breakdown.motionModifier
    ).toBe(4);
    const wayOut = new Map<string, CandidateMeta>([
      [A, { annotation: annotation({ motionLevel: 100 }) }],
      [B, { annotation: annotation({ motionLevel: 100 }) }],
    ]);
    expect(
      rankCandidatesWithContext(
        [A, B], BEAT, 0, 0, context({ targetMotionRange: [0, 5] }), wayOut
      ).topScore?.breakdown.motionModifier
    ).toBe(-6);
  });

  /** In-band is a reward, not merely the absence of a penalty. */
  it("a candidate inside the band gains on one that is only just outside", () => {
    const pair = new Map<string, CandidateMeta>([
      [A, { annotation: annotation({ motionLevel: 40 }) }],
      [B, { annotation: annotation({ motionLevel: 61 }) }],
    ]);
    expect(order(pair, context({ targetMotionRange: [30, 55] }))[0]).toBe(A);
    expect(order(pair, context({ targetMotionRange: [56, 80] }))[0]).toBe(B);
  });

  /** A wildly wrong clip loses more than a nearly right one — the miss is graded, not binary. */
  it("the penalty grows with the size of the miss", () => {
    const pair = new Map<string, CandidateMeta>([
      [A, { annotation: annotation({ motionLevel: 30 }) }],
      [B, { annotation: annotation({ motionLevel: 95 }) }],
    ]);
    expect(order(pair, context({ targetMotionRange: [0, 20] }))[0]).toBe(A);
  });
});

/* ═══════════════════════ FASE 5 — the framing expectation really decides ═══════════════════════ */

describe("the planned framing changes which candidate wins", () => {
  const aerialVsCloseUp = new Map<string, CandidateMeta>([
    [A, { annotation: annotation({ cinematicTags: ["aerial view", "landscape"] } as never) }],
    [B, { annotation: annotation({ cinematicTags: ["portrait", "interview"] } as never) }],
  ]);

  it("an aerial beat prefers the aerial clip", () => {
    expect(order(aerialVsCloseUp, context({ expectedCinematicTags: ["aerial"] }))[0]).toBe(A);
  });

  /** The same pair, the opposite expectation, the opposite winner. */
  it("an interview beat prefers the interview clip", () => {
    expect(order(aerialVsCloseUp, context({ expectedCinematicTags: ["interview"] }))[0]).toBe(B);
  });

  /**
   * FASE 5's second requirement: an empty list means NO EXPECTATION, never "this candidate is
   * wrong". Both orders above must collapse back to the untouched order.
   */
  it("an empty expectation list judges nobody", () => {
    const empty = rankCandidatesWithContext(
      [A, B], BEAT, 0, 0, context({ expectedCinematicTags: [] }), aerialVsCloseUp
    );
    const absent = rankCandidatesWithContext([A, B], BEAT, 0, 0, context(), aerialVsCloseUp);
    expect(empty.rankedPaths).toEqual(absent.rankedPaths);
    expect(empty.reordered).toBe(false);
  });

  /** A tag nobody has is not a penalty for either — it simply matches neither. */
  it("an expectation neither candidate meets leaves the order alone", () => {
    const ranked = rankCandidatesWithContext(
      [A, B], BEAT, 0, 0, context({ expectedCinematicTags: ["macro"] }), aerialVsCloseUp
    );
    expect(ranked.reordered).toBe(false);
  });
});

/* ═══════════════════════ FASE 6 — the audio expectation really decides ═══════════════════════ */

describe("the planned sound changes which candidate wins", () => {
  const crowdVsRain = new Map<string, CandidateMeta>([
    [
      A,
      {
        annotation: annotation({
          audioEvents: [{ type: "crowd", startSec: 0, endSec: 4, confidence: 0.9 }],
        } as never),
      },
    ],
    [
      B,
      {
        annotation: annotation({
          audioEvents: [{ type: "rain", startSec: 0, endSec: 4, confidence: 0.9 }],
        } as never),
      },
    ],
  ]);

  it("a beat planned for a crowd prefers the clip that has one", () => {
    expect(order(crowdVsRain, context({ expectedAudioTypes: ["crowd"] }))[0]).toBe(A);
  });

  it("the same pair, planned for rain, comes back the other way", () => {
    expect(order(crowdVsRain, context({ expectedAudioTypes: ["rain"] }))[0]).toBe(B);
  });

  it("an empty audio expectation judges nobody", () => {
    const empty = rankCandidatesWithContext(
      [A, B], BEAT, 0, 0, context({ expectedAudioTypes: [] }), crowdVsRain
    );
    expect(empty.reordered).toBe(false);
  });

  /** A candidate with no audio annotation at all is not punished for silence it never claimed. */
  it("a clip nobody classified is not punished for the sound it lacks", () => {
    const oneUnknown = new Map<string, CandidateMeta>([
      [A, { annotation: annotation() }],
      [B, { annotation: annotation({ audioEvents: [] } as never) }],
    ]);
    const ranked = rankCandidatesWithContext(
      [A, B], BEAT, 0, 0, context({ expectedAudioTypes: ["crowd"] }), oneUnknown
    );
    expect(ranked.reordered).toBe(false);
  });
});

/* ═══════════════════════ the three together ═══════════════════════ */

describe("the three signals compose rather than cancel", () => {
  /**
   * A candidate that is right on all three must beat one that is wrong on all three, and the
   * reverse context must reverse the result. This is the only case that shows the modifiers land
   * in one sum rather than overwriting one another.
   */
  const rightVsWrong = new Map<string, CandidateMeta>([
    [
      A,
      {
        annotation: annotation({
          motionLevel: 85,
          cinematicTags: ["aerial view"],
          audioEvents: [{ type: "crowd", startSec: 0, endSec: 4, confidence: 0.9 }],
        } as never),
      },
    ],
    [
      B,
      {
        annotation: annotation({
          motionLevel: 10,
          cinematicTags: ["portrait"],
          audioEvents: [{ type: "rain", startSec: 0, endSec: 4, confidence: 0.9 }],
        } as never),
      },
    ],
  ]);

  it("right on all three wins", () => {
    const ctx = context({
      targetMotionRange: [70, 100],
      expectedCinematicTags: ["aerial"],
      expectedAudioTypes: ["crowd"],
    });
    expect(order(rightVsWrong, ctx)[0]).toBe(A);
  });

  it("and the mirrored plan mirrors the winner", () => {
    const ctx = context({
      targetMotionRange: [0, 25],
      expectedCinematicTags: ["portrait"],
      expectedAudioTypes: ["rain"],
    });
    expect(order(rightVsWrong, ctx)[0]).toBe(B);
  });
});

/* ═══════════════════════ FASE 10/12 — delivered means IN THE FILE ═══════════════════════ */

/**
 * THE FALSE POSITIVE THIS ROUND WAS WRITTEN TO CATCH.
 *
 * R196's first feature matrix built `delivered` out of plan counts: captions were reported as
 * delivered because they had been ENABLED and a file existed. On the compose route that is always
 * wrong — its subtitle filter is `enableSubtitles ? "" : ""`, the empty string either way, so
 * compose burns in no captions at all. Transitions, ambience and sfx carried the same shape.
 *
 * The repair is structural rather than case-by-case: `delivered` may only be built from the
 * `delivery` block, which holds two kinds of thing and nothing else — FILE FACTS measured on the
 * delivered MP4, and ROUTE IDENTITY plus the document that route rendered from. A feature with no
 * entry there is `delivered: false` with a reason, which the UNEXPLAINED_GAP rule then requires.
 */
describe("delivered is built from evidence about the file, never from a plan", () => {
  const base = (): RenderFeatureFacts => ({
    beatsWithIntent: 10,
    beatsTotal: 10,
    retrieved: 300,
    eligible: 30,
    shortlisted: 20,
    visionEnabled: true,
    visionReviewPool: 20,
    visionAsked: 16,
    visionApproved: 6,
    motionBandsPlanned: 10,
    motionScored: 9,
    cinematicEnabled: true,
    cinematicPlanned: true,
    cinematicRendered: true,
    captionsEnabled: true,
    captionsPlanned: 10,
    graphicsEnabled: true,
    graphicsPlanned: 3,
    /**
     * RONDE 203 renamed this. It was `transitionsPlanned`, set to one per scene join — transitions
     * the compose route never makes, since it joins scenes with `-f concat`. The matrix then read
     * `executed` off it, so "executed" could not disagree with "planned". This is now the number
     * the two emitters counted while emitting.
     */
    transitionsApplied: 2,
    musicCatalogueAvailable: false,
    ambiencePlanned: 2,
    ambienceUnavailable: 0,
    sfxPlanned: 2,
    duckingApplied: true,
    delivery: {
      fileExists: true,
      hasVideoStream: true,
      hasAudioStream: true,
      fromCinematicRender: false,
      assetsInFinalVideo: 11,
      captionsOnTimeline: 0,
      graphicsOnTimeline: 0,
      ambientClipsOnTimeline: 0,
      sfxClipsOnTimeline: 0,
      musicClipsOnTimeline: 0,
      graphicsBurnedInByCompose: 3,
      avSyncMeasured: true,
      spotChecked: true,
    },
  });

  const composeDelivered = () => buildRenderFeatureMatrix(base());
  const cinematicDelivered = () =>
    buildRenderFeatureMatrix({
      ...base(),
      delivery: {
        ...base().delivery,
        fromCinematicRender: true,
        captionsOnTimeline: 10,
        graphicsOnTimeline: 3,
        ambientClipsOnTimeline: 2,
        sfxClipsOnTimeline: 2,
        graphicsBurnedInByCompose: 0,
      },
    });

  it("captions enabled and planned are NOT delivered when compose produced the file", () => {
    const m = composeDelivered();
    expect(m.captions?.planned).toBe(true);
    expect(m.captions?.delivered).toBe(false);
    expect(m.captions?.reason).toContain("compose delivered this film and burns in no captions");
  });

  it("and ARE delivered when the cinematic timeline carries a caption track", () => {
    expect(cinematicDelivered().captions?.delivered).toBe(true);
  });

  it("a cinematic delivery with an empty caption track is still not delivered", () => {
    const m = buildRenderFeatureMatrix({
      ...base(),
      delivery: { ...base().delivery, fromCinematicRender: true, captionsOnTimeline: 0 },
    });
    expect(m.captions?.delivered).toBe(false);
    expect(m.captions?.reason).toContain("carries no caption track");
  });

  /** A compose overlay is not on a cinematic file, and a timeline graphic is not on a compose one. */
  it("graphics evidence follows the route that actually delivered", () => {
    expect(composeDelivered().graphics?.delivered).toBe(true);
    expect(cinematicDelivered().graphics?.delivered).toBe(true);
    const mixed = buildRenderFeatureMatrix({
      ...base(),
      delivery: {
        ...base().delivery,
        fromCinematicRender: true,
        graphicsOnTimeline: 0,
        graphicsBurnedInByCompose: 3,
      },
    });
    expect(
      mixed.graphics?.delivered,
      "a compose overlay was counted as delivered on a cinematic render"
    ).toBe(false);
  });

  /** Nothing reads a dissolve back off an MP4, so nothing may claim one. */
  it("transitions are never delivered, and say why", () => {
    for (const m of [composeDelivered(), cinematicDelivered()]) {
      expect(m.transitions?.executed).toBe(true);
      expect(m.transitions?.delivered).toBe(false);
      expect(m.transitions?.reason).toContain("nothing inspects the delivered file for transitions");
    }
  });

  it("ambience and sfx need a bed on the delivered timeline", () => {
    const compose = composeDelivered();
    expect(compose.ambience?.delivered).toBe(false);
    expect(compose.sfx?.delivered).toBe(false);
    const cine = cinematicDelivered();
    expect(cine.ambience?.delivered).toBe(true);
    expect(cine.sfx?.delivered).toBe(true);
  });

  it("ducking is not delivered when there is no bed to duck", () => {
    expect(composeDelivered().ducking?.delivered).toBe(false);
    expect(cinematicDelivered().ducking?.delivered).toBe(true);
  });

  /** The selection chain's evidence is the lineage's own FINAL_VIDEO stage, not a stage counter. */
  it("the selection chain is only delivered when its assets are in the film", () => {
    const none = buildRenderFeatureMatrix({
      ...base(),
      delivery: { ...base().delivery, assetsInFinalVideo: 0 },
    });
    for (const name of ["visualIntent", "retrieval", "eligibility", "shortlist", "vision"] as const) {
      expect(none[name]?.delivered, `${name} claimed delivery with nothing in the film`).toBe(false);
      expect(none[name]?.reason).toBeTruthy();
    }
    expect(composeDelivered().retrieval?.delivered).toBe(true);
  });

  /** FASE 9 — every one of these shapes must still satisfy the monotonicity check. */
  it("no arrangement of the evidence breaks the invariant", () => {
    for (const m of [
      composeDelivered(),
      cinematicDelivered(),
      buildRenderFeatureMatrix({ ...base(), delivery: { ...base().delivery, fileExists: false } }),
      buildRenderFeatureMatrix({ ...base(), delivery: { ...base().delivery, assetsInFinalVideo: 0 } }),
      buildRenderFeatureMatrix({ ...base(), visionEnabled: false, visionAsked: 0, visionApproved: 0 }),
    ]) {
      expect(featureMatrixViolations(m)).toEqual([]);
    }
  });

  /** FASE 11 — verified is a claim about the FILE and only deliveredQC may make it. */
  it("verified needs both measurements on the delivered file", () => {
    const both = cinematicDelivered();
    expect(Object.entries(both).filter(([, s]) => s.verified).map(([n]) => n)).toEqual([
      "deliveredQC",
    ]);
    const onlyEnvelope = buildRenderFeatureMatrix({
      ...base(),
      delivery: { ...base().delivery, spotChecked: false },
    });
    expect(onlyEnvelope.deliveredQC?.verified).toBe(false);
    expect(onlyEnvelope.deliveredQC?.delivered).toBe(true);
  });

  /** And with no file at all, nothing anywhere is delivered or verified. */
  it("no file means nothing is delivered", () => {
    const m = buildRenderFeatureMatrix({
      ...base(),
      delivery: { ...base().delivery, fileExists: false },
    });
    for (const [name, s] of Object.entries(m)) {
      expect(s.delivered, `${name} claims delivery with no file`).toBe(false);
      expect(s.verified, `${name} claims verification with no file`).toBe(false);
    }
  });

  /**
   * The structural guard. `delivered` is written in exactly one place, and that place reads the
   * delivery block. A second `delivered:` literal is how this defect would come back.
   */
  it("delivered has one writer, and it reads the evidence", () => {
    const contract = readFileSync(path.join(__dirname, "renderContract.ts"), "utf8");
    const builder = contract.slice(
      contract.indexOf("export function buildRenderFeatureMatrix("),
      contract.indexOf("export function formatFeatureMatrix(")
    );
    expect(builder).toContain("const deliveredWhen = (");
    expect(builder).toContain("d.fileExists && evidence");
    /** Only `deliveredQC` sets the field directly; every other feature goes through the gate. */
    expect((builder.match(/^\s+delivered: /gm) ?? []).length).toBe(1);
  });
});

/* ═══════════════════════ FASE 14/18 — how complete the compose invariant is ═══════════════════════ */

/**
 * THE SECOND SELECTION PATH, AND WHAT IT COSTS THE INVARIANT.
 *
 * FASE 14 asks whether a second selection exists that bypasses R194/R196. Two routes accept a clip
 * without passing the vision boundary — `resolveBeatClipFast` and `fetchBeatScriptImageForced`.
 * Both are last-resort rungs, reached only after the normal route returned nothing, and R94's
 * adoption policy already refuses them a REAL_FUNNEL claim, so the export gate is not fooled.
 *
 * What they DO cost is the compose invariant's completeness. `recordEventForPath` returns null for
 * a clip the ledger has never seen, so such a clip produces no COMPOSE_INPUT at all — and
 * `composeInputs = composeSelected + composeDropped` then holds while a real picture goes
 * unaccounted. The count is now taken and reported rather than assumed to be zero.
 */
describe("compose says how much of its own invariant it can vouch for", () => {
  const exitBlock = (): string => {
    const pipe = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const at = pipe.indexOf("const returnComposed = async (");
    expect(at, "the single compose exit is gone").toBeGreaterThan(-1);
    return pipe.slice(at, at + 5200);
  };

  it("an input the ledger cannot place is counted, not silently skipped", () => {
    const b = exitBlock();
    expect(b).toContain("let unknownToLedger = 0;");
    expect(b).toContain("if (!opened) unknownToLedger++;");
  });

  it("and a non-zero count is a warning, with what it means", () => {
    const b = exitBlock();
    expect(b).toContain("UNKNOWN_TO_LEDGER=");
    expect(b).toContain("cannot account for them");
  });

  /**
   * The repair is a COUNT and never a repair of the record. Inventing a lineage entry here would
   * give an asset a provenance it has not got, which is the one thing the ledger exists to prevent.
   */
  it("nothing invents a lineage record to make the number look complete", () => {
    const b = exitBlock();
    expect(b).not.toContain("createLineage(");
    expect(b).not.toContain("bindPath(");
  });

  /** The two routes that can produce such a clip are still last-resort, not competing selectors. */
  it("the routes that skip the vision boundary run only when the normal route found nothing", () => {
    const pipe = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const fastAt = pipe.indexOf("v = await resolveBeatClipFast(");
    expect(fastAt, "the fast route moved").toBeGreaterThan(-1);
    expect(pipe.slice(Math.max(0, fastAt - 200), fastAt)).toContain(
      "if (!v || isPipelineFallbackClip(v)) {"
    );
    const forcedAt = pipe.indexOf("img = await fetchBeatScriptImageForced(");
    expect(forcedAt).toBeGreaterThan(-1);
    expect(pipe.slice(Math.max(0, forcedAt - 300), forcedAt)).toContain(
      "if (img && !isPipelineFallbackClip(img)) return img;"
    );
  });
});
