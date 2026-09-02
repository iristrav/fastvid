/**
 * RONDE 70 — one line per beat, for every beat, saying where its picture went.
 *
 * [VisualCoverage] already existed, but it fires inside the block that runs when a beat is about
 * to receive a placeholder. So the render explained only its failures. A beat that got a clip
 * said nothing at all, which makes the central question of render 535 — "there were 398
 * candidates, where did they go?" — unanswerable from the log: the successes are invisible and
 * the failures are the only data.
 *
 * This is the render-scoped record that fills that gap. It is written at points the pipeline
 * already reaches, from values it already has:
 *
 *     offered     paths handed to the adopt path (files already on disk)
 *     rejected    from the reject tally, which RONDE 70 made uncappable
 *     eligible    passed every gate — the acceptance point in adoptClip
 *     adopted     actually became this beat's clip
 *     vision      judged / unavailable, attributed to the beat that asked
 *
 * `eligible` and `adopted` are separate counters on purpose. A clip can pass every gate and
 * still not reach the timeline: the file fails validation, the fair-use transform does not
 * produce a transformed file, the beat was already filled. That gap is category D
 * ("goedgekeurd maar niet geadopteerd") and nothing in the pipeline measured it.
 *
 * No provider is called from here, nothing is ranked, nothing is judged. This module counts.
 */

import type { ClipRejectAudit } from "./clipRejectAudit";
import { beatRejectCount, beatRejectReasons, formatClipRejectAuditCapacity } from "./clipRejectAudit";

export type BeatFinalStatus =
  | "adopted"
  | "placeholder"
  /** Never offered a single candidate. */
  | "no_candidates"
  /** Candidates were offered and every one was refused by a gate. */
  | "rejected"
  /** A candidate passed every gate and still did not become the clip. */
  | "eligible_not_adopted"
  /** The render ended without this beat reaching any terminal point. */
  | "unknown";

/**
 * FINAL VALIDATION §20 — the rung of the guaranteed ladder that actually filled the beat.
 *
 * Structurally the same four values as `GuaranteedClipTier` in videoPipeline.ts, declared here
 * rather than imported because videoPipeline imports THIS module and the cycle would be real.
 * The first two are real media; the last two are cards this pipeline drew itself.
 */
export type BeatFillTier = "topical" | "wikimedia" | "text_overlay" | "color_fallback";

export type BeatFunnelRecord = {
  sceneIndex: number;
  beatIndex: number;
  /** Candidate paths handed to the adopt path for this beat, across every attempt. */
  offered: number;
  eligible: number;
  adopted: number;
  visionJudged: number;
  visionUnavailable: number;
  /** Provider/source of the adopted clip, from the adopt audit. */
  origin: string;
  /** Basename of the adopted clip, or "none". */
  selected: string;
  /** Set when the beat actually ended on a generated placeholder. */
  placeholder: boolean;
  /** §20 — which rung of the guaranteed ladder produced the picture, when one did. */
  fillTier?: BeatFillTier;
  /**
   * THE VISION BREAKDOWN — what the beat image gate actually said about this beat's candidates.
   *
   * `visionJudged` above counts SPEND (how many calls this beat cost). These count VERDICTS, and
   * the two answer different questions: a render can spend ten calls on a beat and refuse all ten,
   * or spend two and accept both. Only the second number says whether the catalogue had anything.
   *
   * Kept strictly disjoint. One candidate contributes to exactly one of the three — a picture the
   * gate accepted is not also a picture it was unsure about — so they sum to the number of
   * candidates the gate returned a verdict for, and never to more.
   */
  visionAccepted: number;
  visionRejected: number;
  visionUnclear: number;
  /**
   * Candidates the gate DID NOT LOOK AT: the per-beat look ceiling, a placeholder with nothing to
   * judge, the gate switched off. Separate from `visionUnavailable`, which means vision should
   * have been able to answer and could not (an outage, an unreadable frame) — and separate again
   * from `visionUnclear`, which means it looked and could not decide. Three different facts.
   */
  visionNeverAsked: number;
};

export type BeatOutcomeAudit = {
  beats: Map<string, BeatFunnelRecord>;
};

export function beatOutcomeKey(sceneIndex: number, beatIndex: number): string {
  return `s${sceneIndex}b${beatIndex}`;
}

export function createBeatOutcomeAudit(): BeatOutcomeAudit {
  return { beats: new Map() };
}

