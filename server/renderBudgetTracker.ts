/**
 * BudgetTracker  — tracks one render's stage timing vs budget, measures
 *                  FFmpeg/network/queue/idle time, logs remaining budget.
 * BudgetHistory  — in-process rolling averages across renders (worker-lifetime).
 *                  Provides the historical signal for computeRenderBudget().
 *
 * Usage:
 *   const tracker = new BudgetTracker(budget, videoId);
 *   tracker.stageStart("tts",       budget.ttsMs);
 *   ...
 *   tracker.stageEnd("tts");
 *   tracker.stageStart("retrieval", budget.perSceneRetrieveMs * scenes);
 *   ...
 *   const signals = tracker.stageEnd("retrieval");   // logs remaining budget
 *   tracker.refineFromSignals({ archiveClipRatio, aiClipRatio, ... });
 *   tracker.stageStart("compose",   budget.basePerSceneComposeMs * scenes);
 *   ...
 *   tracker.stageEnd("compose");
 *   tracker.logSummary();               // estimated vs actual, idle time etc.
 *   recordBudgetOutcome(tracker.outcome());  // feeds next render's history
 */

import type { RenderBudget } from "./renderBudget";

// ─── Rolling average helper ────────────────────────────────────────────────

class RollingAvg {
  private readonly values: number[] = [];
  constructor(private readonly maxN = 12) {}

  push(v: number): void {
    this.values.push(v);
    if (this.values.length > this.maxN) this.values.shift();
  }

  avg(): number | null {
    if (this.values.length === 0) return null;
    return this.values.reduce((a, b) => a + b, 0) / this.values.length;
  }

  /** Coefficient of variation (stdDev / avg). Low = stable, high = noisy. */
  cv(): number {
    const a = this.avg();
    if (a == null || a === 0 || this.values.length < 2) return 0;
    const variance = this.values.reduce((s, v) => s + (v - a) ** 2, 0) / this.values.length;
    return Math.sqrt(variance) / a;
  }

  count(): number { return this.values.length; }
}

// ─── Per-tier averages ─────────────────────────────────────────────────────

interface TierAvgs {
  perSceneComposeMs:  RollingAvg;
  perSceneRetrieveMs: RollingAvg;
  concatMs:           RollingAvg;
  uploadMs:           RollingAvg;
  ttsMs:              RollingAvg;
  musicMixMs:         RollingAvg;
}

function newTierAvgs(): TierAvgs {
  return {
    perSceneComposeMs:  new RollingAvg(),
    perSceneRetrieveMs: new RollingAvg(),
    concatMs:           new RollingAvg(),
    uploadMs:           new RollingAvg(),
    ttsMs:              new RollingAvg(),
    musicMixMs:         new RollingAvg(),
  };
}

/** Video-length tier (aligns with renderBudget.ts breakpoints). */
export type BudgetTier = "short" | "medium" | "long" | "vlong";

export function getBudgetTier(expectedVideoSec: number): BudgetTier {
  const m = expectedVideoSec / 60;
  if (m < 3)  return "short";
  if (m < 6)  return "medium";
  if (m < 10) return "long";
  return "vlong";
}

// ─── Singleton process-lifetime history ────────────────────────────────────

const _history: Record<BudgetTier, TierAvgs> = {
  short:  newTierAvgs(),
  medium: newTierAvgs(),
  long:   newTierAvgs(),
  vlong:  newTierAvgs(),
};

export interface HistoricalAvgs {
  perSceneComposeMs:  number | null;
  perSceneRetrieveMs: number | null;
  concatMs:           number | null;
  uploadMs:           number | null;
  ttsMs:              number | null;
  sampleCount:        number;
  /** True if averages are stable enough to use for adjustment. */
  reliable:           boolean;
}

