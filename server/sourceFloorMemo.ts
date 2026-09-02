/**
 * AN ARCHIVE ASSET THAT IS TOO SHORT IS TOO SHORT — REMEMBER IT ONCE.
 *
 * ── What render 562 spent ───────────────────────────────────────────────────────────────────
 *
 *     222 × "source video too short (2.00s < 2.80s for a 3.50s slot)"
 *     34 distinct assets
 *     asset 57358 refused 26 times, 57363 25 times, 57360 23 times, 57357 22 times
 *
 * Every one of those repeats is a download, an ffprobe and a refusal for an answer the render
 * already had. RONDE 86 diagnosed exactly this on render 536 ("594 rejections across 37 distinct
 * assets, an average of sixteen identical failures per asset") and fixed it — in the two routes it
 * looked at. There are five routes into `prepareCuratedArchiveClip`, and three of them still catch
 * the throw and register nothing:
 *
 *     videoPipeline.ts:4412   the retrieval funnel's download path
 *     videoPipeline.ts:19618  the re-prepare on an already-adopted clip
 *     videoPipeline.ts:27827  the alternate-scan pass
 *
 * That is the same seam as R53's `recordClipAdopt`, R62's still/moving counters and R70's beat
 * audit: a rule each route must remember, which most routes do not. So this does not live in the
 * routes. It lives in the one function all five call.
 *
 * ── Why the floor and not just the asset id ─────────────────────────────────────────────────
 *
 * RONDE 86's ban is "this asset failed, drop it for the render". For most throws that is exactly
 * right — a 404, an undecodable file, a Ken Burns clip that cannot be built. But the source-length
 * throw is NOT purely a property of the asset: the floor it is measured against comes from the SLOT
 * (`stitchSourceFloorSec`), so a 2.6-second asset refused for a 3.5-second slot would legitimately
 * pass for a 2.5-second one. Banning it outright would refuse footage the render can actually use.
 *
 * So what is remembered is the FLOOR it failed at, and the memo only answers "yes, again" for a
 * slot demanding at least as much. A shorter slot still gets to ask. That is strictly narrower than
 * a ban and strictly cheaper than asking twice.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────────────────────
 *
 * Not a change to the floor. `VIDRUSH_MIN_SOURCE_VIDEO_SEC` keeps its 2.8, `stitchSourceFloorSec`
 * keeps its rule, and no clip is accepted here that was refused before. The refusal is identical;
 * only the repetition is gone. Whether 2.8 is the right number is a separate question that needs a
 * real render to answer, and `formatSourceFloorLedger` below is what will answer it: it reports what
 * the floor cost this render and how much of that the render's own coverage machinery could have
 * carried, so the next decision is made on production data rather than on judgement.
 */

import { AsyncLocalStorage } from "async_hooks";

/** One asset's worst-case refusal: the LOWEST floor it has already failed to clear. */
export type SourceFloorMemo = {
  /** assetId → the lowest floor (seconds) this asset has failed against this render. */
  failedAtFloorSec: Map<number, number>;
  /** Every refusal, for the render's ledger line. */
  refusals: SourceFloorRefusal[];
};

export type SourceFloorRefusal = {
  assetId: number;
  sourceSec: number;
  floorSec: number;
  slotSec: number;
};

export function createSourceFloorMemo(): SourceFloorMemo {
  return { failedAtFloorSec: new Map(), refusals: [] };
}

/**
 * The message `trimVideoClip` throws, read back into numbers.
 *
 * Parsed rather than threaded through five call signatures on purpose: the floor is computed
 * inside the trim from the slot it was given, and passing it back out would mean changing every
 * route — which is the pattern that produced this bug. Returns null for any other failure, so a
 * 404 or an undecodable file never reaches this memo.
 */
export function parseSourceFloorFailure(
  message: string
): { sourceSec: number; floorSec: number; slotSec: number } | null {
  const m = /source video too short \(([\d.]+)s < ([\d.]+)s for a ([\d.]+)s slot\)/.exec(message);
  if (!m) return null;
  const [sourceSec, floorSec, slotSec] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![sourceSec, floorSec, slotSec].every((n) => Number.isFinite(n))) return null;
  return { sourceSec, floorSec, slotSec };
}

