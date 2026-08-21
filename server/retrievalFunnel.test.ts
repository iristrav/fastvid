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

describe("buildDownloadShortlist", () => {
  it("caps the shortlist at the requested budget even with many more diverse candidates available", () => {
    const sources: FunnelCandidateSource[] = [
      "archive", "wikimedia", "internet_archive", "europeana", "openverse",
      "nasa", "nara", "loc", "pexels", "pixabay",
    ];
    const pool = sources.flatMap((source, si) =>
      Array.from({ length: 2 }, (_, i) => funnelCandidate(source, 10 - si - i * 0.1, `${si}_${i}`))
    );
    const shortlist = buildDownloadShortlist(pool, 6);
    expect(shortlist).toHaveLength(6);
  });

  it("does not let one source monopolize the shortlist when other sources have candidates", () => {
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => funnelCandidate("archive", 9 - i * 0.1, `a${i}`)),
      funnelCandidate("wikimedia", 7.0, "w1"),
      funnelCandidate("nasa", 6.9, "n1"),
      funnelCandidate("nara", 6.8, "na1"),
    ];
    const shortlist = buildDownloadShortlist(pool, 6);
    const archiveCount = shortlist.filter(c => c.source === "archive").length;
    expect(archiveCount).toBeLessThanOrEqual(2);
    expect(shortlist.some(c => c.source === "wikimedia")).toBe(true);
    expect(shortlist.some(c => c.source === "nasa")).toBe(true);
    expect(shortlist.some(c => c.source === "nara")).toBe(true);
  });

  it("caps stock (Pexels/Pixabay) at 1 slot each even when they rank highest", () => {
    const pool = [
      funnelCandidate("pexels", 9.9, "p1"),
      funnelCandidate("pexels", 9.8, "p2"),
      funnelCandidate("pixabay", 9.7, "px1"),
      funnelCandidate("pixabay", 9.6, "px2"),
      funnelCandidate("archive", 7.0, "a1"),
      funnelCandidate("wikimedia", 6.9, "w1"),
    ];
    const shortlist = buildDownloadShortlist(pool, 6);
    expect(shortlist.filter(c => c.source === "pexels")).toHaveLength(1);
    expect(shortlist.filter(c => c.source === "pixabay")).toHaveLength(1);
    // The archive/wikimedia candidates must still get their slots, not be crowded out by stock.
    expect(shortlist.some(c => c.source === "archive")).toBe(true);
    expect(shortlist.some(c => c.source === "wikimedia")).toBe(true);
  });

  it("does not force-fill the budget past a source's cap even when the pool is homogeneous (avoids redundant near-duplicate downloads)", () => {
    const pool = Array.from({ length: 6 }, (_, i) => funnelCandidate("pexels", 9 - i * 0.1, `p${i}`));
    const shortlist = buildDownloadShortlist(pool, 6);
    // Budget is a ceiling, not a fill target: with only Pexels candidates available, the
    // shortlist stays at Pexels' cap (1) instead of downloading 6 near-duplicate stock clips
    // just to hit the budget number — matches STAP 16 ("niet te veel downloaden").
    expect(shortlist).toHaveLength(1);
    expect(shortlist[0].source).toBe("pexels");
  });

  it("keeps relevance as the primary signal: best-ranked candidate per source is chosen first", () => {
    const pool = [
      funnelCandidate("archive", 5.0, "a-low"),
      funnelCandidate("archive", 9.0, "a-high"),
      funnelCandidate("archive", 7.0, "a-mid"),
    ];
    const shortlist = buildDownloadShortlist(pool, 2);
    expect(shortlist.map(c => c.id).sort()).toEqual(["archive:a-high", "archive:a-mid"].sort());
  });

  it("returns an empty list for an empty candidate pool", () => {
    expect(buildDownloadShortlist([], 6)).toEqual([]);
  });

  it("returns an empty list for a zero or negative budget", () => {
    const pool = [funnelCandidate("archive", 9.0, "a1")];
    expect(buildDownloadShortlist(pool, 0)).toEqual([]);
    expect(buildDownloadShortlist(pool, -1)).toEqual([]);
  });

  it("returns fewer than the budget when fewer candidates exist, without crashing", () => {
    const pool = [funnelCandidate("archive", 9.0, "a1"), funnelCandidate("wikimedia", 8.0, "w1")];
    const shortlist = buildDownloadShortlist(pool, MAX_FUNNEL_CANDIDATES_TO_SCORE);
    expect(shortlist).toHaveLength(2);
  });
});

describe("pickBestFunnelCandidate — FASE 4 global best-of-N over a wider shortlist", () => {
  it("compares 5 scored candidates at once and picks the true best (C=9.1 wins over A=7.2/B=8.4/D=7.0/E=6.5)", () => {
    const winner = pickBestFunnelCandidate([
      scored("archive", 7.2),
      scored("wikimedia", 8.4),
      scored("internet_archive", 9.1),
      scored("nasa", 7.0),
      scored("nara", 6.5),
    ]);
    expect(winner?.candidate.source).toBe("internet_archive");
  });

  it("a candidate that ranked lower in metadata order can still win on VisionGate score", () => {
    // Simulates: metadata ranking put "wikimedia" ahead of "nara" (source-tier bonus), but
    // nara's actual downloaded clip scores decisively higher under VisionGate.
    const winner = pickBestFunnelCandidate([
      scored("wikimedia", 6.8),
      scored("nara", 9.2),
    ]);
    expect(winner?.candidate.source).toBe("nara");
  });

  it("stock policy over a wider pool: Pexels must NOT win without clearing the margin (Archive=7.8/Wikimedia=8.4/NASA=8.9/Pexels=9.0)", () => {
    const winner = pickBestFunnelCandidate([
      scored("archive", 7.8),
      scored("wikimedia", 8.4),
      scored("nasa", 8.9),
      scored("pexels", 9.0),
    ]);
    // Best non-stock is NASA at 8.9; Pexels' 9.0 does not clear 8.9 + 1.0 = 9.9.
    expect(winner?.candidate.source).toBe("nasa");
  });

  it("stock policy over a wider pool: Pexels wins when it decisively clears the margin (Archive=6.1/Wikimedia=7.8/Pexels=9.1)", () => {
    const winner = pickBestFunnelCandidate([
      scored("archive", 6.1),
      scored("wikimedia", 7.8),
      scored("pexels", 9.1),
    ]);
    expect(winner?.candidate.source).toBe("pexels");
  });
});
