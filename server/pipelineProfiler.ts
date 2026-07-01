/**
 * PipelineProfiler — per-render timing accumulator + report printer.
 *
 * Collects per-scene breakdown (retrieve → recover → queue → compose),
 * stage wall-clock timestamps, and FFmpeg configuration, then prints a
 * structured report at the end of each video render.
 *
 * Usage:
 *   const prof = createPipelineProfiler(videoId, videoLength, perf);
 *   prof.recordStageStart("script", t0);
 *   prof.recordStageEnd("tts", t1);
 *   prof.recordSceneRetrieve(i, sceneIndex, sceneDuration, startMs, endMs, recoverMs, clipCount);
 *   prof.recordSceneCompose(i, sceneIndex, queueWaitMs, startMs, endMs);
 *   prof.printReport(totalWallMs, pipelineStepTiming.toReport());
 */

import os from "os";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SceneTimingEntry = {
  sceneIndex: number;
  sceneDurationSec: number;
  clipCount: number;
  retrieveMs: number;
  recoverMs: number;
  composeQueueMs: number;
  composeMs: number;
};

export type StageEntry = {
  name: string;
  startMs: number;
  endMs: number;
  parallel: boolean; // true → excluded from serial critical path
};

export type PipelineProfilerConfig = {
  composeParallelism: number;
  retrieveParallelism: number;
  montageSegmentParallelism: number;
  ffmpegPreset: string;
  crf: string;
};

// ─── Profiler ─────────────────────────────────────────────────────────────────

export type PipelineProfiler = ReturnType<typeof createPipelineProfiler>;

