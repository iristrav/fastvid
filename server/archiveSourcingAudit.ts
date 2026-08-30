/**
 * FASTVID — where a beat's candidates go, counted at every step (RONDE 164).
 *
 * ── The question this exists to answer ───────────────────────────────────────────────────────
 *
 * "Zijn we kandidaten aan het verliezen vóór VisionGate, of vinden we wel kandidaten maar zijn ze
 * daadwerkelijk onbruikbaar?"
 *
 * Those two need opposite fixes and, until this module, looked identical from the outside. Render
 * 553's beat s1b6 reported `offered=3 visionJudged=0 adopted=0`; RONDE 163 traced that to a
 * per-source cap by reading four different log lines and reasoning across them. The chain is now
 * one line per beat.
 *
 * ── What it is not ───────────────────────────────────────────────────────────────────────────
 *
 * Not a second audit system. `clipRejectAudit` records why individual clips were refused and
 * `visualSourceLineage` records what became of each asset; neither counts the funnel's own stages,
 * which is the gap. Every number here is already computed by the code that fills it in — no query,
 * no fetch, no extra scoring, no state that outlives the beat.
 *
 * ── The stages ───────────────────────────────────────────────────────────────────────────────
 *
 *   candidatesFound      what retrieval returned for the scene
 *   afterBeatDedup       minus candidates an earlier beat already took (RONDE 2)
 *   afterMetadata        minus the funnel's metadata-visibility slice
 *   afterSourceCap       what buildDownloadShortlist let through
 *   downloaded           of those, the ones that actually fetched
 *   visionJudged         of those, the ones VisionGate scored
 *   visionAccepted       of those, the ones it passed
 *   adopted              whether the beat came away with a picture
 *
 * A stage that is absent is absent, never zero: a beat whose funnel never ran has no counts, and
 * printing zeros for it would read as "found nothing", which is a different finding.
 */

/** Ranking scores of the archive candidates taken, and of the next ones the cap refused. */
export type ArchiveCapComparison = {
  /** rankingScore of each archive candidate that made the shortlist, best first. */
  taken: number[];
  /** rankingScore of each archive candidate the per-source cap turned away, best first. */
  cut: number[];
};

export type ArchiveSourcingAudit = {
  candidatesFound: number | null;
  afterBeatDedup: number | null;
  afterMetadata: number | null;
  afterSourceCap: number | null;
  downloadBudget: number | null;
  downloaded: number | null;
  visionJudged: number | null;
  visionAccepted: number | null;
  adopted: number | null;
  cutBySourceCap: number | null;
  cutByBudget: number | null;
  /** Downloaded candidates VisionGate then refused. */
  rejectedAfterDownload: number | null;
  /**
   * RONDE 170 — candidates the per-source cap refused that then filled a slot nobody else wanted.
   *
   * Reported so the change is measurable rather than assumed: a render where this stays 0 has
   * shortlists that already fill the budget, and one where it is high was leaving paid-for
   * download slots empty while the cap turned candidates away.
   */
  backfilledFromCap: number | null;
  archive: ArchiveCapComparison;
};

export function createArchiveSourcingAudit(): ArchiveSourcingAudit {
  return {
    candidatesFound: null,
    afterBeatDedup: null,
    afterMetadata: null,
    afterSourceCap: null,
    downloadBudget: null,
    downloaded: null,
    visionJudged: null,
    visionAccepted: null,
    adopted: null,
    cutBySourceCap: null,
    cutByBudget: null,
    rejectedAfterDownload: null,
    backfilledFromCap: null,
    archive: { taken: [], cut: [] },
  };
}

/** Filled by buildDownloadShortlist, which computes every one of these anyway. */
export function recordShortlistStage(
  audit: ArchiveSourcingAudit | undefined,
  stage: {
    afterMetadata: number;
    afterBeatDedup: number;
    afterSourceCap: number;
    downloadBudget: number;
    cutBySourceCap: number;
    cutByBudget: number;
    backfilledFromCap: number;
    archive: ArchiveCapComparison;
  }
): void {
  if (!audit) return;
  audit.afterMetadata = stage.afterMetadata;
  audit.afterBeatDedup = stage.afterBeatDedup;
  audit.afterSourceCap = stage.afterSourceCap;
  audit.downloadBudget = stage.downloadBudget;
  audit.cutBySourceCap = stage.cutBySourceCap;
  audit.cutByBudget = stage.cutByBudget;
  audit.backfilledFromCap = stage.backfilledFromCap;
  audit.archive = stage.archive;
}

