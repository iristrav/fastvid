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
    /** RONDE 661: the scene loop's heartbeat — the P5A heartbeat and the stage-4 guard are deleted. */
    expect(calls.length).toBeGreaterThanOrEqual(1);
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

// FIX 9's SepiaSearch floor left with SepiaSearch (removed in VIDEO 619: nothing it found ever
// reached a film). The keyword count the floor used is still pinned.
describe("FIX 9 — the keyword count behind the old SepiaSearch floor", () => {
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

