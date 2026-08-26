import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SUMMARY_COUNTERS,
  VisualSourceLedger,
  emptySummaryCounts,
  formatFunnelReport,
  formatLineageLine,
  formatSourceSummary,
} from "./visualSourceLineage";
import {
  adoptRouteForSource,
  bindLineageLedger,
  createClipAdoptAudit,
  lineageLedgerFor,
  recordClipAdopt,
} from "./clipAdoptAudit";
import { createClipRejectAudit, recordClipReject } from "./clipRejectAudit";
import {
  buildBeatRankingContext,
  curatedAssetProviderText,
  rankCuratedPicksByBeatContext,
  scoreCandidateAgainstBeat,
} from "./videoPipeline";
import { buildVideoQualityReport } from "./videoQualityReport";
import {
  enqueueVisualSearchMemory,
  recordSearchMisses,
  resetVisualSearchMemoryQueue,
  visualSearchMemoryQueueStats,
} from "./visualSearchMemory";
import {
  globalBudgetSnapshot,
  maxConcurrentRenders,
  withGlobalMediaFetch,
  withGlobalVisionGate,
} from "./globalResourceBudget";
import { composeParallelismForVideo, montageSegmentParallelism } from "./sourcingPolicy";

/**
 * RONDE 86 — the render can say where every picture came from, and two of them can run at once.
 *
 * Render 536 (18 scenes, 8-10 bucket, 168 minutes, score 60/100) is the measurement behind every
 * section below:
 *
 *   · 27 of 66 composed clips reported source=unknown — provenance lived only in the filename,
 *     and padShortClipWithNext renames a clip to `pad_combined_sNbM_<ts>.mp4`.
 *   · 594 "source video too short" rejections over 37 distinct assets — one missing
 *     usedAssetIds.add() meant the same broken asset was re-tried on every beat.
 *   · Not one [VisualSelection] line — the RONDE 79 ranking lived in adoptClip's closure and the
 *     archive path never reached it.
 *   · 113 DB "Queue limit reached" — 248 un-awaited inserts against a queueLimit of 100.
 *   · 2671 candidates retrieved, 39 downloaded, and no counter that could attribute the loss.
 *
 * Each test below names the defect it holds shut.
 */

const PIPELINE_SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const CURATED_SRC = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
const MEMORY_SRC = fs.readFileSync(path.join(__dirname, "visualSearchMemory.ts"), "utf8");
const BUDGET_SRC = fs.readFileSync(path.join(__dirname, "globalResourceBudget.ts"), "utf8");

const ledger = () => new VisualSourceLedger({ renderId: "test", videoId: 536 });

/* ═════════════ §A — lineage survives the compose path ═════════════ */

