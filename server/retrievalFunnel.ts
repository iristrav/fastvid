/**
 * Retrieval Funnel Engine — hybrid parallel retrieval with coverage-based weighting.
 *
 * All sources (own archive + Wikimedia + Pexels + Pixabay) are queried in parallel.
 * The archive's embedding similarity against the beat query determines an
 * `archiveCoverage` score (0–1) which automatically shifts the weight balance:
 *
 *   coverage > 0.88 → archive_dominant (archive weight 1.0, internet weight 0.3)
 *   coverage 0.45–0.88 → hybrid (weights proportional to coverage)
 *   coverage < 0.45 → internet_dominant (archive weight 0.3, internet weight 1.0)
 *
 * The user never sees "no results" from the archive — when coverage is low, internet
 * sources simply carry more weight and the archive fades out gracefully.
 *
 * Entry point: buildRetrievalFunnel(request) → RetrievalFunnelResult
 *
 * Feature flag: ENABLE_RETRIEVAL_FUNNEL=true (also requires ENABLE_SCENE_CANDIDATE_POOL=true).
 */

import {
  buildTopicMatcher,
  assessCandidateTopicality,
  topicalRankingBonus,
  type TopicMatcher,
} from "./candidateTopicalRelevance";
import {
  listCuratedArchiveCandidates,
  buildBeatMatchTags,
  applyCrossVideoVarietyDegrade,
  stubPowerWordFromSceneText,
  extractTopicAnchorTags,
  type CuratedCandidatePick,
} from "./curatedMediaSourcing";
import {
  scoreBeatAgainstStoredEmbedding,
  loadStoredAssetEmbedding,
} from "./archiveEmbeddingIndex";
import { cosineSimilarityVectors } from "./semanticVisualMatching";
import {
  matchCandidateToBeat,
  type BeatTemporalContext,
} from "./candidatePeriodMatch";
import {
  formatSearchMemoryLine,
  mergeRecalledIntoArchivePicks,
  recallProvenAssetsForEntity,
  type SearchMemoryRecallMetrics,
} from "./searchMemoryRecall";
import {
  recordShortlistStage,
  type ArchiveSourcingAudit,
} from "./archiveSourcingAudit";

import { type PoolCandidate } from "./scenePool";

// ─── Types ────────────────────────────────────────────────────────────────────

export type FunnelCandidateSource =
  | "archive"
  | "pexels"
  | "pixabay"
  | "wikimedia"
  | "internet_archive"
  | "europeana"
  | "openverse"
  | "nasa"
  | "nara"
  | "loc"
  /** RONDE 169 — YouTube is a pool source now, so the funnel counts it like any other. */
  | "youtube_cc";

export type FunnelStrategy =
  | "archive_dominant"   // coverage > ARCHIVE_DOMINANT_THRESHOLD
  | "hybrid"             // coverage between thresholds
  | "internet_dominant"; // coverage < INTERNET_DOMINANT_THRESHOLD

/**
 * Unified candidate from any retrieval source.
 * Archive candidates carry an `archivePick`; external ones carry a `poolCandidate`.
 * Exactly one of the two is present.
 */
export type FunnelCandidate = {
  /** Stable dedup key. */
  id: string;
  source: FunnelCandidateSource;
  title: string;
  thumbnailUrl: string | null;
  mediaType: "video" | "image";

  // ── Ranking scores ──────────────────────────────────────────────────────────
  /** Cosine similarity of beat-text embedding vs asset embedding (0–1, null when not indexed). */
  embeddingSimilarity: number | null;
  /** Keyword-match score from the archive ranker (0–N, null for external). */
  archiveKeywordScore: number | null;
  /** CLIP image-text similarity (filled by P2 thumbnail ranking). */
  clipSimilarity: number | null;
  /** Final merged score after source-weight application. */
  rankingScore: number;

  // ── Payload for download step ───────────────────────────────────────────────
  /** Set when source === "archive" — pass to fetchCuratedArchiveBeatClip. */
  archivePick?: CuratedCandidatePick;
  /** Set when source !== "archive" — pass to downloadAndTrimPoolCandidate. */
  poolCandidate?: PoolCandidate;

  // ── Self-learning: per-beat scoring ────────────────────────────────────────
  /**
   * Pre-loaded text embedding for this asset (archive only).
   * Used by scoreFunnelCandidateForBeat() to do fast in-memory per-beat cosine
   * similarity without extra API calls.
   */
  storedEmbedding?: number[];
};

export type FunnelMetrics = {
  retrievalLatencyMs: number;
  archiveCoverage: number;
  strategy: FunnelStrategy;
  archiveCandidateCount: number;
  externalCandidateCount: number;
  mergedCount: number;
  finalCount: number;
  embeddingScoredCount: number;
};

