/**
 * RONDE 132 §2/§11/§12 — the same picture, coming back.
 *
 * ── What was already right ───────────────────────────────────────────────────────────────────
 *
 * FastVid does not lack dedup sets. RONDE 34 wrote the scopes down and they still hold:
 * `usedContentKeys` at the adopt point, `usedCuratedAssetIds` for archive rows,
 * `usedCuratedStorageUrls` for the files behind them, `usedFunnelCandidateIds` for funnel ids.
 * Between them the same footage could not reach the timeline twice, and did not.
 *
 * ── The leak ─────────────────────────────────────────────────────────────────────────────────
 *
 * They are written by whichever route happens to run, and one of them had a single writer:
 *
 *     dedup.usedCuratedAssetIds.add(...)     ← ONE call site, the older archive scan
 *     dedup.usedFunnelCandidateIds.add(...)  ← the funnel, four call sites
 *
 * The funnel is the primary path. So an archive asset adopted through the funnel was recorded as a
 * used FUNNEL CANDIDATE and never as a used ARCHIVE ASSET, and everything asking the archive-asset
 * question was blind to it — including RONDE 131's search memory, whose exclude set is exactly
 * that Set. A memory could therefore hand back a picture this very video had already used, which
 * is the one thing §11 says it must never do.
 *
 * `usedContentKeys` still caught it at adopt time, so nothing shipped twice. But it was caught
 * AFTER the download and the vision call, in one of the six shortlist slots the beat gets — paid
 * for in budget, in a slot a different picture could have filled.
 *
 * ── What changed ─────────────────────────────────────────────────────────────────────────────
 *
 * One reader and one writer over the sets that already exist. No new storage, no second system:
 * `assetUsedInVideo` asks all of them and says which matched, `markAssetUsedInVideo` writes all of
 * them so no route can record one identity and miss another.
 */
import { describe, expect, it } from "vitest";

import {
  assetUsedInVideo,
  createVisualDedupStats,
  formatControlledReuse,
  formatVisualDedupReject,
  formatVisualDedupSummary,
  markAssetUsedInVideo,
  noteDuplicateAttempt,
  type UsedAssetSets,
} from "./visualDedupRegistry";
import { orderForDiversity, recallProvenAssetsForEntity } from "./searchMemoryRecall";
import type { ProvenAssetMemory } from "./visualSearchMemory";
import type { ArchiveAssetRow } from "./curatedMediaSourcing";

const sets = (): UsedAssetSets => ({
  usedContentKeys: new Set(),
  usedCuratedAssetIds: new Set(),
  usedCuratedStorageUrls: new Set(),
  usedProviderKeys: new Set(),
  usedFunnelCandidateIds: new Set(),
});

/* ═══════════════════════ A–F: the brief's dedup cases ═══════════════════════ */