describe("RONDE 86 §A — a clip's origin outlives its filename", () => {
  it("TEST 1 — lineage survives the pad rename that produced 27 unknowns", () => {
    const l = ledger();
    const downloaded = "/w/scene_3_b2__pid_wikimedia-a1b2c3d4e5f60718.mp4";
    l.createLineage({
      sceneIndex: 3, beatIndex: 2,
      candidateId: "wikimedia:a1b2c3d4e5f60718", contentKey: "wikimedia:a1b2c3d4e5f60718",
      provider: "wikimedia", providerAssetId: "File_Fuhrerbunker.jpg",
      localPath: downloaded, mediaType: "image", route: "primary",
    });
    // Exactly the chain render 536 walked: trim → pad → text overlay. RONDE 87 gives each hop its
    // own record carrying parentLineageId, so a derived file can never read as its own source.
    const trimmed = "/w/scene_3_b2__pid_wikimedia-a1b2c3d4e5f60718_still.mp4";
    const padded = "/w/pad_combined_s3b2_1740000000000.mp4";
    const withText = "/w/pad_combined_s3b2_1740000000000_text.mp4";
    l.linkDerivedPath(trimmed, downloaded, "TRIMMED");
    l.linkDerivedPath(padded, trimmed, "PADDED");
    l.linkDerivedPath(withText, padded, "OVERLAYED");

    expect(l.providerFor(withText), "the montage path must still resolve to wikimedia").toBe("wikimedia");
    expect(l.rootOf(l.resolve(withText)!.lineageId)!.originalFilename).toBe(path.basename(downloaded));
    expect(l.resolve(withText)?.currentFilename).toBe(path.basename(withText));
  });

  it("TEST 2 — a rename that was never linked still resolves by content key", () => {
    const l = ledger();
    l.createLineage({
      sceneIndex: 0, beatIndex: 0,
      candidateId: "pexels:deadbeefdeadbeef", contentKey: "pexels:deadbeefdeadbeef",
      provider: "pexels", localPath: "/w/a__pid_pexels-deadbeefdeadbeef.mp4",
      mediaType: "video", route: "primary",
    });
    // A path the ledger has never seen, resolved on the key the pipeline's dedup already computes.
    expect(l.providerFor("/w/completely_different_name.mp4", "pexels:deadbeefdeadbeef")).toBe("pexels");
    // And with no key and no link there is no answer — the ledger reports absence, never a guess.
    expect(l.providerFor("/w/completely_different_name.mp4")).toBeNull();
  });

  it("TEST 3 — a derivation cycle cannot hang the resolver", () => {
    const l = ledger();
    l.linkDerivedPath("/w/a.mp4", "/w/b.mp4", "TRIMMED");
    l.linkDerivedPath("/w/b.mp4", "/w/a.mp4", "TRIMMED");
    expect(l.resolve("/w/a.mp4")).toBeNull();
  });

  it("TEST 4 — every recordClipAdopt call site writes lineage, without one of them changing", () => {
    const audit = createClipAdoptAudit();
    const l = ledger();
    bindLineageLedger(audit, l);
    expect(lineageLedgerFor(audit)).toBe(l);

    recordClipAdopt(audit, 4, 1, "The bunker in April 1945.", "/w/scene_4_b1_curated_a55995.mp4",
      "archive", "Führerbunker exterior", null, 55995, 8);
    const record = l.resolve("/w/scene_4_b1_curated_a55995.mp4");
    expect(record).not.toBeNull();
    expect(record!.sceneIndex).toBe(4);
    expect(record!.archiveAssetId).toBe(55995);
    expect(record!.visionScore).toBe(8);
    expect(record!.route).toBe("primary");
    // RONDE 87: "archive" is the adopt ROUTE, and this clip's provider was never proven, so the
    // record says so instead of borrowing the route label.
    expect(record!.sourceLabel).toBe("archive");
    expect(record!.provider).toBeNull();
    expect(record!.providerStatus).toBe("UNVERIFIED");
  });

  it("TEST 5 — lineage is not truncated by the adopt audit's 120-entry cap", () => {
    const audit = createClipAdoptAudit();
    const l = ledger();
    bindLineageLedger(audit, l);
    for (let i = 0; i < 150; i++) {
      recordClipAdopt(audit, i, 0, "beat", `/w/clip_${i}.mp4`, "archive");
    }
    // The audit array is capped on purpose — it is a log. The lineage is the record of what is
    // in the finished video, and a long render must not stop recording it at clip 120.
    expect(audit.length).toBe(120);
    expect(l.size).toBe(150);
    expect(l.resolve("/w/clip_149.mp4")).not.toBeNull();
  });

  it("TEST 6 — the quality report counts the ledger's provider, not the filename's", () => {
    // `pad_combined_...` matches no pattern in inferClipSourceFromPath, which is why render 536's
    // report filed 27 real clips under `unknown` while the score read bySource.
    const clip = "/w/pad_combined_s3b2_1740000000000.mp4";
    const withoutLedger = buildVideoQualityReport([clip], "Hitler's Last Days");
    expect(withoutLedger.bySource.unknown).toBe(1);

    const withLedger = buildVideoQualityReport([clip], "Hitler's Last Days", {
      resolveSource: () => "wikimedia",
    });
    expect(withLedger.bySource.wikimedia).toBe(1);
    expect(withLedger.bySource.unknown).toBeUndefined();
  });

  it("TEST 7 — the compose manifest and the report read the same ledger", () => {
    expect(PIPELINE_SRC).toContain("resolveSource: (clipPath) => visualDedup.sourcingCache.lineage.providerFor(clipPath)");
    expect(PIPELINE_SRC).toContain("formatLineageLine(lineageRecord, clipPath)");
    // MUTATION GUARD: the two renames that ended provenance must both still be linked, each with
    // the stage that describes it (RONDE 87).
    expect(PIPELINE_SRC).toContain('linkDerivedPath(effectiveClip, clipPath, "PADDED")');
    expect(PIPELINE_SRC).toContain('linkDerivedPath(withText, effectiveClip, "OVERLAYED")');
  });

  it("TEST 8 — the lineage line names the source and whether it is proven", () => {
    const l = ledger();
    const rec = l.createLineage({
      sceneIndex: 2, beatIndex: 5,
      candidateId: "internet_archive:x", contentKey: "internet_archive:x",
      provider: "internet_archive", providerAssetId: "berlin-1945",
      localPath: "/w/ia.mp4", mediaType: "video", route: "rescue", candidateScore: 142,
    });
    const line = formatLineageLine(rec, "/w/ia.mp4");
    expect(line).toContain("provider=internet_archive");
    expect(line).toContain("providerStatus=VERIFIED");
    expect(line).toContain("route=rescue");
    // RONDE 87: no record means no provider — the line says UNVERIFIED rather than naming a guess.
    const unknown = formatLineageLine(null, "/w/x.mp4");
    expect(unknown).toContain("provider=UNVERIFIED");
    expect(unknown).toContain("providerStatus=UNVERIFIED");
  });
});