/** Read worker-lifetime averages for a tier. */
export function getHistoricalAvgs(tier: BudgetTier): HistoricalAvgs {
  const t = _history[tier];
  const count = t.perSceneComposeMs.count();
  return {
    perSceneComposeMs:  t.perSceneComposeMs.avg(),
    perSceneRetrieveMs: t.perSceneRetrieveMs.avg(),
    concatMs:           t.concatMs.avg(),
    uploadMs:           t.uploadMs.avg(),
    ttsMs:              t.ttsMs.avg(),
    sampleCount: count,
    // Reliable when ≥ 3 samples with low coefficient of variation
    reliable: count >= 3 && t.perSceneComposeMs.cv() < 0.35,
  };
}

// ─── Budget outcome (persisted after render) ───────────────────────────────

export interface BudgetOutcome {
  tier:             BudgetTier;
  scenesCount:      number;
  expectedVideoSec: number;
  budgetMs:         number;
  actualMs:         number;
  budgetUsedPct:    number;
  confidence:       string;
  predictionErrorPct: number;
  stageActuals: {
    perSceneComposeMs:  number | null;
    perSceneRetrieveMs: number | null;
    concatMs:           number | null;
    uploadMs:           number | null;
    ttsMs:              number | null;
  };
  utilization: {
    ffmpegBusyMs:  number;
    networkWaitMs: number;
    queueWaitMs:   number;
    idleMs:        number;
    ffmpegPct:     number;
    idlePct:       number;
  };
}

/** Feed a completed render's outcome into process-lifetime history. */
export function recordBudgetOutcome(outcome: BudgetOutcome): void {
  const tier = _history[outcome.tier];
  const n = outcome.scenesCount;
  if (outcome.stageActuals.perSceneComposeMs  != null) tier.perSceneComposeMs.push(outcome.stageActuals.perSceneComposeMs);
  if (outcome.stageActuals.perSceneRetrieveMs != null) tier.perSceneRetrieveMs.push(outcome.stageActuals.perSceneRetrieveMs);
  if (outcome.stageActuals.concatMs           != null) tier.concatMs.push(outcome.stageActuals.concatMs);
  if (outcome.stageActuals.uploadMs           != null) tier.uploadMs.push(outcome.stageActuals.uploadMs);
  if (outcome.stageActuals.ttsMs              != null) tier.ttsMs.push(outcome.stageActuals.ttsMs);
  void n; // scenesCount available for future per-scene normalization
}

// ─── Per-render stage tracker ──────────────────────────────────────────────

interface StageEntry {
  stage:    string;
  budgetMs: number;
  startMs:  number;
  endMs:    number | null;
}

/** Signals collected after retrieval for mid-render budget refinement. */
export interface RetrievalSignals {
  /** Fraction of clips that came from local archive (0..1). High = faster compose. */
  archiveClipRatio:   number;
  /** Fraction of clips that are AI-generated (0..1). High = slower compose. */
  aiClipRatio:        number;
  /** Fraction of retrieval calls that hit a local cache (0..1). */
  clipCacheHitRatio:  number;
  /** Total clips actually retrieved (for per-clip complexity check). */
  totalClipsRetrieved: number;
  /** Average clips per scene (for refining per-scene compose budget). */
  avgClipsPerScene:   number;
}

export class BudgetTracker {
  private readonly renderStartMs: number;
  private readonly budget:        RenderBudget;
  private readonly videoId:       number | string;
  private stages:       StageEntry[] = [];
  private ffmpegBusyMs  = 0;
  private networkWaitMs = 0;
  private queueWaitMs   = 0;
  private refinedAt:    string | null = null;
  private refinedDelta: number | null = null;

  constructor(budget: RenderBudget, videoId: number | string) {
    this.budget       = budget;
    this.videoId      = videoId;
    this.renderStartMs = Date.now();
  }

