/**
 * RONDE 97 §7/§8/§11 — WHAT THE RENDER PROMISED, AND WHAT IT ACTUALLY DID.
 *
 * Three questions that turn out to be one question asked at three scales:
 *
 *   §7  For ONE BEAT, in what order may the pipeline give up? (the fallback ladder)
 *   §8  For ONE BEAT, what did it end up with, and may that be called verified? (coverage)
 *   §11 For ONE FEATURE, across the render, is it planned or is it in the file? (the matrix)
 *
 * All three exist to stop the same thing: a claim that outruns the evidence. RONDE 89 blocked the
 * export of a film whose beats hold no verified visual; RONDE 94 blocked an adoption that claims
 * REAL_FUNNEL without one. What neither could do is say, in one place, "music was planned and is
 * not in the delivered file" — because nothing distinguished PLANNED from DELIVERED.
 *
 * ── Why this is a contract module and not an engine ─────────────────────────────────────────
 *
 * It decides nothing and renders nothing. `adoptionPolicy` already says what a route may claim,
 * `beatVisualStatus` already reads coverage, the cinematic planners already plan. This writes down
 * the ORDER those existing answers must come in, and the vocabulary for reporting the distance
 * between a plan and a file. A second selection engine, a second coverage mapping or a second
 * planner would each be the mistake this codebase repeats most.
 */
import { adoptionPolicyFor, type AdoptCategory } from "./adoptionPolicy";

/* ═══════════════════════ §7 — the fallback ladder ═══════════════════════ */

/**
 * The order in which a beat is allowed to settle for less.
 *
 * Each rung claims strictly less than the one above it. The ladder is a partial ORDER, not a
 * search strategy: it does not say which routes to try, it says that having reached rung N, the
 * pipeline may not later present the result as rung N-1. That is the property render 568 broke —
 * ten beats filled by `subject_fallback` and counted as own footage.
 */
export const FALLBACK_LADDER = [
  "APPROVED_REAL",
  "RESCUE_REAL",
  "FALLBACK_SUBJECT",
  "BACKFILL",
  "GENERATED",
  "GRAPHIC",
  "PLACEHOLDER",
] as const;

export type FallbackRung = (typeof FALLBACK_LADDER)[number];

/** Which rung a declared adopt route lands on. Derived from the policy, never re-decided here. */
export function rungForAdoptSource(source: string): FallbackRung | null {
  const category: AdoptCategory = adoptionPolicyFor(source).category;
  switch (category) {
    case "REAL_FUNNEL":
      return "APPROVED_REAL";
    case "RESCUE_REAL":
      return "RESCUE_REAL";
    case "FALLBACK_SUBJECT":
      return "FALLBACK_SUBJECT";
    case "BACKFILL_TIME":
      return "BACKFILL";
    case "GENERATED":
      return "GENERATED";
    case "GRAPHIC":
      return "GRAPHIC";
    case "PLACEHOLDER":
      return "PLACEHOLDER";
    /** An undeclared route has no rung, which is why RONDE 94 refuses it outright. */
    default:
      return null;
  }
}

export function rungRank(rung: FallbackRung): number {
  return FALLBACK_LADDER.indexOf(rung);
}

/**
 * MAY THIS ROUTE TAKE THE BEAT, GIVEN WHAT THE BEAT ALREADY HAS?
 *
 * The rule is one sentence: a lower rung may never displace a higher one. A placeholder cannot
 * replace approved real footage, and a subject fallback cannot replace a rescue — which is the
 * "fallback mag nooit een goede approved visual verdringen" the brief states twice.
 *
 * The same rung IS allowed to replace itself: two approved real clips competing for one beat is
 * an ordinary editorial choice and not this rule's business.
 */
export function fallbackMayReplace(current: FallbackRung | null, candidate: FallbackRung | null): boolean {
  if (!candidate) return false;
  if (!current) return true;
  return rungRank(candidate) <= rungRank(current);
}

/* ═══════════════════════ §8 — the beat coverage contract ═══════════════════════ */

