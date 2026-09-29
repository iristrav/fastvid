/**
 * RONDE 160 (FASE 7/10/11) — the live candidate pool, ranked by the ranking engine that already
 * exists, instead of by a keyword counter.
 *
 * ── What the audit found ─────────────────────────────────────────────────────────────────────
 *
 * FASE 7 asks for QUALITY > SOURCE: a perfect archive asset should beat a poor YouTube one, and an
 * excellent YouTube asset should be able to win. Two separate things turned out to be true, and
 * only one of them was the problem anybody expected.
 *
 *   1. The retrieval order in `HISTORICAL_SOURCE_TIER_ORDER` is a first-match-wins CASCADE:
 *      internet_archive, then youtube_cc, then wikimedia, then NARA… If a tier returns anything
 *      usable, the tiers below it are never asked. Under a cascade, source position IS the
 *      ranking, and quality cannot outrank it.
 *
 *   2. But a multi-source POOL also exists, it is ON by default
 *      (`ENABLE_SCENE_CANDIDATE_POOL !== "false"`), and it gathers candidates from ten providers
 *      before choosing. So a place where quality genuinely can outrank source is already running
 *      in production — and `selectCandidatesFromPool` scored it by counting shared word-stems:
 *      +1 per token the title/tags/description share with the beat, +3 if the power word is in the
 *      title, +2 if it is in the tags. No source priority, no diversity, no duplicate penalty, no
 *      motion, aspect, duration or freshness, and no idea what shot the Director asked for.
 *
 * Meanwhile `visualMatchingV2/candidateRanking.ts` implements all thirteen of those signals,
 * including `sourcePriority` (deliberately weighted at only 0.07, which is exactly what makes
 * "quality beats source" true rather than aspirational) and `diversity`. It was feature-flagged off
 * and imported by nothing in the live pipeline.
 *
 * ── Why this file is an adapter and not a ranker ─────────────────────────────────────────────
 *
 * FASE 17: no second search engine, no second ranking engine. So nothing here scores anything. It
 * translates one vocabulary into another and calls `rankCandidates` — the same function, the same
 * weights, the same tested behaviour. If a signal is wrong, it is wrong in one place.
 *
 * The source-token mapping is `engineSourceFor`, which `cinematicPipelineInputs` already uses for
 * exactly this translation. A second copy of that mapping would be a second opinion about what
 * "archival" means.
 */
import {
  rankCandidates,
  DEFAULT_RANKING_CONFIG,
  DEFAULT_SOURCE_PRIORITY,
} from "./visualMatchingV2/candidateRanking";
import { providerFitForNeed } from "./providerCapability";
import { classifyChannelAuthority } from "./channelAuthority";
import type { MediaForm } from "./beatVisualIntent";
import type {
  CandidateAsset,
  CandidateSource,
  RankedCandidate,
  SourcePriority,
  VisualIntent,
} from "./visualMatchingV2/types";
import { engineSourceFor } from "./cinematicPipelineInputs";

/**
 * The subset of `PoolCandidate` this adapter reads.
 *
 * Declared structurally rather than imported so that `scenePool.ts` and this module do not become
 * mutually dependent, and so a caller holding a candidate from anywhere — including a source that
 * is not yet a `PoolCandidateSource` — can be ranked without widening a union first. A test
 * asserts the two shapes stay compatible.
 */
export type RankablePoolCandidate = {
  id: string;
  assetId: string;
  source: string;
  remoteUrl: string;
  thumbnailUrl: string | null;
  title: string;
  description: string | null;
  tags: string[];
  mediaType: "video" | "image";
  durationSec: number | null;
  license: string | null;
  width: number | null;
  height: number | null;
  clipSimilarity: number | null;
  embeddingSimilarity: number | null;
  rankingScore: number | null;
  /** The query this candidate came back for, when the retrieval route recorded one. */
  searchQuery?: string;
  /**
   * The platform block, when the provider filled one. Optional everywhere: only YouTube supplies
   * it, and a candidate without it is ranked exactly as it was before this round.
   */
  youtube?: { channel?: string | null; publishedAt?: string | null } | null;
};
