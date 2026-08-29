/**
 * RONDE 105 — one definition of "this beat has a picture of its own, and somebody checked it".
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────────────────
 *
 * A production render reported `Visual quality — 100/100 (Excellent)` on a montage where thirteen
 * of its beats had no image of their own and the vision model had approved not one frame. Three
 * separate subsystems were each telling a piece of the truth and none of them was talking to the
 * others:
 *
 *   · voiceVisualMatch  counted degraded rescues and said "13 beat(s) zonder eigen beeld"
 *   · clipAdoptAudit    counted `fallbackBeats`, which only matches the sources "fallback" and
 *                       "rescue_placeholder" — so a held frame, a graphic or a reused clip cost
 *                       nothing at all
 *   · the quality score read CLIP scores of a handful of adopted clips and nothing else
 *
 * Three definitions of the same question drift, and these had. This is the one definition. Every
 * consumer imports it rather than re-deriving it, so the report, the warnings and the score can
 * no longer disagree about what a covered beat is.
 *
 * ── The two axes ─────────────────────────────────────────────────────────────────────────────
 *
 * A beat is described by two independent facts, and collapsing them is what produced the lie:
 *
 *   COVERAGE       did this beat get real footage of its own, or a stand-in?
 *   VERIFICATION   did the content decider look at it, and what did it say?
 *
 * A beat can have real footage nobody checked (`own_footage` + `never_asked`), and a beat can
 * have a held frame the model was never going to be asked about (`held_frame` + `never_asked`).
 * Only the combination `own_footage` + `verified_fit` is a beat that is actually finished.
 *
 * Nothing here judges anything. It reads what RONDE 103/104 already recorded — the adopt audit's
 * route label and the relevance ledger's verdict — and states the combination. There is no second
 * AI, no CLIP score, no keyword rule.
 */
import * as path from "path";

import type { ClipAdoptEntry } from "./clipAdoptAudit";
import type { BeatRelevanceLedger } from "./beatVisualRelevance";

/**
 * What kind of picture this beat ended up with.
 *
 * The order is deliberate: everything below `own_footage` is a stand-in for footage this render
 * failed to find, and the report says so rather than counting it as a filled beat.
 */
export type BeatCoverage =
  /** Real footage sourced for this beat. The only value that is not a compromise. */
  | "own_footage"
  /** The previous clip was held longer because there was no new one. */
  | "held_frame"
  /**
   * RONDE 112 — real footage of the beat's main subject, adopted when nothing matching the beat's
   * full claim existed. "Hitler" under "Hitler died in his bunker in 1945".
   *
   * Its own kind rather than own_footage, because the two claims are genuinely different: the
   * vision gate was asked whether the picture shows the SUBJECT, and it never saw the rest of the
   * sentence. Calling that a verified own visual would be the report claiming a check that was
   * not performed. It is also emphatically not a stand-in — the picture is real, it is on
   * subject, and it is far better than the held frame it replaced.
   */
  | "subject_only"
  /** A motion graphic or text card standing in for footage. */
  | "graphic"
  /** A colour card. No picture at all. */
  | "placeholder"
  /** Generated rather than filmed. */
  | "generated"
  /** No clip was recorded for this beat. */
  | "none";

/** What the content decider said about the picture this beat ended up with. */
export type BeatVerification =
  /** The model looked and said it belongs. */
  | "verified_fit"
  /** The model looked and said it does not belong, and it was not used anyway. */
  | "verified_mismatch"
  /**
   * The model looked, said it does not belong, and the pipeline used it regardless because every
   * alternative had been refused too (the RONDE 67 product decision). Never reported as a fit.
   */
  | "reprieved_after_refusal"
  /** The model was asked and could not answer — an outage, a timeout, an unreadable frame. */
  | "unknown"
  /** The model was never asked: budget spent, per-beat ceiling reached, or nothing to judge. */
  | "never_asked";

