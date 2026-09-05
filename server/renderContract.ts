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
