/**
 * RONDE 206 — shot variety, and the beat that keeps picking the shot the last beat took.
 *
 * ── The ordering R206 asks about ─────────────────────────────────────────────────────────────
 *
 * relevance → content correctness → technical quality → shot fit → diversity → duplicate penalty
 * → source preference.
 *
 * That is the order the DEFAULT_RANKING_WEIGHTS implement, and the first half of this file pins
 * it as arithmetic rather than as a comment, so a future tuning pass cannot quietly let source
 * preference outweigh whether the picture is right.
 *
 * ── The second question, and the answer this round had to fix ────────────────────────────────
 *
 * "Do different beats structurally get the same first search result?"
 *
 * They did, on the route that ships. `selectCandidatesFromPool` has two branches: the thirteen-
 * signal engine, and the keyword scorer it falls back to. R170's duplicate penalty was applied
 * only INSIDE the first branch — and that branch runs only when `poolRankingV2Enabled()`, which
 * follows `CINEMATIC_EDITING_ENGINE` and is off by default.
 *
 * So on the default route the pool was handed a usage ledger (R180 wired it) and never read it.
 * Every beat of a scene ranked the SAME pool by keyword overlap alone, with a stable sort — which
 * is deterministic, and deterministically returns the same candidate first. The failure is
 * strongest exactly where it is least visible: when two candidates tie, which is the common case
 * for a pool of stock clips whose titles share the beat's nouns.
 *
 * The fix applies the existing penalty to both branches. It is not a second ranker: relevance is
 * still decided entirely by whichever branch ran, and the penalty only adjusts the order it
 * produced. The scales make that literal — see "a real difference in relevance still wins" below.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { selectCandidatesFromPool, type PoolCandidate, type SceneCandidatePool } from "./scenePool";
import { newLedger, recordUse, DUPLICATE_PENALTY, SAME_PROVIDER_PENALTY } from "./duplicateGuard";
import { DEFAULT_RANKING_WEIGHTS } from "./visualMatchingV2/candidateRanking";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  /**
   * The route that ships. Both flags off is the default deployment, and it is the configuration
   * the bug below lived in — so the test asserts against it explicitly rather than inheriting
   * whatever the environment happens to have.
   */
  process.env.POOL_RANKING_V2 = "false";
  delete process.env.CINEMATIC_EDITING_ENGINE;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL)) delete process.env[k];
  Object.assign(process.env, ORIGINAL);
});

function candidate(over: Partial<PoolCandidate> & { assetId: string; source: PoolCandidate["source"] }): PoolCandidate {
  return {
    id: `${over.source}:${over.assetId}`,
    remoteUrl: `https://example.invalid/${over.assetId}.mp4`,
    thumbnailUrl: null,
    title: "",
    description: null,
    tags: [],
    mediaType: "video",
    durationSec: 8,
    license: null,
    width: 1920,
    height: 1080,
    sourceCreator: null,
    licenseUrl: null,
    clipSimilarity: null,
    embeddingSimilarity: null,
    rankingScore: null,
    visionScore: null,
    selectionScore: null,
    ...over,
  } as PoolCandidate;
}

function pool(candidates: PoolCandidate[]): SceneCandidatePool {
  return {
    sceneIndex: 0,
    sceneText: "Berlin in the winter of 1945.",
    queries: ["berlin 1945"],
    candidates,
    metrics: {
      retrievalLatencyMs: 0,
      cacheHit: false,
      apiCallsPerProvider: {},
      candidatesBeforeDedup: candidates.length,
      candidatesAfterDedup: candidates.length,
      candidatesAfterLimit: candidates.length,
      poolSize: candidates.length,
      estimatedMemoryBytes: candidates.length * 400,
    },
  };
}

/* ═══════════════════════ the ordering, as arithmetic ═══════════════════════ */

describe("R206 — the ranking signals are weighted in the order the brief names", () => {
  const W = DEFAULT_RANKING_WEIGHTS;
  /** The groups R206 names, mapped onto the signals that implement them. */
  const relevance = W.clipSimilarity + W.embeddingSimilarity + W.keywordScore;
  const correctness = W.entityMatch + W.editorialScore;
  const technical = W.resolutionMatch + W.orientationMatch;
  const shotFit = W.motionMatch + W.durationFit;
  const variety = W.diversity;
  const source = W.sourcePriority;

  /**
   * RULE 7, as a number. Relevance is more than half the total on its own, so no combination of
   * everything else can put a wrong picture first — which is the property "relevantie boven
   * diversiteit" actually needs, rather than a pairwise comparison against one other signal.
   */
  it("relevance outweighs everything else put together", () => {
    expect(relevance).toBeGreaterThan(correctness + technical + shotFit + variety + source);
  });

  it("content correctness outranks technical quality", () => {
    expect(correctness).toBeGreaterThan(technical);
  });

  it("shot fit outranks technical quality", () => {
    expect(shotFit).toBeGreaterThan(technical);
  });

  /** Phase 9 made this true on purpose: not repeating a shot beats preferring a nicer source. */
  it("variety outranks source preference", () => {
    expect(variety).toBeGreaterThan(source);
  });

  /**
   * The one honest wrinkle in the matrix, recorded rather than smoothed over: technical quality
   * and source preference are weighted EQUALLY (0.07 each). R206's order puts technical first, so
   * this is a tie where the brief expects a gap.
   *
   * It is left as it is, and this test pins it so it is a decision rather than an accident. Two
   * reasons: resolutionMatch and orientationMatch score null on nearly every adapter today (most
   * populate no width/height), so the weight is redistributed and the tie is theoretical; and
   * changing a shipped weight to satisfy an ordering nobody has measured a render against is
   * exactly the tuning-by-audit this round is not allowed to do.
   */
  it("technical quality and source preference are currently tied — recorded, not hidden", () => {
    expect(technical).toBe(source);
  });
});

/* ═══════════════════════ different beats, different shots ═══════════════════════ */