export function createPipelineProfiler(
  videoId: string,
  videoLength: string,
  cfg: PipelineProfilerConfig
) {
  const sceneTimings: SceneTimingEntry[] = [];
  const stages: StageEntry[] = [];

  // Record a stage that starts and ends at known wall-clock times.
  // Call recordStageStart(name, now) when stage begins, recordStageEnd(name, now) when done.
  const stageStarts = new Map<string, number>();

  function recordStageStart(name: string, atMs = Date.now()): void {
    stageStarts.set(name, atMs);
  }

  function recordStageEnd(name: string, atMs = Date.now(), parallel = false): void {
    const startMs = stageStarts.get(name) ?? atMs;
    stageStarts.delete(name);
    stages.push({ name, startMs, endMs: atMs, parallel });
  }

  function recordStageRange(name: string, startMs: number, endMs: number, parallel = false): void {
    stages.push({ name, startMs, endMs, parallel });
  }

  function recordSceneRetrieve(
    _slotIndex: number,
    sceneIndex: number,
    sceneDurationSec: number,
    startMs: number,
    endMs: number,
    recoverMs: number,
    clipCount: number
  ): void {
    // Find existing entry or create one
    let entry = sceneTimings.find((e) => e.sceneIndex === sceneIndex);
    if (!entry) {
      entry = {
        sceneIndex,
        sceneDurationSec,
        clipCount,
        retrieveMs: endMs - startMs,
        recoverMs,
        composeQueueMs: 0,
        composeMs: 0,
      };
      sceneTimings.push(entry);
    } else {
      entry.retrieveMs = endMs - startMs;
      entry.recoverMs = recoverMs;
      entry.clipCount = clipCount;
    }
  }

  function recordSceneCompose(
    _slotIndex: number,
    sceneIndex: number,
    queueWaitMs: number,
    startMs: number,
    endMs: number
  ): void {
    let entry = sceneTimings.find((e) => e.sceneIndex === sceneIndex);
    if (!entry) {
      entry = {
        sceneIndex,
        sceneDurationSec: 0,
        clipCount: 0,
        retrieveMs: 0,
        recoverMs: 0,
        composeQueueMs: queueWaitMs,
        composeMs: endMs - startMs,
      };
      sceneTimings.push(entry);
    } else {
      entry.composeQueueMs = queueWaitMs;
      entry.composeMs = endMs - startMs;
    }
  }

  function printReport(
    totalWallMs: number,
    stepReport?: { rows: Array<{ category: string; label: string; sceneIndex?: number; ms: number }>; totalsByCategory: Record<string, number> }
  ): void {
    const cpuCount = (() => { try { return os.cpus().length; } catch { return 0; } })();
    const sep = "─".repeat(68);
    const dbl = "═".repeat(68);

    console.log(`\n[PipelineReport] ${dbl}`);
    console.log(`[PipelineReport]  VIDEO RENDER PROFILE  videoId=${videoId}  len=${videoLength}`);
    console.log(`[PipelineReport] ${dbl}`);
    console.log(`[PipelineReport]  Total wall-clock: ${fmtSec(totalWallMs)}  |  CPU cores: ${cpuCount}`);
    console.log(
      `[PipelineReport]  Compose parallelism: ${cfg.composeParallelism}  ` +
      `Retrieve parallelism: ${cfg.retrieveParallelism}  ` +
      `Montage segment parallelism: ${cfg.montageSegmentParallelism}`
    );
    console.log(
      `[PipelineReport]  FFmpeg: preset=${cfg.ffmpegPreset}  CRF=${cfg.crf || "18"}  ` +
      `max concurrent ffmpeg: ~${cfg.composeParallelism * cfg.montageSegmentParallelism}`
    );

    // Encoder recommendation
    const presetRanks: Record<string, number> = {
      ultrafast: 1, superfast: 2, veryfast: 3, faster: 4, fast: 5,
      medium: 6, slow: 7, slower: 8, veryslow: 9,
    };
    const curRank = presetRanks[cfg.ffmpegPreset] ?? 3;
    if (curRank > 3) {
      const speedupMap: Record<string, string> = {
        medium: "2.0–2.5×", slow: "3–4×", slower: "5–6×", veryslow: "7–10×",
        fast: "1.3–1.6×", faster: "1.1–1.3×",
      };
      const bitrateIncrease: Record<string, string> = {
        medium: "~8%", slow: "~5%", slower: "~3%", fast: "~12%", faster: "~15%",
      };
      console.log(`[PipelineReport]  ⚠ Encoder recommendation:`);
      console.log(`[PipelineReport]    Current:        libx264 preset=${cfg.ffmpegPreset} crf=${cfg.crf || "18"}`);
      console.log(`[PipelineReport]    Recommended:    libx264 preset=veryfast  (set FFMPEG_PRESET=veryfast)`);
      console.log(`[PipelineReport]    Estimated speedup: ${speedupMap[cfg.ffmpegPreset] ?? "unknown"}  bitrate increase: ${bitrateIncrease[cfg.ffmpegPreset] ?? "~10%"}  VMAF loss: <1`);
    } else {
      console.log(`[PipelineReport]  ✓ Encoder preset=${cfg.ffmpegPreset} (optimal range)`);
    }

    // ── Critical path ────────────────────────────────────────────────────────
    console.log(`[PipelineReport] ${sep}`);
    console.log(`[PipelineReport]  CRITICAL PATH`);
    const serialStages = stages.filter((s) => !s.parallel).sort((a, b) => a.startMs - b.startMs);
    const parallelStages = stages.filter((s) => s.parallel);

    let criticalMs = 0;
    const stageRows: Array<{ name: string; ms: number; pct: number; parallel: boolean }> = [];
    for (const s of stages) {
      const ms = s.endMs - s.startMs;
      stageRows.push({ name: s.name, ms, pct: 0, parallel: s.parallel });
      if (!s.parallel) criticalMs += ms;
    }
    const idleMs = Math.max(0, totalWallMs - criticalMs);
    const allMs = criticalMs + idleMs;

    // Compute percentages as fraction of total wall time
    for (const r of stageRows) r.pct = totalWallMs > 0 ? (r.ms / totalWallMs) * 100 : 0;

    const maxBarWidth = 30;
    for (const r of stageRows) {
      const bar = "█".repeat(Math.round((r.pct / 100) * maxBarWidth));
      const parallelTag = r.parallel ? " [parallel]" : "";
      console.log(
        `[PipelineReport]    ${r.name.padEnd(20)} ${fmtSec(r.ms).padStart(7)}  ${r.pct.toFixed(0).padStart(3)}%  ${bar}${parallelTag}`
      );
    }
    if (idleMs > 500) {
      const idlePct = totalWallMs > 0 ? (idleMs / totalWallMs) * 100 : 0;
      const bar = "░".repeat(Math.round((idlePct / 100) * maxBarWidth));
      console.log(
        `[PipelineReport]    ${"idle / unaccounted".padEnd(20)} ${fmtSec(idleMs).padStart(7)}  ${idlePct.toFixed(0).padStart(3)}%  ${bar}`
      );
    }

    // Bottleneck
    const bottleneck = [...stageRows].sort((a, b) => b.ms - a.ms)[0];
    if (bottleneck) {
      console.log(`[PipelineReport]  Bottleneck: ${bottleneck.name} (${fmtSec(bottleneck.ms)}, ${bottleneck.pct.toFixed(0)}% of wall time)`);
    }

    // ── Per-scene breakdown ──────────────────────────────────────────────────
    if (sceneTimings.length > 0) {
      console.log(`[PipelineReport] ${sep}`);
      console.log(`[PipelineReport]  PER-SCENE BREAKDOWN  (retrieve → recover → queue → compose → total)`);
      const sorted = [...sceneTimings].sort((a, b) => {
        const ta = a.retrieveMs + a.recoverMs + a.composeQueueMs + a.composeMs;
        const tb = b.retrieveMs + b.recoverMs + b.composeQueueMs + b.composeMs;
        return tb - ta; // slowest first
      });

      let sumRetrieve = 0, sumRecover = 0, sumQueue = 0, sumCompose = 0;
      for (const e of sorted) {
        const total = e.retrieveMs + e.recoverMs + e.composeQueueMs + e.composeMs;
        console.log(
          `[PipelineReport]    Scene ${String(e.sceneIndex).padStart(2)}  ` +
          `clips=${e.clipCount}  dur=${e.sceneDurationSec.toFixed(1)}s  ` +
          `retrieve=${fmtSec(e.retrieveMs)}  recover=${fmtSec(e.recoverMs)}  ` +
          `queue=${fmtSec(e.composeQueueMs)}  compose=${fmtSec(e.composeMs)}  ` +
          `TOTAL=${fmtSec(total)}`
        );
        sumRetrieve += e.retrieveMs;
        sumRecover += e.recoverMs;
        sumQueue += e.composeQueueMs;
        sumCompose += e.composeMs;
      }

      const sceneCount = sceneTimings.length;
      console.log(`[PipelineReport]    AVG (${sceneCount} scenes)` +
        `  retrieve=${fmtSec(sumRetrieve / sceneCount)}  recover=${fmtSec(sumRecover / sceneCount)}` +
        `  queue=${fmtSec(sumQueue / sceneCount)}  compose=${fmtSec(sumCompose / sceneCount)}`
      );

      // Top 10 slowest by compose time
      const top10Compose = [...sceneTimings].sort((a, b) => b.composeMs - a.composeMs).slice(0, 10);
      console.log(`[PipelineReport]  TOP 10 SLOWEST compose:`);
      for (const e of top10Compose) {
        if (e.composeMs === 0) continue;
        console.log(
          `[PipelineReport]    Scene ${e.sceneIndex}  compose=${fmtSec(e.composeMs)}  clips=${e.clipCount}  dur=${e.sceneDurationSec.toFixed(1)}s`
        );
      }
    }

    // ── pipelineStepTiming summary (if provided) ─────────────────────────────
    if (stepReport) {
      const byCategory = stepReport.totalsByCategory;
      const cats = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
      if (cats.length > 0) {
        console.log(`[PipelineReport] ${sep}`);
        console.log(`[PipelineReport]  INSTRUMENTED STAGE TOTALS (may overlap for parallel stages)`);
        const instrTotal = cats.reduce((s, [, ms]) => s + ms, 0);
        for (const [cat, ms] of cats) {
          const pct = instrTotal > 0 ? (ms / instrTotal) * 100 : 0;
          console.log(`[PipelineReport]    ${cat.padEnd(30)} ${fmtSec(ms).padStart(7)}  ${pct.toFixed(0)}%`);
        }
        console.log(`[PipelineReport]    ${"Total instrumented".padEnd(30)} ${fmtSec(instrTotal).padStart(7)}`);
      }
    }

    console.log(`[PipelineReport] ${dbl}\n`);
  }

  return {
    recordStageStart,
    recordStageEnd,
    recordStageRange,
    recordSceneRetrieve,
    recordSceneCompose,
    printReport,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtSec(ms: number): string {
  if (ms <= 0) return "0.0s";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