/* ═════════════ §B — one ranking, every path ═════════════ */

describe("RONDE 86 §B — the curated path ranks on the same evidence as the web path", () => {
  const beat = "In the Führerbunker in April 1945, Hitler dictated his political testament.";

  it("TEST 9 — the RONDE 79 scorer is one function, used by both paths", () => {
    // The defect was that it lived inside adoptClip's closure. If it moves back, the archive path
    // silently stops ranking again — which is exactly what render 536 shipped.
    expect(PIPELINE_SRC).toContain("export function scoreCandidateAgainstBeat(");
    expect(PIPELINE_SRC).toContain(
      "scoreCandidateAgainstBeat(dedup.clipAnnotationMeta.get(p)?.providerText ?? undefined, rankingCtx).total"
    );
    expect(PIPELINE_SRC).toContain("rankCuratedPicksByBeatContext(ranked, curatedRankCtx)");
  });

  it("TEST 10 — a candidate that names the beat's place and period outranks one that names neither", () => {
    const ctx = buildBeatRankingContext(beat, { primaryPerson: "Adolf Hitler" });
    const onTopic = scoreCandidateAgainstBeat(
      { title: "Führerbunker Berlin April 1945", description: "Adolf Hitler in the bunker" }, ctx
    );
    const offTopic = scoreCandidateAgainstBeat({ title: "generic wartime footage" }, ctx);
    expect(onTopic.total).toBeGreaterThan(offTopic.total);
  });

  it("TEST 11 — the archive's own score still wins when it separates the candidates", () => {
    // The context reorder must never displace a candidate the archive scored materially higher —
    // that would trade match quality for a signal built from sparser metadata.
    const ctx = buildBeatRankingContext(beat, { primaryPerson: "Adolf Hitler" });
    const picks = [
      { score: 300, asset: { id: 1, title: "generic wartime footage" } },
      { score: 100, asset: { id: 2, title: "Führerbunker Berlin April 1945" } },
    ];
    const { ranked } = rankCuratedPicksByBeatContext(picks, ctx);
    expect(ranked[0]!.asset.id, "a 200-point keyword gap is not a tie").toBe(1);
  });

  it("TEST 12 — within a tied score band, the beat's context decides", () => {
    const ctx = buildBeatRankingContext(beat, { primaryPerson: "Adolf Hitler" });
    const picks = [
      { score: 120, asset: { id: 1, title: "generic wartime footage" } },
      { score: 118, asset: { id: 2, title: "Führerbunker Berlin April 1945", tags: ["hitler", "bunker"] } },
    ];
    const { ranked, scores } = rankCuratedPicksByBeatContext(picks, ctx);
    expect(ranked[0]!.asset.id, "two points apart is a tie the archive cannot resolve").toBe(2);
    expect(scores.get(ranked[0]!)!.total).toBeGreaterThan(scores.get(ranked[1]!)!.total);
  });

  it("TEST 13 — a single candidate is never re-ranked and never logged as a selection", () => {
    const ctx = buildBeatRankingContext(beat, { primaryPerson: "Adolf Hitler" });
    const picks = [{ score: 10, asset: { id: 7, title: "anything" } }];
    const { ranked, scores } = rankCuratedPicksByBeatContext(picks, ctx);
    expect(ranked).toBe(picks);
    expect(scores.size).toBe(0);
  });

  it("TEST 14 — the archive row's own words are what gets scored, nothing invented", () => {
    const pt = curatedAssetProviderText({
      title: "Bundesarchiv Bild 183",
      tags: ["berlin", "1945"],
      sourceNote: "German Federal Archives",
      entities: ["Adolf Hitler"],
      topics: ["wwii"],
      originalQuery: "hitler bunker",
    });
    expect(pt.title).toBe("Bundesarchiv Bild 183");
    expect(pt.tags).toContain("adolf hitler".replace("adolf hitler", "Adolf Hitler"));
    expect(pt.tags).toContain("wwii");
    expect(pt.description).toContain("German Federal Archives");
  });

  it("TEST 15 — the rescue route ranks before it picks, not after it fails", () => {
    // adoptBestSimilarBeatClip used to walk `ranked` in keyword order and take the first clip
    // that passed the vision gate. The reorder must happen before that loop.
    const rescueIdx = PIPELINE_SRC.indexOf("rankCuratedPicksByBeatContext(ranked, rescueCtx)");
    const loopIdx = PIPELINE_SRC.indexOf("const similarFloor = adoptOpts?.visionFloor");
    expect(rescueIdx).toBeGreaterThan(-1);
    expect(rescueIdx, "the ranking must run before the adopt loop reads `ranked`").toBeLessThan(loopIdx);
  });
});

