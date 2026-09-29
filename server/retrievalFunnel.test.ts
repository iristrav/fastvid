import { describe, expect, it } from "vitest";
import {
  mergeCandidates,
  pickBestFunnelCandidate,
  buildDownloadShortlist,
  STOCK_TIER_WIN_MARGIN,
  MAX_FUNNEL_CANDIDATES_TO_SCORE,
  type FunnelCandidate,
  type FunnelCandidateSource,
  type ScoredFunnelCandidate,
} from "./retrievalFunnel";
import type { PoolCandidate, PoolCandidateSource } from "./scenePool";

// FASE 1 — Visual Discovery Engine: replaces "first candidate that downloads
// successfully wins" with "score every downloaded candidate with the existing
// VisionGate, then pick the best — but a stock (Pexels/Pixabay) candidate must
// not win on a merely marginal score edge over a comparable non-stock
// candidate." These tests use the exact worked examples from the spec.

function candidate(source: FunnelCandidate["source"]): FunnelCandidate {
  return {
    id: `${source}:test`,
    source,
    title: `${source} clip`,
    thumbnailUrl: null,
    mediaType: "video",
    embeddingSimilarity: null,
    archiveKeywordScore: null,
    clipSimilarity: null,
    rankingScore: 0,
  };
}

function scored(source: FunnelCandidate["source"], score: number | null, pass = true): ScoredFunnelCandidate {
  return {
    candidate: candidate(source),
    clipPath: `/tmp/${source}.mp4`,
    visionResult: { pass, worstScore10: score },
  };
}


// FASE 2 — Unified Multi-Source Discovery: historical/open sources (Internet Archive,
// Europeana, Wikimedia) get a small pre-CLIP ranking bonus over stock (Pexels/Pixabay) so
// they're more likely to land in the small top-N slice that actually gets downloaded and
// VisionGate-scored. This does NOT change who ultimately wins (pickBestFunnelCandidate,
// tested above, is unchanged) — it only changes which candidates get a chance to compete.

function poolCandidate(source: PoolCandidateSource, assetId: string): PoolCandidate {
  return {
    id: `${source}:${assetId}`,
    assetId,
    source,
    remoteUrl: `https://example.test/${source}/${assetId}`,
    thumbnailUrl: null,
    title: `${source} clip ${assetId}`,
    description: null,
    tags: [],
    mediaType: "video",
    durationSec: null,
    license: null,
    width: null,
    height: null,
    sourceCreator: null,
    licenseUrl: null,
    clipSimilarity: null,
    embeddingSimilarity: null,
    rankingScore: null,
    visionScore: null,
    selectionScore: null,
  };
}

describe("mergeCandidates — FASE 2 source-tier bonus", () => {
  it("ranks equally-fresh external candidates by source priority: internet_archive > europeana > wikimedia > pexels/pixabay", () => {
    const pool: PoolCandidate[] = [
      poolCandidate("pexels", "p1"),
      poolCandidate("pixabay", "px1"),
      poolCandidate("wikimedia", "w1"),
      poolCandidate("europeana", "e1"),
      poolCandidate("internet_archive", "ia1"),
    ];
    const merged = mergeCandidates([], [], pool, 1, 1, 10);
    const order = merged.map(c => c.source);
    expect(order[0]).toBe("internet_archive");
    expect(order[1]).toBe("europeana");
    expect(order[2]).toBe("wikimedia");
    // pexels/pixabay both carry a 0 bonus, so their relative order isn't asserted here,
    // only that both trail every historical/open source.
    expect(order.slice(3).sort()).toEqual(["pexels", "pixabay"]);
  });

  it("still respects the max cap after applying the source-tier bonus", () => {
    const pool: PoolCandidate[] = [
      poolCandidate("internet_archive", "ia1"),
      poolCandidate("europeana", "e1"),
      poolCandidate("wikimedia", "w1"),
      poolCandidate("pexels", "p1"),
    ];
    const merged = mergeCandidates([], [], pool, 1, 1, 2);
    expect(merged).toHaveLength(2);
    expect(merged.map(c => c.source)).toEqual(["internet_archive", "europeana"]);
  });

  it("does not crash or misrank a source absent from the bonus map (defensive against future new sources)", () => {
    const pool: PoolCandidate[] = [
      { ...poolCandidate("pexels", "p1"), source: "unknown_future_source" as PoolCandidateSource },
      poolCandidate("internet_archive", "ia1"),
    ];
    const merged = mergeCandidates([], [], pool, 1, 1, 10);
    expect(merged).toHaveLength(2);
    expect(merged[0].source).toBe("internet_archive");
    expect(Number.isNaN(merged[1].rankingScore)).toBe(false);
  });
});