export type RetrievalFunnelResult = {
  sceneIndex: number;
  candidates: FunnelCandidate[];
  archiveCoverage: number;
  strategy: FunnelStrategy;
  metrics: FunnelMetrics;
};

/** When the archive has NO embedding index at all, fall back to normalised keyword
 *  score.  The keyword scorer returns raw integer points — 100 pts ~ good match. */
const KEYWORD_SCORE_MAX = 100;

/** FASE 2/3 source priority (own archive is handled separately, always highest):
 *  historical/open sources get a small pre-CLIP ranking bonus over stock (Pexels/Pixabay), so
 *  they're more likely to land in the small top-N slice that actually gets downloaded and
 *  scored — without touching VisionGate or the final pickBestFunnelCandidate() margin logic,
 *  which still decides the real winner. FASE 3 inserts NARA/Library of Congress/NASA/Openverse
 *  between Internet Archive and Europeana, per the requested priority order (Internet Archive
 *  > NARA > Library of Congress > NASA > Openverse > Europeana > Wikimedia > stock); the FASE 2
 *  values for internet_archive/europeana/wikimedia/pexels/pixabay are left unchanged. */
/**
 * YOUTUBE WAS NOT IN THIS TABLE AT ALL, AND `?? 0` PUT IT IN THE STOCK TIER.
 *
 * ── The reading that matters ────────────────────────────────────────────────────────────────
 *
 * The lookup below is `EXTERNAL_SOURCE_TIER_BONUS[c.source] ?? 0`. `youtube_cc` arrived later
 * than this table (RONDE 169/170/175 built the pool route) and no entry was ever added for it, so
 * every YouTube candidate scored `0.7 + 0` — the same tier as Pexels and Pixabay, and BELOW all
 * seven historical sources, Wikimedia's 0.10 included. Not a bonus set too low: a missing row,
 * defaulting silently to the bottom.
 *
 * That is the second half of what kept YouTube to one beat of nineteen in render 577. The
 * shortlist cap decided how many chances YouTube could have; this decided whether it ever ranked
 * high enough to use them, and `buildDownloadShortlist` fills in `rankingScore` order.
 *
 * ── Why above internet_archive and not merely present ───────────────────────────────────────
 *
 * The operator's brief is a film made mostly of YouTube footage. Simply adding YouTube at, say,
 * 0.13 would slot it mid-table and leave the Internet Archive ranking first, which answers a
 * different question than the one asked. The whole existing spread from best to worst historical
 * source is 0.05 (0.15 down to 0.10), so a margin of 0.07 over the top of that table is decisive
 * rather than marginal — which is the point, and is why it is stated here as a number with a
 * reason instead of tuned until a render looked right.
 *
 * ── What a bonus cannot do ──────────────────────────────────────────────────────────────────
 *
 * It moves candidates up the shortlist, and nothing else. `assessCandidateTopicality` still drops
 * an off-topic candidate before this line is reached — a bonus never rescues material that does
 * not match the beat — the per-source cap still bounds how many YouTube candidates may be
 * shortlisted, the download budget still bounds the shortlist, and `pickBestFunnelCandidate`
 * still picks the winner on real VisionGate scores. A YouTube clip the picture editor refuses is
 * still refused.
 */
export function youtubeSourceTierBonus(): number {
  const raw = process.env.YOUTUBE_TIER_BONUS?.trim();
  if (raw) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return 0.22;
}

const EXTERNAL_SOURCE_TIER_BONUS: Partial<Record<FunnelCandidateSource, number>> = {
  /** Read through the accessor so an operator can dial it — see `youtubeSourceTierBonus`. */
  get youtube_cc() {
    return youtubeSourceTierBonus();
  },
  internet_archive: 0.15,
  nara: 0.145,
  loc: 0.14,
  nasa: 0.135,
  openverse: 0.125,
  europeana: 0.12,
  wikimedia: 0.10,
  pexels: 0,
  pixabay: 0,
};

/**
 * RONDE 27: nudge toward footage that actually moves.
 *
 * Render 528's final cut was 18 clips of which 7 were stills panned with Ken Burns — Wikimedia
 * photographs of Hitler, a Bundesarchiv plate, a curated still — because for this topic the
 * best-MATCHING material is photographic while the moving material is mostly generic stock.
 *
 * This is deliberately a shortlist nudge, not a veto. rankingScore decides which candidates get
 * downloaded and CLIP-scored at all (MAX_FUNNEL_CANDIDATES_TO_SCORE); the winner is still chosen
 * by pickBestFunnelCandidate on real VisionGate scores. So a clip gets a better chance to be
 * CONSIDERED, and a well-matching still still beats a poorly-matching clip. Sized at roughly half
 * a source-tier step (the tier bonuses above span 0–0.15) — pushing harder would trade the user's
 * "everything should match" against their "more video", which is the wrong trade to make blind.
 */