/* ═════════════ §C — a broken asset is out for the render ═════════════ */

describe("RONDE 86 §C — the curated failure route registers what failed", () => {
  it("TEST 16 — the catch that discarded 594 rejections now marks the asset used", () => {
    const idx = CURATED_SRC.indexOf("curated asset ${picked.asset.id} failed:");
    expect(idx).toBeGreaterThan(-1);
    const block = CURATED_SRC.slice(idx, idx + 1800);
    expect(block).toContain("usedAssetIds.add(picked.asset.id)");
    expect(block).toContain("usedStorageUrls.add(picked.asset.storageUrl)");
    // MUTATION GUARD: a bare `return null` in that catch is the defect itself.
    const catchBody = block.slice(0, block.indexOf("return null;"));
    expect(catchBody).toContain("usedAssetIds.add");
  });

  it("TEST 17 — the sister route it disagreed with is unchanged", () => {
    // preparePooledArchiveClip has always done this. The bug was that only one of the two routes
    // into the same prepare function did, so which route a beat took decided whether the render
    // learned anything.
    const idx = PIPELINE_SRC.indexOf("asset ${picked.asset.id} prepare failed:");
    expect(idx).toBeGreaterThan(-1);
    // Widened for RONDE 87, which records the DOWNLOAD_FAILED event in the same catch block.
    const block = PIPELINE_SRC.slice(idx, idx + 900);
    expect(block).toContain("dedup.usedCuratedAssetIds.add(picked.asset.id)");
    expect(block).toContain("dedup.usedCuratedStorageUrls.add(picked.asset.storageUrl)");
  });

  it("TEST 18 — the exclusion the registration feeds is still consulted", () => {
    // Registering is only useful because every selection path reads these sets.
    expect(CURATED_SRC).toContain("if (excludeIds.has(asset.id)) continue;");
    expect(CURATED_SRC).toContain(
      "if (usedAssetIds.has(picked.asset.id) || usedStorageUrls.has(picked.asset.storageUrl)) {"
    );
  });
});

/* ═════════════ §D — the search memory stops flooding the pool ═════════════ */

