import { describe, expect, it } from "vitest";
import {
  mergeCandidates,
  pickBestFunnelCandidate,
  STOCK_TIER_WIN_MARGIN,
  type FunnelCandidate,
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

describe("pickBestFunnelCandidate", () => {
  it("picks the best non-stock candidate over a marginally-higher-scoring Pexels candidate (8.9/8.7/9.0 example)", () => {
    const winner = pickBestFunnelCandidate([
      scored("archive", 8.9),
      scored("wikimedia", 8.7),
      scored("pexels", 9.0),
    ]);
    expect(winner?.candidate.source).toBe("archive");
  });

  it("lets a decisively-higher-scoring Pexels candidate win when it clears the margin", () => {
    const winner = pickBestFunnelCandidate([
      scored("archive", 8.9),
      scored("wikimedia", 8.7),
      scored("pexels", 8.9 + STOCK_TIER_WIN_MARGIN),
    ]);
    expect(winner?.candidate.source).toBe("pexels");
  });

  it("lets Pexels win when its score decisively clears the best non-stock score (NARA/Wikimedia/Pexels example: 6.1/7.8/9.1)", () => {
    const winner = pickBestFunnelCandidate([
      scored("archive", 6.1),
      scored("wikimedia", 7.8),
      scored("pexels", 9.1),
    ]);
    // "archive" stands in for the non-stock Tier-1 candidate here. Best non-stock is
    // Wikimedia at 7.8; Pexels' 9.1 clears 7.8 + STOCK_TIER_WIN_MARGIN (1.0) = 8.8, so
    // Pexels wins — matching the spec's own worked example ("Dan mag Pexels winnen").
    expect(winner?.candidate.source).toBe("pexels");
  });

  it("returns null when no candidate passes the vision gate — caller must fall back to existing recovery", () => {
    const winner = pickBestFunnelCandidate([
      scored("archive", 4.0, false),
      scored("pexels", 3.5, false),
    ]);
    expect(winner).toBeNull();
  });

  it("lets Pixabay win when it is the only passing candidate", () => {
    const winner = pickBestFunnelCandidate([
      scored("archive", 4.0, false),
      scored("pixabay", 7.0, true),
    ]);
    expect(winner?.candidate.source).toBe("pixabay");
  });

  it("treats a null worstScore10 as 0 instead of crashing", () => {
    const winner = pickBestFunnelCandidate([
      scored("wikimedia", null, true),
      scored("archive", 5.0, true),
    ]);
    expect(winner?.candidate.source).toBe("archive");
  });

  it("never lets a non-stock candidate lose to a worse-scoring stock candidate", () => {
    const winner = pickBestFunnelCandidate([
      scored("archive", 7.2),
      scored("wikimedia", 8.8),
      scored("pexels", 6.9),
    ]);
    expect(winner?.candidate.source).toBe("wikimedia");
  });
});

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