const MOVING_FOOTAGE_BONUS = 0.08;

/**
 * RONDE 29: the bonus now knows how the render is actually going.
 *
 * RONDE 27 applied a flat nudge whether the montage was already all video or all stills — it
 * could not tell the difference, because nothing measured the result. `deficit` (0–1, from
 * visualMixPolicy.movingShareDeficit) closes that loop: 0 when the render is at or above its
 * moving-footage target, rising to 1 when nothing adopted so far moves.
 *
 * The bonus scales between 1× and 2× the base — so at most 0.16, still inside a single
 * source-tier step (the tier bonuses span 0–0.15). A render on target behaves exactly as it did
 * before this change; only a render drifting toward an all-stills montage pulls harder. Still a
 * shortlist nudge, never a veto: the winner is decided by pickBestFunnelCandidate on real
 * VisionGate scores, so a well-matching still continues to beat a poorly-matching clip.
 */
function movingFootageBonus(mediaType: "video" | "image", deficit = 0): number {
  if (mediaType !== "video") return 0;
  let base = MOVING_FOOTAGE_BONUS;
  if (process.env.MOVING_FOOTAGE_BONUS?.trim()) {
    const n = parseFloat(process.env.MOVING_FOOTAGE_BONUS.trim());
    if (!isNaN(n) && n >= 0 && n <= 0.5) base = n;
  }
  return base * (1 + Math.max(0, Math.min(1, deficit)));
}

// ─── Merge + dedup ────────────────────────────────────────────────────────────

function archiveCandidateId(pick: CuratedCandidatePick): string {
  return `archive:${pick.asset.id}`;
}

