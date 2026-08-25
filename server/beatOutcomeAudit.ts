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

/** The per-beat line. One per beat, adopted or not. */
export function formatBeatFunnelLine(
  rec: BeatFunnelRecord,
  status: BeatFinalStatus,
  rejected: number,
  topRejects: string
): string {
  return (
    `[VisualCoverageFinal] scene=${rec.sceneIndex} beat=${rec.beatIndex} status=${status} ` +
    `origin=${rec.origin || "none"} offered=${rec.offered} rejected=${rejected} ` +
    `eligible=${rec.eligible} adopted=${rec.adopted} ` +
    `visionJudged=${rec.visionJudged} visionUnavailable=${rec.visionUnavailable} ` +
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