describe("RONDE 132 §2 — a picture used once is not offered again", () => {
  it("A. the same asset offered twice: the second is refused", () => {
    const s = sets();
    const asset = { archiveAssetId: 101, contentKey: "curated:asset:101" };
    expect(assetUsedInVideo(s, asset).used).toBe(false);
    markAssetUsedInVideo(s, asset);
    expect(assetUsedInVideo(s, asset)).toEqual({ used: true, matchedOn: "archive_asset_id" });
  });

  it("B. the same asset via memory AND via the archive scan is used once", () => {
    /**
     * THE LEAK, as behaviour. The funnel adopts asset 101 and records it. The memory then offers
     * the same asset to a later beat — and is refused, because the funnel now writes the identity
     * the memory's exclude set is built from.
     */
    const s = sets();
    // Funnel adopt: every identity, which is what this round changed.
    markAssetUsedInVideo(s, {
      funnelCandidateId: "archive:101",
      archiveAssetId: 101,
      contentKey: "curated:asset:101",
    });
    // Memory, a later beat, same asset.
    expect(assetUsedInVideo(s, { archiveAssetId: 101 }).used).toBe(true);
    // ...and the archive scan too.
    expect(s.usedCuratedAssetIds.has(101)).toBe(true);
  });

  it("BEFORE: recording only the funnel id left the archive-asset question unanswered", () => {
    // The old behaviour, stated so the fix cannot be read as cosmetic.
    const s = sets();
    s.usedFunnelCandidateIds.add("archive:101");
    expect(assetUsedInVideo(s, { archiveAssetId: 101 }).used).toBe(false);
    // Which is exactly what let memory hand it back.
  });

  it("C. the same file under two different asset rows is caught on the storage URL", () => {
    const s = sets();
    markAssetUsedInVideo(s, { archiveAssetId: 101, storageUrl: "s3://bucket/goering.mp4" });
    // A DIFFERENT row (id 202) pointing at the same file.
    expect(assetUsedInVideo(s, { archiveAssetId: 202, storageUrl: "s3://bucket/goering.mp4" }))
      .toEqual({ used: true, matchedOn: "storage_url" });
  });

  it("C2. the same provider asset reached by two routes is caught on provider+id", () => {
    const s = sets();
    markAssetUsedInVideo(s, { provider: "wikimedia", providerAssetId: "File_Goering.jpg" });
    expect(assetUsedInVideo(s, { provider: "WIKIMEDIA", providerAssetId: " File_Goering.jpg " }))
      .toEqual({ used: true, matchedOn: "provider_asset_id" });
  });

  it("D. different clips from the same provider are all allowed", () => {
    // The rule is about the same PICTURE, never about the same source.
    const s = sets();
    markAssetUsedInVideo(s, { provider: "wikimedia", providerAssetId: "A.jpg" });
    for (const id of ["B.jpg", "C.jpg", "D.jpg"]) {
      expect(assetUsedInVideo(s, { provider: "wikimedia", providerAssetId: id }).used, id).toBe(false);
    }
  });

  it("E. with alternatives available, nothing is reused", () => {
    const s = sets();
    for (const id of [101, 102, 103]) markAssetUsedInVideo(s, { archiveAssetId: id });
    expect(assetUsedInVideo(s, { archiveAssetId: 104 }).used).toBe(false);
  });

  it("F. controlled reuse is possible but must announce itself", () => {
    /**
     * §2 allows reuse only when nothing else is left, and demands it be logged. A silent reuse is
     * indistinguishable from the bug this round fixes, which is the whole reason for the line.
     */
    const line = formatControlledReuse({
      videoId: 556,
      beat: "s2b3",
      asset: "curated:asset:101",
      reason: "no_alternative_candidate",
    });
    expect(line).toContain("status=CONTROLLED_REUSE");
    expect(line).toContain("reason=no_alternative_candidate");
    expect(line).toContain("video=556");
  });

  it("an identity FastVid does not have never matches by accident", () => {
    // Empty, blank and null identities must not collide with each other.
    const s = sets();
    markAssetUsedInVideo(s, { contentKey: "  ", storageUrl: "", providerAssetId: "x" });
    expect(assetUsedInVideo(s, { contentKey: "" }).used).toBe(false);
    expect(assetUsedInVideo(s, { storageUrl: "   " }).used).toBe(false);
    expect(assetUsedInVideo(s, {}).used).toBe(false);
    // provider without id, and id without provider, are both incomplete.
    expect(assetUsedInVideo(s, { providerAssetId: "x" }).used).toBe(false);
    expect(assetUsedInVideo(s, { provider: "wikimedia" }).used).toBe(false);
  });

  it("a non-integer archive id is never recorded", () => {
    const s = sets();
    markAssetUsedInVideo(s, { archiveAssetId: 1.5 });
    expect(s.usedCuratedAssetIds.size).toBe(0);
  });
});

/* ═══════════════════════ the log lines §2 asks for ═══════════════════════ */

