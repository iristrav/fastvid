/**
 * Per-step wall-clock timing for video pipeline diagnostics.
 * Logs human-readable summaries to identify compose/visual bottlenecks.
 */

import { composeLocalClipsOnly } from "./sourcingPolicy";

export type PipelineTimingCategory =
  | "scene_generation"
  | "voiceover"
  | "image_search"
  | "image_download"
  | "image_processing"
  | "scene_composition"
  | "video_rendering"
  | "compose_rescue"
  | "llm_call";

export type PipelineTimingRow = {
  category: PipelineTimingCategory;
  label: string;
  sceneIndex?: number;
  ms: number;
};

const CATEGORY_LABELS: Record<PipelineTimingCategory, string> = {
  scene_generation: "Scene / script generation",
  voiceover: "Voiceover",
  image_search: "Image / clip search",
  image_download: "Image / clip download",
  image_processing: "Image / clip processing (CLIP, trim)",
  scene_composition: "Scene composition (FFmpeg montage)",
  video_rendering: "Final concat + music + upload",
  compose_rescue: "Compose-time rescue fetch",
  llm_call: "LLM call",
};

function formatSec(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export class PipelineStepTiming {
  private rows: PipelineTimingRow[] = [];
  private stageStarted = new Map<string, number>();

  record(
    category: PipelineTimingCategory,
    label: string,
    ms: number,
    sceneIndex?: number
  ): void {
    if (ms < 0) return;
    this.rows.push({ category, label, sceneIndex, ms });
    const prefix = sceneIndex != null ? `Scene ${sceneIndex} ` : "";
    console.log(`[PipelineTiming] ${prefix}${label}: ${formatSec(ms)}`);
  }

  async time<T>(
    category: PipelineTimingCategory,
    label: string,
    fn: () => Promise<T>,
    sceneIndex?: number
  ): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.record(category, label, Date.now() - t0, sceneIndex);
    }
  }

  startStage(stageKey: string): void {
    this.stageStarted.set(stageKey, Date.now());
  }

  endStage(stageKey: string, category: PipelineTimingCategory, label: string): void {
    const t0 = this.stageStarted.get(stageKey);
    if (t0 == null) return;
    this.stageStarted.delete(stageKey);
    this.record(category, label, Date.now() - t0);
  }

  /** Aggregate by category for one scene. */
  summarizeScene(sceneIndex: number): void {
    const sceneRows = this.rows.filter((r) => r.sceneIndex === sceneIndex);
    if (!sceneRows.length) return;

    const byLabel = new Map<string, number>();
    const byCategory = new Map<PipelineTimingCategory, number>();
    for (const row of sceneRows) {
      byLabel.set(row.label, (byLabel.get(row.label) ?? 0) + row.ms);
      byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + row.ms);
    }

    console.log(`[PipelineTiming] ── Scene ${sceneIndex} ──`);
    const sortedLabels = [...byLabel.entries()].sort((a, b) => b[1] - a[1]);
    for (const [label, ms] of sortedLabels) {
      console.log(`[PipelineTiming]   ${label}: ${formatSec(ms)}`);
    }
    const total = sortedLabels.reduce((sum, [, ms]) => sum + ms, 0);
    console.log(`[PipelineTiming]   Total: ${formatSec(total)}`);

    const topCat = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCat) {
      console.log(
        `[PipelineTiming]   Slowest category: ${CATEGORY_LABELS[topCat[0]]} (${formatSec(topCat[1])})`
      );
    }
  }

  /** Full pipeline summary grouped by category. */
  summarizeAll(): void {
    const byCategory = new Map<PipelineTimingCategory, number>();
    for (const row of this.rows) {
      byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + row.ms);
    }
    console.log("[PipelineTiming] ══ Pipeline timing summary ══");
    const sorted = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
    let total = 0;
    for (const [cat, ms] of sorted) {
      total += ms;
      console.log(`[PipelineTiming]   ${CATEGORY_LABELS[cat]}: ${formatSec(ms)}`);
    }
    console.log(`[PipelineTiming]   Total (instrumented): ${formatSec(total)}`);
    if (sorted[0]) {
      console.log(
        `[PipelineTiming]   Bottleneck: ${CATEGORY_LABELS[sorted[0][0]]} (${formatSec(sorted[0][1])})`
      );
    }
  }

  toReport(): {
    rows: PipelineTimingRow[];
    totalsByCategory: Record<string, number>;
    totalsByScene: Record<string, number>;
  } {
    const totalsByCategory: Record<string, number> = {};
    const totalsByScene: Record<string, number> = {};
    for (const row of this.rows) {
      totalsByCategory[row.category] = (totalsByCategory[row.category] ?? 0) + row.ms;
      if (row.sceneIndex != null) {
        const key = String(row.sceneIndex);
        totalsByScene[key] = (totalsByScene[key] ?? 0) + row.ms;
      }
    }
    return { rows: [...this.rows], totalsByCategory, totalsByScene };
  }
}

export function recordPipelineTiming(
  timing: PipelineStepTiming | undefined,
  category: PipelineTimingCategory,
  label: string,
  ms: number,
  sceneIndex?: number
): void {
  timing?.record(category, label, ms, sceneIndex);
}

export async function timePipelineStep<T>(
  timing: PipelineStepTiming | undefined,
  category: PipelineTimingCategory,
  label: string,
  fn: () => Promise<T>,
  sceneIndex?: number
): Promise<T> {
  if (!timing) return fn();
  return timing.time(category, label, fn, sceneIndex);
}

/** True when compose render must not trigger Wikimedia/Pexels/archive network fetches. */
export function isComposeNetworkBlocked(
  dedup?: {
    composeNetworkBlocked?: boolean;
    videoLength?: string;
    composeFetchExemptScenes?: Set<number>;
  },
  /**
   * RONDE 159 — which scene is asking.
   *
   * The block is right in general and wrong for a scene that has almost no footage. Video 552's
   * scene 2 went into compose with 2 of the 7 clips it needed, was refused thirteen times here,
   * and ended as 21.5 seconds of narration over two clips — the shortfall RONDE 157/158 then had
   * to fill with slowed and replayed picture. The footage existed; the render would not go and
   * get it, while holding eleven unused minutes of budget.
   *
   * A caller that does not name a scene gets the plain answer, because the exemption is a
   * statement about one starved scene and must not leak into decisions made for the render.
   */
  sceneIndex?: number
): boolean {
  if (!Boolean(dedup?.composeNetworkBlocked) || !composeLocalClipsOnly(dedup?.videoLength)) {
    return false;
  }
  if (sceneIndex != null && dedup?.composeFetchExemptScenes?.has(sceneIndex)) return false;
  return true;
}

/** Loud marker when network sourcing runs during compose (should be rare). */
export function warnComposeTimeNetwork(
  timing: PipelineStepTiming | undefined,
  source: string,
  sceneIndex: number
): void {
  console.warn(
    `[PipelineTiming] ⚠ COMPOSE-TIME NETWORK: ${source} on scene ${sceneIndex} — clips should be cached before render`
  );
  recordPipelineTiming(timing, "compose_rescue", `${source} (compose-time)`, 0, sceneIndex);
}