export type BeatVisualStatus = {
  sceneIndex: number;
  beatIndex: number;
  coverage: BeatCoverage;
  verification: BeatVerification;
  /** The adopt route that filled this beat ("archive", "rescue_extend", "fallback", …). */
  source: string;
  basename: string;
  /**
   * True only for `own_footage` + `verified_fit`.
   *
   * This is the number the quality score is built on, and the reason it is a single derived flag
   * rather than something each consumer works out: "the beat has a real picture AND the picture
   * was checked AND the check passed" is one claim, and it must mean the same thing everywhere.
   */
  verifiedOwnVisual: boolean;
  /** Short machine-readable reason when `verifiedOwnVisual` is false. */
  reason: string;
};

/** Routes that mean "no footage was found for this beat" rather than "footage was found". */
const COVERAGE_BY_SOURCE: ReadonlyMap<string, BeatCoverage> = new Map<string, BeatCoverage>([
  ["fallback", "placeholder"],
  ["rescue_placeholder", "placeholder"],
  ["rescue_extend", "held_frame"],
  ["subject_fallback", "subject_only"],
  ["rescue_graphic", "graphic"],
  ["graphic", "graphic"],
  ["motion_graphic", "graphic"],
  ["rescue_ai", "generated"],
  ["kling", "generated"],
  ["ai", "generated"],
  ["text_overlay", "graphic"],
  ["color_fallback", "placeholder"],
]);

/** A guaranteed-ladder file is a card the ladder drew when everything else had failed. */
export function isGuaranteedClipName(basename: string): boolean {
  return /guaranteed|_slot\d+_guaranteed/i.test(path.basename(basename || ""));
}

/**
 * What kind of picture an adopt entry represents.
 *
 * Reads the route label the pipeline recorded, then the filename as a second opinion for the
 * guaranteed ladder — whose two placeholder rungs write a recognisable name and whose two real
 * rungs (`topical`, `wikimedia`) do not.
 */
export function coverageOfAdoptEntry(entry: {
  source: string;
  basename: string;
}): BeatCoverage {
  const mapped = COVERAGE_BY_SOURCE.get(entry.source.trim().toLowerCase());
  if (mapped) return mapped;
  if (isGuaranteedClipName(entry.basename)) return "placeholder";
  return "own_footage";
}

function verificationOf(decision: {
  reprieved: boolean;
  verdict: string;
}): BeatVerification {
  if (decision.reprieved) return "reprieved_after_refusal";
  if (decision.verdict === "fits") return "verified_fit";
  if (decision.verdict === "does_not_fit") return "verified_mismatch";
  // `unknown` covers both "the model could not answer" and "the gate declined to ask". The
  // ledger does not distinguish them per clip; the render-level counters do, and the report
  // prints both. Per beat, the honest word for "no verdict" is unknown.
  return "unknown";
}

/**
 * Read the relevance ledger for the picture this beat ACTUALLY ended up with.
 *
 * ── RONDE 166: what this used to do, and why the number it produced was wrong ────────────────
 *
 * The lookup was by beat alone — the first ledger entry whose context named this scene and beat.
 * That was written when a beat was judged once, and stopped being true the moment the funnel
 * started judging several candidates per beat: render 554's s2b3 alone judged four. The ledger
 * therefore holds the LOSERS of a beat as well as its winner, in insertion order, and "the first
 * entry for this beat" is usually a loser.
 *
 * So `verified_mismatch=6` did not mean six beats shipped a refused picture. It meant six beats
 * whose first recorded candidate was refused — which is compatible with all six of them having
 * adopted a perfectly good picture two candidates later. The type's own documentation says
 * verified_mismatch is a picture that "was not used anyway", and the lookup could not tell.
 *
 * The adopt audit knows which file won: `entry.basename`. Matching on it reads the verdict of the
 * clip that is on screen. The beat-wide scan is kept as a FALLBACK, for a beat whose adopted file
 * was never judged under the name the audit recorded — there the honest answer is still "something
 * on this beat was judged", and losing that would trade a wrong number for a missing one.
 */
