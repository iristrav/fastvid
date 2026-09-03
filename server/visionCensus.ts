/**
 * WHO ASKED A MODEL TO LOOK AT A PICTURE, AND HOW OFTEN.
 *
 * ── The question this answers, and the one it does not ──────────────────────────────────────
 *
 * `visualMatchingV2/visionMetrics.ts` measures the QUALITY AND COST of one specific caller: the
 * funnel's `scoreCandidates`. Latency, cache hit rate, tokens per beat, average score per
 * dimension. It is shaped around that call and it is right to be.
 *
 * This answers a different question: how many times, in this render, did ANY route ask a vision
 * model to look at something, and which route was it. That is a roll-call, not a measurement, and
 * forcing it into the other accumulator would mean inventing token counts and dimension scores for
 * callers that have neither — dishonest numbers dressed as completeness.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────────────────────
 *
 * Five production callers reach a vision model:
 *
 *     scoreCandidates          visualMatchingV2/llmVisionScorer.ts   → visionMetrics
 *     judgeBeatImage           beatImageRelevanceGate.ts             → beatOutcomeAudit
 *     judgeBeatImage (direct)  videoPipeline.ts, YouTube screening   → nothing
 *     evaluateClipVisionGate   visualQualityGate.ts                  → nothing
 *     scoreAdoptedClipQuality  visualQualityGate.ts                  → nothing
 *
 * Two ledgers that do not know about each other, and three callers in neither. Any render-level
 * statement of the form "this render made N vision calls" was a count of one subsystem presented
 * as a total — the exact pattern this codebase keeps finding: the pipeline does something and the
 * metric does not know it happened.
 *
 * ── Why a scope and not a module-level counter ──────────────────────────────────────────────
 *
 * `MAX_CONCURRENT_RENDERS` can be greater than one, and two renders in one process sharing a
 * module-level accumulator would each report the other's spend. The census is therefore ambient
 * per render, the same mechanism `searchProvenanceStorage`, `subjectGateStorage` and
 * `plannedShotStorage` already use for the same reason.
 *
 * Outside any scope this records nothing and costs a map lookup. That is deliberate: a unit test
 * calling a gate directly should not have to open a census to do it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The routes that can ask. Closed, so a new caller has to be named here to be counted. */
export type VisionCaller =
  | "funnel_scorer"
  | "beat_judge"
  | "youtube_screening"
  | "clip_quality_gate"
  | "adopted_clip_quality";

/**
 * What came back.
 *
 *   judged       the model answered
 *   unavailable  it was asked and could not answer — no key, a timeout, a refusal
 *   skipped      it was deliberately not asked: a budget was spent, a cache had the answer,
 *                the gate was switched off
 *
 * `skipped` is counted rather than ignored because "we did not ask" and "we asked and got nothing"
 * are different facts about a render, and a reader chasing a thin video needs to tell them apart.
 */
export type VisionAskOutcome = "judged" | "unavailable" | "skipped";

export type VisionCensus = {
  byCaller: Map<VisionCaller, Record<VisionAskOutcome, number>>;
};

const censusStorage = new AsyncLocalStorage<VisionCensus>();

export function newVisionCensus(): VisionCensus {
  return { byCaller: new Map() };
}

/** Run `fn` with `census` collecting every vision ask made inside it. */
export function withVisionCensus<T>(census: VisionCensus, fn: () => T): T {
  return censusStorage.run(census, fn);
}

/** The census for the render currently running, or undefined outside one. */
export function getVisionCensus(): VisionCensus | undefined {
  return censusStorage.getStore();
}

/**
 * Record one ask. Never throws, and does nothing outside a census scope.
 *
 * `count` is the number of ASKS, not of pictures: a caller that sends four frames in one request
 * has made one ask. Callers that genuinely loop record once per iteration.
 */
export function recordVisionAsk(
  caller: VisionCaller,
  outcome: VisionAskOutcome,
  count = 1
): void {
  const census = censusStorage.getStore();
  if (!census || count <= 0) return;
  const row =
    census.byCaller.get(caller) ?? { judged: 0, unavailable: 0, skipped: 0 };
  row[outcome] += count;
  census.byCaller.set(caller, row);
}

/** Every caller's totals, plus the render total. One line each; empty when nothing asked. */
export function formatVisionCensus(census: VisionCensus | undefined): string[] {
  if (!census || census.byCaller.size === 0) {
    return ["[VisionCensus] no vision call was made in this render"];
  }
  const lines: string[] = [];
  let judged = 0;
  let unavailable = 0;
  let skipped = 0;
  /** Sorted so two renders of the same shape produce byte-identical reports. */
  for (const caller of [...census.byCaller.keys()].sort()) {
    const r = census.byCaller.get(caller)!;
    judged += r.judged;
    unavailable += r.unavailable;
    skipped += r.skipped;
    lines.push(
      `[VisionCensus] ${caller} judged=${r.judged} unavailable=${r.unavailable} skipped=${r.skipped}`
    );
  }
  lines.push(
    `[VisionCensus] TOTAL judged=${judged} unavailable=${unavailable} skipped=${skipped} ` +
      `callers=${census.byCaller.size}`
  );
  return lines;
}