describe("RONDE 86 §D — search-memory writes are bounded, batched and de-duplicated", () => {
  beforeEach(() => resetVisualSearchMemoryQueue());
  afterEach(() => resetVisualSearchMemoryQueue());

  it("TEST 19 — 248 dead ends no longer become 248 un-awaited inserts", () => {
    // Render 536's exact burst, against a pool whose queueLimit is 100.
    const searchedKeys: string[] = [];
    for (let i = 0; i < 248; i++) searchedKeys.push(`pexels|query number ${i}`);
    recordSearchMisses({
      subject: "Adolf Hitler",
      subjectType: "person",
      searchedKeys,
      adoptedByProvider: new Map(),
    });
    // Everything is queued, nothing is in flight per row: the drain releases at most
    // SEARCH_MEMORY_DB_CONCURRENCY statements at a time.
    expect(MEMORY_SRC).toContain("const wave: Array<Promise<void>> = [];");
    expect(MEMORY_SRC).toContain("await Promise.all(wave);");
    expect(MEMORY_SRC).not.toContain("void recordVisualSearchMemory({");
  });

  it("TEST 20 — a repeated (entity, source, query) is written once, not once per sighting", () => {
    expect(enqueueVisualSearchMemory({
      entity: "Adolf Hitler", entityType: "person", query: "hitler bunker", source: "pexels", success: false,
    })).toBe(true);
    // Same triple, different spelling and casing — canonicalEntityKey collapses them, and the
    // database collapses them too, so sending it twice is pool pressure for no information.
    expect(enqueueVisualSearchMemory({
      entity: "  adolf   hitler ", entityType: "person", query: "hitler bunker", source: "PEXELS", success: false,
    })).toBe(false);
    expect(visualSearchMemoryQueueStats().deduped).toBe(1);
  });

  it("TEST 21 — the queue has a ceiling, and says when it hit one", () => {
    expect(MEMORY_SRC).toContain("const SEARCH_MEMORY_QUEUE_MAX = 5_000;");
    expect(MEMORY_SRC).toContain("droppedForBackpressure += 1;");
    // Backpressure is reported, never silent — the failure mode this round exists to end.
    expect(MEMORY_SRC).toContain("dropped for backpressure");
  });

  it("TEST 22 — concurrency and batch size are bounded and configurable", () => {
    const prev = { c: process.env.SEARCH_MEMORY_DB_CONCURRENCY, b: process.env.SEARCH_MEMORY_BATCH_SIZE };
    try {
      expect(MEMORY_SRC).toContain('process.env.SEARCH_MEMORY_DB_CONCURRENCY');
      expect(MEMORY_SRC).toContain('process.env.SEARCH_MEMORY_BATCH_SIZE');
      // The defaults must stay well under the pool's queueLimit of 100 even with several renders.
      expect(MEMORY_SRC).toContain("return 2;");
      expect(MEMORY_SRC).toContain("return 50;");
    } finally {
      if (prev.c === undefined) delete process.env.SEARCH_MEMORY_DB_CONCURRENCY;
      if (prev.b === undefined) delete process.env.SEARCH_MEMORY_BATCH_SIZE;
    }
  });

  it("TEST 23 — a miss still never downgrades a proven success", () => {
    // The batched writer must keep recordVisualSearchMemory's own rule.
    const idx = MEMORY_SRC.indexOf("async function writeSearchMemoryBatch(");
    const body = MEMORY_SRC.slice(idx, MEMORY_SRC.indexOf("\n}", MEMORY_SRC.indexOf("for (const row of individual)", idx)));
    expect(body).toContain("usageCount: sql`${visualSearchMemory.usageCount} + 1`");
    expect(body, "the batch must not write a success verdict at all").not.toMatch(/set:\s*\{[^}]*success:/);
  });
});

/* ═════════════ §E — the funnel has numbers ═════════════ */

