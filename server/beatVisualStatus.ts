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
import { coverageForAdoptSource } from "./adoptionPolicy";
import * as path from "path";

import type { ClipAdoptEntry } from "./clipAdoptAudit";
import { representativeAdoptEntryPerBeat } from "./clipAdoptAudit";
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

/**
 * RONDE 91 — the source→coverage table that used to live here is gone.
 *
 * It held twelve entries and everything else fell through to `own_footage`. `adoptionPolicy` now
 * declares every adopt label the pipeline can produce and `coverageForAdoptSource` derives the
 * coverage from `countsAsRealFootage`, so there is one table instead of two that could disagree —
 * and no permissive default for a label nobody declared. See `coverageOfAdoptEntry`.
 */

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
  /**
   * RONDE 91 — the declared adoption policy decides this, not a second string table.
   *
   * This function used to consult `COVERAGE_BY_SOURCE` (twelve entries) and return `own_footage`
   * for everything else. `adoptRouteForSource` had the same shape with `primary`, and RONDE 90
   * found a third. In all three the UNKNOWN case was the flattering one.
   *
   * That mattered here more than anywhere else: `verifiedOwnVisual` is `own_footage` AND
   * `verified_fit`, it feeds `beatVisuals.verifiedOwnVisual`, and RONDE 89's
   * `NO_VERIFIED_OWN_VISUAL` export condition reads that number. A route nobody had declared could
   * land on `own_footage`, be judged a fit, become a beat's verified visual, and help a render past
   * the delivery gate — which is the exact shape of the failure this whole line of work exists to
   * stop.
   *
   * `coverageForAdoptSource` derives the answer from `countsAsRealFootage`, so a route that may not
   * claim real footage cannot be `own_footage`, and an undeclared route lands on `none`.
   */
  const coverage = coverageForAdoptSource(entry.source);
  /**
   * The filename stays a second opinion for one case only, and it is still needed: the guaranteed
   * ladder's placeholder rungs write a recognisable name, and a caller can record them under a
   * generic route label. A card is a card whatever the label said — but this may only ever make
   * the reading MORE conservative, never less, so it cannot resurrect the old default.
   */
  if (coverage === "own_footage" && isGuaranteedClipName(entry.basename)) return "placeholder";
  return coverage;
}

/**
 * Exposed for tests only: `verificationOf` is a pure mapping and the `never_asked` case is the
 * whole point of this round, so it is asserted directly rather than through a ledger fixture.
 */
export const __testVerificationOf = (d: { reprieved: boolean; verdict: string; evaluated?: boolean }) =>
  verificationOf(d);