/**
 * What a beat ended up with, in the vocabulary a person would use.
 *
 * One canonical set, derived from the adoption policy — deliberately NOT a second mapping. RONDE
 * 91 removed the last hand-written coverage table for exactly this reason: two tables answering
 * one question is how `subject_fallback` came to count as own footage in one reader and not in
 * another.
 */
export type BeatCoverageState =
  | "VERIFIED_REAL"
  | "RESCUE_REAL"
  | "FALLBACK_SUBJECT"
  | "BACKFILL"
  | "GENERATED"
  | "GRAPHIC"
  | "PLACEHOLDER"
  | "NO_VISUAL";

export type BeatCoverage = {
  sceneIndex: number;
  beatIndex: number;
  state: BeatCoverageState;
  /** The adopt route that produced it, or "" when the beat has no picture. */
  source: string;
  /** Why the beat is in this state — the reason the shortlist or the guard recorded. */
  reason: string;
  /** Was the picture APPROVED by the editor for THIS beat? Only that makes a beat verified. */
  verified: boolean;
  /** The last lifecycle stage the beat's asset is known to have reached. */
  lifecycle: string;
};

/**
 * THE ONE PLACE A BEAT'S STATE IS DECIDED.
 *
 * `verified` is an input rather than a derivation, and that is the whole point: a REAL_FUNNEL
 * route whose picture was never approved is NOT `VERIFIED_REAL`. Render 568 had seventeen beats
 * whose route said REAL_FUNNEL and whose pictures nobody had looked at, and every reader that
 * derived "verified" from the route alone reported them as verified footage.
 */
export function beatCoverage(input: {
  sceneIndex: number;
  beatIndex: number;
  source: string;
  approved: boolean;
  reason?: string;
  lifecycle?: string;
}): BeatCoverage {
  const rung = rungForAdoptSource(input.source);
  const base = {
    sceneIndex: input.sceneIndex,
    beatIndex: input.beatIndex,
    source: input.source,
    reason: input.reason ?? "",
    lifecycle: input.lifecycle ?? "UNKNOWN",
  };

  if (!input.source) {
    return { ...base, state: "NO_VISUAL", verified: false, reason: input.reason || "NO_VISUAL" };
  }
  /** An undeclared route has no rung. It cannot be verified and it cannot be classified. */
  if (!rung) {
    return { ...base, state: "NO_VISUAL", verified: false, reason: input.reason || "UNDECLARED_ROUTE" };
  }
  if (rung === "APPROVED_REAL") {
    return input.approved
      ? { ...base, state: "VERIFIED_REAL", verified: true }
      : /**
         * A funnel route without an approval is real media that nobody vouched for. It is reported
         * as a rescue — the nearest honest rung — rather than as verified, and never the reverse.
         */
        { ...base, state: "RESCUE_REAL", verified: false, reason: input.reason || "NOT_APPROVED" };
  }
  return { ...base, state: rung as BeatCoverageState, verified: false };
}

/** VERIFIED_REAL is the only state that may be counted as a beat's own verified visual. */
export function coverageIsVerified(state: BeatCoverageState): boolean {
  return state === "VERIFIED_REAL";
}

export function formatBeatCoverage(c: BeatCoverage): string {
  return (
    `[BeatCoverage] s${c.sceneIndex}b${c.beatIndex} state=${c.state} verified=${c.verified} ` +
    `source=${c.source || "none"} lifecycle=${c.lifecycle}` +
    (c.reason ? ` reason=${c.reason}` : "")
  );
}

/* ═══════════════════════ §11 — the feature matrix ═══════════════════════ */

/**
 * PLANNED IS NOT RENDERED, AND RENDERED IS NOT VERIFIED.
 *
 * Five states per feature, and the gaps between them are the whole point:
 *
 *   enabled   — the configuration asks for it.
 *   planned   — a planner produced something for it.
 *   executed  — the renderer was actually handed that plan and ran it.
 *   delivered — it is in the file the viewer gets.
 *   verified  — something inspected the delivered file and found it.
 *
 * Render 568 could report a caption plan and a music track while the delivered MP4 had neither,
 * because "configured" was the only state anything recorded. The honest answer for most features
 * before a real render is `delivered: false, verified: false` — and this module exists so that
 * answer can be given rather than assumed either way.
 */