describe("RONDE 86 §E — every funnel stage is counted, per provider and in total", () => {
  /**
   * RONDE 87 replaced the counter API these tests were written against.
   *
   * RONDE 86's funnel was a set of counters a caller incremented directly (countFunnel /
   * countRejection), which made "one source of truth for the final counts" a convention rather
   * than something the code could enforce — two call sites could count the same event twice, and
   * a provider could be passed in as any string a caller liked. RONDE 87 derives every number
   * from the lineage EVENTS instead, deduplicated on (lineageId, stage).
   *
   * The guarantees these tests were written for are unchanged and still asserted below, now
   * against the API that actually enforces them. Their stricter successors — no double counting,
   * per-asset rejection attribution, the UNVERIFIED bucket — live in
   * ronde87SourceAuditLogging.test.ts.
   */
  const ledger87 = () => new VisualSourceLedger({ renderId: "r86-compat" });
  const candidate = (l: VisualSourceLedger, provider: string, key: string, at = "/w/c.mp4") =>
    l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: key, contentKey: key,
      provider, localPath: at,
    });

  it("TEST 24 — the funnel covers retrieval through composition, plus the exits", () => {
    expect([...SUMMARY_COUNTERS]).toEqual([
      "searches", "results", "eligible", "ranked", "selected",
      "downloadStarted", "downloadSucceeded", "downloadFailed",
      "adopted", "transformed", "composed", "replaced", "removed",
      "finalVideo", "rejected", "fallback", "rescue", "backfill",
    ]);
    const empty = emptySummaryCounts();
    for (const c of SUMMARY_COUNTERS) expect(empty[c]).toBe(0);
  });

  it("TEST 25 — counts are attributed to a provider and roll up to a total", () => {
    const l = ledger87();
    l.countSearch("Wikimedia", 40);
    l.countSearch("pexels", 60);
    const w = candidate(l, "wikimedia", "wikimedia:1", "/w/w.mp4");
    l.recordEvent(w.lineageId, "ADOPTED", { status: "OK" });
    const s = l.summary();
    expect(s.total.results).toBe(100);
    // Provider names are one key regardless of how a caller spells them.
    expect(s.byProvider.wikimedia!.results).toBe(40);
    expect(s.byProvider.wikimedia!.adopted).toBe(1);
  });

  it("TEST 26 — a rejection names the gate that produced it", () => {
    const l = ledger87();
    const c = candidate(l, "pexels", "pexels:1", "/w/p.mp4");
    for (let i = 0; i < 4; i++) {
      l.recordEvent(c.lineageId, "ELIGIBLE", {
        status: "REJECTED", reason: "vision_gate", gate: "vision_gate", timestamp: 1000 + i,
      });
    }
    const other = candidate(l, "pexels", "pexels:2", "/w/p2.mp4");
    l.recordRejection(other.localPath, "baked_text");
    const s = l.summary();
    // The same asset refused by the same gate is ONE finding, however often it is logged.
    expect(s.failureReasons.vision_gate).toBe(1);
    expect(s.failureReasons.baked_text).toBe(1);
    expect(s.total.rejected).toBe(2);
  });

  it("TEST 27 — every gate in the pipeline reports through one point", () => {
    const audit = createClipRejectAudit();
    const l = ledger87();
    audit.lineage = l;
    const c = candidate(l, "pexels", "pexels:1", "/w/p.mp4");
    recordClipReject(audit, 1, 2, c.localPath, "vision_gate", "q");
    expect(l.summary().total.rejected).toBe(1);
    // And an audit with no ledger (tests, tools) behaves exactly as before.
    const bare = createClipRejectAudit();
    expect(() => recordClipReject(bare, 1, 2, "/w/x.mp4", "vision_gate", "q")).not.toThrow();
    expect(bare.recorded).toBe(1);
  });

  it("TEST 28 — the rescue ladder and the colour card are counted apart from a normal fill", () => {
    expect(adoptRouteForSource("archive")).toBe("primary");
    expect(adoptRouteForSource("rescue_wikimedia")).toBe("rescue");
    expect(adoptRouteForSource("fallback")).toBe("fallback");
    expect(adoptRouteForSource("rescue_placeholder")).toBe("fallback");
    expect(adoptRouteForSource("guaranteed")).toBe("backfill");

    const audit = createClipAdoptAudit();
    const l = ledger87();
    bindLineageLedger(audit, l);
    recordClipAdopt(audit, 0, 0, "b", "/w/a.mp4", "fallback");
    recordClipAdopt(audit, 0, 1, "b", "/w/b.mp4", "rescue_wikimedia");
    recordClipAdopt(audit, 0, 2, "b", "/w/c.mp4", "archive");
    const s = l.summary();
    expect(s.total.fallback).toBe(1);
    expect(s.total.rescue).toBe(1);
    expect(s.total.adopted).toBe(3);
  });

  it("TEST 29 — the report is one readable block, ordered by contribution", () => {
    const l = ledger87();
    l.countSearch("pexels", 900);
    l.countSearch("wikimedia", 40);
    const w = candidate(l, "wikimedia", "wikimedia:1", "/w/w.mp4");
    l.recordEvent(w.lineageId, "COMPOSED", { status: "OK" });
    l.markFinalVideo([w.localPath]);
    const lines = formatFunnelReport(l.summary(), true);
    expect(lines[0]).toContain("[VisualFunnel] TOTAL");
    expect(lines[1], "the provider that actually reached the video comes first").toContain("pexels");
    const summaryLabels = formatSourceSummary(l.summary(), true)
      .flatMap((b) => b.split("\n"))
      .filter((x) => /^ {2}\S/.test(x))
      .map((x) => x.trim());
    expect(summaryLabels[0], "wikimedia filled the video, so it leads the summary").toBe("wikimedia");
  });

  it("TEST 30 — the render emits the funnel and the existing sourcing metrics both", () => {
    expect(PIPELINE_SRC).toContain("formatFunnelReport(summary, ledger.finalVideoWasVerified)");
    expect(PIPELINE_SRC).toContain("formatSourceSummary(summary, ledger.finalVideoWasVerified)");
    // RONDE 86/87 must not have replaced the Phase-20 counters they sit beside.
    expect(PIPELINE_SRC).toContain("export function logSourcingMetrics(");
    expect(PIPELINE_SRC).toContain("[SourcingMetrics] videoId=");
  });
});