/** The record for one beat, created on first mention. Every note below goes through this. */
export function beatRecord(
  audit: BeatOutcomeAudit,
  sceneIndex: number,
  beatIndex: number
): BeatFunnelRecord {
  const key = beatOutcomeKey(sceneIndex, beatIndex);
  let rec = audit.beats.get(key);
  if (!rec) {
    rec = {
      sceneIndex,
      beatIndex,
      offered: 0,
      eligible: 0,
      adopted: 0,
      visionJudged: 0,
      visionUnavailable: 0,
      origin: "",
      selected: "none",
      placeholder: false,
      visionAccepted: 0,
      visionRejected: 0,
      visionUnclear: 0,
      visionNeverAsked: 0,
    };
    audit.beats.set(key, rec);
  }
  return rec;
}

export function noteBeatCandidatesOffered(
  audit: BeatOutcomeAudit | undefined,
  sceneIndex: number,
  beatIndex: number,
  count: number
): void {
  if (!audit || count <= 0) return;
  beatRecord(audit, sceneIndex, beatIndex).offered += count;
}

/** A candidate passed every gate. It may still fail to become the clip — that is the point. */
export function noteBeatEligible(
  audit: BeatOutcomeAudit | undefined,
  sceneIndex: number,
  beatIndex: number
): void {
  if (!audit) return;
  beatRecord(audit, sceneIndex, beatIndex).eligible++;
}

export function noteBeatAdopted(
  audit: BeatOutcomeAudit | undefined,
  sceneIndex: number,
  beatIndex: number,
  origin: string,
  basename: string
): void {
  if (!audit) return;
  const rec = beatRecord(audit, sceneIndex, beatIndex);
  rec.adopted++;
  rec.origin = origin || rec.origin;
  rec.selected = basename || rec.selected;
}

export function noteBeatPlaceholder(
  audit: BeatOutcomeAudit | undefined,
  sceneIndex: number,
  beatIndex: number
): void {
  if (!audit) return;
  beatRecord(audit, sceneIndex, beatIndex).placeholder = true;
}

/**
 * §20 — which rung of the guaranteed ladder ended up filling this beat.
 *
 * Recorded separately from `placeholder` because the two answer different questions. `placeholder`
 * says "every real strategy was exhausted"; the tier says WHAT the viewer then sees, and those are
 * not the same outcome: the ladder's first two rungs return real footage. A render that reported
 * `placeholder=7` was telling the truth about the search and nothing at all about the picture.
 */
export function noteBeatFillTier(
  audit: BeatOutcomeAudit | undefined,
  sceneIndex: number,
  beatIndex: number,
  tier: BeatFillTier | undefined
): void {
  if (!audit || !tier) return;
  beatRecord(audit, sceneIndex, beatIndex).fillTier = tier;
}

/**
 * One VERDICT from the beat image gate, attributed to the beat it was asked about.
 *
 * Distinct from `noteBeatVision`, which counts the CALL. A cached verdict costs no call and is
 * still a verdict; a call that times out costs a call and yields no verdict. Counting them in one
 * number is how "the gate was asked 29 times" came to be read as "29 pictures were judged".
 */
export function noteBeatVisionVerdict(
  audit: BeatOutcomeAudit | undefined,
  sceneIndex: number,
  beatIndex: number,
  outcome: "accepted" | "rejected" | "unclear" | "never_asked"
): void {
  if (!audit) return;
  const rec = beatRecord(audit, sceneIndex, beatIndex);
  if (outcome === "accepted") rec.visionAccepted++;
  else if (outcome === "rejected") rec.visionRejected++;
  else if (outcome === "unclear") rec.visionUnclear++;
  else rec.visionNeverAsked++;
}

export function noteBeatVision(
  audit: BeatOutcomeAudit | undefined,
  sceneIndex: number,
  beatIndex: number,
  outcome: "judged" | "unavailable"
): void {
  if (!audit) return;
  const rec = beatRecord(audit, sceneIndex, beatIndex);
  if (outcome === "judged") rec.visionJudged++;
  else rec.visionUnavailable++;
}

/**
 * Exactly one status per beat, decided in a fixed order so a beat can never carry two.
 *
 * `adopted` wins over everything: a beat that got its clip is adopted no matter how many
 * candidates it refused on the way, and no adopted beat may also read as category D. Only after
 * that do the failure shapes get to explain themselves.
 */
export function resolveBeatStatus(rec: BeatFunnelRecord, rejected: number): BeatFinalStatus {
  if (rec.adopted > 0) return "adopted";
  if (rec.placeholder) return "placeholder";
  if (rec.eligible > 0) return "eligible_not_adopted";
  if (rejected > 0) return "rejected";
  if (rec.offered === 0) return "no_candidates";
  return "unknown";
}