// FASE 3 — Maximum Real Footage Discovery: NARA, Library of Congress, NASA and Openverse are
// inserted into the same pre-CLIP source-tier bonus, per the requested priority order
// (Internet Archive > NARA > Library of Congress > NASA > Openverse > Europeana > Wikimedia >
// stock). The FASE 2 sources' relative order/values must not change.

describe("mergeCandidates — FASE 3 source-tier bonus", () => {
  it("ranks all 9 external sources in the exact requested priority order", () => {
    const pool: PoolCandidate[] = [
      poolCandidate("pexels", "p1"),
      poolCandidate("pixabay", "px1"),
      poolCandidate("wikimedia", "w1"),
      poolCandidate("europeana", "e1"),
      poolCandidate("openverse", "ov1"),
      poolCandidate("nasa", "n1"),
      poolCandidate("loc", "l1"),
      poolCandidate("nara", "na1"),
      poolCandidate("internet_archive", "ia1"),
    ];
    const merged = mergeCandidates([], [], pool, 1, 1, 10);
    const order = merged.map(c => c.source);
    expect(order[0]).toBe("internet_archive");
    expect(order[1]).toBe("nara");
    expect(order[2]).toBe("loc");
    expect(order[3]).toBe("nasa");
    expect(order[4]).toBe("openverse");
    expect(order[5]).toBe("europeana");
    expect(order[6]).toBe("wikimedia");
    expect(order.slice(7).sort()).toEqual(["pexels", "pixabay"]);
  });

  it("still lets Pexels/Pixabay compete (not removed), just without a SOURCE-tier bonus", () => {
    // RONDE 27 added a media-type bonus on top of the source-tier one, and poolCandidate()
    // fixtures are mediaType "video", so the flat 0.7 became 0.78. What this test protects is
    // that the two stock providers get no SOURCE bonus and are still in the pool — both still
    // hold. Asserted as equality between the two rather than against a literal, so it keeps
    // meaning the same thing if either bonus is retuned again.
    const pool: PoolCandidate[] = [poolCandidate("pexels", "p1"), poolCandidate("pixabay", "px1")];
    const merged = mergeCandidates([], [], pool, 1, 1, 10);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.rankingScore).toBe(merged[1]!.rankingScore);
    // Strictly below the lowest-tier source that does get a bonus, on identical media type.
    const wiki = mergeCandidates([], [], [poolCandidate("wikimedia", "w1")], 1, 1, 10);
    expect(merged[0]!.rankingScore).toBeLessThan(wiki[0]!.rankingScore);
  });

  it("gives moving footage a bonus over a still from the same source", () => {
    const clip = poolCandidate("pexels", "vid1");
    const still = { ...poolCandidate("pexels", "img1"), mediaType: "image" as const };
    const merged = mergeCandidates([], [], [clip, still], 1, 1, 10);
    const byId = new Map(merged.map(c => [c.id, c.rankingScore]));
    expect(byId.get("pexels:vid1")!).toBeGreaterThan(byId.get("pexels:img1")!);
  });
});

// FASE 4 — Candidate Expansion + Global Best-of-N: replaces the flat "top-3 by rank" download
// selection with a source-diversity-aware shortlist, so a strong candidate that isn't in the
// top 3 overall (e.g. crowded out by several candidates from one source) still gets a chance
// to be downloaded and VisionGate-scored. pickBestFunnelCandidate() itself (tested above) is
// unchanged — these tests cover buildDownloadShortlist(), the new selection layer in front of it.

function funnelCandidate(source: FunnelCandidateSource, rankingScore: number, idSuffix: string): FunnelCandidate {
  return {
    id: `${source}:${idSuffix}`,
    source,
    title: `${source} ${idSuffix}`,
    thumbnailUrl: null,
    mediaType: "video",
    embeddingSimilarity: null,
    archiveKeywordScore: null,
    clipSimilarity: null,
    rankingScore,
  };
}