/* ═════════════ §F — less work, same quality ═════════════ */

describe("RONDE 86 §F — the scan stops vetting candidates nobody will prepare", () => {
  it("TEST 31 — the queue is capped at what the wave loop can actually consume", () => {
    expect(PIPELINE_SRC).toContain("if (queue.length >= prepareCap) break;");
    // The cap must come from the same number the wave loop uses, not a second constant.
    expect(PIPELINE_SRC).toContain(
      "const prepareCap = archivePrepareAttemptsPerBeat(dedup.perf.fastStockMode, relaxed, tryCap);"
    );
  });

  it("TEST 32 — the candidates that ARE prepared are the same ones, in the same order", () => {
    // The loop is deterministic and front-to-back, so stopping early cannot change which
    // candidates land in the first `prepareCap` slots. Reproduced here against the real shape.
    const ranked = Array.from({ length: 24 }, (_, i) => ({ id: i, ok: i % 3 !== 0 }));
    const build = (limit: number | null) => {
      const q: number[] = [];
      for (const c of ranked) {
        if (limit != null && q.length >= limit) break;
        if (!c.ok) continue;
        q.push(c.id);
      }
      return q;
    };
    expect(build(6)).toEqual(build(null).slice(0, 6));
  });
});

/* ═════════════ §G — two renders share one machine ═════════════ */

