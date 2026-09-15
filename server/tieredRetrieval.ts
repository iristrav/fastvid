/**
 * RONDE 246 — RETRIEVAL IN TIERS, so the slow tail is not paid for when the good sources answered.
 *
 * ── The trade this makes, stated plainly ────────────────────────────────────────────────────
 *
 * `buildSceneCandidatePool` asked all eleven providers at once, so a scene's retrieval cost the
 * SLOWEST provider. Tiers cost the SUM of the tiers actually visited. That is worse, not better,
 * for a scene that has to reach the last tier — and it is the shape RONDE 3's guard was written
 * against, when Library of Congress made 51 sequential calls and took 150 seconds.
 *
 * What pays for it is the early exit. A scene whose first tier covers every sentence never asks
 * tiers two, three and four at all: one tier instead of the maximum of eleven. The bet is that the
 * sources an operator ranks first usually answer, and the measurement that settles whether the bet
 * pays is `[Step] category Image / clip search`, which RONDE 241 finally attached to something.
 *
 * Within a tier nothing changes: its members run together under `Promise.allSettled`, so one slow
 * or broken provider neither serialises its neighbours nor takes their results down with it.
 *
 * ── Why this is a module rather than a loop inside the pool ─────────────────────────────────
 *
 * Because the pool's providers are imported, not injected, a behavioural test of the ordering
 * inside `buildSceneCandidatePool` would have to make real HTTP calls. Here the rule is a pure
 * function over thunks, so "tier 2 is not asked when tier 1 satisfied" is a fact a test can prove
 * rather than a string it can match.
 */

/** One unit of retrieval work, not yet started. */
export type RetrievalTask<T> = {
  /** Lower runs first. Tasks sharing a number run together. */
  tier: number;
  /** For the log — which provider this is. */
  source: string;
  /**
   * DEFERRED. The whole point: `tasks.push(searchX(...))` starts the search at push time, so a
   * list built that way is already running before anyone decides whether it should.
   */
  run: () => Promise<T>;
};

export type TieredRetrievalReport = {
  /** How many tiers were actually asked. */
  tiersRun: number;
  /** Tier numbers that were never reached, in order. */
  tiersSkipped: number[];
  /** True when the run stopped because `satisfied` said so rather than running out of tiers. */
  stoppedEarly: boolean;
};

/**
 * Run tasks tier by tier, stopping as soon as the caller says it has enough.
 *
 * `satisfied` is consulted only BETWEEN tiers, never within one: a tier is a decision about which
 * sources to ask together, and abandoning half of it once the other half answered would discard
 * work already paid for.
 *
 * Results are handed over per tier rather than collected here, because the caller's accumulation —
 * dedup, per-source caching, api-call bookkeeping — is its own business and this function has no
 * opinion about candidates.
 */
export async function runTieredRetrieval<T>(params: {
  tasks: ReadonlyArray<RetrievalTask<T>>;
  /** Called with each tier's settled results, in tier order, before `satisfied` is consulted. */
  onTierResults: (results: PromiseSettledResult<T>[], tier: number) => void;
  /**
   * Whether to stop. Absent means never stop early — every tier runs, which is exactly the old
   * all-at-once behaviour minus the parallelism, and is the honest default for a caller that has
   * not said what "enough" means.
   */
  satisfied?: () => boolean;
  /** One line per tier, so a render can show where it stopped and why. */
  log?: (line: string) => void;
}): Promise<TieredRetrievalReport> {
  const tiers = [...new Set(params.tasks.map((t) => t.tier))].sort((a, b) => a - b);
  const report: TieredRetrievalReport = { tiersRun: 0, tiersSkipped: [], stoppedEarly: false };

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]!;
    const inTier = params.tasks.filter((t) => t.tier === tier);
    const t0 = Date.now();
    const results = await Promise.allSettled(inTier.map((t) => t.run()));
    report.tiersRun++;
    params.onTierResults(results, tier);

    const failed = results.filter((r) => r.status === "rejected").length;
    params.log?.(
      `[Retrieval] tier=${tier} sources=${inTier.map((t) => t.source).join(",")} ` +
        `ms=${Date.now() - t0}` + (failed > 0 ? ` failed=${failed}` : "")
    );

    if (params.satisfied?.()) {
      report.stoppedEarly = true;
      report.tiersSkipped = tiers.slice(i + 1);
      params.log?.(
        `[Retrieval] stopping after tier=${tier} — the scene is covered; ` +
          `tier(s) ${report.tiersSkipped.join(",") || "none"} not asked`
      );
      break;
    }
  }

  return report;
}

/**
 * Enough DISTINCT candidates that every sentence in the scene could have one.
 *
 * ── What this does NOT claim, and why the name says "could" ─────────────────────────────────
 *
 * It would be easy to call this "the scene is covered" and it would be false. At pool-build time
 * no candidate has been matched to a sentence: the subject screen, the ranking and the picture
 * editor all run later, and any of them may refuse. A pool of six candidates for a six-sentence
 * scene is a NECESSARY condition for covering it, never proof that it is covered.
 *
 * So this is deliberately the weaker, true statement. Dressing a necessary condition up as a
 * sufficient one is the exact move that gave this pipeline `[ClipValidation] OK` on checks that
 * could not fail and `provider unavailable (no capacity)` on a blocked account — a metric that
 * claims more than it measured, believed for weeks.
 *
 * ── Why the ratio, and why it is deliberately generous ──────────────────────────────────────
 *
 * One candidate per sentence is the floor for a pool that is about to be filtered several times
 * over, so the multiplier asks for headroom: material enough that the later refusals have
 * somewhere to go. It stops the run early only when the earlier tiers were genuinely productive.
 *
 * ── Why an unknown beat count never satisfies ───────────────────────────────────────────────
 *
 * A caller that does not say how many sentences it has cannot be told it has enough for them. It
 * runs every tier — slower, and correct. Guessing a beat count here would turn a missing fact into
 * a confident early exit, which is the failure this pipeline keeps paying for.
 */
export const CANDIDATES_WANTED_PER_BEAT = 3;

export function enoughForEveryBeat(params: {
  beatCount?: number;
  /** DISTINCT candidates gathered so far — deduped the way the final pool will be. */
  distinctCandidates: number;
  /** Override for callers that want a different headroom. */
  perBeat?: number;
}): boolean {
  const beats = params.beatCount;
  if (!Number.isFinite(beats) || (beats ?? 0) <= 0) return false;
  const wanted = (beats as number) * Math.max(1, params.perBeat ?? CANDIDATES_WANTED_PER_BEAT);
  return params.distinctCandidates >= wanted;
}
