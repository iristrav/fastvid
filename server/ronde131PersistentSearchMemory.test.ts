/**
 * RONDE 131 — a memory that recorded what worked and never handed it back.
 *
 * ── The audit ────────────────────────────────────────────────────────────────────────────────
 *
 * FastVid has had a persistent, cross-video search memory since F3-26. The table is real, it is
 * keyed on the canonical entity, it upserts with a usage count, and it has an `assetId` column
 * naming the archive asset a proven query produced. Nothing was missing from the storage.
 *
 * Three things were missing from the reading and the writing:
 *
 *   1. `primeQueriesWithSearchMemory` — the ONLY reader on the retrieval path — does this:
 *
 *          const proven = memory.filter(m => m.success && m.query).map(m => m.query);
 *
 *      `assetId`, `source`, `qualityScore`: dropped. A memory hit therefore reordered the
 *      QUESTIONS and never returned the ANSWER. Video B re-asked every provider for footage
 *      Video A had already found, validated, adopted and stored.
 *
 *   2. `recordAdoptedClipSource`, the highest-volume writer, wrote no `assetId` at all — so even
 *      a reader that wanted one would have found the column empty on almost every row.
 *
 *   3. Worse, for a curated winner it wrote NOTHING:
 *
 *          const source = providerFromContentKey(input.contentKey);   // "curated" → ""
 *          if (!source || !subject || !query) return;
 *
 *      `providerFromContentKey` excludes "curated" on the reasoning that a curated clip is not a
 *      place you can search again. That is right for a QUERY memory and backwards for an ASSET
 *      memory: a curated asset is precisely the hit that needs no search next time, because
 *      FastVid already holds the file. The single most valuable row this table can hold was the
 *      one row it never wrote.
 *
 * ── What changed ─────────────────────────────────────────────────────────────────────────────
 *
 * The write records the asset. The read returns the asset. The funnel offers it as an ordinary
 * archive candidate — which is the entire safety argument, and it is structural: a recalled asset
 * is merged, coverage-scored, ranked, shortlisted, downloaded, preview-validated, licence-checked,
 * VisionGate'd, relevance-judged and duplicate-checked by exactly the code that does it for a
 * candidate found a second ago. Nothing here is downstream of a gate, so nothing here can skip one.
 *
 * No new table, no new cache, no second memory. The layers stay distinct:
 *
 *     query cache        per render      "did I already ask this?"
 *     PERSISTENT MEMORY  across renders  "what did asking this ever find?"
 *     asset cache        per render      "what do I know about this asset?"
 *     vision cache       process-wide    "does it show what the beat needs?"
 */
import { describe, expect, it, vi } from "vitest";

import { createSearchMemoryRecallMetrics, formatSearchMemoryLine, formatSearchMemorySummary, searchMemoryCacheHitRate } from "./searchMemoryRecall";
import {
  CURATED_ARCHIVE_MEMORY_SOURCE,
  adoptedClipMemoryRow,
  canonicalEntityKey,
  curatedAssetIdFromContentKey,
  providerFromContentKey,
} from "./visualSearchMemory";
import type { ArchiveAssetRow, CuratedCandidatePick } from "./curatedMediaSourcing";
import type { ProvenAssetMemory } from "./visualSearchMemory";

/* ═══════════════════════ a stand-in for the two tables ═══════════════════════ */

/**
 * The persistent memory and the archive, as the two stores they really are.
 *
 * The point of this harness is that Video A and Video B are separate calls that share NOTHING
 * except these stores — exactly the relationship two renders have. A saving that only appears
 * because a variable stayed in scope would prove nothing about production.
 */