/** Filled by the beat loop once the downloads and VisionGate have run. */
export function recordBeatOutcome(
  audit: ArchiveSourcingAudit | undefined,
  outcome: {
    candidatesFound: number;
    downloaded: number;
    visionJudged: number;
    visionAccepted: number;
    adopted: boolean;
  }
): void {
  if (!audit) return;
  audit.candidatesFound = outcome.candidatesFound;
  audit.downloaded = outcome.downloaded;
  audit.visionJudged = outcome.visionJudged;
  audit.visionAccepted = outcome.visionAccepted;
  audit.adopted = outcome.adopted ? 1 : 0;
  audit.rejectedAfterDownload = Math.max(0, outcome.downloaded - outcome.visionAccepted);
}

/**
 * Which of the two problems this beat had.
 *
 * The brief's central question, answered per beat rather than argued about per render. A beat that
 * lost candidates before VisionGate needs the funnel widened; one whose candidates VisionGate
 * refused needs better candidates, not more of them. Told apart by whether anything was cut on the
 * way in.
 */
export type ArchiveSourcingVerdict =
  /** Nothing was found. The search is the problem. */
  | "NO_CANDIDATES"
  /** Candidates existed and were cut before VisionGate could see them. */
  | "LOST_BEFORE_VISION"
  /** VisionGate saw them and refused them all. The candidates were the problem. */
  | "REJECTED_BY_VISION"
  /** The beat got a picture. */
  | "ADOPTED"
  /** Not enough was recorded to say. Never guessed at. */
  | "NOT_MEASURED";

export function archiveSourcingVerdict(audit: ArchiveSourcingAudit): ArchiveSourcingVerdict {
  if (audit.adopted === 1) return "ADOPTED";
  if (audit.candidatesFound == null || audit.visionJudged == null) return "NOT_MEASURED";
  if (audit.candidatesFound === 0) return "NO_CANDIDATES";
  const cut = (audit.cutBySourceCap ?? 0) + (audit.cutByBudget ?? 0);
  // Judged nothing while candidates were turned away on the way in: the funnel is the constraint.
  if (audit.visionJudged === 0 && cut > 0) return "LOST_BEFORE_VISION";
  if (audit.visionJudged > 0 && (audit.visionAccepted ?? 0) === 0) return "REJECTED_BY_VISION";
  if (cut > 0) return "LOST_BEFORE_VISION";
  return "NOT_MEASURED";
}

const n = (v: number | null): string => (v == null ? "?" : String(v));

/**
 * Is the cap turning away candidates that were about as good as the ones it kept?
 *
 * The brief asks whether the top 3 really are the best 3. A cap is doing its job when what it cuts
 * scores materially below what it keeps, and is costing the render when the next ones are just as
 * strong. Reported as the two score ranges rather than a verdict — one beat cannot settle it, and
 * a number that invites a judgement is more use than a judgement made on one sample.
 */
function formatCapComparison(archive: ArchiveCapComparison): string {
  if (archive.taken.length === 0) return "archiveScores=none";
  const range = (xs: number[]): string =>
    xs.length === 0
      ? "none"
      : `${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)}`;
  const gap =
    archive.taken.length > 0 && archive.cut.length > 0
      ? (Math.min(...archive.taken) - Math.max(...archive.cut)).toFixed(2)
      : "n/a";
  return `archiveTaken=[${range(archive.taken)}] archiveCut=[${range(archive.cut)}] capGap=${gap}`;
}

export function formatArchiveSourcingAudit(
  beatLabel: string,
  audit: ArchiveSourcingAudit
): string {
  return (
    `[ArchiveSourcingAudit] beat=${beatLabel} ` +
    `candidatesFound=${n(audit.candidatesFound)} afterBeatDedup=${n(audit.afterBeatDedup)} ` +
    `afterMetadata=${n(audit.afterMetadata)} afterSourceCap=${n(audit.afterSourceCap)} ` +
    `downloadBudget=${n(audit.downloadBudget)} downloaded=${n(audit.downloaded)} ` +
    `visionJudged=${n(audit.visionJudged)} visionAccepted=${n(audit.visionAccepted)} ` +
    `adopted=${n(audit.adopted)} ` +
    `cutBySourceCap=${n(audit.cutBySourceCap)} cutByBudget=${n(audit.cutByBudget)} ` +
    `backfilledFromCap=${n(audit.backfilledFromCap)} ` +
    `rejectedAfterDownload=${n(audit.rejectedAfterDownload)} ` +
    `verdict=${archiveSourcingVerdict(audit)} ${formatCapComparison(audit.archive)}`
  );
}

