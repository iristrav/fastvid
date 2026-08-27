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

/**
 * Read the relevance ledger for one beat.
 *
 * The ledger is keyed by clip path and by content identity, and this report has neither — it has
 * a basename and a beat. So the lookup is by beat: the entry whose recorded context names this
 * scene and beat. That is exact, because RONDE 103 records the context alongside every decision.
 */
function verificationForBeat(
  ledger: BeatRelevanceLedger | undefined,
  sceneIndex: number,
  beatIndex: number
): BeatVerification {
  if (!ledger) return "never_asked";
  for (const { ctx, decision } of ledger.byClipPath.values()) {
    if (ctx.sceneIndex !== sceneIndex || ctx.beatIndex !== beatIndex) continue;
    if (decision.reprieved) return "reprieved_after_refusal";
    if (decision.verdict === "fits") return "verified_fit";
    if (decision.verdict === "does_not_fit") return "verified_mismatch";
    // `unknown` covers both "the model could not answer" and "the gate declined to ask". The
    // ledger does not distinguish them per clip; the render-level counters do, and the report
    // prints both. Per beat, the honest word for "no verdict" is unknown.
    return "unknown";
  }
  return "never_asked";
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
    const verification = verificationForBeat(ledger, entry.sceneIndex, entry.beatIndex);
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