export function mergeCandidates(
  archivePicks: CuratedCandidatePick[],
  archiveEmbSims: (number | null)[],
  externalPool: PoolCandidate[],
  archiveWeight: number,
  internetWeight: number,
  max: number,
  /** RONDE 29: 0–1 shortfall against the render's moving-footage target. 0 = neutral. */
  movingDeficit = 0,
  /**
   * RONDE 54: what this video is about, so an external candidate can be judged on the words its
   * own provider attached to it. Optional — omitted, every candidate is treated as unjudgeable
   * and the ranking is exactly what it was.
   */
  topicMatcher?: TopicMatcher,
  /**
   * RONDE 175 §2: the years, places and subjects this beat is established to be about.
   *
   * Optional for the same reason as topicMatcher — omitted, every candidate scores exactly as it
   * did before, because absence of period information is neutral by design.
   */
  beatTemporalContext?: BeatTemporalContext
): FunnelCandidate[] {
  const seen = new Set<string>();
  const merged: FunnelCandidate[] = [];
  /** RONDE 54: external candidates whose metadata argues against them. */
  const offTopic: Array<{ candidate: PoolCandidate; reason: string }> = [];

  // Archive candidates
  for (let i = 0; i < archivePicks.length; i++) {
    const pick = archivePicks[i];
    const id = archiveCandidateId(pick);
    if (seen.has(id)) continue;
    seen.add(id);

    const embSim = archiveEmbSims[i] ?? null;
    // Base score: normalised keyword match (0–1) × archive weight
    const kwBase = Math.min(1, pick.score / KEYWORD_SCORE_MAX);
    const embBoost = embSim !== null ? embSim * 0.4 : 0;
    const archiveMediaType = (pick.asset.mediaType === "video" ? "video" : "image") as "video" | "image";
    /**
     * RONDE 175 §2 — what the candidate says about its own period, place and subject.
     *
     * Applied to the archive too, and not only to stock: an archive holding a 1945 reel is no
     * better a fit for a 1926 beat than a stock clip would be. Absence is neutral, so the
     * catalogue-numbered titles this archive is full of ("Bundesarchiv Bild 183-S33882") score
     * exactly as they did before.
     */
    const archiveMatch = matchCandidateToBeat(
      [pick.asset.title, (pick.asset as { description?: string }).description, pick.archiveName]
        .filter(Boolean)
        .join(" "),
      beatTemporalContext
    );
    const rankingScore =
      (kwBase + embBoost + movingFootageBonus(archiveMediaType, movingDeficit) + archiveMatch.bonus) *
      archiveWeight;

    // Load stored embedding for fast per-beat cosine scoring (no extra API call)
    const storedEmb = loadStoredAssetEmbedding(pick.asset.id);

    merged.push({
      id,
      source: "archive",
      title: pick.asset.title ?? "archive clip",
      thumbnailUrl: null, // archive assets don't expose thumbnail URLs
      mediaType: archiveMediaType,
      embeddingSimilarity: embSim,
      archiveKeywordScore: pick.score,
      clipSimilarity: null,
      rankingScore,
      archivePick: pick,
      storedEmbedding: storedEmb?.embedding,
    });
  }

  // External candidates
  for (const c of externalPool) {
    const id = c.id;
    if (seen.has(id)) continue;
    seen.add(id);

    // FASE 2 / STAP 7: pre-CLIP source priority. All external candidates previously got the
    // exact same flat score (internetWeight * 0.7) regardless of provider, so historical/open
    // sources (Wikimedia, Internet Archive, Europeana) had no better a chance than Pexels/
    // Pixabay of landing in the small top-N slice that actually gets downloaded and CLIP-scored
    // (see videoPipeline.ts's MAX_FUNNEL_CANDIDATES_TO_SCORE cap). This bonus only affects which
    // candidates make that shortlist — the actual winner is still decided by
    // pickBestFunnelCandidate() on real VisionGate scores, unchanged.
    // RONDE 54: the candidate's own metadata finally gets a vote. Until now every external
    // candidate scored identically here regardless of subject, so "white-lives-matter-montana-
    // sticker" and "Signed Photograph of Adolf Hitler" arrived at the CLIP tie-break level —
    // and CLIP scored the sticker HIGHER (0.2226 vs 0.2116 in render 531).
    const topical = topicMatcher ? assessCandidateTopicality(c, topicMatcher) : null;
    if (topical?.verdict === "off_topic") {
      offTopic.push({ candidate: c, reason: topical.reason });
      continue;
    }
    const rankingScore =
      internetWeight *
      (0.7 +
        (EXTERNAL_SOURCE_TIER_BONUS[c.source] ?? 0) +
        movingFootageBonus(c.mediaType, movingDeficit) +
        // RONDE 175 §2: agreement on year, place or subject lifts; a year that genuinely conflicts
        // costs. Saying nothing costs nothing.
        matchCandidateToBeat(`${c.title ?? ""} ${c.assetId ?? ""}`, beatTemporalContext).bonus +
        topicalRankingBonus(topical?.verdict ?? "neutral"));
    merged.push({
      id,
      source: c.source as FunnelCandidateSource,
      title: c.title,
      thumbnailUrl: c.thumbnailUrl,
      mediaType: c.mediaType,
      embeddingSimilarity: null,
      archiveKeywordScore: null,
      clipSimilarity: null,
      rankingScore,
      poolCandidate: c,
    });
  }

  // RONDE 54: never starve a scene. A beat with no candidates becomes a colour card, which is
  // worse than a weak clip — so when the topical filter would leave nothing, the rejects come
  // back and the ranking penalty decides the order instead. Same principle as the archive's
  // exhaustion rule.
  if (merged.length === 0 && offTopic.length > 0) {
    console.warn(
      `[Funnel] every external candidate read as off-topic (${offTopic.length}) — keeping them ` +
        `rather than leaving the scene empty: ${offTopic.slice(0, 3).map((o) => o.reason).join(" | ")}`
    );
    for (const { candidate: c } of offTopic) {
      merged.push({
        id: `${c.source}:${c.assetId}`,
        source: c.source as FunnelCandidateSource,
        title: c.title,
        thumbnailUrl: c.thumbnailUrl,
        mediaType: c.mediaType,
        embeddingSimilarity: null,
        archiveKeywordScore: null,
        clipSimilarity: null,
        rankingScore: internetWeight * 0.2,
        poolCandidate: c,
      });
    }
  } else if (offTopic.length > 0) {
    console.log(
      `[Funnel] dropped ${offTopic.length} off-topic candidate(s): ` +
        offTopic.slice(0, 4).map((o) => `"${(o.candidate.title || o.candidate.assetId).slice(0, 40)}" (${o.reason})`).join(", ")
    );
  }

  merged.sort((a, b) => b.rankingScore - a.rankingScore);
  return merged.slice(0, max);
}

const STOCK_SOURCES = new Set<FunnelCandidateSource>(["pexels", "pixabay"]);

/** Is this one of the commissioned stock libraries the diversity cap was written against? */
export function isStockSource(source: string): boolean {
  return STOCK_SOURCES.has(source.trim().toLowerCase() as FunnelCandidateSource);
}

/**
 * RONDE 65: score spread below which the CLIP ranking is treated as noise.
 *
 * One point on a 0-10 integer scale is 0.025 of cosine similarity — smaller than the gap render
 * 531 measured between a modern political sticker and a photograph of the subject himself.
 */
function scoreSpreadEnv(fallback: number): number {
  // Deliberately NOT envThreshold: that clamps to 0..1, which is right for a similarity and
  // wrong for a gap on a 0-10 point scale.
  const raw = process.env.NON_DISCRIMINATING_SCORE_SPREAD?.trim();
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : fallback;
}
const NON_DISCRIMINATING_SCORE_SPREAD = scoreSpreadEnv(1);
