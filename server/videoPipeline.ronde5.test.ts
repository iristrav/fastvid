import { readFileSync } from "fs";
import path from "path";
import {
  pipelineEmergencyFinishMs,
  pipelineRushModeMs,
  visualSourcingTurboMs,
} from "./sourcingPolicy";
import { describe, expect, it } from "vitest";

// RONDE 5 — FIX 6/7/8/9: the retrieval side was proven healthy in render 517 (funnel in
// ~20s, real archiveScores, hybrid coverage, 21 unique downloaded assets, everything
// VisionGate-passed), yet ZERO funnel winners reached compose and the final video was one
// stock clip plus a My Little Pony animation stretched over two scenes. Four causes, four
// fixes:
//
//  FIX 6 — the per-beat shortlist consumption (download+VisionGate of up to 6 candidates,
//          strictly sequential) cost 12-25s against a 12-20s beat budget, so beats were
//          killed mid-loop after downloading passing candidates. Downloads now run in
//          bounded parallel batches of 3; VisionGate stays sequential.
//  FIX 7 — the sourcing degradation ladder (turbo 3min / rush 5min / emergency 7min)
//          measured from generationStartedAt, so script+TTS+prewarm counted against it and
//          a stall-recovery retry inherited the dead attempt's clock (attempt 2 of render
//          517 hit 12s budgets 34 seconds in). The ladder clock now starts when the visual
//          stage starts.
//  FIX 8 — scheduleAuditForAsset was the only background-CPU path without the
//          yield-to-renders rule its two siblings already follow.
//  FIX 9 — the SepiaSearch keyword floor only applied when a person anchor existed; without
//          one, a single-word overlap ("escape", "suicide") was enough to adopt anything.
//
// These live inline in very large functions with no exported unit, so the tests pin the
// executable source, mirroring the FASE 7.2 / RONDE 2 convention.

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const auditorSrc = readFileSync(path.join(__dirname, "clipBackgroundAuditor.ts"), "utf8");

/** Strips comments so assertions match executable code, not the prose explaining it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The funnel consumption block: from the shortlist to the winner pick. */
function funnelConsumptionBlock(): string {
  const start = pipelineSrc.indexOf("const toScore = buildDownloadShortlist(");
  expect(start).toBeGreaterThan(-1);
  const end = pipelineSrc.indexOf("let winner = pickBestFunnelCandidate(scored", start);
  expect(end).toBeGreaterThan(start);
  return pipelineSrc.slice(start, end);
}

// ─── FIX 6 — bounded parallel shortlist downloads ─────────────────────────────

describe("FIX 6 — shortlist downloads run in bounded parallel batches", () => {
  it("the download loop batches by FUNNEL_DOWNLOAD_CONCURRENCY = 3", () => {
    const block = codeOnly(funnelConsumptionBlock());
    expect(block).toContain("const FUNNEL_DOWNLOAD_CONCURRENCY = 3;");
    expect(block).toContain("dlIdx += FUNNEL_DOWNLOAD_CONCURRENCY");
    expect(block).toContain("toScore.slice(dlIdx, dlIdx + FUNNEL_DOWNLOAD_CONCURRENCY)");
    expect(block).toContain("await Promise.all(");
  });

  it("the sequential download form is gone", () => {
    const block = codeOnly(funnelConsumptionBlock());
    // The old shape awaited downloadFunnelCandidate directly inside a for..of over toScore.
    expect(block).not.toMatch(/for \(const candidate of toScore\)/);
  });

  it("FIX 3 is preserved: failed downloads are still registered, successes still counted", () => {
    const block = codeOnly(funnelConsumptionBlock());
    const failBranch = block.slice(block.indexOf("if (!clipPath) {"));
    expect(failBranch).toContain("dedup.usedFunnelCandidateIds.add(candidate.id);");
    expect(failBranch).toContain("continue;");
    // downloadedCount still increments only on the success path, after the failure branch.
    const addIdx = block.indexOf("dedup.usedFunnelCandidateIds.add(candidate.id);");
    const countIdx = block.indexOf("downloadedCount++;");
    expect(addIdx).toBeGreaterThan(-1);
    expect(countIdx).toBeGreaterThan(addIdx);
  });

  it("VisionGate stays sequential and receives exactly the same arguments", () => {
    const block = funnelConsumptionBlock();
    // One VisionGate call, in a plain for..of AFTER the download phase — not inside Promise.all.
    const gateIdx = block.indexOf("await evaluateClipVisionGate(");
    const gateLoopIdx = block.indexOf("for (const { candidate, clipPath } of downloadedClips)");
    expect(gateLoopIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(gateLoopIdx);
    const call = block.slice(gateIdx, block.indexOf(");", gateIdx));
    // FASE 7.2's queryEmb slot is still explicitly undefined (11th positional arg).
    const args = call
      .slice(call.indexOf("(") + 1)
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => l.length > 0 && !l.startsWith("//"));
    expect(args[10]).toBe("undefined");
    expect(call).toContain("clipContentKey(clipPath)");
    expect(call).not.toContain("funnelBeatEmb");
  });

  it("scored order and reject audit are unchanged", () => {
    const block = codeOnly(funnelConsumptionBlock());
    // Results applied in shortlist order: downloadedClips is filled batch-by-batch from
    // toScore slices, and the gate loop walks it in that same order.
    expect(block).toContain("downloadedClips.push({ candidate, clipPath });");
    expect(block).toContain("scored.push({ candidate, clipPath, visionResult });");
    expect(block).toContain('recordClipReject(dedup.clipRejectAudit, scene.index, beat.index, clipPath, "vision_gate", candidate.title);');
  });

  it("winner selection (FIX 1) is untouched", () => {
    expect(pipelineSrc).toMatch(/let winner = pickBestFunnelCandidate\(scored, dedup\.usedFunnelCandidateIds[,)]/);
  });
});