  /** Call at the start of each major stage. */
  stageStart(stage: string, budgetMs: number): void {
    this.stages.push({ stage, budgetMs, startMs: Date.now(), endMs: null });
    const elapsedMs      = Date.now() - this.renderStartMs;
    const remainingMs    = Math.max(0, this.budget.totalMs - elapsedMs);
    console.log(
      `[Budget] video=${this.videoId} → ${stage}  ` +
      `budget=${fmtMs(budgetMs)}  elapsed=${fmtMs(elapsedMs)}  remaining=${fmtMs(remainingMs)}`
    );
  }

  /**
   * Call at the end of each stage. Logs actual vs budget and remaining total.
   *
   * ── RONDE 137: a stage that OVERLAPS another reports how much of it was its own ────────────
   *
   * Video 558 reported this, and it sent a whole round of investigation the wrong way:
   *
   *     ✓ retrieval  actual=16m 32s / budget=1m 36s   OVER +14m 56s
   *     ✓ compose    actual=16m 15s / budget=4m 24s   OVER +11m 51s
   *
   * Compose looked like the bottleneck. It was not: the three scenes took 22.2s, 26.7s and 8.2s of
   * ffmpeg — 57 seconds in total. The 16m15 is wall-clock, and compose runs INTERLEAVED with
   * retrieval (stageStart("compose") sits inside the chunk loop, stageEnd after it), so both
   * stages were open across the same window and both measured it. The same sixteen minutes,
   * counted twice, and both blamed.
   *
   * `exclusiveMs` is the part of this stage's window during which no earlier stage was still open.
   * It does not replace `actual` — the wall-clock number is still true and still the one the budget
   * is compared against — it says how much of that time belongs to this stage alone. For video 558
   * compose would have reported roughly a minute exclusive against sixteen wall-clock, which is the
   * distinction between "compose is slow" and "compose is waiting".
   */
  stageEnd(stage: string): { actualMs: number; budgetMs: number; overBudget: boolean } {
    const entry = [...this.stages].reverse().find(s => s.stage === stage && s.endMs == null);
    if (entry) entry.endMs = Date.now();
    const actualMs    = entry ? (entry.endMs! - entry.startMs) : 0;
    const bMs         = entry?.budgetMs ?? 0;
    const overBudget  = actualMs > bMs;
    const elapsedMs   = Date.now() - this.renderStartMs;
    const remainingMs = Math.max(0, this.budget.totalMs - elapsedMs);
    const tag = overBudget
      ? ` ⚠ OVER +${fmtMs(actualMs - bMs)}`
      : ` ✓ saved ${fmtMs(bMs - actualMs)}`;
    const exclusiveMs = entry ? this.exclusiveMsFor(entry) : 0;
    // Only worth printing when the two genuinely differ — an unoverlapped stage would just repeat
    // itself, and a repeated number reads as noise rather than as information.
    const overlapTag =
      entry && actualMs - exclusiveMs > 1_000
        ? `  exclusive=${fmtMs(exclusiveMs)} (overlapped ${fmtMs(actualMs - exclusiveMs)} with an earlier stage)`
        : "";
    console.log(
      `[Budget] video=${this.videoId} ✓ ${stage}  ` +
      `actual=${fmtMs(actualMs)} / budget=${fmtMs(bMs)}${tag}  ` +
      `total_remaining=${fmtMs(remainingMs)}${overlapTag}`
    );
    return { actualMs, budgetMs: bMs, overBudget };
  }