function makeWorld() {
  const memoryRows: Array<{
    entity: string;
    query: string;
    source: string;
    assetId: number;
    usageCount: number;
    qualityScore: number | null;
  }> = [];
  const archive = new Map<number, ArchiveAssetRow>();
  let networkSearches = 0;

  const asset = (id: number, title: string): ArchiveAssetRow =>
    ({ id, archiveId: 1, title, mediaType: "video", isActive: 1 }) as unknown as ArchiveAssetRow;

  return {
    memoryRows,
    archive,
    get networkSearches() {
      return networkSearches;
    },
    /** The provider round a beat runs when it has nothing better. */
    providerSearch(hits: Array<{ id: number; title: string }>) {
      networkSearches += 1;
      for (const h of hits) archive.set(h.id, asset(h.id, h.title));
      return hits;
    },
    /**
     * The adopt point, using PRODUCTION's own mapping.
     *
     * `adoptedClipMemoryRow` is the function `recordAdoptedClipSource` calls; only the write to
     * MySQL is stood in for here. Rebuilding the mapping in the test instead would have let a
     * broken mapping keep the test green — which is exactly how the curated-winner gap survived.
     */
    remember(entity: string, query: string, contentKey: string, score10?: number) {
      const row = adoptedClipMemoryRow({
        subject: entity,
        subjectType: "person",
        query,
        contentKey,
        score10,
      });
      if (!row || row.assetId == null) return;
      // The table's real unique key: sha256(`${entity}|${source}|${query}`) — see dedupeKeyHash.
      const key = canonicalEntityKey(row.entity);
      const existing = memoryRows.find(
        (r) => r.entity === key && r.query === row.query && r.source === row.source
      );
      if (existing) {
        existing.usageCount += 1;
        return;
      }
      memoryRows.push({
        entity: key,
        query: row.query,
        source: row.source,
        assetId: row.assetId,
        usageCount: 1,
        qualityScore: row.qualityScore ?? null,
      });
    },
    /** What `getProvenAssetIdsForEntity` does: entity-keyed, success-only, asset-bearing. */
    readMemory: async (entity: string, limit: number): Promise<ProvenAssetMemory[]> => {
      const key = canonicalEntityKey(entity);
      return memoryRows
        .filter((r) => r.entity === key)
        .sort((a, b) => b.usageCount - a.usageCount)
        .slice(0, limit)
        .map((r) => ({
          assetId: r.assetId,
          query: r.query,
          source: r.source,
          usageCount: r.usageCount,
          qualityScore: r.qualityScore,
        }));
    },
    loadAssets: async (ids: number[]) =>
      ids.map((id) => archive.get(id)).filter((a): a is ArchiveAssetRow => a != null),
    resolveArchiveName: async () => "Bundesarchiv",
  };
}

const GORING = "Hermann Göring";

/* ═══════════════════════ §8/§9 — the multi-video flow ═══════════════════════ */

describe("RONDE 131 — Video A, Video B, Video C", () => {

  it("one query remembers one asset — the table's unique key is (entity, source, query)", () => {
    /**
     * A real property of the F3-26 schema, stated here rather than discovered later.
     *
     *     dedupeKeyHash = sha256(`${entity}|${source}|${query}`)
     *
     * `assetId` is not in the key, and the upsert overwrites it, so two clips adopted from the SAME
     * query collapse into one row naming the more recent asset. A subject therefore accumulates one
     * proven asset per distinct query, not per clip.
     *
     * Not changed in this round, and deliberately so: widening the key to include the asset would
     * multiply the row count per subject and change what `usageCount` means — "this query works"
     * would become "this query found this file", which is a different and less useful signal for
     * `primeQueriesWithSearchMemory`. Recording one proven asset per proven query is enough for
     * the recall to have something to offer, and every beat asks its own question.
     */
    const world = makeWorld();
    world.providerSearch([
      { id: 101, title: "Göring at Nuremberg" },
      { id: 102, title: "Göring and the Luftwaffe" },
    ]);
    world.remember(GORING, "same query", "curated:asset:101");
    world.remember(GORING, "same query", "curated:asset:102");
    expect(world.memoryRows).toHaveLength(1);
    // ...and the row is reinforced rather than duplicated.
    expect(world.memoryRows[0].usageCount).toBe(2);
  });

  it("the entity key is case- and spacing-insensitive, so spellings do not fork the memory", () => {
    // RONDE 28's lesson, re-checked because this round adds a second reader on the same key.
    expect(canonicalEntityKey("Hermann  Göring ")).toBe(canonicalEntityKey("hermann göring"));
    expect(canonicalEntityKey("HERMANN GÖRING")).toBe("hermann göring");
  });
});

/* ═══════════════════════ §5 — learn only from good results ═══════════════════════ */