function verificationOf(decision: {
  reprieved: boolean;
  verdict: string;
  /** Optional so a caller with an older record still type-checks; absent reads as "looked". */
  evaluated?: boolean;
}): BeatVerification {
  if (decision.reprieved) return "reprieved_after_refusal";
  if (decision.verdict === "fits") return "verified_fit";
  if (decision.verdict === "does_not_fit") return "verified_mismatch";
  /**
   * `unknown` used to cover BOTH "the model could not answer" AND "the gate declined to ask".
   *
   * The ledger now distinguishes them per clip — `BeatRelevanceDecision.evaluated` — so the two
   * finally reach their own words. `never_asked` has been in this vocabulary since RONDE 166 with
   * nothing able to produce it; this is what produces it.
   *
   * The difference is not cosmetic. "Looked, unsure" is a fact about the PICTURE, and a beat that
   * ends on it was genuinely examined. "Never looked" is a fact about this RENDER — its budget,
   * its configuration, a placeholder with nothing to judge — and a beat that ends on THAT was
   * never examined at all. Reporting the second as the first is how an unexamined beat came to
   * read as an examined one.
   */
  if (decision.evaluated === false) return "never_asked";
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
 * ── Why the choice of entry is not made here ────────────────────────────────────────────────
 *
 * This used to keep the LAST entry per beat, "matching the assumption clipAdoptAudit already
 * makes". That assumption was disproved and clipAdoptAudit was fixed; this function was not, and
 * it is the one RONDE 89's export gate reads. The next production render said so exactly:
 *
 *     NO_VERIFIED_OWN_VISUAL: 0 of 16 beat(s) got an approved picture of their own
 *     (never_asked=15, own_footage=3)
 *
 * `pushClip` APPENDS, so a beat holding real footage and a colour card records both. Keeping the
 * last entry made fifteen of sixteen beats read as "placeholder — nothing to judge" while their
 * real clips sat one entry earlier in the same audit. A beat cannot earn a verified visual for a
 * picture the bookkeeping discarded, so the gate refused a film that had footage.
 *
 * The rule now lives once, in `representativeAdoptEntryPerBeat`, and both summarisers ask it.
 * Sharing the definition is the point: this is the second time the same seam has cost a render,
 * and a rule two callers must remember is a rule one of them will forget.
 */
export function buildBeatVisualStatuses(
  adoptAudit: readonly ClipAdoptEntry[] | undefined,
  ledger: BeatRelevanceLedger | undefined
): BeatVisualStatus[] {
  const byBeat = representativeAdoptEntryPerBeat(adoptAudit ?? []).entries;
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
      /**
       * RONDE 132 §3 — `never_asked` is never a reason on its own.
       *
       * The word says the gate was not consulted and stops there, which is how "the beat holds a
       * held frame, so there was nothing to judge" and "the beat holds real footage nobody looked
       * at" ended up sharing one label in the render warning. The first is the pipeline working;
       * the second is a hole in the instrumentation.
       *
       * `neverAskedReason` was written for exactly this in RONDE 166 §9 and had no caller — the
       * warning built its own reason string and used the bare verification. It is the caller now.
       */
      reason: verifiedOwnVisual
        ? ""
        : verification === "never_asked"
          ? neverAskedReason(coverage)
          : coverage !== "own_footage"
            ? coverage
            : verification,
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
  severityOf: (sceneIndex: number, beatIndex: number, basename: string) => string,
  /**
   * RENDER 564 — WHAT IS ACTUALLY IN THE DELIVERED FILE.
   *
   * The invariant below says a refused clip "is on screen". It was built from the ADOPT audit,
   * which records what a beat was given — not what survived. Render 564 printed seven of these,
   * and six were about clips the compose barrier had turned away:
   *
   *     [ComposeBarrier] s0 clip 6: BLOCKED scene_0_b5_curated_a57670.mp4 — refused on s0b2005
   *     [VisualFitAudit] INVARIANT_BROKEN beat=s0b2005 … the compose barrier was bypassed
   *
   * The loudest line in the report, printed at error level, crying wolf on exactly the case where
   * the guard did its job — and sending the investigation after a bypass that never happened.
   * That is the failure RONDE 142 and 159 both describe: a check that contradicts the code is how
   * a real finding gets ignored.
   *
   * Basenames of the clips the concat actually took, from the FINAL_VIDEO events rather than from
   * `record.currentFilename`: one lineage record can be re-pointed across several copies of an
   * asset, so the record's filename is not evidence of which copy was delivered, while the event
   * carries the path `markFinalVideo` was handed.
   *
   * Absent means delivery is unknown — the audit then reports the refusal without claiming it
   * reached the screen, because it cannot know that.
   */
  deliveredBasenames?: ReadonlySet<string>
): string[] {
  if (statuses.length === 0) return [];
  const counts = {
    verifiedFit: 0,
    softMismatch: 0,
    /** Refusals `classifyMismatch` could not place. The guard has no opinion on these. */
    unclassifiedMismatch: 0,
    hardMismatch: 0,
    totallyUnrelated: 0,
    unknown: 0,
    neverAsked: 0,
    adoptedFit: 0,
    reprievedSoftMismatch: 0,
    rejectedHardMismatch: 0,
    rejectedUnrelated: 0,
    /**
     * RENDER 564 — refused, adopted anyway, and then removed before the concat.
     *
     * Counted rather than silent. This is the compose barrier doing its job, and a render where
     * it happens often is telling you the retrieval stage keeps handing beats material the picture
     * editor will not accept — a real signal, and a different one from the invariant above.
     */
    refusedAndRemoved: 0,
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
    const blocking = severity === "HARD_MISMATCH" || severity === "TOTALLY_UNRELATED";
    if (severity === "HARD_MISMATCH") counts.hardMismatch++;
    else if (severity === "TOTALLY_UNRELATED") counts.totallyUnrelated++;
    /**
     * RONDE 167 — an UNCLASSIFIED refusal is not a soft one, and counting it as one flatters the
     * guard exactly where the guard does nothing.
     *
     * `classifyMismatch` reads the gate's prose for phrases its own prompt invites. When the model
     * answers in words none of the patterns know, the kind is UNCLEAR, the severity is UNKNOWN and
     * `reprieveAllowedFor` lets the refusal be taken back — deliberately, because RONDE 160 proved
     * guessing here is worse. So these are precisely the beats where RONDE 166 has no opinion, and
     * reporting them as `softMismatch` would say the opposite. Video 551 had seven of them.
     *
     * Counted on its own so a render can be asked how much of its refusal traffic the severity
     * rule actually reached. A high number here is the signal that the classifier needs work —
     * which is a different round from this one, and it needs this number first.
     */
    else if (severity === "SOFT_MISMATCH") counts.softMismatch++;
    else counts.unclassifiedMismatch++;
    if (s.verification === "reprieved_after_refusal") {
      if (blocking) {
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
    /**
     * RONDE 167 — the OTHER way the invariant can break, which the first check could not see.
     *
     * A beat reading `own_footage` + `verified_mismatch` has a picture the gate refused and NOBODY
     * reprieved. `composeBarrierAllows` is supposed to make that impossible, so it means the clip
     * reached the timeline down a path that never met the barrier. The reprieve check above cannot
     * catch it — there was no reprieve to inspect — and video 554 reported four beats in exactly
     * this state while the audit said nothing.
     */
    if (blocking && s.verification === "verified_mismatch" && s.coverage === "own_footage") {
      /**
       * RENDER 564 — say only what is known.
       *
       * `delivered` decides between two genuinely different findings. A refused clip IN the
       * delivered file is the invariant this check exists for. A refused clip the barrier
       * removed is the guard WORKING, and shouting INVARIANT_BROKEN at it — at error level, six
       * times out of seven — buries the one case that mattered.
       */
      const delivered = deliveredBasenames?.has(s.basename);
      if (delivered === false) {
        counts.refusedAndRemoved++;
      } else if (delivered === true) {
        lines.push(
          `[VisualFitAudit] INVARIANT_BROKEN beat=s${s.sceneIndex}b${s.beatIndex} ` +
            `severity=${severity} is in the delivered file with no reprieve — ` +
            `the compose barrier did not stop it`
        );
      } else {
        /** No delivery record to consult: report the refusal, claim nothing about the screen. */
        lines.push(
          `[VisualFitAudit] REFUSED_AND_ADOPTED beat=s${s.sceneIndex}b${s.beatIndex} ` +
            `severity=${severity} was adopted with no reprieve — delivery not checked`
        );
      }
    }
  }
  lines.unshift(
    `[VisualFitAudit] TOTAL beats=${statuses.length} verifiedFit=${counts.verifiedFit} ` +
      `softMismatch=${counts.softMismatch} ` +
      `unclassifiedMismatch=${counts.unclassifiedMismatch} ` +
      `hardMismatch=${counts.hardMismatch} ` +
      `totallyUnrelated=${counts.totallyUnrelated} unknown=${counts.unknown} ` +
      `neverAsked=${counts.neverAsked} adoptedFit=${counts.adoptedFit} ` +
      `reprievedSoftMismatch=${counts.reprievedSoftMismatch} ` +
      `rejectedHardMismatch=${counts.rejectedHardMismatch} ` +
      `rejectedUnrelated=${counts.rejectedUnrelated} ` +
      `refusedAndRemoved=${counts.refusedAndRemoved}`
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
