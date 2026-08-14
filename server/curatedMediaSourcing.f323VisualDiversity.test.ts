import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  searchCuratedCandidatesForBeat,
  type CuratedCandidatePick,
  type CuratedBeatContext,
  type CuratedSceneContext,
} from "./curatedMediaSourcing";
import type { MediaArchiveAsset } from "../drizzle/schema";

// F3-23: scoreCuratedAsset/rankCuratedCandidatesForBeat picked the best-matching curated asset
// per beat, but searchCuratedCandidatesForBeat never consulted per-video "recently used" state
// when choosing between near-tied candidates — reorderForArchiveDiversity (Phase 10) existed and
// was already unit-tested (see curatedMediaSourcing.test.ts), but had no live call site. These
// tests prove it's now actually wired into the live ranking pipeline via a new
// `usedArchiveNames` option, using the candidatePool bypass (skips the DB scan) with
// skipSemantic:true (skips the LLM semantic pass) so the underlying real, unmocked
// scoreCuratedAsset/rankCuratedCandidatesForBeat/reorderForArchiveDiversity logic runs
// deterministically — no mocking of the reordering/scoring logic itself.
describe("searchCuratedCandidatesForBeat — F3-23 visual diversity wiring", () => {
  const origClip = process.env.ENABLE_CLIP_EMBEDDING_INDEX;
  const origSemantic = process.env.ENABLE_SEMANTIC_VISUAL_MATCH;

  beforeEach(() => {
    process.env.ENABLE_CLIP_EMBEDDING_INDEX = "false";
    process.env.ENABLE_SEMANTIC_VISUAL_MATCH = "false";
  });

  afterEach(() => {
    if (origClip === undefined) delete process.env.ENABLE_CLIP_EMBEDDING_INDEX;
    else process.env.ENABLE_CLIP_EMBEDDING_INDEX = origClip;
    if (origSemantic === undefined) delete process.env.ENABLE_SEMANTIC_VISUAL_MATCH;
    else process.env.ENABLE_SEMANTIC_VISUAL_MATCH = origSemantic;
    vi.restoreAllMocks();
  });

  const beat: CuratedBeatContext = {
    index: 0,
    text: "Soldiers and tanks advanced through the ruined city of berlin",
    keywords: ["soldiers", "tanks", "berlin"],
    searchQuery: "soldiers tanks berlin",
  };
  const scene: CuratedSceneContext = { text: beat.text, pexelsQuery: beat.searchQuery };

  function makeAsset(id: number, tags: string[]): MediaArchiveAsset {
    return {
      id,
      title: `Berlin footage ${id}`,
      tags,
      mediaType: "video",
      storageUrl: `https://example.com/asset-${id}.mp4`,
      mixKind: "video",
    } as unknown as MediaArchiveAsset;
  }

  function makePool(archiveA: string, archiveB: string): CuratedCandidatePick[] {
    // Identical tags on both assets -> scoreCuratedAsset gives them an identical score, so
    // they land in the exact same score band and only reorderForArchiveDiversity's archive
    // recency bias decides which is tried first.
    const tags = ["soldiers", "tanks", "berlin"];
    return [
      { asset: makeAsset(1, tags), archiveName: archiveA, score: 0, archiveNicheTags: [] },
      { asset: makeAsset(2, tags), archiveName: archiveB, score: 0, archiveNicheTags: [] },
    ];
  }

  it("Test 1/4 — two same-scoring candidates from different archives: the less-recently-used archive's asset is preferred", async () => {
    const candidatePool = makePool("Overused Archive", "Fresh Archive");
    const usedArchiveNames = new Map([["Overused Archive", 6]]);

    const result = await searchCuratedCandidatesForBeat(
      beat,
      scene,
      new Set(),
      new Set(),
      "Test Documentary",
      { candidatePool, skipSemantic: true, usedArchiveNames }
    );

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.archiveName).toBe("Fresh Archive");
  });

  it("Test 3 — without any usedArchiveNames signal, tied candidates keep their natural (stable) order", async () => {
    const candidatePool = makePool("Archive A", "Archive B");

    const result = await searchCuratedCandidatesForBeat(
      beat,
      scene,
      new Set(),
      new Set(),
      "Test Documentary",
      { candidatePool, skipSemantic: true }
    );

    expect(result.length).toBeGreaterThan(0);
    // No diversity signal supplied — order is whatever the deterministic scoring/pool order
    // produced, i.e. the same asset that would have won before this change (id 1, Archive A).
    expect(result[0]!.asset.id).toBe(1);
  });

  it("Test 4 — a clearly-better-matching candidate is never displaced by the diversity bias, even for an overused archive", async () => {
    const strongTags = ["soldiers", "tanks", "berlin"];
    const weakTags = ["documentary"];
    const candidatePool: CuratedCandidatePick[] = [
      { asset: makeAsset(1, strongTags), archiveName: "Overused Archive", score: 0, archiveNicheTags: [] },
      { asset: makeAsset(2, weakTags), archiveName: "Fresh Archive", score: 0, archiveNicheTags: [] },
    ];
    // Even though "Overused Archive" has been used a lot, its candidate's real content match is
    // far stronger than the weak-tag "Fresh Archive" candidate — reorderForArchiveDiversity must
    // never let the weaker match win just because it's from a fresher archive.
    const usedArchiveNames = new Map([["Overused Archive", 20]]);

    const result = await searchCuratedCandidatesForBeat(
      beat,
      scene,
      new Set(),
      new Set(),
      "Test Documentary",
      { candidatePool, skipSemantic: true, usedArchiveNames }
    );

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.asset.id).toBe(1);
  });
});