/**
 * The render-end tally: which constraint actually bound, across every beat.
 *
 * One beat proves nothing about a budget. This is the number the next round needs before touching
 * MAX_FUNNEL_CANDIDATES_TO_SCORE: a render whose beats mostly read LOST_BEFORE_VISION with
 * cutByBudget high has a budget problem, and one whose beats read REJECTED_BY_VISION does not.
 */
/**
 * The gap between the worst candidate the cap kept and the best one it turned away, per beat.
 *
 * Absent — not zero — for a beat where the cap cut nothing, or that had no archive candidates at
 * all: those beats say nothing about whether the cap is set right, and averaging a zero in for them
 * would drag the mean toward "the cap is costing us" using beats the cap never touched.
 */
export function capGapFor(audit: ArchiveSourcingAudit): number | null {
  const { taken, cut } = audit.archive;
  if (taken.length === 0 || cut.length === 0) return null;
  return Math.min(...taken) - Math.max(...cut);
}

export type ArchiveCapStats = {
  /** Beats where the cap actually turned an archive candidate away. */
  beatsWithCapBinding: number;
  avgCapGap: number | null;
  medianCapGap: number | null;
  capGapMin: number | null;
  capGapMax: number | null;
};

/**
 * RONDE 165 — whether the per-source cap is cutting good candidates, over a whole render.
 *
 * RONDE 164 printed the gap per beat, and render 554 gave exactly one beat with a gap of 0.00 —
 * one archive candidate refused that scored identically to the one kept. One beat is an anecdote,
 * and raising the cap on it would be guessing. These are the numbers that would turn it into
 * evidence: how many beats the cap actually bound on, and how far below the kept candidates the
 * refused ones really scored.
 *
 * A small median gap across many binding beats means the cap is refusing candidates as good as the
 * ones it keeps. A large one means it is doing its job. Neither is decided here — this reports, and
 * the decision needs a render to read it on.
 */
export function archiveCapStats(audits: ReadonlyArray<ArchiveSourcingAudit>): ArchiveCapStats {
  const gaps = audits
    .map(capGapFor)
    .filter((g): g is number => g != null)
    .sort((a, b) => a - b);
  if (gaps.length === 0) {
    return {
      beatsWithCapBinding: 0,
      avgCapGap: null,
      medianCapGap: null,
      capGapMin: null,
      capGapMax: null,
    };
  }
  const mid = Math.floor(gaps.length / 2);
  return {
    beatsWithCapBinding: gaps.length,
    avgCapGap: gaps.reduce((sum, g) => sum + g, 0) / gaps.length,
    medianCapGap: gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2,
    capGapMin: gaps[0],
    capGapMax: gaps[gaps.length - 1],
  };
}

function formatCapStats(stats: ArchiveCapStats): string {
  const g = (v: number | null): string => (v == null ? "n/a" : v.toFixed(2));
  return (
    `beatsWithCapBinding=${stats.beatsWithCapBinding} ` +
    `avgCapGap=${g(stats.avgCapGap)} medianCapGap=${g(stats.medianCapGap)} ` +
    `capGapMin=${g(stats.capGapMin)} capGapMax=${g(stats.capGapMax)}`
  );
}

export function summarizeArchiveSourcing(audits: ReadonlyArray<ArchiveSourcingAudit>): string {
  if (audits.length === 0) return "";
  const counts = new Map<ArchiveSourcingVerdict, number>();
  let cutByCap = 0;
  let cutByBudget = 0;
  let rejectedAfterDownload = 0;
  let backfilled = 0;
  for (const a of audits) {
    const v = archiveSourcingVerdict(a);
    counts.set(v, (counts.get(v) ?? 0) + 1);
    cutByCap += a.cutBySourceCap ?? 0;
    cutByBudget += a.cutByBudget ?? 0;
    rejectedAfterDownload += a.rejectedAfterDownload ?? 0;
    backfilled += a.backfilledFromCap ?? 0;
  }
  const byVerdict = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([v, c]) => `${v}=${c}`)
    .join(" ");
  return (
    `[ArchiveSourcingAudit] TOTAL beats=${audits.length} ${byVerdict} ` +
    `cutBySourceCap=${cutByCap} cutByBudget=${cutByBudget} ` +
    `rejectedAfterDownload=${rejectedAfterDownload} backfilledFromCap=${backfilled} ` +
    formatCapStats(archiveCapStats(audits))
  );
}