function verificationForBeat(
  ledger: BeatRelevanceLedger | undefined,
  sceneIndex: number,
  beatIndex: number,
  adoptedBasename: string
): BeatVerification {
  if (!ledger) return "never_asked";
  let onThisBeat: BeatVerification | null = null;
  for (const [clipPath, { ctx, decision }] of ledger.byClipPath.entries()) {
    if (ctx.sceneIndex !== sceneIndex || ctx.beatIndex !== beatIndex) continue;
    // The clip that is actually on screen settles it, wherever it sits in the map.
    if (adoptedBasename && path.basename(clipPath) === adoptedBasename) {
      return verificationOf(decision);
    }
    onThisBeat ??= verificationOf(decision);
  }
  return onThisBeat ?? "never_asked";
}

/**
 * RONDE 166 §9 — why a beat's picture was never judged.
 *
 * Video 554 reported `never_asked=2` and nothing said which two or why. The reason is not guessed
 * at here: it is read off the two records that exist. A beat covered by a placeholder or a held
 * frame has nothing to judge and the gate is right not to have been asked; a beat holding real
 * footage that nobody looked at is a gap in the instrumentation, and those are different findings
 * that must not share a word.
 */
export function neverAskedReason(coverage: BeatCoverage): string {
  switch (coverage) {
    case "placeholder":
      return "no_picture_to_judge:placeholder";
    case "held_frame":
      return "no_picture_to_judge:held_frame";
    case "graphic":
      return "no_picture_to_judge:graphic";
    case "none":
      return "no_clip_recorded";
    case "generated":
      return "generated_clip_not_routed_through_gate";
    case "own_footage":
    case "subject_only":
      // Real footage with no verdict. Nothing about the coverage explains it, so nothing is
      // invented — this names the gap rather than papering over it.
      return "real_footage_never_judged";
  }
}

/**
 * The status of every beat this render filled, from the two records that already exist.
 *
 * Later entries for the same beat win, matching the assumption clipAdoptAudit already makes: a
 * recovery layer that re-adopts a beat is describing that beat's more current state.
 */
export function buildBeatVisualStatuses(
  adoptAudit: readonly ClipAdoptEntry[] | undefined,
  ledger: BeatRelevanceLedger | undefined
): BeatVisualStatus[] {
  const byBeat = new Map<string, ClipAdoptEntry>();
  for (const e of adoptAudit ?? []) {
    byBeat.set(`${e.sceneIndex}:${e.beatIndex}`, e);
  }
  const out: BeatVisualStatus[] = [];
  for (const entry of byBeat.values()) {
    const coverage = coverageOfAdoptEntry(entry);
    const verification = verificationForBeat(
      ledger, entry.sceneIndex, entry.beatIndex, entry.basename
    );
    const verifiedOwnVisual = coverage === "own_footage" && verification === "verified_fit";
    out.push({
      sceneIndex: entry.sceneIndex,
      beatIndex: entry.beatIndex,
      coverage,
      verification,
      source: entry.source,
      basename: entry.basename,
      verifiedOwnVisual,
      reason: verifiedOwnVisual ? "" : coverage !== "own_footage" ? coverage : verification,
    });
  }
  return out.sort((a, b) => a.sceneIndex - b.sceneIndex || a.beatIndex - b.beatIndex);
}

export type BeatVisualTally = {
  beats: number;
  verifiedOwnVisual: number;
  /** Beats whose picture is real footage, whatever the verdict was. */
  ownFootage: number;
  byCoverage: Record<BeatCoverage, number>;
  byVerification: Record<BeatVerification, number>;
};

export function tallyBeatVisualStatuses(statuses: readonly BeatVisualStatus[]): BeatVisualTally {
  const byCoverage: Record<BeatCoverage, number> = {
    own_footage: 0, subject_only: 0, held_frame: 0, graphic: 0, placeholder: 0, generated: 0,
    none: 0,
  };
  const byVerification: Record<BeatVerification, number> = {
    verified_fit: 0, verified_mismatch: 0, reprieved_after_refusal: 0, unknown: 0, never_asked: 0,
  };
  let verifiedOwnVisual = 0;
  for (const s of statuses) {
    byCoverage[s.coverage]++;
    byVerification[s.verification]++;
    if (s.verifiedOwnVisual) verifiedOwnVisual++;
  }
  return {
    beats: statuses.length,
    verifiedOwnVisual,
    ownFootage: byCoverage.own_footage,
    byCoverage,
    byVerification,
  };
}