  /**
   * How much of `entry`'s window had no OTHER stage open at the same time.
   *
   * Overlap is attributed to whichever stage started FIRST, because that is the one still waiting:
   * in video 558 retrieval was the long pole and compose ran inside its window, so the sixteen
   * shared minutes belong to retrieval and compose is left with what it alone occupied.
   *
   * Pure arithmetic over the stage list this class already keeps; it records nothing new and
   * changes no decision. A stage still running (endMs null) counts up to this stage's end.
   */
  private exclusiveMsFor(entry: { stage: string; startMs: number; endMs: number | null }): number {
    const end = entry.endMs ?? Date.now();
    const earlier = this.stages.filter(
      (s) => s !== entry && s.startMs < entry.startMs
    );
    // Merge the earlier stages' windows, clipped to this one, then subtract their union.
    const spans = earlier
      .map((s) => [Math.max(s.startMs, entry.startMs), Math.min(s.endMs ?? end, end)] as const)
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let cursor = entry.startMs;
    for (const [a, b] of spans) {
      if (b <= cursor) continue;
      covered += b - Math.max(a, cursor);
      cursor = Math.max(cursor, b);
    }
    return Math.max(0, end - entry.startMs - covered);
  }

  /** Record FFmpeg process wall-clock time. Call from execRaw completion. */
  /**
   * RONDE 129 — how much of the render's clock is left.
   *
   * The tracker already knows this (it computes it for stageEnd and logSummary); nothing could
   * ASK it. A retry that will be cut off by the deadline costs its wait and its work and delivers
   * nothing, so the decision to retry needs this number.
   */
  remainingMs(): number {
    return Math.max(0, this.budget.totalMs - (Date.now() - this.renderStartMs));
  }

  addFfmpegBusyMs(ms: number):  void { this.ffmpegBusyMs  += ms; }
  /** Record outbound network wait (download/upload time). */
  addNetworkWaitMs(ms: number): void { this.networkWaitMs += ms; }
  /** Record time a task spent waiting in a pLimit queue. */
  addQueueWaitMs(ms: number):   void { this.queueWaitMs   += ms; }

  /**
   * Refine the compose budget based on what retrieval actually produced.
   * Call this after Stage 3 (retrieval) before Stage 4 (compose) starts.
   * The refinement is logged and the updated values are written back to the
   * active render budget via the returned adjustment object.
   */
  refineFromSignals(
    signals: RetrievalSignals,
    activeBudget: RenderBudget
  ): { newComposeMs: number; newConfidence: import("./renderBudget").BudgetConfidence } {
    const base = activeBudget.basePerSceneComposeMs;
    let factor = 1.0;
    const reasons: string[] = [];

    // Archive clips compose faster (local file, no download, simple encode)
    if (signals.archiveClipRatio > 0.6) {
      factor *= 0.85;
      reasons.push(`archive_heavy (${Math.round(signals.archiveClipRatio * 100)}%) → −15%`);
    }

    // AI-generated clips are large + slow to encode (diffusion output)
    if (signals.aiClipRatio > 0.25) {
      factor *= 1.20;
      reasons.push(`ai_heavy (${Math.round(signals.aiClipRatio * 100)}%) → +20%`);
    } else if (signals.aiClipRatio > 0.1) {
      factor *= 1.10;
      reasons.push(`ai_moderate (${Math.round(signals.aiClipRatio * 100)}%) → +10%`);
    }

    // High cache hit ratio → clips already probed + validated → faster compose setup
    if (signals.clipCacheHitRatio > 0.7) {
      factor *= 0.92;
      reasons.push(`cache_hit (${Math.round(signals.clipCacheHitRatio * 100)}%) → −8%`);
    }

    // More clips per scene → longer montage encode
    if (signals.avgClipsPerScene > 10) {
      factor *= 1.15;
      reasons.push(`clip_dense (${signals.avgClipsPerScene.toFixed(1)}/scene) → +15%`);
    } else if (signals.avgClipsPerScene < 4) {
      factor *= 0.90;
      reasons.push(`clip_sparse (${signals.avgClipsPerScene.toFixed(1)}/scene) → −10%`);
    }

    const newComposeMs = Math.round(
      Math.min(Math.max(base * factor, 45_000), 180_000)
    );

    const newConfidence: import("./renderBudget").BudgetConfidence =
      Math.abs(factor - 1.0) < 0.08
        ? "HIGH"
        : factor < 1.0
          ? "HIGH"   // we're tightening = conservative
          : "MEDIUM";

    const delta = newComposeMs - base;
    this.refinedAt    = "post-retrieval";
    this.refinedDelta = delta;

    console.log(
      `[Budget] video=${this.videoId} refinement @ post-retrieval\n` +
      `  base_compose=${fmtMs(base)} → refined=${fmtMs(newComposeMs)} (factor=${factor.toFixed(2)})\n` +
      `  signals: ${reasons.join(", ") || "no adjustment"}\n` +
      `  new_confidence=${newConfidence}`
    );

    return { newComposeMs, newConfidence };
  }

