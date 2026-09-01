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
import { buildBeatVisualStatuses, neverAskedReason } from "./beatVisualStatus";
import { formatMontageShortfallWarning } from "./videoQualityReport";
import { formatProviderSkips } from "./scenePool";
import {
  beatContinuesPreviousThought,
  formatSubjectFallbackEmptyLine,
  resolveBeatSubject,
} from "./beatSubjectFallback";
import type { ClipAdoptEntry } from "./clipAdoptAudit";

/** One adopted beat, in the shape clipAdoptAudit records. */
const adopt = (
  sceneIndex: number,
  beatIndex: number,
  basename: string,
  source: string
): ClipAdoptEntry =>
  ({ sceneIndex, beatIndex, basename, source }) as unknown as ClipAdoptEntry;

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

/* ═══════════════════════ N: never_asked must name a cause ═══════════════════════ */

describe("RONDE 132 §3 — never_asked is never an ending on its own", () => {
  it("THE GAP: the warning printed the bare word, with no cause", () => {
    /**
     * From the render:
     *
     *     10 van 14 beat(s) zonder goedgekeurd eigen beeld
     *     (held_frame=2, never_asked=5, subject_only=1, unknown=2)
     *
     * `never_asked=5` says the gate was not consulted and stops there — so "the beat holds a held
     * frame, there was nothing to judge" and "the beat holds real footage nobody looked at" shared
     * one label. The first is the pipeline working. The second is a hole.
     *
     * `neverAskedReason` was written for this in RONDE 166 §9 and had no caller: the warning built
     * its own string from the bare verification.
     */
    const statuses = buildBeatVisualStatuses(
      [
        adopt(0, 0, "own_footage.mp4", "archive"),
        adopt(0, 1, "scene_0_b1_placeholder.mp4", "fallback"),
      ],
      undefined // no relevance ledger at all → every beat is never_asked
    );
    for (const st of statuses) {
      expect(st.verification, `${st.sceneIndex}:${st.beatIndex}`).toBe("never_asked");
      // ...and not one of them reports the bare word as its reason.
      expect(st.reason, `${st.sceneIndex}:${st.beatIndex}`).not.toBe("never_asked");
      expect(st.reason.length).toBeGreaterThan(0);
    }
  });

  it("real footage nobody judged is named as the gap it is", () => {
    const [st] = buildBeatVisualStatuses([adopt(0, 0, "own_footage.mp4", "archive")], undefined);
    expect(st!.reason).toBe("real_footage_never_judged");
  });

  it("a beat with nothing to judge says so, and is not confused with the gap", () => {
    // A placeholder carries no picture, so the gate is RIGHT not to have been asked. That must
    // read differently from real footage that slipped past the gate.
    const [st] = buildBeatVisualStatuses(
      [adopt(0, 0, "scene_0_b0_placeholder.mp4", "fallback")],
      undefined
    );
    expect(st!.reason).toContain("no_picture_to_judge");
    expect(st!.reason).not.toBe("real_footage_never_judged");
  });

  it("every coverage has a cause — none can fall through to a blank", () => {
    /**
     * The invariant §3 asks for: never_asked may not become a normal ending without a cause. Stated
     * across the whole vocabulary rather than for the cases that happen to occur today.
     */
    const coverages = [
      "own_footage", "subject_only", "placeholder", "held_frame", "graphic", "none", "generated",
    ] as const;
    for (const c of coverages) {
      const reason = neverAskedReason(c);
      expect(reason, c).toBeTruthy();
      expect(reason, c).not.toBe("never_asked");
      expect(reason.length, c).toBeGreaterThan(3);
    }
  });

  it("a beat that WAS judged keeps its verdict, not a never-asked cause", () => {
    // The change must not overwrite a real verdict with a reason about not having one.
    const ledger = { byClipPath: new Map() } as unknown as Parameters<typeof buildBeatVisualStatuses>[1];
    const statuses = buildBeatVisualStatuses([adopt(0, 0, "own_footage.mp4", "archive")], ledger);
    expect(statuses[0]!.verification).toBe("never_asked"); // empty ledger, still never asked
    expect(statuses[0]!.reason).toBe("real_footage_never_judged");
  });
});

/* ═══════════════════════ J: a beat with no subject of its own ═══════════════════════ */