describe("RONDE 86 §G — the budget is global, not per render", () => {
  it("TEST 33 — MAX_CONCURRENT_RENDERS exists, defaults to today's behaviour, and serialises at 1", () => {
    const prev = process.env.MAX_CONCURRENT_RENDERS;
    try {
      delete process.env.MAX_CONCURRENT_RENDERS;
      // Default is the queue's own per-worker cap, which is 1 unless MAX_JOBS_PER_WORKER is set —
      // so an existing deployment behaves exactly as it does today.
      expect(maxConcurrentRenders()).toBeGreaterThanOrEqual(1);
      process.env.MAX_CONCURRENT_RENDERS = "1";
      expect(maxConcurrentRenders()).toBe(1);
      process.env.MAX_CONCURRENT_RENDERS = "3";
      expect(maxConcurrentRenders()).toBe(3);
      // Out-of-range values fall back rather than uncapping the box.
      process.env.MAX_CONCURRENT_RENDERS = "999";
      expect(maxConcurrentRenders()).toBeLessThanOrEqual(16);
    } finally {
      if (prev === undefined) delete process.env.MAX_CONCURRENT_RENDERS;
      else process.env.MAX_CONCURRENT_RENDERS = prev;
    }
  });

  it("TEST 34 — the two resources that multiply across renders are gated process-wide", async () => {
    // Measured, not inspected: more tasks than the limit, and the peak in-flight count is checked.
    const limit = globalBudgetSnapshot().mediaFetchLimit;
    let inFlight = 0;
    let peak = 0;
    const task = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    };
    await Promise.all(Array.from({ length: limit * 3 }, () => withGlobalMediaFetch(task)));
    expect(peak).toBeLessThanOrEqual(limit);

    const visionLimit = globalBudgetSnapshot().visionGateLimit;
    inFlight = 0;
    peak = 0;
    await Promise.all(Array.from({ length: visionLimit * 3 }, () => withGlobalVisionGate(task)));
    expect(peak).toBeLessThanOrEqual(visionLimit);
  });

  it("TEST 35 — the gates queue; a render waits, it is never refused", async () => {
    // p-limit runs every queued task. A budget that dropped work would cost a beat its picture,
    // which is worse than the contention it was meant to relieve.
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => withGlobalMediaFetch(async () => i))
    );
    expect(results.length).toBe(40);
    expect(new Set(results).size).toBe(40);
    expect(BUDGET_SRC).not.toMatch(/return null;\s*\/\/ dropped/);
  });

  it("TEST 36 — the gates sit at the single choke point each path already funnels through", () => {
    expect(PIPELINE_SRC).toContain("return withGlobalMediaFetch(() => downloadToFileStreamingInner(");
    expect(PIPELINE_SRC).toContain("const result = await withGlobalVisionGate(() => evaluateClipVisionGate(");
    const queueSrc = fs.readFileSync(path.join(__dirname, "videoQueue.ts"), "utf8");
    expect(queueSrc).toContain("Math.min(config.maxJobsPerWorker, maxConcurrentRenders())");
    expect(queueSrc).toContain("while (activeJobsCount() < renderCap)");
  });

  it("TEST 37 — no global budget varies with video length", () => {
    // RONDE 82's parity rule: a longer video may take longer, it may not consume more at once.
    expect(BUDGET_SRC).not.toMatch(/videoLength|isFastShortVideoLength|"8-10"|"15-20"/);
  });
});

/* ═════════════ §H/I — nothing RONDE 83 fixed was undone ═════════════ */

describe("RONDE 86 §I — the RONDE 83 concurrency limits are intact", () => {
  it("TEST 38 — all seven per-render limits are unchanged", () => {
    const semSrc = fs.readFileSync(path.join(__dirname, "_core", "semaphore.ts"), "utf8");
    const graphicsSrc = fs.readFileSync(path.join(__dirname, "editorialGraphicsEngine.ts"), "utf8");

    expect(semSrc).toContain('parseInt(process.env.FFMPEG_CONCURRENCY_LIMIT ?? "3", 10)');
    expect(graphicsSrc).toContain("pLimit(Math.max(1, montageSegmentParallelism()))");
    expect(CURATED_SRC).toContain("const archiveDownloadLimit = pLimit(archiveDownloadConcurrency());");
    expect(PIPELINE_SRC).toContain("const visualLimit = pLimit(perf.sceneParallelism);");
    expect(PIPELINE_SRC).toContain("const composeLimit = pLimit(composeParallelismForVideo(videoLength, IS_RAILWAY));");
    expect(PIPELINE_SRC).toContain("const beatLimit = pLimit(beatConcurrency);");
    // RONDE 84's wave loop, which the funnel counters must not have restructured.
    expect(PIPELINE_SRC).toContain("if (results.some(Boolean)) return true;");
  });

  it("TEST 39 — compose parallelism is still the same at every video length", () => {
    const values = ["1", "8-10", "10-15", "15-20"].map((l) => composeParallelismForVideo(l, false));
    expect(new Set(values).size, `compose parallelism differs by length: ${values}`).toBe(1);
    expect(montageSegmentParallelism()).toBeGreaterThanOrEqual(2);
  });

  it("TEST 40 — RONDE 85's moving filler and RONDE 84's candidate depth are untouched", () => {
    expect(PIPELINE_SRC).toContain("export const ARCHIVE_PREPARE_ATTEMPTS_MAX = 6;");
    expect(PIPELINE_SRC).not.toContain("return fastMode ? 2 : 2;");
    expect((PIPELINE_SRC.match(/tpad=stop_mode=clone/g) ?? []).length).toBe(1);
  });
});
