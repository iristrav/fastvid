/**
 * Per-video audit trail — why candidate clips were rejected during adopt.
 *
 * RONDE 70 — the cap used to lie.
 *
 * This was a plain array with `if (audit.length >= 80) return;`. Silent. Nothing counted what
 * it dropped, and nothing said it had started dropping. Two consequences, and the second is the
 * dangerous one:
 *
 *   1. Past 80 rejections the render simply stopped explaining itself.
 *   2. The cap is CHRONOLOGICAL, and [VisualCoverage] derived its per-beat count by filtering
 *      this array. So early scenes were fully recorded and late beats reported `rejected=0` —
 *      indistinguishable from "nothing was ever found for this beat". One of those means the
 *      sourcing found nothing (category A); the other means it found plenty and refused all of
 *      it (category C). Render 534 had 398 raw candidates against a cap of 80.
 *
 * The fix separates the two things the audit is for. The DETAIL (which file, which query) is
 * expensive and stays bounded. The COUNT per beat and per reason is a handful of integers, is
 * what every funnel question is actually asked of, and is now never dropped — a beat that had
 * forty rejections says forty whether or not there was room to name them.
 *
 * When the detail cap does bind, it is now visible: recorded, dropped and capacity are all
 * reported. Never a silent return again.
 *
 * Observability only. No reject reason, gate or threshold is defined or changed here.
 */
import * as path from "path";
import type { VisualSourceLedger } from "./visualSourceLineage";

export type ClipRejectEntry = {
  sceneIndex: number;
  beatIndex: number;
  basename: string;
  reason: string;
  source?: string;
};

export type ClipRejectAudit = {
  /** Bounded detail — the named examples. */
  entries: ClipRejectEntry[];
  /** How many detail entries this audit will hold. */
  capacity: number;
  /** Every recordClipReject call, whether or not its detail was stored. */
  recorded: number;
  /** Calls whose DETAIL was not stored because the cap had been reached. */
  dropped: number;
  /**
   * "s{scene}b{beat}" -> reason -> count. Never dropped, never capped: this is what the funnel
   * audit reads, so a late beat can no longer report a rejection count of zero it did not earn.
   */
  perBeat: Map<string, Map<string, number>>;
  /**
   * RONDE 86: the render's lineage ledger, so a rejection is also a funnel event.
   *
   * Attached rather than passed at every call site: this function is the single point every gate
   * in the pipeline reports a refusal to, which makes it the one place the funnel's `rejected`
   * stage can be counted completely and attributed to the gate that produced it. Optional, so an
   * audit created outside a render (tests, tools) behaves exactly as before.
   */
  lineage?: VisualSourceLedger;
};

/** Detail entries kept. Counting is unbounded; only the named examples are limited. */
export const CLIP_REJECT_DETAIL_CAPACITY = 400;

export function beatRejectKey(sceneIndex: number, beatIndex: number): string {
  return `s${sceneIndex}b${beatIndex}`;
}

export function createClipRejectAudit(capacity = CLIP_REJECT_DETAIL_CAPACITY): ClipRejectAudit {
  return { entries: [], capacity, recorded: 0, dropped: 0, perBeat: new Map() };
}

export function recordClipReject(
  audit: ClipRejectAudit,
  sceneIndex: number,
  beatIndex: number,
  clipPath: string,
  reason: string,
  source?: string
): void {
  audit.recorded++;
  // RONDE 86: the same refusal, counted in the retrieval funnel and attributed to its gate. The
  // provider comes from the ledger when it knows this clip and from the reject reason otherwise,
  // so a rejection is never filed under a provider the render only guessed at.
  if (audit.lineage) {
    audit.lineage.countRejection(audit.lineage.providerFor(clipPath) ?? "unknown", reason);
  }

  // The count comes first and has no cap. Whatever happens to the detail below, the funnel
  // audit's per-beat number is complete.
  const key = beatRejectKey(sceneIndex, beatIndex);
  let byReason = audit.perBeat.get(key);
  if (!byReason) {
    byReason = new Map();
    audit.perBeat.set(key, byReason);
  }
  byReason.set(reason, (byReason.get(reason) ?? 0) + 1);

  if (audit.entries.length >= audit.capacity) {
    audit.dropped++;
    return;
  }
  audit.entries.push({
    sceneIndex,
    beatIndex,
    basename: path.basename(clipPath),
    reason,
    source,
  });
}

/** Total rejections for one beat — from the tally, so never understated by the detail cap. */
export function beatRejectCount(audit: ClipRejectAudit, sceneIndex: number, beatIndex: number): number {
  const byReason = audit.perBeat.get(beatRejectKey(sceneIndex, beatIndex));
  if (!byReason) return 0;
  let total = 0;
  for (const n of byReason.values()) total += n;
  return total;
}

/** Reasons for one beat, most frequent first — again from the tally, not the capped entries. */
export function beatRejectReasons(
  audit: ClipRejectAudit,
  sceneIndex: number,
  beatIndex: number
): Array<[string, number]> {
  const byReason = audit.perBeat.get(beatRejectKey(sceneIndex, beatIndex));
  if (!byReason) return [];
  return [...byReason.entries()].sort((a, b) => b[1] - a[1]);
}

/** Render-wide reason breakdown. Reads the tally, so it is complete even past the detail cap. */
export function summarizeClipRejectAudit(audit: ClipRejectAudit | ClipRejectEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  if (Array.isArray(audit)) {
    for (const e of audit) counts[e.reason] = (counts[e.reason] ?? 0) + 1;
    return counts;
  }
  for (const byReason of audit.perBeat.values()) {
    for (const [reason, n] of byReason) counts[reason] = (counts[reason] ?? 0) + n;
  }
  return counts;
}

/**
 * One line saying how much of the detail survived. Printed once per render so a reader knows
 * whether the named examples below are the whole story or a sample of it.
 */
export function formatClipRejectAuditCapacity(audit: ClipRejectAudit): string {
  return (
    `auditEntriesRecorded=${audit.recorded} auditEntriesDropped=${audit.dropped} ` +
    `auditCapacity=${audit.capacity}`
  );
}