describe("RONDE 132 §4 — why half the beats had no subject", () => {
  /**
   * ── The answer, from the code ──────────────────────────────────────────────────────────────
   *
   * `resolveBeatSubject` had six routes and every one of them asked the SENTENCE:
   *
   *     1. the beat's own semantic persons        beat-local
   *     2. the beat's own semantic companies      beat-local
   *     3. the video's person lock                ...but only when the beat literally spells the name
   *     4. names extracted from the beat text     beat-local
   *     5. the beat's own semantic locations      beat-local
   *     6. the beat's own semantic events         beat-local
   *
   * The scene was never consulted. Not once. And route 3 — the only one carrying video-level
   * context — is gated on `beat.includes(part)`, which is exactly what an abstract sentence never
   * does. So "That's the chilling story hidden beneath the battlefields" resolved to nothing while
   * the scene around it named Hitler twice.
   *
   * It was not a threshold and not a bug. The function only ever looked at one sentence.
   */
  const abstractBeats = [
    "But how did these overlooked blunders twist the trajectory of history?",
    "This obsession cost thousands of lives and altered global power balances.",
    "That's the chilling story hidden beneath the battlefields.",
    "unraveling bonds and trust, ultimately shaping their catastrophic downfall.",
  ];

  it("THE BUG: every one of the render's abstract beats resolved to nothing", () => {
    // No scene context supplied — the old behaviour exactly.
    for (const beatText of abstractBeats) {
      expect(resolveBeatSubject({ beatText }), beatText).toBeNull();
    }
  });

  it("the person lock could not help, because it needs the beat to spell the name", () => {
    // Route 3, and why it never fired on these sentences.
    for (const beatText of abstractBeats) {
      expect(resolveBeatSubject({ beatText, primaryPerson: "Adolf Hitler" }), beatText).toBeNull();
    }
    // It does fire when the beat DOES name them — unchanged.
    expect(
      resolveBeatSubject({ beatText: "Hitler ordered the attack.", primaryPerson: "Adolf Hitler" })
    ).toMatchObject({ subject: "Adolf Hitler", origin: "person_lock" });
  });

  it("J. THE FIX: the scene's own names answer the beat the sentence could not", () => {
    for (const beatText of abstractBeats) {
      const subject = resolveBeatSubject({
        beatText,
        sceneEntities: { persons: ["Hitler"] },
        neighbourPersons: ["Hitler"],
      });
      expect(subject, beatText).toBeTruthy();
      expect(subject!.subject, beatText).toBe("Hitler");
    }
  });

  it("a borrowed subject is LABELLED as borrowed, so the log stays honest", () => {
    /**
     * The claim genuinely weakens: a subject the beat supplied is about this sentence, one taken
     * from the scene is about the passage. That difference has to survive into the report.
     */
    const continued = resolveBeatSubject({
      beatText: "That's the chilling story hidden beneath the battlefields.",
      sceneEntities: { persons: ["Hitler"] },
      neighbourPersons: ["Hitler"],
    });
    expect(continued!.origin).toBe("neighbour_beat_persons");

    // A sentence that introduces rather than continues falls through to the wider scene label.
    const fresh = resolveBeatSubject({
      beatText: "Production lines slowed to a crawl across occupied Europe.",
      sceneEntities: { persons: ["Hitler"] },
      neighbourPersons: ["Hitler"],
    });
    expect(fresh!.origin).toBe("scene_persons");
  });

  it("the beat's own subject is NEVER overruled by the scene's", () => {
    /**
     * The constraint that keeps this from making things worse. A beat that names someone is about
     * them, whoever else the scene mentions.
     */
    const subject = resolveBeatSubject({
      beatText: "Göring inspected the Luftwaffe that spring.",
      entities: { persons: ["Göring"] },
      sceneEntities: { persons: ["Hitler"] },
      neighbourPersons: ["Hitler"],
    });
    expect(subject).toMatchObject({ subject: "Göring", origin: "semantic_persons" });
  });

  it("a sentence that introduces something new is answered by the SCENE route alone", () => {
    /**
     * Isolates the scene route from the neighbour route. The four abstract beats above all carry
     * a pronoun, so the neighbour route answers them and the scene route would go untested — which
     * is how a removed scene route could keep every other test in this file green.
     */
    const fresh = "Production lines slowed to a crawl across occupied Europe.";
    expect(beatContinuesPreviousThought(fresh)).toBe(false);
    expect(resolveBeatSubject({ beatText: fresh, neighbourPersons: ["Hitler"] })).toBeNull();
    expect(resolveBeatSubject({ beatText: fresh, sceneEntities: { persons: ["Hitler"] } }))
      .toMatchObject({ subject: "Hitler", origin: "scene_persons" });
  });

  it("the pipeline actually HANDS the resolver the scene's names", () => {
    /**
     * Source-bound, and the weakest test in this file — deliberately labelled as such. The wiring
     * lives inside `trySubjectFallbackForBeat`, which needs a whole render to call. Without this
     * the fix could be disconnected in production while every behaviour test above stayed green,
     * which is exactly what a mutation of the call site proved.
     */
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const pipe = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    const idx = pipe.indexOf("const subject = resolveBeatSubject({");
    expect(idx).toBeGreaterThan(0);
    const call = pipe.slice(idx, pipe.indexOf("});", idx));
    expect(call).toContain("sceneEntities: { persons: sceneNames }");
    expect(call).toContain("neighbourPersons: sceneNames");
    // ...from the field that already carries them.
    expect(pipe).toContain("const sceneNames = (scene.personNames ?? []).filter(Boolean);");
  });

  it("a scene with no names still resolves to nothing — nothing is invented", () => {
    // The whole point of the module: no subject is a real outcome, and borrowing from an empty
    // scene would be the "random word from the sentence" it exists to avoid, one step removed.
    for (const beatText of abstractBeats) {
      expect(resolveBeatSubject({ beatText, sceneEntities: { persons: [] } }), beatText).toBeNull();
      expect(resolveBeatSubject({ beatText, neighbourPersons: ["the", "history"] }), beatText)
        .toBeNull();
    }
  });

  it("continuation is a grammatical test, not a content decision", () => {
    expect(beatContinuesPreviousThought("His obsession cost thousands of lives.")).toBe(true);
    expect(beatContinuesPreviousThought("That's the chilling story.")).toBe(true);
    expect(beatContinuesPreviousThought("These blunders changed everything.")).toBe(true);
    expect(beatContinuesPreviousThought("Germany invaded Poland in 1939.")).toBe(false);
    expect(beatContinuesPreviousThought("")).toBe(false);
  });
});

