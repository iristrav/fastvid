/**
 * F3-26: user-facing and admin-facing warnings for genuinely insufficient visual footage.
 *
 * The DECISION of whether to warn is a pure function (computeArchiveCoverageWarning) so it can
 * be tested without a database — it only fires when the actual final count of usable footage
 * (archive + anything web sourcing found) is still short of what's needed, never on a raw
 * "archive_count < X" snapshot taken before web sourcing had a chance to fill the gap.
 *
 * Reuses existing surfaces rather than building new ones:
 *  - User-facing: `videos.progressStep` (server/db.ts updateVideoProgress) — the same field
 *    server/routers.ts already uses for a low-coverage note at enqueue time
 *    (`"Waiting in queue — limited archive footage for this topic"`).
 *  - Admin-facing: the existing `archive_content_gaps` table + its admin-only tRPC routes
 *    (listContentGaps/clearContentGaps in server/routers.ts), via recordArchiveContentGap.
 */

import { getVideoById, updateVideoProgress } from "./db";
import { recordArchiveContentGap } from "./archiveContentGaps";

export const INSUFFICIENT_FOOTAGE_USER_MESSAGE =
  "Not enough footage available\n\n" +
  "We couldn't find enough suitable footage for this topic. Your video may take longer to " +
  "generate while we search for additional sources.";

export type CoverageWarningInput = {
  entity: string;
  /** How many usable clips the curated archive had for this entity before web sourcing. */
  archiveCount: number;
  /** How many usable clips are actually needed (beat requirements for this entity). */
  recommendedCount: number;
  /** Whether web sourcing was attempted for this entity. */
  webSearchAttempted: boolean;
  /** How many additional usable clips web sourcing found, when attempted. */
  webFoundCount: number;
};

export type CoverageWarningDecision = {
  /** Total usable footage after archive + any web sourcing. */
  totalCount: number;
  /** True only when totalCount is still short of recommendedCount despite web sourcing. */
  shouldWarnUser: boolean;
  /** True when coverage is structurally low for this entity — an admin actionable signal.
   *  Fires together with shouldWarnUser today, kept as a separate field since the two audiences
   *  may reasonably diverge later (e.g. an admin threshold stricter than the user-facing one). */
  shouldWarnAdmin: boolean;
};

/**
 * Pure decision logic — never warns just because archiveCount < recommendedCount; it warns only
 * when the actual final tally (archive + web) is still short. Sufficient archive coverage, or a
 * web search that closed the gap, never produces a warning (F3-26 requirement #11).
 */
export function computeArchiveCoverageWarning(input: CoverageWarningInput): CoverageWarningDecision {
  const totalCount = input.archiveCount + (input.webSearchAttempted ? input.webFoundCount : 0);
  const insufficient = totalCount < input.recommendedCount;
  return {
    totalCount,
    shouldWarnUser: insufficient,
    shouldWarnAdmin: insufficient,
  };
}

/**
 * Applies the user-facing and admin-facing warnings when genuinely warranted. Best-effort —
 * never throws, never blocks video production.
 */
export async function applyCoverageWarningIfNeeded(
  videoId: number,
  input: CoverageWarningInput
): Promise<CoverageWarningDecision> {
  const decision = computeArchiveCoverageWarning(input);
  try {
    if (decision.shouldWarnUser) {
      // Preserve the current progressPercent — this is an informational note layered onto the
      // in-flight render's status text, not a step transition, so it must not reset/misrepresent
      // actual progress the same way enqueueVideoJob's percent=0 coverage note legitimately can
      // (that one fires before generation has started at all).
      const video = await getVideoById(videoId);
      await updateVideoProgress(videoId, INSUFFICIENT_FOOTAGE_USER_MESSAGE, video?.progressPercent ?? 0);
    }
    if (decision.shouldWarnAdmin) {
      // Reuses the existing admin gap-tracking surface (archive_content_gaps + its admin tRPC
      // routes) rather than building a parallel admin notification table. The sample text
      // carries the structured detail an admin needs (entity/counts/web-search outcome) — the
      // existing listContentGaps route already surfaces keyword+sampleBeatText+hitCount.
      await recordArchiveContentGap(
        `low-coverage:${input.entity}`,
        `LOW ARCHIVE COVERAGE — entity: ${input.entity} | archive: ${input.archiveCount} | ` +
        `recommended: ${input.recommendedCount}+ | web search: ${input.webSearchAttempted ? "completed" : "not attempted"} | ` +
        `additional found: ${input.webFoundCount} | action: consider manually adding more footage to the archive`
      );
    }
  } catch (err) {
    console.warn("[CoverageWarning] apply failed:", (err as Error).message?.slice(0, 120));
  }
  return decision;
}