/** One line per beat that is not finished, for the render log. */
/**
 * RONDE 166 §8/§9 — why every beat's picture is on screen, in one block.
 *
 * Built from the statuses this module already derives plus the severity of each refusal, so it
 * reports on the existing records rather than keeping its own. Two rules make it worth reading:
 *
 *   · A HARD_MISMATCH or TOTALLY_UNRELATED may never appear as adopted or reprieved. If one does,
 *     the reprieve guard has been bypassed and this is where that becomes visible.
 *   · A `never_asked` beat gets a named reason, never a blank. "Nothing to judge" and "real
 *     footage nobody looked at" are different findings and used to share one word.
 */
export function formatVisualFitAudit(
  statuses: readonly BeatVisualStatus[],
  severityOf: (sceneIndex: number, beatIndex: number, basename: string) => string
): string[] {
  if (statuses.length === 0) return [];
  const counts = {
    verifiedFit: 0,
    softMismatch: 0,
    hardMismatch: 0,
    totallyUnrelated: 0,
    unknown: 0,
    neverAsked: 0,
    adoptedFit: 0,
    reprievedSoftMismatch: 0,
    rejectedHardMismatch: 0,
    rejectedUnrelated: 0,
  };
  const lines: string[] = [];
  for (const s of statuses) {
    if (s.verification === "verified_fit") {
      counts.verifiedFit++;
      counts.adoptedFit++;
      continue;
    }
    if (s.verification === "unknown") {
      counts.unknown++;
      continue;
    }
    if (s.verification === "never_asked") {
      counts.neverAsked++;
      lines.push(
        `[VisualFitAudit] beat=s${s.sceneIndex}b${s.beatIndex} status=NEVER_ASKED ` +
          `reason=${neverAskedReason(s.coverage)} source=${s.source}`
      );
      continue;
    }
    // Refused. What happened next is the difference between a reprieve and a rejection.
    const severity = severityOf(s.sceneIndex, s.beatIndex, s.basename);
    if (severity === "HARD_MISMATCH") counts.hardMismatch++;
    else if (severity === "TOTALLY_UNRELATED") counts.totallyUnrelated++;
    else counts.softMismatch++;
    if (s.verification === "reprieved_after_refusal") {
      if (severity === "HARD_MISMATCH" || severity === "TOTALLY_UNRELATED") {
        // The invariant the round exists for. Counted as reprieved so the totals still add up,
        // and shouted about so it cannot pass as an ordinary fallback.
        lines.push(
          `[VisualFitAudit] INVARIANT_BROKEN beat=s${s.sceneIndex}b${s.beatIndex} ` +
            `severity=${severity} was reprieved — a hard mismatch may never be taken back`
        );
      }
      counts.reprievedSoftMismatch++;
    } else if (severity === "TOTALLY_UNRELATED") counts.rejectedUnrelated++;
    else if (severity === "HARD_MISMATCH") counts.rejectedHardMismatch++;
  }
  lines.unshift(
    `[VisualFitAudit] TOTAL beats=${statuses.length} verifiedFit=${counts.verifiedFit} ` +
      `softMismatch=${counts.softMismatch} hardMismatch=${counts.hardMismatch} ` +
      `totallyUnrelated=${counts.totallyUnrelated} unknown=${counts.unknown} ` +
      `neverAsked=${counts.neverAsked} adoptedFit=${counts.adoptedFit} ` +
      `reprievedSoftMismatch=${counts.reprievedSoftMismatch} ` +
      `rejectedHardMismatch=${counts.rejectedHardMismatch} ` +
      `rejectedUnrelated=${counts.rejectedUnrelated}`
  );
  return lines;
}

export function formatBeatVisualProblems(statuses: readonly BeatVisualStatus[]): string[] {
  return statuses
    .filter((s) => !s.verifiedOwnVisual)
    .map(
      (s) =>
        `[BeatVisual] scene=${s.sceneIndex} beat=${s.beatIndex} ` +
        `visual_status=no_verified_visual coverage=${s.coverage} ` +
        `verification=${s.verification} reason=${s.reason} source=${s.source}`
    );
}