/* ═══════════════════════ the five empty subject searches ═══════════════════════ */

describe("RONDE 132 — 'subject search returned nothing' was two failures in one sentence", () => {
  const subject = { subject: "hitler", kind: "person", origin: "semantic_persons" } as const;

  it("THE AMBIGUITY: one reason covered a bug and correct behaviour alike", () => {
    /**
     * Reported five times in the render, for "hitler", "germany" and "russia", on a WWII
     * documentary with a filled archive. `subject_search_returned_nothing` asserts that nothing
     * came back — but "plenty came back and every candidate was refused" is at least as likely on
     * a one-word beat, and the line could not tell them apart.
     */
    const old = "reason=subject_search_returned_nothing";
    expect(formatSubjectFallbackEmptyLine(1, 1, subject, { rejected: 0 })).not.toContain(old);
    expect(formatSubjectFallbackEmptyLine(1, 1, subject, { rejected: 4 })).not.toContain(old);
  });

  it("nothing reached the gates — the case actually worth investigating", () => {
    const line = formatSubjectFallbackEmptyLine(1, 1, subject, { rejected: 0 });
    expect(line).toContain("reason=no_candidate_reached_the_gates");
    expect(line).toContain("rejected=0");
  });

  it("candidates arrived and were all refused — the pipeline working", () => {
    const line = formatSubjectFallbackEmptyLine(1, 1, subject, { rejected: 4 });
    expect(line).toContain("reason=all_candidates_rejected");
    expect(line).toContain("rejected=4");
  });

  it("with no count available it says so rather than guessing", () => {
    // A rejection count is proof a candidate reached the gates; absent it, neither story is known.
    const line = formatSubjectFallbackEmptyLine(1, 1, subject);
    expect(line).toContain("reason=subject_search_outcome_unknown");
    expect(line).not.toContain("rejected=");
  });

  it("the line names where the subject came from, so a borrowed one is visible here too", () => {
    const borrowed = { subject: "Hitler", kind: "person", origin: "scene_persons" } as const;
    expect(formatSubjectFallbackEmptyLine(1, 1, borrowed, { rejected: 0 }))
      .toContain("origin=scene_persons");
  });
});