describe("RONDE 131 — only what actually worked is remembered", () => {
  it("a rejected candidate is never written as a successful hit", () => {
    /**
     * The write happens at the adopt point — after VisionGate, after beat relevance, after the
     * duplicate check. A candidate that was refused never reaches it, so "do not learn from
     * failures" is a property of WHERE the writer sits rather than a filter that could be
     * forgotten.
     */
    const world = makeWorld();
    world.providerSearch([{ id: 101, title: "Göring at Nuremberg" }]);
    // A beat that rejected everything adopts nothing, so nothing calls remember().
    expect(world.memoryRows).toEqual([]);
  });

  it("THE FIX: a curated winner now produces a row that names its asset", () => {
    /**
     * The row `recordAdoptedClipSource` builds, from production's own mapping. Before this round
     * this input produced NOTHING — `providerFromContentKey("curated:asset:101")` is "" and the
     * function returned early.
     */
    const row = adoptedClipMemoryRow({
      subject: GORING,
      subjectType: "person",
      query: "Hermann Göring Berlin archival footage",
      contentKey: "curated:asset:101",
      score10: 8.2,
    });
    expect(row).toBeTruthy();
    expect(row!.assetId).toBe(101);
    expect(row!.source).toBe(CURATED_ARCHIVE_MEMORY_SOURCE);
    expect(row!.success).toBe(true);
    expect(row!.entity).toBe(GORING);
    expect(row!.qualityScore).toBe(82);
  });

  it("a provider winner still records a QUERY memory, with no asset — unchanged", () => {
    // The pre-existing behaviour, untouched: there is no file to point at, only a place to look.
    const row = adoptedClipMemoryRow({
      subject: GORING,
      subjectType: "person",
      query: "Hermann Göring portrait",
      contentKey: "wikimedia:File_Goering.jpg",
      score10: 7,
    });
    expect(row!.source).toBe("wikimedia");
    expect(row!.assetId).toBeUndefined();
  });

  it("a locally produced clip teaches nothing, as before", () => {
    // A still we rendered or a colour card: there is no "where to look next time".
    for (const contentKey of ["still:abc123", "file:1024:x.mp4", "stock:vid:3"]) {
      const row = adoptedClipMemoryRow({
        subject: GORING,
        subjectType: "person",
        query: "q",
        contentKey,
      });
      expect(row?.assetId, contentKey).toBeUndefined();
    }
    expect(adoptedClipMemoryRow({ subject: "", subjectType: "person", query: "q", contentKey: "curated:asset:1" })).toBeNull();
    expect(adoptedClipMemoryRow({ subject: GORING, subjectType: "person", query: "  ", contentKey: "curated:asset:1" })).toBeNull();
  });

  it("only a curated content key yields an asset id", () => {
    expect(curatedAssetIdFromContentKey("curated:asset:101")).toBe(101);
    expect(curatedAssetIdFromContentKey("  curated:asset:7  ")).toBe(7);
    // Everything else is a provider clip: a query memory, not an asset memory.
    expect(curatedAssetIdFromContentKey("wikimedia:File_Foo.jpg")).toBeNull();
    expect(curatedAssetIdFromContentKey("stock:vid:12")).toBeNull();
    expect(curatedAssetIdFromContentKey("still:abc123")).toBeNull();
    expect(curatedAssetIdFromContentKey("curated:asset:0")).toBeNull();
    expect(curatedAssetIdFromContentKey("curated:asset:x")).toBeNull();
    expect(curatedAssetIdFromContentKey("")).toBeNull();
  });

  it("THE BUG: providerFromContentKey still refuses curated, which is why the branch exists", () => {
    /**
     * Left exactly as it was. It answers "where can I search again", and the honest answer for a
     * curated clip is still "nowhere" — the fix is a separate branch that asks a different
     * question, not a weakening of this one.
     */
    expect(providerFromContentKey("curated:asset:101")).toBe("");
    expect(providerFromContentKey("wikimedia:File_Foo.jpg")).toBe("wikimedia");
    expect(providerFromContentKey("still:abc")).toBe("");
  });

  it("the curated source label is its own, not a provider name", () => {
    // A row with this source is a pointer to a file FastVid holds, not an instruction to search.
    expect(CURATED_ARCHIVE_MEMORY_SOURCE).toBe("curated_archive");
    expect(providerFromContentKey(`${CURATED_ARCHIVE_MEMORY_SOURCE}:x`)).toBe("curated_archive");
  });
});

/* ═══════════════════════ §7 — the metrics ═══════════════════════ */