/**
 * FINAL VALIDATION §20 — what the VIEWER got, as distinct from what the SEARCH did.
 *
 * ── The 2-out-of-29 problem ─────────────────────────────────────────────────────────────────
 *
 * The first real production render reported `beats=29 adopted=2 placeholder=7 rejected=5
 * noCandidates=15`. Read as coverage that says two beats out of twenty-nine have a picture, which
 * would be a broken video. It is not what happened: `adopted` counts one specific event —
 * `noteBeatAdopted`, called from ONE place in the adopt path — while the rescue ladder, the
 * subject fallback and the extend-last-clip route all put real footage on screen without ever
 * passing through it. The statuses above describe the RETRIEVAL FUNNEL accurately and were never
 * a coverage measure; reading them as one is what made a finished video look empty.
 *
 * So this is a second, separate question asked of the same record: for this beat, what is on the
 * screen?
 *
 *   REAL_ASSET        real footage — adopted, or a real rung of the guaranteed ladder
 *   INTENTIONAL_TEXT  a card carrying the beat's own narration: chosen, readable, not a failure
 *   FALLBACK          a drawn colour card — something is there, but nothing chose it
 *   NO_VALID_ASSET    the beat reached no picture at all
 *
 * ── The category that is deliberately absent ────────────────────────────────────────────────
 *
 * There is no INTENTIONAL_GRAPHIC. A graphic in this pipeline is an alpha overlay composited ON
 * TOP of a beat that already has a picture — never the beat's whole picture — and
 * `buildCinematicSceneInputs` drops a beat with no adopted clip from the plan outright
 * ("a beat with no adopted clip is simply absent from the plan"). Adding the name here would
 * create a category nothing can ever be counted into, which is precisely the R160 failure this
 * round exists to undo. When a graphic-only beat becomes a real editorial outcome, it earns the
 * category then.
 */
export type BeatCoverageCategory =
  | "REAL_ASSET"
  | "INTENTIONAL_TEXT"
  | "FALLBACK"
  | "NO_VALID_ASSET";

/**
 * Exactly one category per beat, in a fixed order, from the most specific evidence down.
 *
 * The fill tier is checked before `adopted` because it is the narrower fact: it names the rung
 * that produced the file the viewer sees, while `adopted` only says the adopt path ran.
 */
export function resolveBeatCoverage(rec: BeatFunnelRecord): BeatCoverageCategory {
  if (rec.fillTier === "topical" || rec.fillTier === "wikimedia") return "REAL_ASSET";
  if (rec.fillTier === "text_overlay") return "INTENTIONAL_TEXT";
  if (rec.fillTier === "color_fallback") return "FALLBACK";
  if (rec.adopted > 0) return "REAL_ASSET";
  /** The placeholder block ran but no tier was recorded — a card of unknown kind is still a card. */
  if (rec.placeholder) return "FALLBACK";
  return "NO_VALID_ASSET";
}

/** Render-wide roll-up of the coverage categories. */
export function summarizeBeatCoverage(
  rows: Array<{ record: BeatFunnelRecord }>
): Record<BeatCoverageCategory, number> {
  const out: Record<BeatCoverageCategory, number> = {
    REAL_ASSET: 0,
    INTENTIONAL_TEXT: 0,
    FALLBACK: 0,
    NO_VALID_ASSET: 0,
  };
  for (const r of rows) out[resolveBeatCoverage(r.record)]++;
  return out;
}

/**
 * THE BEAT LEDGER — one line per beat, in the funnel's own vocabulary.
 *
 * ── What is here, and what is deliberately NOT ──────────────────────────────────────────────
 *
 * Every field below is a counter something in the pipeline really increments. The brief also asks
 * for `found`, `ranked`, `timeline` and `rendered`, and those are NOT here — not as zeroes, not as
 * estimates. Nothing per beat feeds them today:
 *
 *   found      the candidate pool is built per SCENE, not per beat; there is no per-beat "found".
 *   ranked     ranking happens inside poolRanking over the scene's pool, before a beat is chosen.
 *   timeline   the EDL is built after the render loop, from adopted clips, with no beat counter.
 *   rendered   the render manifest names files, not beats.
 *
 * Printing them as `found=0` would recreate the exact defect this whole line exists to end: a
 * counter nobody feeds, read as a measurement. When a stage is instrumented it earns its field.
 *
 * ── The invariant ───────────────────────────────────────────────────────────────────────────
 *
 * `adopted <= eligible <= offered` where the funnel fed all three. It is asserted in the tests
 * rather than enforced here: a counter that silently clamps itself cannot report a wiring bug, and
 * a wiring bug is precisely what this line is for.
 */