describe("RONDE 132 §2 — the refusal is visible", () => {
  it("names the video, the beat, the asset and WHICH identity matched", () => {
    expect(
      formatVisualDedupReject({
        videoId: 556,
        beat: "s2b3",
        asset: "curated:asset:101",
        matchedOn: "archive_asset_id",
      })
    ).toBe(
      "[VisualDedup] video=556 beat=s2b3 asset=curated:asset:101 " +
        "status=REJECTED reason=already_used_in_video matchedOn=archive_asset_id"
    );
  });

  it("the summary counts unique against duplicate attempts, split by identity", () => {
    /**
     * `matchedOn` in the summary is what makes a rise attributable: an archive-asset match and a
     * content-key match are two different stories about where the repeat came from.
     */
    const stats = createVisualDedupStats();
    stats.uniqueAssets = 14;
    stats.reusedAssets = 1;
    noteDuplicateAttempt(stats, "archive_asset_id");
    noteDuplicateAttempt(stats, "archive_asset_id");
    noteDuplicateAttempt(stats, "content_key");
    const line = formatVisualDedupSummary(556, stats);
    expect(line).toContain("uniqueAssets=14");
    expect(line).toContain("reusedAssets=1");
    expect(line).toContain("duplicateAttempts=3");
    expect(line).toContain("archive_asset_id=2");
    expect(line).toContain("content_key=1");
    // Identities that caught nothing are left out rather than printed as zeros.
    expect(line).not.toContain("storage_url");
  });

  it("a render with no duplicates says so cleanly", () => {
    const stats = createVisualDedupStats();
    stats.uniqueAssets = 16;
    expect(formatVisualDedupSummary(556, stats)).toBe(
      "[VisualDedup] video=556 uniqueAssets=16 reusedAssets=0 duplicateAttempts=0"
    );
  });
});

/* ═══════════════════════ P/Q: memory obeys the video ═══════════════════════ */

describe("RONDE 132 §11 — the used-asset set outranks the memory", () => {
  const memory = (assetId: number, usageCount = 1): ProvenAssetMemory => ({
    assetId,
    query: `q${assetId}`,
    source: "curated_archive",
    usageCount,
    qualityScore: 80,
  });
  const archiveRow = (id: number) =>
    ({ id, archiveId: 1, title: `asset ${id}`, mediaType: "video" }) as unknown as ArchiveAssetRow;

  it("P. a proven memory asset is offered when the video has not used it", async () => {
    const out = await recallProvenAssetsForEntity("Hermann Göring", {
      readMemory: async () => [memory(101), memory(102)],
      loadAssets: async (ids) => ids.map(archiveRow),
      resolveArchiveName: async () => "Bundesarchiv",
    });
    expect(out.map((r) => r.pick.asset.id)).toEqual([101, 102]);
  });

  it("Q. a memory asset already used is skipped and the NEXT one is offered", async () => {
    const excluded: number[] = [];
    const out = await recallProvenAssetsForEntity("Hermann Göring", {
      excludeAssetIds: new Set([101]),
      onExcluded: (m) => excluded.push(m.assetId),
      readMemory: async () => [memory(101), memory(102)],
      loadAssets: async (ids) => ids.map(archiveRow),
      resolveArchiveName: async () => "Bundesarchiv",
    });
    expect(out.map((r) => r.pick.asset.id)).toEqual([102]);
    // And the refusal is reported rather than filtered away in silence: a working exclude set
    // must not look identical to an empty memory.
    expect(excluded).toEqual([101]);
  });

  it("every memory asset already used yields nothing, loudly", async () => {
    const excluded: number[] = [];
    const out = await recallProvenAssetsForEntity("Hermann Göring", {
      excludeAssetIds: new Set([101, 102]),
      onExcluded: (m) => excluded.push(m.assetId),
      readMemory: async () => [memory(101), memory(102)],
      loadAssets: async (ids) => ids.map(archiveRow),
      resolveArchiveName: async () => "Bundesarchiv",
    });
    expect(out).toEqual([]);
    expect(excluded.sort()).toEqual([101, 102]);
  });
});

/* ═══════════════════════ §11/§12: diversity without losing evidence ═══════════════════════ */