/** Record one refusal. The lowest floor an asset has failed at is the one worth keeping. */
export function noteSourceFloorFailure(
  memo: SourceFloorMemo | undefined,
  assetId: number,
  refusal: { sourceSec: number; floorSec: number; slotSec: number }
): void {
  if (!memo) return;
  memo.refusals.push({ assetId, ...refusal });
  const known = memo.failedAtFloorSec.get(assetId);
  if (known == null || refusal.floorSec < known) {
    memo.failedAtFloorSec.set(assetId, refusal.floorSec);
  }
}

/**
 * Would this asset fail again at this slot's floor?
 *
 * Only when the slot demands AT LEAST as much source as the one that already refused it. A slot
 * with a lower floor is a genuinely different question and is asked.
 */
export function sourceFloorWouldFailAgain(
  memo: SourceFloorMemo | undefined,
  assetId: number,
  floorSec: number
): boolean {
  const failedAt = memo?.failedAtFloorSec.get(assetId);
  return failedAt != null && floorSec >= failedAt;
}

/* ═══════════════════════ the render-scoped scope ═══════════════════════ */

/**
 * Render-scoped, not module-scoped.
 *
 * A module-level Map would be shared by every render running in the same process, so one video's
 * refusal would silently ban an asset for another video whose slots are shorter. `AsyncLocalStorage`
 * is the pattern this codebase already uses for exactly this (`searchProvenanceStorage`,
 * `renderTopicStorage`): the scope is opened once per render and every await inside it — including
 * the five routes into `prepareCuratedArchiveClip` — sees the same memo without being passed one.
 *
 * Outside a scope both accessors are no-ops, so a caller that never opens one behaves exactly as it
 * did before this module existed.
 */
const sourceFloorStorage = new AsyncLocalStorage<SourceFloorMemo>();

export function getSourceFloorMemo(): SourceFloorMemo | undefined {
  return sourceFloorStorage.getStore();
}

export function withSourceFloorMemo<T>(memo: SourceFloorMemo, fn: () => T): T {
  return sourceFloorStorage.run(memo, fn);
}

/**
 * WHAT THE FLOOR COST THIS RENDER, and what the render itself could have carried.
 *
 * `coverableAtSlowdown` is the number the threshold question turns on. The pipeline already slows
 * footage up to `MAX_COVERAGE_SLOWDOWN` to cover a gap without a held frame, so a slot of S seconds
 * is fully coverable by a source of S / MAX_COVERAGE_SLOWDOWN. Every refusal at or above that
 * length was refused footage this render could have used at full coverage — a cost the flat floor
 * imposes that the pipeline's own machinery does not require.
 *
 * It is reported, not acted on. Lowering a threshold on the strength of a line like this without a
 * real render to compare against is how a measurement becomes a regression.
 */
export function formatSourceFloorLedger(
  memo: SourceFloorMemo,
  maxCoverageSlowdown: number
): string {
  if (memo.refusals.length === 0) return "[SourceFloor] no asset was refused for length";
  const assets = new Set(memo.refusals.map((r) => r.assetId));
  const coverable = memo.refusals.filter(
    (r) => r.sourceSec >= r.slotSec / Math.max(1, maxCoverageSlowdown)
  );
  const repeats = memo.refusals.length - assets.size;
  const worst = [...assets]
    .map((id) => ({ id, n: memo.refusals.filter((r) => r.assetId === id).length }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((a) => `${a.id}×${a.n}`)
    .join(",");
  return (
    `[SourceFloor] refusals=${memo.refusals.length} uniqueAssets=${assets.size} ` +
    `repeats=${repeats} coverableAtSlowdown=${coverable.length} ` +
    `slowdownCap=${maxCoverageSlowdown}x mostRefused=${worst || "none"}`
  );
}