export function formatBeatLedgerLine(rec: BeatFunnelRecord): string {
  const evaluated = rec.visionAccepted + rec.visionRejected + rec.visionUnclear;
  return (
    `[BeatLedger] beat=s${rec.sceneIndex}b${rec.beatIndex} ` +
    `offered=${rec.offered} vision_evaluated=${evaluated} ` +
    `vision_accepted=${rec.visionAccepted} vision_rejected=${rec.visionRejected} ` +
    `vision_unclear=${rec.visionUnclear} vision_never_asked=${rec.visionNeverAsked} ` +
    `vision_unavailable=${rec.visionUnavailable} vision_calls=${rec.visionJudged} ` +
    `eligible=${rec.eligible} adopted=${rec.adopted} ` +
    `coverage=${resolveBeatCoverage(rec)} origin=${rec.origin || "none"}`
  );
}

/** The per-beat line. One per beat, adopted or not. */
export function formatBeatFunnelLine(
  rec: BeatFunnelRecord,
  status: BeatFinalStatus,
  rejected: number,
  topRejects: string
): string {
  return (
    `[VisualCoverageFinal] scene=${rec.sceneIndex} beat=${rec.beatIndex} status=${status} ` +
    /** §20 — the funnel's verdict and the viewer's, side by side, never conflated. */
    `coverage=${resolveBeatCoverage(rec)} fillTier=${rec.fillTier ?? "none"} ` +
    `origin=${rec.origin || "none"} offered=${rec.offered} rejected=${rejected} ` +
    `eligible=${rec.eligible} adopted=${rec.adopted} ` +
    `visionJudged=${rec.visionJudged} visionUnavailable=${rec.visionUnavailable} ` +
    /** The verdicts, which `visionJudged` (a spend count) cannot express. */
    `visionAccepted=${rec.visionAccepted} visionRejected=${rec.visionRejected} ` +
    `visionUnclear=${rec.visionUnclear} visionNeverAsked=${rec.visionNeverAsked} ` +
    `topRejects=${topRejects || "none"} selected=${rec.selected}`
  );
}

/**
 * The beats to report on: every beat the render PLANNED, plus every beat anything was actually
 * observed for. The union matters — the planned list comes from the scene results, and the
 * fast-path and rescue routes fill a scene without recording a beat list, so a beat that was
 * worked on can be absent from it. A beat the audit saw but the plan does not name would
 * otherwise vanish from the report entirely, which is the failure this whole round is about.
 */
export function collectReportableBeats(
  audit: BeatOutcomeAudit,
  plannedBeats: Array<{ sceneIndex: number; beatIndex: number }>,
  observedKeys: Iterable<string>
): Array<{ sceneIndex: number; beatIndex: number }> {
  const seen = new Map<string, { sceneIndex: number; beatIndex: number }>();
  const add = (sceneIndex: number, beatIndex: number) => {
    seen.set(beatOutcomeKey(sceneIndex, beatIndex), { sceneIndex, beatIndex });
  };
  for (const b of plannedBeats) add(b.sceneIndex, b.beatIndex);
  for (const rec of audit.beats.values()) add(rec.sceneIndex, rec.beatIndex);
  for (const key of observedKeys) {
    const m = /^s(-?\d+)b(-?\d+)$/.exec(key);
    if (m) add(Number(m[1]), Number(m[2]));
  }
  return [...seen.values()].sort(
    (a, b) => a.sceneIndex - b.sceneIndex || a.beatIndex - b.beatIndex
  );
}

/**
 * Every beat the render planned, in order, each with exactly one status — including beats that
 * never reached the audit at all, which appear as `unknown` rather than silently missing.
 *
 * `allBeats` is the authoritative list, so the report cannot be shorter than the render.
 */
export function finalizeBeatOutcomes(
  audit: BeatOutcomeAudit,
  allBeats: Array<{ sceneIndex: number; beatIndex: number }>,
  rejectedFor: (sceneIndex: number, beatIndex: number) => number
): Array<{ record: BeatFunnelRecord; status: BeatFinalStatus; rejected: number }> {
  return allBeats.map(({ sceneIndex, beatIndex }) => {
    const record = beatRecord(audit, sceneIndex, beatIndex);
    const rejected = rejectedFor(sceneIndex, beatIndex);
    return { record, status: resolveBeatStatus(record, rejected), rejected };
  });
}