// ─── FIX 7 — the sourcing ladder clock starts at the visual stage ─────────────

describe("FIX 7 — sourcing-ladder clock starts when the visual stage starts", () => {
  it("pipelineStartedMs is re-anchored to Date.now() right before the scene loop", () => {
    const anchor = pipelineSrc.indexOf("Sequential stage: ${scenes.length} scenes");
    expect(anchor).toBeGreaterThan(-1);
    const after = pipelineSrc.slice(anchor, anchor + 1600);
    expect(after).toContain("visualDedup.pipelineStartedMs = Date.now();");
    expect(after).toContain("sourcing-ladder clock started at visual stage");
    // And it happens BEFORE the visual heartbeat that enforces the ladder.
    const resetIdx = pipelineSrc.indexOf("visualDedup.pipelineStartedMs = Date.now();");
    const heartbeatIdx = pipelineSrc.indexOf("const visualHeartbeat = setInterval(");
    expect(resetIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeLessThan(heartbeatIdx);
  });

  it("the initial assignment from the DB wall clock still exists (initial value only)", () => {
    expect(pipelineSrc).toContain("visualDedup.pipelineStartedMs = pipelineWallStartMs;");
  });

  it("the hard wall-clock guard still uses pipelineWallStartMs, not the ladder clock", () => {
    const calls = codeOnly(pipelineSrc).match(/assertPipelineWithinBudget\(videoId, pipelineWallStartMs/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("the fast-short ladder rungs exist and keep their order (values widened by RONDE 8)", () => {
    // FIX 7 itself moved only the CLOCK, not the thresholds — at the time they were 3/5/7 min.
    // RONDE 8 then deliberately widened the fast-short rungs to 5/7/9 (render 518: a 3-scene
    // 1-min video needs ~5min of visual stage, so the last scene always hit turbo budgets).
    // What this test still guards from FIX 7's contract: all three rungs exist for the
    // fast-short path and their ladder ordering is intact.
    // RONDE 81 removed the isFastShortVideoLength branch: the rungs are now the same fractions
    // of every length's own wall-clock target, so long videos get a ladder too. The fast-short
    // VALUES are unchanged, which is what FIX 7's contract was actually about — so this asserts
    // the values the functions return rather than the shape of the source that produces them.
    expect(visualSourcingTurboMs("1")).toBe(5 * 60_000);      // turbo
    expect(pipelineRushModeMs("1")).toBe(7 * 60_000);         // rush
    expect(pipelineEmergencyFinishMs("1")).toBe(9 * 60_000);  // emergency
    expect(visualSourcingTurboMs("1")).toBeLessThan(pipelineRushModeMs("1"));
    expect(pipelineRushModeMs("1")).toBeLessThan(pipelineEmergencyFinishMs("1"));
  });
});

// ─── FIX 8 — background audits yield to active renders ────────────────────────

describe("FIX 8 — scheduleAuditForAsset yields to active render jobs", () => {
  it("skips scheduling when a render job is active, like its two siblings", () => {
    const fn = auditorSrc.slice(auditorSrc.indexOf("export function scheduleAuditForAsset"));
    const body = codeOnly(fn.slice(0, fn.indexOf("let auditorTimer")));
    expect(body).toContain("workerLocalActiveJobs");
    expect(body).toContain("if (workerLocalActiveJobs() > 0) return;");
    // The guard runs BEFORE any asset lookup / ffmpeg / CLIP work.
    expect(body.indexOf("workerLocalActiveJobs() > 0")).toBeLessThan(body.indexOf("getMediaArchiveAssetById"));
  });

  it("the periodic auditor batch (the recovery path for skipped assets) is unchanged", () => {
    const batch = auditorSrc.slice(auditorSrc.indexOf("export async function runClipAuditorBatch"));
    expect(batch).toContain("if (workerLocalActiveJobs() > 0) {");
  });
});

// ─── FIX 9 — SepiaSearch keyword floor without a person anchor ────────────────

describe("FIX 9 — SepiaSearch requires provider-authored relevance without a person anchor", () => {
  function sepiaMetaBlock(): string {
    const start = pipelineSrc.indexOf("const metaHay = `${metaTitle} ${meta.description ?? \"\"} ${tagNames} ${hit.query}`;");
    expect(start).toBeGreaterThan(-1);
    return pipelineSrc.slice(start, start + 2600);
  }

  it("the personless floor exists: providerScore < 2 rejects the candidate", () => {
    const block = codeOnly(sepiaMetaBlock());
    expect(block).toContain("if (!personName && beatKeywords.length > 0) {");
    expect(block).toContain("if (providerScore < 2) {");
    expect(block).toContain("continue;");
  });

  it("the floor is computed over provider-authored text only — hit.query is excluded", () => {
    const block = sepiaMetaBlock();
    const floorIdx = block.indexOf("const providerScore = scoreVisualRelevance(");
    expect(floorIdx).toBeGreaterThan(-1);
    const floorExpr = block.slice(floorIdx, block.indexOf(";", floorIdx));
    expect(floorExpr).toContain("${metaTitle} ${meta.description ?? \"\"} ${tagNames}");
    expect(floorExpr).not.toContain("hit.query"); // our own query would be circular evidence
  });

  it("the existing person-anchored guards are byte-identical", () => {
    const block = codeOnly(sepiaMetaBlock());
    expect(block).toContain("if (personName && !textMentionsPersonName(metaHay, personName)) continue;");
    expect(block).toContain("if (beatKeywords.length > 0 && metaScore < 2 && personName) continue;");
  });

  it("rejections are logged with the title so the next render log shows what was blocked", () => {
    expect(pipelineSrc).toContain("SepiaSearch candidate rejected (no person anchor,");
  });

  it("scoreVisualRelevance itself is unchanged (simple keyword count)", () => {
    const fn = pipelineSrc.slice(pipelineSrc.indexOf("function scoreVisualRelevance"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("if (kw.length < 3) continue;");
    expect(body).toContain("if (t.includes(kw)) score++;");
  });

  it("regression: the render-517 failures would now be blocked", () => {
    // Reimplements the floor expression byte-for-byte to show what it does to the two clips
    // that shipped: provider-authored text sharing <2 beat keywords is refused.
    const scoreVisualRelevance = (text: string, keywords: string[]): number => {
      const t = text.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (kw.length < 3) continue;
        if (t.includes(kw)) score++;
      }
      return score;
    };
    const beatKeywords = ["hitler", "bunker", "berlin", "suicide", "escape", "cyanide"];
    // The two clips that filled render 517's final video:
    expect(scoreVisualRelevance("[SFM Ponies] Little Pip explosive escape (2015) (Reupload)", beatKeywords)).toBeLessThan(2);
    expect(scoreVisualRelevance("Suicide Commando - live", beatKeywords)).toBeLessThan(2);
    // A genuinely on-topic candidate clears the floor trivially:
    expect(scoreVisualRelevance("Hitler's bunker in Berlin, 1945 newsreel footage", beatKeywords)).toBeGreaterThanOrEqual(2);
  });
});

// ─── Earlier rounds are untouched ─────────────────────────────────────────────

describe("RONDE 1-4 are untouched by RONDE 5", () => {
  const funnelSrc = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");
  const poolSrc = readFileSync(path.join(__dirname, "scenePool.ts"), "utf8");
  const embSrc = readFileSync(path.join(__dirname, "archiveEmbeddingIndex.ts"), "utf8");

  it("R1/R2 winner memory + gap-strategy ordering intact", () => {
    expect(funnelSrc).toContain("const unusedPassers = usedCandidateIds?.size");
    expect(funnelSrc).toContain('case "archive_only":\n    case "one_external":\n    case "all_external":');
    const adds = codeOnly(pipelineSrc).match(/dedup\.usedFunnelCandidateIds\.add\(candidate\.id\);/g) ?? [];
    expect(adds).toHaveLength(2); // failed download (FIX 3) + winner (FIX 1)
  });

  it("R3 provider batching + R4 DB-backed embedding index intact", () => {
    expect(poolSrc).toContain("const DETAIL_FETCH_CONCURRENCY = 5;");
    expect(embSrc).toContain("export async function ensureArchiveEmbeddingCacheLoaded(");
    expect(embSrc).toContain("fastvid_archive_asset_embeddings");
  });

  it("FASE 7.2/7.3 intact", () => {
    const localSrc = readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
    expect(localSrc).toMatch(/const MODERN_EVIDENCE_MIN_SIM = visionThreshold\("MODERN_EVIDENCE_MIN_SIM", 0\.235\)/);
    expect(pipelineSrc).toContain("queryEmbeddingSource=resolved-by-vision-gate");
  });

  it("no ranking constant, VisionGate threshold or provider timeout moved", () => {
    expect(funnelSrc).toContain("export const STOCK_TIER_WIN_MARGIN = 1.0;");
    expect(funnelSrc).toContain("export const MAX_FUNNEL_CANDIDATES_TO_SCORE = 6;");
    const localSrc = readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
    expect(localSrc).toContain("return minScore10 / 40;");
    const code = codeOnly(pipelineSrc);
    expect(code).not.toContain("Math.random() <");
  });
});
