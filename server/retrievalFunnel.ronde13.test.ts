import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { applyCrossVideoVarietyDegrade, type CuratedCandidatePick } from "./curatedMediaSourcing";

// RONDE 13 — "as the archive fills, it kept shipping the same footage."
//
// The cross-video variety machinery (getCrossVideoExcludeAssetIds + applyCrossVideoVarietyDegrade,
// cooldown = last 6 same-topic videos) existed, but it was only wired into the OLD non-funnel
// archive scan. The production path is the retrieval funnel, whose searchArchiveCandidates()
// queried the archive with EMPTY exclude sets — so recently-used assets were never held back on
// the path that actually runs. A filled archive therefore kept re-winning the same clips.
//
// Fix: thread the recent-same-topic exclude set into buildRetrievalFunnel (both the prefetch and
// inline call sites) and apply applyCrossVideoVarietyDegrade to the archive picks BEFORE coverage
// scoring — so when only reused assets match, coverage drops, the strategy shifts toward
// internet_dominant, and the pipeline actively pulls fresh external footage. Degrades gracefully:
// if excluding would starve the archive pool, the assets are kept as a last resort.

const funnelSrc = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");
const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** Strips comments so assertions match executable code, not the prose explaining it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function pick(id: number): CuratedCandidatePick {
  return { asset: { id }, score: 50 } as unknown as CuratedCandidatePick;
}

describe("RONDE 13 — the funnel type carries the cross-video exclude set", () => {
  const code = codeOnly(funnelSrc);

  it("RetrievalFunnelRequest declares crossVideoExcludeIds", () => {
    expect(code).toContain("crossVideoExcludeIds?: Set<number>");
  });

  it("buildRetrievalFunnel imports and applies applyCrossVideoVarietyDegrade to the archive picks", () => {
    expect(code).toContain("applyCrossVideoVarietyDegrade");
    // Applied to the archive search result, guarded on a non-empty set.
    expect(code).toContain("req.crossVideoExcludeIds && req.crossVideoExcludeIds.size > 0");
    expect(code).toContain("applyCrossVideoVarietyDegrade(archiveSearchResult.candidates, req.crossVideoExcludeIds)");
  });

  it("the degrade runs BEFORE coverage scoring (so coverage reflects fresh material)", () => {
    const degradeIdx = code.indexOf("applyCrossVideoVarietyDegrade(archiveSearchResult.candidates");
    const coverageIdx = code.indexOf("computeArchiveCoverage(archivePicks");
    expect(degradeIdx).toBeGreaterThan(-1);
    expect(coverageIdx).toBeGreaterThan(-1);
    expect(degradeIdx).toBeLessThan(coverageIdx);
  });
});

describe("RONDE 13 — the pipeline feeds the exclude set into BOTH funnel call sites", () => {
  const code = codeOnly(pipelineSrc);

  it("the exclude set is computed once, before prefetch, so prefetched funnels get it", () => {
    expect(code).toContain("const crossVideoExcludeIdsForRun = archiveCrossVideoVarietyEnabled(videoLength)");
    expect(code).toContain("getCrossVideoExcludeAssetIds(topicContext, videoId)");
  });

  it("the prefetch funnel receives crossVideoExcludeIds", () => {
    // The prefetch buildRetrievalFunnel({...}) passes the computed set.
    const prefetchIdx = code.indexOf("crossVideoExcludeIds: crossVideoExcludeIdsForRun");
    expect(prefetchIdx).toBeGreaterThan(-1);
  });

  it("the inline funnel receives dedup.crossVideoExcludeIds", () => {
    expect(code).toContain("crossVideoExcludeIds: dedup.crossVideoExcludeIds");
  });

  it("visualDedup reuses the same computed set (prefetch + inline + beat dedup agree)", () => {
    expect(code).toContain("visualDedup.crossVideoExcludeIds = crossVideoExcludeIdsForRun");
    // no second getCrossVideoExcludeAssetIds recompute at the visualDedup assignment
    const occurrences = code.match(/getCrossVideoExcludeAssetIds\(/g) ?? [];
    expect(occurrences.length).toBe(1);
  });
});

describe("RONDE 13 — degrade behaviour: filled archive still yields fresh picks or falls back", () => {
  it("holds back recently-used assets when enough fresh ones remain", () => {
    const pool = Array.from({ length: 20 }, (_, i) => pick(i));
    const recentlyUsed = new Set([0, 1, 2, 3, 4]);
    const result = applyCrossVideoVarietyDegrade(pool, recentlyUsed);
    expect(result.every((c) => !recentlyUsed.has(c.asset.id))).toBe(true);
    expect(result.length).toBe(15);
  });

  it("falls back to the full pool (last resort) rather than starving a beat", () => {
    const pool = [pick(0), pick(1), pick(2)];
    const allExcluded = new Set([0, 1, 2]);
    const result = applyCrossVideoVarietyDegrade(pool, allExcluded);
    // never returns empty — the beat is never starved
    expect(result.length).toBe(3);
  });

  it("an empty exclude set is a no-op (unchanged pool)", () => {
    const pool = [pick(0), pick(1)];
    expect(applyCrossVideoVarietyDegrade(pool, new Set())).toBe(pool);
  });
});