export type FeatureName =
  | "visualIntent" | "retrieval" | "eligibility" | "shortlist" | "vision"
  | "cinematic" | "movement" | "transitions" | "graphics" | "captions"
  | "music" | "ambience" | "sfx" | "ducking" | "deliveredQC";

export type FeatureStatus = {
  enabled: boolean;
  planned: boolean;
  executed: boolean;
  delivered: boolean;
  verified: boolean;
  /** Required whenever a later state is false while an earlier one is true. */
  reason?: string;
};

export type FeatureMatrix = Partial<Record<FeatureName, FeatureStatus>>;

export function featureStatus(input: Partial<FeatureStatus> = {}): FeatureStatus {
  return {
    enabled: input.enabled ?? false,
    planned: input.planned ?? false,
    executed: input.executed ?? false,
    delivered: input.delivered ?? false,
    verified: input.verified ?? false,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

/**
 * The states must be monotonic: a feature cannot be delivered without being executed, or executed
 * without being planned. A matrix that says otherwise is not describing a render, it is describing
 * a bookkeeping error — and reporting it as a finding is the difference between a matrix that can
 * be trusted and one that merely looks tidy.
 */
export function featureMatrixViolations(matrix: FeatureMatrix): string[] {
  const out: string[] = [];
  for (const [name, s] of Object.entries(matrix) as [FeatureName, FeatureStatus][]) {
    if (s.planned && !s.enabled) out.push(`[FeatureMatrix] ${name} PLANNED_WHILE_DISABLED`);
    if (s.executed && !s.planned) out.push(`[FeatureMatrix] ${name} EXECUTED_WITHOUT_PLAN`);
    if (s.delivered && !s.executed) out.push(`[FeatureMatrix] ${name} DELIVERED_WITHOUT_EXECUTION`);
    if (s.verified && !s.delivered) out.push(`[FeatureMatrix] ${name} VERIFIED_WITHOUT_DELIVERY`);
    /** A promise that stopped short must say where and why, or it is an unexplained gap. */
    const stalled = (s.enabled && !s.planned) || (s.planned && !s.executed) || (s.executed && !s.delivered);
    if (stalled && !s.reason) out.push(`[FeatureMatrix] ${name} UNEXPLAINED_GAP`);
  }
  return out;
}

/**
 * The facts one render can state about itself, and nothing more.
 *
 * R195 — every field here is a number or a boolean the pipeline already holds when the report is
 * written. Nothing is inferred from a later stage, and there is no field for "probably". A feature
 * this render genuinely cannot speak about is left out of the matrix rather than guessed at, which
 * is what `Partial` is for.
 */
export type RenderFeatureFacts = {
  // ── RUNTIME FACTS — what the render DID ───────────────────────────────────────────────────
  //
  // Everything in this half describes work that happened. None of it is evidence about the file
  // the viewer receives, and `delivered` may never be built from it. R197 found that exact
  // mistake in R196's first version of this builder: captions were reported as delivered because
  // they had been ENABLED, on a route whose subtitle filter is the empty string either way.

  /** Beats that resolved a visual intent. */
  beatsWithIntent: number;
  beatsTotal: number;
  /** Retrieval, eligibility and the bounded shortlist, from the per-beat funnel. */
  retrieved: number;
  eligible: number;
  shortlisted: number;
  /** Vision: whether the gate is on, how many asks were made, how many came back a fit. */
  visionEnabled: boolean;
  visionReviewPool: number;
  visionAsked: number;
  visionApproved: number;
  /** Movement: whether a band was planned for any beat, and whether it moved any ranking. */
  motionBandsPlanned: number;
  motionScored: number;
  /** The cinematic route: flag, a stored plan, a render that ran. */
  cinematicEnabled: boolean;
  cinematicPlanned: boolean;
  cinematicRendered: boolean;
  /** Captions, graphics, transitions and audio AS THE PLAN HELD THEM — never as delivery. */
  captionsEnabled: boolean;
  captionsPlanned: number;
  graphicsEnabled: boolean;
  graphicsPlanned: number;
  transitionsPlanned: number;
  /** `musicCatalogueAvailable` is the honest external blocker, not a code state. */
  musicCatalogueAvailable: boolean;
  ambiencePlanned: number;
  ambienceUnavailable: number;
  sfxPlanned: number;
  duckingApplied: boolean;

  // ── DELIVERY EVIDENCE — what can be established about the file the viewer receives ────────
  //
  // R197 §10/§12. Two kinds of thing live here and nothing else may:
  //
  //   FILE FACTS     measured on the delivered MP4 itself (ffprobe, the spot check)
  //   ROUTE IDENTITY the delivered file provably came from the path that carries this feature,
  //                  and the document that path rendered from says what it carried
  //
  // A feature with no entry here cannot be `delivered`. That is the point: the honest answer to
  // "is this in the file" is often "nothing here can say", and a matrix that guesses instead is
  // worse than one that admits it.
  delivery: {
    /** A file was produced and stored. */
    fileExists: boolean;
    /** FILE FACT — the delivered container really carries a video stream. */
    hasVideoStream: boolean;
    /** FILE FACT — and an audio stream. */
    hasAudioStream: boolean;
    /** ROUTE IDENTITY — the delivered file came from the cinematic render, not from compose. */
    fromCinematicRender: boolean;
    /**
     * The assets this render's selection chain put in the delivered film, from the lineage's own
     * FINAL_VIDEO stage. Not an inspection of pixels; the strongest statement this pipeline makes
     * about what the delivered file is made of.
     */
    assetsInFinalVideo: number;
    /** From the DOCUMENT the cinematic render was made from — what will play, not what was asked. */
    captionsOnTimeline: number;
    graphicsOnTimeline: number;
    ambientClipsOnTimeline: number;
    sfxClipsOnTimeline: number;
    musicClipsOnTimeline: number;
    /** Overlays the COMPOSE route burned into the file it produced. Irrelevant to a cinematic one. */
    graphicsBurnedInByCompose: number;
    /** Which measurements actually ran on the delivered file. */
    avSyncMeasured: boolean;
    spotChecked: boolean;
  };
};

/**
 * Build the matrix from one render's own facts.
 *
 * ── Why this is a function and not fifteen inline objects ───────────────────────────────────
 *
 * Because the five states have to mean the same thing for every feature or the monotonicity check
 * is measuring nothing. Deciding what `delivered` means for captions in one place and for graphics
 * in another is how a matrix becomes decoration. The rule, applied identically throughout:
 *
 *   enabled   — configuration allows it
 *   planned   — this render produced a plan for it
 *   executed  — the plan was actually carried out
 *   delivered — it is in the file the viewer receives
 *   verified  — something INSPECTED that file and found it
 *
 * `verified` is false almost everywhere, and that is the honest answer rather than a gap in this
 * function: nothing in this pipeline reads a finished MP4 back and confirms a caption is on it.
 * Only `deliveredQC` can claim it, because measuring the delivered file is what it IS.
 *
 * A feature only enters the matrix when the facts can place it. A render that never reached the
 * cinematic route says nothing about `cinematic` instead of reporting five falses, because five
 * falses read as "it failed" and the truth is "it was not asked for".
 */
export function buildRenderFeatureMatrix(f: RenderFeatureFacts): FeatureMatrix {
  const matrix: FeatureMatrix = {};
  const put = (name: FeatureName, s: Partial<FeatureStatus>) => {
    matrix[name] = featureStatus(s);
  };
  const d = f.delivery;

  /**
   * The one gate every `delivered` passes through.
   *
   * R197 §10 — a feature is delivered when a DELIVERY FACT says so, and never because a plan
   * existed or a stage ran. `evidence` is that fact; `whenAbsent` is what the report says when
   * there is none, which the UNEXPLAINED_GAP rule then requires rather than tolerates.
   */
  const deliveredWhen = (
    evidence: boolean,
    whenAbsent: string
  ): { delivered: boolean; reason?: string } =>
    d.fileExists && evidence
      ? { delivered: true }
      : { delivered: false, reason: d.fileExists ? whenAbsent : "no file was delivered" };

  /**
   * The selection chain's delivery fact, shared by the five stages that produce the picture.
   *
   * Not an inspection of pixels — nothing in this pipeline reads a frame back and recognises the
   * clip it came from. It is the lineage's own FINAL_VIDEO stage: assets this render selected that
   * the delivered film is made of. That is the strongest true statement available, and calling it
   * anything stronger is the mistake this whole module exists to prevent.
   */
  const pictureLanded = d.assetsInFinalVideo > 0;
  const noPicture = "no asset this render selected is recorded in the delivered film";

  put("visualIntent", {
    enabled: true,
    planned: f.beatsWithIntent > 0,
    executed: f.beatsWithIntent > 0,
    ...deliveredWhen(pictureLanded, noPicture),
    ...(f.beatsWithIntent < f.beatsTotal
      ? { reason: `${f.beatsTotal - f.beatsWithIntent} beats resolved no visual intent` }
      : {}),
  });

  put("retrieval", {
    enabled: true,
    planned: f.beatsTotal > 0,
    executed: f.retrieved > 0,
    ...deliveredWhen(pictureLanded, noPicture),
    ...(f.retrieved === 0 ? { reason: "no candidate reached any beat" } : {}),
  });

  put("eligibility", {
    enabled: true,
    planned: f.retrieved > 0,
    executed: f.eligible > 0,
    ...deliveredWhen(pictureLanded, noPicture),
    ...(f.retrieved > 0 && f.eligible === 0
      ? { reason: "every retrieved candidate was refused before the editor saw it" }
      : {}),
  });

  put("shortlist", {
    enabled: true,
    planned: f.eligible > 0,
    executed: f.shortlisted > 0,
    ...deliveredWhen(pictureLanded, noPicture),
    ...(f.eligible > 0 && f.shortlisted === 0
      ? { reason: "eligible candidates existed and none was admitted" }
      : {}),
  });

  put("vision", {
    enabled: f.visionEnabled,
    planned: f.visionEnabled && f.visionReviewPool > 0,
    executed: f.visionAsked > 0,
    /** A verdict reaches the film only through a picture the film is made of. */
    ...deliveredWhen(pictureLanded && f.visionApproved > 0, noPicture),
    ...(f.visionEnabled && f.visionApproved === 0
      ? { reason: `asked=${f.visionAsked} approved=0 — no picture was called a fit` }
      : !f.visionEnabled
        ? { reason: "the beat image gate is switched off" }
        : {}),
  });

  put("movement", {
    enabled: true,
    planned: f.motionBandsPlanned > 0,
    executed: f.motionScored > 0,
    ...deliveredWhen(pictureLanded && f.motionScored > 0, noPicture),
    ...(f.motionBandsPlanned > 0 && f.motionScored === 0
      ? { reason: "bands were planned and no candidate could be measured against them" }
      : f.motionBandsPlanned === 0
        ? { reason: "no planner produced a movement band for any beat" }
        : {}),
  });

  put("cinematic", {
    enabled: f.cinematicEnabled,
    planned: f.cinematicPlanned,
    executed: f.cinematicRendered,
    /** ROUTE IDENTITY, and the cleanest delivery fact in the matrix. */
    ...deliveredWhen(d.fromCinematicRender, "compose produced the delivered file, not this route"),
    ...(f.cinematicEnabled && !d.fromCinematicRender
      ? {
          reason: f.cinematicPlanned
            ? f.cinematicRendered
              ? "the render ran and its output was not the delivered file"
              : "a plan was stored and no render ran from it"
            : "the route is on and no timeline was planned",
        }
      : !f.cinematicEnabled
        ? { reason: "CINEMATIC_RENDER_PATH is off — compose delivered this film" }
        : {}),
  });

  /**
   * CAPTIONS — the false positive R197 was written to catch.
   *
   * R196 read `delivered` off `captionsEnabled`, and on the compose route that is always wrong:
   * its subtitle filter is `enableSubtitles ? "" : ""` — the empty string either way, so compose
   * burns in no captions at all. The only route that carries them is the cinematic one, and the
   * only honest evidence is the caption track on the document it rendered from.
   */
  put("captions", {
    enabled: f.captionsEnabled,
    planned: f.captionsPlanned > 0,
    executed: d.captionsOnTimeline > 0,
    ...deliveredWhen(
      d.fromCinematicRender && d.captionsOnTimeline > 0,
      d.fromCinematicRender
        ? "the delivered timeline carries no caption track"
        : "compose delivered this film and burns in no captions"
    ),
    ...(f.captionsEnabled && f.captionsPlanned === 0
      ? { reason: "captions are on and none was planned" }
      : !f.captionsEnabled
        ? { reason: "captions are switched off for this render" }
        : {}),
  });

  /** Two routes, two different pieces of evidence — a compose overlay is not on a cinematic file. */
  put("graphics", {
    enabled: f.graphicsEnabled,
    planned: f.graphicsPlanned > 0,
    executed: d.graphicsBurnedInByCompose > 0 || d.graphicsOnTimeline > 0,
    ...deliveredWhen(
      d.fromCinematicRender ? d.graphicsOnTimeline > 0 : d.graphicsBurnedInByCompose > 0,
      d.fromCinematicRender
        ? "the delivered timeline carries no graphics track"
        : "compose burned no overlay into the delivered file"
    ),
    ...(f.graphicsPlanned > d.graphicsBurnedInByCompose + d.graphicsOnTimeline
      ? {
          reason:
            `${f.graphicsPlanned} graphics were planned and ` +
            `${d.graphicsBurnedInByCompose + d.graphicsOnTimeline} reached a render`,
        }
      : !f.graphicsEnabled
        ? { reason: "no graphic was generated for this render" }
        : {}),
  });

  /**
   * TRANSITIONS — planned, and nothing can say whether they are in the file.
   *
   * No probe reads a dissolve back off an MP4, and neither renderer reports the transitions it
   * applied. `delivered: false` with the reason is the honest answer; claiming it from a scene
   * count would be the captions mistake in a second place.
   */
  put("transitions", {
    enabled: true,
    planned: f.transitionsPlanned > 0,
    executed: f.transitionsPlanned > 0,
    ...deliveredWhen(false, "nothing inspects the delivered file for transitions"),
    ...(f.transitionsPlanned === 0 ? { reason: "this film is cut, with no transitions" } : {}),
  });

  /** The one feature whose gap is external rather than a defect. Its own helper states it. */
  matrix.music = musicFeatureStatus(f.musicCatalogueAvailable);
  if (d.fromCinematicRender && d.musicClipsOnTimeline > 0 && d.fileExists) {
    /** A catalogue appeared and the document carries it — the only way this becomes delivered. */
    matrix.music = featureStatus({ enabled: true, planned: true, executed: true, delivered: true });
  }

  put("ambience", {
    enabled: true,
    planned: f.ambiencePlanned > 0,
    executed: d.ambientClipsOnTimeline > 0,
    ...deliveredWhen(
      d.fromCinematicRender && d.ambientClipsOnTimeline > 0,
      d.fromCinematicRender
        ? "the delivered timeline carries no ambient clip"
        : "compose delivered this film and lays no ambience bed"
    ),
    ...(f.ambienceUnavailable > 0
      ? { reason: `${f.ambienceUnavailable} planned ambiences the catalogue could not supply` }
      : f.ambiencePlanned === 0
        ? { reason: "no scene was planned room tone" }
        : {}),
  });

  put("sfx", {
    enabled: true,
    planned: f.sfxPlanned > 0,
    executed: d.sfxClipsOnTimeline > 0,
    ...deliveredWhen(
      d.fromCinematicRender && d.sfxClipsOnTimeline > 0,
      d.fromCinematicRender
        ? "the delivered timeline carries no sfx clip"
        : "compose delivered this film and places no sfx track"
    ),
    ...(f.sfxPlanned === 0 ? { reason: "no beat was planned an object sound" } : {}),
  });

  /**
   * DUCKING — only meaningful when there is something to duck, and only observable when the
   * delivered file carries the bed that would be ducked.
   */
  const bedOnTimeline = d.ambientClipsOnTimeline + d.sfxClipsOnTimeline + d.musicClipsOnTimeline;
  put("ducking", {
    enabled: true,
    planned: f.ambiencePlanned > 0 || f.sfxPlanned > 0,
    executed: f.duckingApplied && bedOnTimeline > 0,
    ...deliveredWhen(
      d.fromCinematicRender && bedOnTimeline > 0 && d.hasAudioStream && f.duckingApplied,
      bedOnTimeline === 0
        ? "nothing was laid under the narration to duck"
        : "nothing inspects the delivered mix for ducking"
    ),
    ...((f.ambiencePlanned > 0 || f.sfxPlanned > 0) && !f.duckingApplied
      ? { reason: "a bed was planned under the narration and nothing ducked it" }
      : f.ambiencePlanned === 0 && f.sfxPlanned === 0
        ? { reason: "nothing was laid under the narration to duck" }
        : {}),
  });

  /**
   * The only feature that may claim `verified`, because inspecting the delivered file is what it
   * does. Both halves must have run: a spot check without an envelope measurement cannot see
   * narration running past the picture, and an envelope without a spot check cannot see black.
   */
  const qcRan = d.fileExists && (d.avSyncMeasured || d.spotChecked);
  put("deliveredQC", {
    enabled: true,
    planned: d.fileExists,
    executed: qcRan,
    delivered: qcRan,
    verified: d.fileExists && d.avSyncMeasured && d.spotChecked,
    ...(!d.fileExists
      ? { reason: "no file was delivered, so there was nothing to inspect" }
      : !(d.avSyncMeasured && d.spotChecked)
        ? {
            reason:
              `avSync=${d.avSyncMeasured ? "measured" : "not measured"} ` +
              `spotCheck=${d.spotChecked ? "run" : "not run"}`,
          }
        : {}),
  });

  return matrix;
}

export function formatFeatureMatrix(matrix: FeatureMatrix): string[] {
  const names = Object.keys(matrix) as FeatureName[];
  if (names.length === 0) return [];
  const mark = (b: boolean) => (b ? "yes" : "no");
  const lines = ["[FeatureMatrix] feature enabled planned executed delivered verified"];
  for (const name of names.sort()) {
    const s = matrix[name]!;
    lines.push(
      `[FeatureMatrix] ${name} ${mark(s.enabled)} ${mark(s.planned)} ${mark(s.executed)} ` +
        `${mark(s.delivered)} ${mark(s.verified)}` + (s.reason ? ` reason=${s.reason}` : "")
    );
  }
  return [...lines, ...featureMatrixViolations(matrix)];
}

/**
 * §13 — MUSIC IS THE ONE HONEST EXTERNAL BLOCKER, AND IT SAYS SO.
 *
 * This build has no music catalogue. The brief is explicit that it must not be faked with a sine
 * bed or a generated substitute, and `cinematicAmbient` already refuses to lay one down. What was
 * missing is the matrix entry that states the consequence rather than leaving it to be inferred
 * from the absence of a log line.
 */
export function musicFeatureStatus(catalogueAvailable: boolean): FeatureStatus {
  if (catalogueAvailable) return featureStatus({ enabled: true, planned: true });
  return featureStatus({
    enabled: true,
    planned: false,
    reason: "musicSourceUnavailable — this build has no music catalogue, and a sine bed is not music",
  });
}


/* ═══════════════════════ §4 — the provider funnel, reconciled ═══════════════════════ */

/**
 * RONDE 97 §4 — ONE MEANING FOR `eligible`, AND ONE FOR `adopted`.
 *
 * The brief's rule is a single sentence: a provider may not report `eligible=0` while adopting
 * assets through a normal REAL_FUNNEL route. Render 568 printed exactly that shape —
 *
 *     [VisualFunnel] wikimedia retrieved=400 eligible=0 adopted=2 finalVideo=1
 *     [VisualFunnel] ww2       retrieved=0   eligible=0 adopted=6 finalVideo=1
 *     [VisualFunnel] loc       retrieved=0   eligible=0 adopted=1
 *
 * — and each line was true in its own subsystem's vocabulary while being impossible taken
 * together. That is what "reconciliation" means here: not new counters, but a check that the
 * existing ones can all be true at once.
 *
 * Adoptions off the funnel are legitimate and expected, which is why the check is not "adopted
 * implies eligible". A rescue, a subject fallback, a backfill, a generated card or a placeholder
 * all adopt without eligibility BY DECLARATION — `adoptionPolicy` says so and RONDE 94 enforces
 * it. So the reconciliation asks the only question that has no legitimate answer: were there more
 * adoptions than the declared exceptions can account for?
 */
export type ProviderFunnelCounts = {
  results: number;
  eligible: number;
  adopted: number;
  rescue: number;
  fallback: number;
  backfill: number;
  composed: number;
  finalVideo: number;
};

export type FunnelFinding = { provider: string; code: string; message: string };

/**
 * The three impossibilities, per provider.
 *
 * ELIGIBLE_EXCEEDS_RESULTS and COMPOSED_EXCEEDS_ADOPTED are monotonicity: a stage cannot produce
 * more than the stage before it fed it. UNEXPLAINED_FUNNEL_ADOPTION is the render-568 line — more
 * adoptions than eligibility and the declared exceptions together can account for.
 *
 * A provider with `results=0` is deliberately NOT flagged for having adopted: several routes
 * adopt an asset the render already holds (the curated pool, a local archive row) without ever
 * issuing a search, and reporting those as broken would train the reader to scroll past the line
 * that finally matters.
 */
export function reconcileProviderFunnel(
  byProvider: Record<string, ProviderFunnelCounts>
): FunnelFinding[] {
  const out: FunnelFinding[] = [];
  for (const [provider, c] of Object.entries(byProvider)) {
    if (c.results > 0 && c.eligible > c.results) {
      out.push({
        provider,
        code: "ELIGIBLE_EXCEEDS_RESULTS",
        message: `eligible=${c.eligible} from results=${c.results}`,
      });
    }
    if (c.composed > c.adopted) {
      out.push({
        provider,
        code: "COMPOSED_EXCEEDS_ADOPTED",
        message: `composed=${c.composed} from adopted=${c.adopted}`,
      });
    }
    if (c.finalVideo > c.composed && c.composed > 0) {
      out.push({
        provider,
        code: "DELIVERED_EXCEEDS_COMPOSED",
        message: `finalVideo=${c.finalVideo} from composed=${c.composed}`,
      });
    }
    /** The declared ways to adopt without eligibility. Anything beyond them is unexplained. */
    const declaredExceptions = c.rescue + c.fallback + c.backfill;
    const unexplained = c.adopted - c.eligible - declaredExceptions;
    if (unexplained > 0) {
      out.push({
        provider,
        code: "UNEXPLAINED_FUNNEL_ADOPTION",
        message:
          `adopted=${c.adopted} eligible=${c.eligible} rescue=${c.rescue} ` +
          `fallback=${c.fallback} backfill=${c.backfill} — ${unexplained} adoption(s) claim the ` +
          `funnel without eligibility and without a declared exception`,
      });
    }
  }
  return out;
}

export function formatFunnelReconciliation(findings: FunnelFinding[]): string[] {
  return findings.map((f) => `[ProviderFunnelInvariant] ${f.provider} ${f.code} ${f.message}`);
}
