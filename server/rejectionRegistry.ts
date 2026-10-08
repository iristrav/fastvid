/**
 * REJECTION REGISTRY — the one owner of "this picture was turned away".
 *
 * ONE ROUTE: every refusal in a render is registered here and nowhere else — what was refused
 * (the file and its asset identity), why (the reason code), at which stage (the file, its content,
 * the push…), for which intent (scene, sentence, the query that found it), when, and how sure the
 * decider was. It is the only writer of a refusal onto the asset's lineage, so an asset's record
 * cannot end twice or not at all. It is NOT the archive: it remembers decisions about candidates
 * for this render, it stores no media and outlives nothing.
 *
 * What it does not own, and why: a supplier that cannot DELIVER a file (a YouTube video refused at
 * download, a 403 from an archive) is a fact about the supplier, kept by `providerFailureClass` and
 * `youtubeUnusableVideos`; a VisualJudge verdict is kept, with its frames' evidence, by the
 * relevance ledger. Both still register the refusal they cause here.
 *
 * — Per-video audit trail, history —
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

/** Where in the one route a refusal was made. */
export type RejectionStage =
  | "technical"
  | "dedup"
  | "usage"
  | "budget"
  | "metadata"
  | "on_screen_text"
  | "picture"
  | "push"
  | "archive"
  | "unknown";

export type RejectionEntry = {
  sceneIndex: number;
  beatIndex: number;
  basename: string;
  reason: string;
  /** The query that found the candidate — the intent it was fetched for. */
  source?: string;
  stage: RejectionStage;
  /** 0..1 — how sure the decider was. Deterministic rules are 1. */
  confidence: number;
  /** Epoch ms. */
  at: number;
};

export type RejectionRegistry = {
  /** Bounded detail — the named examples. */
  entries: RejectionEntry[];
  /** How many detail entries this audit will hold. */
  capacity: number;
  /** Every registerRejection call, whether or not its detail was stored. */
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
  /**
   * HOW OFTEN THE SAME ASSET WAS REFUSED FOR THE SAME REASON ON THE SAME BEAT.
   *
   * Render 573 printed one `[AdoptionGuard]` line nine times, word for word:
   *
   *     scene=2 beat=2 route=archive eligible=true vision=UNCLEAR blocked=FUNNEL_WITHOUT_EVIDENCE
   *     file=scene_2_b2_curated_a57465.mp4                                                    ×9
   *
   * Nine reads of an unchanged decision — the guard is a pure function of four inputs, none of
   * which moved between calls. The retry loop above it re-offered the same picture, and the log
   * showed nine refusals where a reader needed to see one refusal and a loop.
   *
   * This counts; it does not suppress. The per-beat and per-reason tallies above are untouched and
   * still record every call, so nothing here can make a failure look smaller than it was. What it
   * buys is a log that names the repetition instead of performing it.
   */
  repeats: Map<string, number>;
};

/**
 * Has this exact refusal already been reported? Returns how many times it had been seen BEFORE
 * this call, so a caller logs on 0 and counts thereafter.
 */
export function noteRepeatedRefusal(
  audit: RejectionRegistry | undefined,
  sceneIndex: number,
  beatIndex: number,
  identity: string,
  reason: string
): number {
  if (!audit) return 0;
  const key = `${beatRejectKey(sceneIndex, beatIndex)}|${identity}|${reason}`;
  const seen = audit.repeats.get(key) ?? 0;
  audit.repeats.set(key, seen + 1);
  return seen;
}

/** Detail entries kept. Counting is unbounded; only the named examples are limited. */
export const REJECTION_DETAIL_CAPACITY = 400;

export function beatRejectKey(sceneIndex: number, beatIndex: number): string {
  return `s${sceneIndex}b${beatIndex}`;
}

export function createRejectionRegistry(capacity = REJECTION_DETAIL_CAPACITY): RejectionRegistry {
  return {
    entries: [],
    capacity,
    recorded: 0,
    dropped: 0,
    perBeat: new Map(),
    repeats: new Map(),
  };
}

/**
 * Which stage a reason code belongs to. The codes are the ones every decider has always used; the
 * stage is read off them so a caller states WHY once and the registry files it in the right place.
 */