/** Render-wide roll-up of the per-beat statuses, for the one summary line. */
export function summarizeBeatOutcomes(
  rows: Array<{ status: BeatFinalStatus }>
): Record<BeatFinalStatus, number> {
  const out: Record<BeatFinalStatus, number> = {
    adopted: 0,
    placeholder: 0,
    no_candidates: 0,
    rejected: 0,
    eligible_not_adopted: 0,
    unknown: 0,
  };
  for (const r of rows) out[r.status]++;
  return out;
}

/**
 * The whole per-beat report as a list of lines: one per beat, then the roll-up, then how much
 * reject detail survived.
 *
 * This is a function rather than a loop inlined in the pipeline for one reason: a loop in a
 * 31k-line file can only be tested by reading the source, and a source assertion cannot tell
 * `for (const r of rows)` from `for (const r of rows.slice(1))`. That is exactly how RONDE 62's
 * download ceiling passed its tests for two renders while bounding nothing. Returning the lines
 * makes "one line per beat" a thing a test can actually count.
 */
export function renderBeatFunnelReport(
  audit: BeatOutcomeAudit,
  plannedBeats: Array<{ sceneIndex: number; beatIndex: number }>,
  rejects: ClipRejectAudit
): string[] {
  const rows = finalizeBeatOutcomes(
    audit,
    collectReportableBeats(audit, plannedBeats, rejects.perBeat.keys()),
    (sceneIndex, beatIndex) => beatRejectCount(rejects, sceneIndex, beatIndex)
  );
  const lines = rows.map(({ record, status, rejected }) => {
    const topRejects =
      beatRejectReasons(rejects, record.sceneIndex, record.beatIndex)
        .slice(0, 3)
        .map(([reason, count]) => `${reason}:${count}`)
        .join(",") || "none";
    return formatBeatFunnelLine(record, status, rejected, topRejects);
  });
  const t = summarizeBeatOutcomes(rows);
  lines.push(
    `[VisualCoverageFinal] TOTAL beats=${rows.length} adopted=${t.adopted} ` +
      `placeholder=${t.placeholder} eligibleNotAdopted=${t.eligible_not_adopted} ` +
      `rejected=${t.rejected} noCandidates=${t.no_candidates} unknown=${t.unknown}`
  );
  /**
   * §20 — the coverage roll-up, on its own line, in the viewer's terms.
   *
   * Deliberately a SECOND line rather than more fields on the first: the two totals answer
   * different questions and will not agree, and a reader who sees them merged will read the funnel
   * numbers as coverage, which is the whole mistake being corrected here.
   */
  const c = summarizeBeatCoverage(rows.map((r) => ({ record: r.record })));
  lines.push(
    `[VisualCoverageFinal] COVERAGE beats=${rows.length} REAL_ASSET=${c.REAL_ASSET} ` +
      `INTENTIONAL_TEXT=${c.INTENTIONAL_TEXT} FALLBACK=${c.FALLBACK} ` +
      `NO_VALID_ASSET=${c.NO_VALID_ASSET}`
  );
  /**
   * The ledger, one line per beat, after the funnel lines above.
   *
   * A second line per beat rather than more fields on the first: the first answers "where did this
   * beat's picture come from", the ledger answers "what happened to its candidates". Merging them
   * produced a line nobody could read, which is how the funnel numbers went unnoticed for so long.
   */
  for (const { record } of rows) lines.push(formatBeatLedgerLine(record));
  // Whether the named examples elsewhere in the log are the whole story or a sample. The
  // per-beat counts above are never capped, so only the DETAIL can be short.
  lines.push(`[VisualCoverageFinal] rejectAudit ${formatClipRejectAuditCapacity(rejects)}`);
  return lines;
}

/** Category D at provider level: passed every gate, never became a clip. */
export function formatEligibleNotAdoptedByProvider(
  metrics: Iterable<[string, { eligibleCount: number; adoptedCount: number }]>
): string | null {
  const rows: string[] = [];
  for (const [provider, m] of metrics) {
    if (m.eligibleCount === 0 && m.adoptedCount === 0) continue;
    rows.push(
      `${provider}: eligible=${m.eligibleCount} adopted=${m.adoptedCount} ` +
        `eligibleNotAdopted=${m.eligibleCount - m.adoptedCount}`
    );
  }
  if (rows.length === 0) return null;
  return `[VisualCoverageFinal] eligibleNotAdopted by provider — ${rows.join(" | ")}`;
}