describe("RONDE 132 §11 — ten proven assets do not always yield asset #1", () => {
  const m = (assetId: number, usageCount: number): ProvenAssetMemory => ({
    assetId,
    query: "q",
    source: "curated_archive",
    usageCount,
    qualityScore: 80,
  });

  it("rotates WITHIN a usage tier, so the evidence ordering is untouched", () => {
    /**
     * The constraint that keeps this from being a quality regression: a less-proven asset must
     * never be offered over a better-proven one. Only the order among EQUALLY proven assets moves.
     */
    const pool = [m(1, 5), m(2, 5), m(3, 5), m(4, 2), m(5, 2)];
    for (const seed of [0, 1, 2, 3, 7]) {
      const ordered = orderForDiversity(pool, seed);
      const usages = ordered.map((x) => x.usageCount);
      // Still descending by usage: tier 5 first, then tier 2, every time.
      expect(usages, `seed=${seed}`).toEqual([5, 5, 5, 2, 2]);
    }
  });

  it("a different seed leads with a different asset", () => {
    const pool = [m(1, 5), m(2, 5), m(3, 5)];
    expect(orderForDiversity(pool, 1).map((x) => x.assetId)).toEqual([2, 3, 1]);
    expect(orderForDiversity(pool, 2).map((x) => x.assetId)).toEqual([3, 1, 2]);
    // ...and every asset is still offered, none dropped.
    expect(orderForDiversity(pool, 2).map((x) => x.assetId).sort()).toEqual([1, 2, 3]);
  });

  it("seed 0 changes nothing at all", () => {
    // A caller that does not ask for variety must not get any.
    const pool = [m(1, 5), m(2, 5)];
    expect(orderForDiversity(pool, 0)).toBe(pool);
  });

  it("a single asset and an empty memory are left alone", () => {
    expect(orderForDiversity([], 3)).toEqual([]);
    const one = [m(1, 5)];
    expect(orderForDiversity(one, 3)).toBe(one);
  });

  it("a negative seed still lands inside the tier", () => {
    const pool = [m(1, 5), m(2, 5), m(3, 5)];
    expect(orderForDiversity(pool, -1).map((x) => x.assetId).sort()).toEqual([1, 2, 3]);
  });
});

/* ═══════════════════════ wired into the real path ═══════════════════════ */

describe("RONDE 132 §2 — wired where the pictures are actually adopted", () => {
  const read = (file: string) => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    return readFileSync(join(__dirname, file), "utf8");
  };

  it("the funnel adopt point records every identity, not just the funnel id", () => {
    const pipe = read("videoPipeline.ts");
    const idx = pipe.indexOf("markAssetUsedInVideo(dedup, {");
    expect(idx).toBeGreaterThan(0);
    const block = pipe.slice(idx, pipe.indexOf("});", idx));
    expect(block).toContain("funnelCandidateId: candidate.id");
    expect(block).toContain("archiveAssetId: candidate.archivePick?.asset?.id");
    expect(block).toContain("contentKey: clipContentKey(clipPath)");
    expect(block).toContain("providerAssetId: candidate.poolCandidate?.assetId");
  });

  it("the memory recall is handed the video's used-asset set and a reporter", () => {
    const pipe = read("videoPipeline.ts");
    expect(pipe).toContain("memoryExcludeAssetIds: dedup.usedCuratedAssetIds,");
    expect(pipe).toContain("onMemoryAssetExcluded:");
    expect(pipe).toContain("formatVisualDedupReject({");
  });

  it("the render report prints the dedup summary", () => {
    expect(read("videoPipeline.ts")).toContain("formatVisualDedupSummary(getActiveVideoId()");
  });

  it("the registry owns no storage of its own", () => {
    /**
     * "Geen tweede cachesysteem": it is a reader and a writer over the sets that already exist,
     * so a module-level Map or Set here would be exactly the second system the brief forbids.
     */
    const registry = read("visualDedupRegistry.ts");
    expect(registry).not.toMatch(/^const \w+ = new (Map|Set)/m);
    expect(registry).not.toMatch(/^let \w+ = new (Map|Set)/m);
  });

  it("RONDE 34's dedup scopes are still the ones being used", () => {
    // Not replaced — extended. Every set named in RONDE 34's comment is still the storage.
    const pipe = read("videoPipeline.ts");
    for (const set of [
      "usedContentKeys",
      "usedCuratedAssetIds",
      "usedCuratedStorageUrls",
      "usedFunnelCandidateIds",
    ]) {
      expect(pipe, set).toContain(`${set}:`);
    }
  });
});