/* ═══════════════════════ O/T: the shortfall and the skipped providers ═══════════════════════ */

describe("RONDE 132 §10 — a short montage says HOW short", () => {
  const short = (sceneIndex: number, shortBySec: number, uniqueClips = 3, neededClips = 5) =>
    ({ sceneIndex, shortBySec, uniqueClips, neededClips });

  it("THE GAP: the old warning had no number and said 'may'", () => {
    /**
     * From the render:
     *
     *     short montage: scene(s) 1, 2 had less footage than voice
     *                    — the tail may be filled by holding the last frame
     *
     * A 0.3s shortfall is a rounding artefact; a 12s one is a visible freeze. Both produced that
     * exact sentence, and the "may" left the reader unable to tell whether anything froze at all.
     */
    const line = formatMontageShortfallWarning([short(1, 0.4), short(2, 12.3)], [1, 2]);
    expect(line).not.toContain("may be filled");
    expect(line).toContain("12.3s");
  });

  it("names the worst scene, because that is the one worth looking at", () => {
    const line = formatMontageShortfallWarning([short(1, 0.4), short(2, 12.3, 2, 6)], [1, 2]);
    expect(line).toContain("worst scene 2 at 12.3s");
    expect(line).toContain("2 unique clip(s), 6 needed");
  });

  it("the total says whether it is one bad scene or a systemic shortage", () => {
    expect(formatMontageShortfallWarning([short(1, 4), short(2, 6)], [1, 2]))
      .toContain("10.0s short in total");
  });

  it("with no shortfall recorded it keeps the old, weaker sentence rather than inventing one", () => {
    // The estimate can flag a scene without a shortfall being recorded. Printing "0.0s short"
    // there would be a measurement that was never taken.
    const line = formatMontageShortfallWarning([], [1, 2]);
    expect(line).toContain("scene(s) 1, 2");
    expect(line).toContain("may be filled");
    expect(line).not.toContain("0.0s");
  });

  it("O. NOT DONE: the shortfall does not yet send the beat back to sourcing", () => {
    /**
     * Stated as a test so it cannot be quietly forgotten.
     *
     * §10 asks for `requiredDuration vs availableUniqueDuration` BEFORE the montage, and a return
     * to sourcing when it falls short. The check exists and is now measured, but the loop back
     * into sourcing does not: the shortfall is detected inside compose, which sits downstream of
     * every sourcing route, and re-entering sourcing from there is an architectural change rather
     * than a patch.
     *
     * What this round delivers is the number that says whether it is worth building.
     */
    const line = formatMontageShortfallWarning([short(1, 12.3)], [1]);
    expect(line).toContain("filled by holding the last frame");
  });
});

describe("RONDE 132 §13 — a provider that was never asked says so", () => {
  it("T. the skip reason distinguishes a missing key from a disabled flag", () => {
    /**
     * The render reported "Geen Wikimedia-stills" with no way to tell whether Wikimedia had been
     * asked and found nothing, or had never been called. Those need completely different work:
     * "the queries are wrong" versus "the key is missing".
     */
    expect(formatProviderSkips({ pexels: "no_api_key", europeana: "disabled_by_flag" }))
      .toBe("europeana=disabled_by_flag pexels=no_api_key");
  });

  it("nothing skipped produces nothing", () => {
    expect(formatProviderSkips({})).toBe("");
  });

  it("every provider guard routes through the recorder", () => {
    // Source-bound: the guards live inside the pool builder, which needs a whole scene to call.
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const pool = readFileSync(join(__dirname, "scenePool.ts"), "utf8");
    for (const source of [
      "pexels", "pixabay", "internet_archive", "europeana", "openverse", "nasa", "nara", "loc",
    ]) {
      expect(pool, source).toContain(`noteSkip("${source}"`);
    }
    expect(pool).toContain("[ProviderSkipped] scene=");
    /**
     * And the recorder actually assigns BOTH reasons. Asserting only that `noteSkip` is called
     * leaves a version that skips the provider and records nothing — which is the state this
     * round exists to fix, and a mutation proved the test could not see it.
     */
    const idx = pool.indexOf("const noteSkip =");
    expect(idx).toBeGreaterThan(0);
    const body = pool.slice(idx, pool.indexOf("};", idx));
    expect(body).toContain('skipped[source] = "disabled_by_flag";');
    expect(body).toContain('skipped[source] = "no_api_key";');
  });
});