export function rejectionStageForReason(reason: string): RejectionStage {
  if (/^(file_missing|not_a_valid_video|pipeline_fallback|mostly_black|below_size_floor|invalid_file|transform_failed)/.test(reason)) return "technical";
  if (/^(already_used_in_render|duplicate_clip_once_per_video)/.test(reason)) return "dedup";
  if (/^(still_photo_budget|scene_still_cap|category_at_limit)/.test(reason)) return "usage";
  if (/^shortlist_full/.test(reason)) return "budget";
  if (/^(baked_edit_text)/.test(reason)) return "on_screen_text";
  if (/^(beat_image_gate|hard_mismatch)|refused on s\d+b\d+/.test(reason)) return "picture";
  if (/^(UNDECLARED_ADOPT_ROUTE|FUNNEL_WITHOUT_EVIDENCE)/.test(reason)) return "push";
  if (/^archive not ready/.test(reason)) return "archive";
  if (/^(ai_generated|rejected_stock|person_topic_off_topic_visual|stock_without_person|blocked_category|documentary_beat_gate|entity_evidence|no_beat_match|not_script_anchored|person_not_named)/.test(reason)) return "metadata";
  return "unknown";
}

/**
 * Register one refusal — the only way a refusal is written.
 *
 * Counted per sentence with no cap (the placeholder decision and the funnel read the count); the
 * named detail is bounded; and the refusal is filed ONCE on the asset's lineage, so callers never
 * write the lineage themselves. A refusal with no sentence (`beatIndex` undefined) still reaches
 * the lineage — it simply has no sentence to be counted under.
 */
export function registerRejection(
  registry: RejectionRegistry,
  sceneIndex: number,
  beatIndex: number | undefined,
  clipPath: string,
  reason: string,
  source?: string,
  detail: { stage?: RejectionStage; confidence?: number; contentKey?: string } = {}
): void {
  registry.recorded++;
  /** VIDEO 641 (W1) — filed under the sentence that refused it, not the one that opened the record. */
  registry.lineage?.recordRejection(clipPath, reason, detail.contentKey, beatIndex == null ? {} : { sceneIndex, beatIndex });
  if (beatIndex == null) return;

  // The count comes first and has no cap. Whatever happens to the detail below, the funnel
  // audit's per-beat number is complete.
  const key = beatRejectKey(sceneIndex, beatIndex);
  let byReason = registry.perBeat.get(key);
  if (!byReason) {
    byReason = new Map();
    registry.perBeat.set(key, byReason);
  }
  byReason.set(reason, (byReason.get(reason) ?? 0) + 1);

  if (registry.entries.length >= registry.capacity) {
    registry.dropped++;
    return;
  }
  registry.entries.push({
    sceneIndex,
    beatIndex,
    basename: path.basename(clipPath),
    reason,
    source,
    stage: detail.stage ?? rejectionStageForReason(reason),
    confidence: detail.confidence ?? 1,
    at: Date.now(),
  });
}

export function beatRejectCount(audit: RejectionRegistry, sceneIndex: number, beatIndex: number): number {
  const byReason = audit.perBeat.get(beatRejectKey(sceneIndex, beatIndex));
  if (!byReason) return 0;
  let total = 0;
  for (const n of byReason.values()) total += n;
  return total;
}

/** Reasons for one beat, most frequent first — again from the tally, not the capped entries. */
export function beatRejectReasons(
  audit: RejectionRegistry,
  sceneIndex: number,
  beatIndex: number
): Array<[string, number]> {
  const byReason = audit.perBeat.get(beatRejectKey(sceneIndex, beatIndex));
  if (!byReason) return [];
  return [...byReason.entries()].sort((a, b) => b[1] - a[1]);
}

/** Render-wide reason breakdown. Reads the tally, so it is complete even past the detail cap. */
export function summarizeRejections(audit: RejectionRegistry | RejectionEntry[]): Record<string, number> {
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
export function formatRejectionCapacity(audit: RejectionRegistry): string {
  return (
    `auditEntriesRecorded=${audit.recorded} auditEntriesDropped=${audit.dropped} ` +
    `auditCapacity=${audit.capacity}`
  );
}