  /** Produce the final BudgetOutcome for history + persistence. */
  outcome(): BudgetOutcome {
    const totalActualMs = Date.now() - this.renderStartMs;
    const tier = getBudgetTier(this.budget.expectedVideoSec);
    const scenes = this.budget.scenesCount;

    const stageMs = (name: string): number | null => {
      const e = this.stages.find(s => s.stage === name && s.endMs != null);
      return e ? (e.endMs! - e.startMs) : null;
    };

    const composeMs  = stageMs("compose");
    const retrieveMs = stageMs("retrieval");
    const idle = Math.max(0, totalActualMs - this.ffmpegBusyMs - this.networkWaitMs - this.queueWaitMs);

    return {
      tier,
      scenesCount:      scenes,
      expectedVideoSec: this.budget.expectedVideoSec,
      budgetMs:         this.budget.totalMs,
      actualMs:         totalActualMs,
      budgetUsedPct:    Math.round((totalActualMs / this.budget.totalMs) * 100),
      confidence:       this.budget.confidence,
      predictionErrorPct: Math.round(((totalActualMs - this.budget.totalMs) / this.budget.totalMs) * 100),
      stageActuals: {
        perSceneComposeMs:  composeMs  != null ? Math.round(composeMs  / scenes) : null,
        perSceneRetrieveMs: retrieveMs != null ? Math.round(retrieveMs / scenes) : null,
        concatMs:   stageMs("concat"),
        uploadMs:   stageMs("upload"),
        ttsMs:      stageMs("tts"),
      },
      utilization: {
        ffmpegBusyMs:  this.ffmpegBusyMs,
        networkWaitMs: this.networkWaitMs,
        queueWaitMs:   this.queueWaitMs,
        idleMs:        idle,
        ffmpegPct:     Math.round((this.ffmpegBusyMs  / totalActualMs) * 100),
        idlePct:       Math.round((idle               / totalActualMs) * 100),
      },
    };
  }

  /** Log final render summary with estimated vs actual times. */
  logSummary(): void {
    const o = this.outcome();
    const sign = (n: number) => n > 0 ? `+${n}%` : `${n}%`;
    const refinement = this.refinedDelta != null
      ? `  refined_compose=${this.refinedAt} Δ${fmtMs(Math.abs(this.refinedDelta))} ${this.refinedDelta > 0 ? "up" : "down"}`
      : "";
    console.log(
      [
        `[BudgetSummary] video=${this.videoId}`,
        `  estimated=${fmtMs(o.budgetMs)}  actual=${fmtMs(o.actualMs)}  used=${o.budgetUsedPct}%`,
        `  prediction_error=${sign(o.predictionErrorPct)}  confidence=${o.confidence}`,
        `  ffmpeg=${fmtMs(o.utilization.ffmpegBusyMs)} (${o.utilization.ffmpegPct}%)` +
          `  network=${fmtMs(o.utilization.networkWaitMs)}` +
          `  queue=${fmtMs(o.utilization.queueWaitMs)}` +
          `  idle=${fmtMs(o.utilization.idleMs)} (${o.utilization.idlePct}%)` +
          refinement,
        `  tier=${o.tier}  scenes=${o.scenesCount}  history_samples=${getHistoricalAvgs(o.tier).sampleCount}`,
      ].join("\n")
    );
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}