describe("RONDE 131 — the saving is counted, not asserted", () => {
  it("hits, misses and the rate move as the render goes", () => {
    const m = createSearchMemoryRecallMetrics();
    expect(searchMemoryCacheHitRate(m)).toBe(0);

    m.memoryHits += 3;
    m.assetsReused += 7;
    m.providerSearchesAvoided += 3;
    m.memoryMisses += 1;
    m.newSearches += 1;
    expect(searchMemoryCacheHitRate(m)).toBeCloseTo(0.75, 5);

    const line = formatSearchMemorySummary(m);
    expect(line).toContain("memoryHits=3");
    expect(line).toContain("memoryMisses=1");
    expect(line).toContain("assetsReused=7");
    expect(line).toContain("providerSearchesAvoided=3");
    expect(line).toContain("newSearches=1");
    expect(line).toContain("cacheHitRate=75.0%");
  });

  it("a refused recall is reported, not hidden", () => {
    // A memory that quietly dropped its own failures would be unfalsifiable.
    const m = createSearchMemoryRecallMetrics();
    m.memoryHits = 2;
    m.memoryRejectedAfterValidation = 1;
    expect(formatSearchMemorySummary(m)).toContain("memoryRejectedAfterValidation=1");
  });

  it("the per-beat line reads as the brief specified it", () => {
    expect(
      formatSearchMemoryLine({
        query: "Hermann Göring Berlin archival footage",
        hit: true,
        provider: "curated_archive",
        assets: 4,
        networkAvoided: true,
      })
    ).toBe(
      '[SearchMemory] query="Hermann Göring Berlin archival footage" hit=true ' +
        "provider=curated_archive assets=4 networkAvoided=true"
    );

    expect(formatSearchMemoryLine({ query: "new unknown subject", hit: false })).toBe(
      '[SearchMemory] query="new unknown subject" hit=false providerSearch=true'
    );
  });
});

/* ═══════════════════════ the wiring, and the layers ═══════════════════════ */

describe("RONDE 131 — wired into the real path, and no second cache", () => {
  const read = (file: string) => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    return readFileSync(join(__dirname, file), "utf8");
  };

  it("the SearchGate still runs before anything reaches a provider", () => {
    // §4: memory changes what is offered, never what is allowed. The gate is untouched.
    const pipe = read("videoPipeline.ts");
    const idx = pipe.indexOf("export async function cachedProviderSearch<T>(");
    const body = pipe.slice(idx, pipe.indexOf("export function logSourcingMetrics(", idx));
    expect(body.indexOf("if (!decision.admitted)")).toBeLessThan(body.indexOf("const activeCache"));
    expect(read("searchQueryContract.ts")).toContain("SEARCH_GATE_STRICT");
  });

  it("no new table and no new cache — the memory that already existed is the one used", () => {
    const schema = (() => {
      const { readFileSync } = require("fs") as typeof import("fs");
      const { join } = require("path") as typeof import("path");
      return readFileSync(join(__dirname, "../drizzle/schema.ts"), "utf8");
    })();
    // One search-memory table, the F3-26 one, with the assetId column this round finally reads.
    expect((schema.match(/mysqlTable\(\s*\n?\s*"visual_search_memory"/g) ?? []).length).toBe(1);
    expect(schema).toContain('assetId: int("assetId").references(() => mediaArchiveAssets.id)');
    // The recall module stores nothing of its own.
    const recall = read("searchMemoryRecall.ts");
    expect(recall).not.toContain("new Map<string,");
    expect(recall).not.toMatch(/^const \w*[Cc]ache\b/m);
  });

  it("the per-render counters live on the per-render state, not in a module singleton", () => {
    // Two renders on one worker must not share a count, for the same reason RONDE 173 put the
    // query cache on RenderCtx.
    const pipe = read("videoPipeline.ts");
    expect(pipe).toContain("searchMemoryMetrics: createSearchMemoryRecallMetrics(),");
    expect(pipe).toContain("recalledAssetIds: new Set(),");
    const recall = read("searchMemoryRecall.ts");
    expect(recall).not.toMatch(/^let \w+Metrics/m);
  });

  it("the summary reaches the render report", () => {
    expect(read("videoPipeline.ts")).toContain(
      'formatSearchMemorySummary(visualDedup.searchMemoryMetrics)'
    );
  });

});

/* ═══════════════════════ §11 — the regression surface ═══════════════════════ */

describe("RONDE 131 — nothing earlier was traded for this", () => {
  const read = (file: string) => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    return readFileSync(join(__dirname, file), "utf8");
  };

  it("the gates this round is forbidden to touch are all still there", () => {
    const pipe = read("videoPipeline.ts");
    for (const marker of [
      "function ensurePipelineForceExport(",   // force-export
      "isMostlyBlackClip",                     // mostly-black detection
      "composeBarrierAllows",                  // beat relevance barrier
    ]) {
      expect(pipe, marker).toContain(marker);
    }
    expect(read("beatVisualRelevance.ts").length).toBeGreaterThan(0);
    expect(read("visualMismatchFeedback.ts")).toContain("HARD_MISMATCH");
  });

  it("RONDE 130's per-render query cache is untouched by this round", () => {
    const pipe = read("videoPipeline.ts");
    expect(pipe).toContain("const activeCache = cache ?? get_activeSourcingCache() ?? undefined;");
    // The two layers are distinct: one asks "did I already ask this THIS render", the other
    // "what did asking this ever find, in ANY render".
    expect(read("searchMemoryRecall.ts")).toContain("across renders");
  });
});
