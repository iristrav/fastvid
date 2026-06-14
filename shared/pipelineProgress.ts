export type PipelineDisplayStageKey =
  | "script"
  | "voiceover"
  | "visuals"
  | "finish";

export const PIPELINE_DISPLAY_STAGES: ReadonlyArray<{
  key: PipelineDisplayStageKey;
  label: string;
}> = [
  { key: "script", label: "Writing script" },
  { key: "voiceover", label: "Generating voiceover" },
  { key: "visuals", label: "Finding visuals" },
  { key: "finish", label: "Finishing video" },
] as const;

function stage(key: PipelineDisplayStageKey): { key: PipelineDisplayStageKey; label: string } {
  const found = PIPELINE_DISPLAY_STAGES.find((s) => s.key === key)!;
  return { key, label: found.label };
}

/** Map granular pipeline progress to a coarse user-facing stage (admin + dashboard). */
export function resolvePipelineDisplayStage(
  rawStage: string,
  percent = 0
): { key: PipelineDisplayStageKey; label: string } {
  const s = rawStage.toLowerCase();

  if (/complete|klaar|video ready|re-render complete/.test(s)) {
    return stage("finish");
  }
  if (/upload|samenvoegen|export|muziek|afrond|concatenat|music mix/.test(s)) {
    return stage("finish");
  }
  if (
    /effect|overgang|jaartal|grade|nalopen|eindcontrole|final review|controleren|beeld.?tekst|visual review|assembly|montage|plakken|achter elkaar|compose|samenstellen|stitch/.test(
      s
    )
  ) {
    return stage("finish");
  }
  if (
    /visual|beeld|archive|fetching|beat|backfill|scene \d|matching archive|generating ai|tick \d|zoeken|finding visuals/.test(
      s
    )
  ) {
    return stage("visuals");
  }
  if (/voiceover|elevenlabs|voice|parsing|omzetten naar scenes/.test(s)) {
    return stage("voiceover");
  }
  if (/script|research|schrijven|prompt|outline|approv|refine|matching script|sections in parallel|assembling script|writing script/.test(s)) {
    return stage("script");
  }

  if (percent < 28) return stage("script");
  if (percent < 42) return stage("voiceover");
  if (percent < 70) return stage("visuals");
  return stage("finish");
}

export function pipelineStageIndex(key: PipelineDisplayStageKey): number {
  return PIPELINE_DISPLAY_STAGES.findIndex((s) => s.key === key);
}

/** Human-readable duration for pipeline UI and logs (e.g. 42s, 3m 05s). */
export function formatGenerationDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min > 0) return `${min}m ${String(rem).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Append live elapsed time to a progress label shown in the dashboard badge. */
export function progressStepWithElapsed(label: string, startedAtMs: number): string {
  const elapsedSec = Math.floor((Date.now() - startedAtMs) / 1000);
  return `${label} · ${formatGenerationDuration(elapsedSec)}`;
}

/** Rough max generation window for UI estimates (seconds). */
export function maxGenerationEstimateSec(videoLength?: string | null): number {
  if (videoLength === "1") return 12 * 60;
  if (videoLength === "8-10") return 75 * 60;
  if (videoLength === "10-15" || videoLength === "15-20") return 90 * 60;
  return 90 * 60;
}

/** Estimate seconds remaining from elapsed time and progress percent. */
export function estimateRemainingGenerationSec(
  progressPercent: number,
  elapsedSec: number,
  maxTotalSec?: number
): number | null {
  if (progressPercent >= 99) return 0;
  if (progressPercent < 3 || elapsedSec < 8) return null;

  const fromPercent = Math.round((elapsedSec * (100 - progressPercent)) / progressPercent);
  if (maxTotalSec != null) {
    return Math.max(0, Math.min(fromPercent, maxTotalSec - elapsedSec));
  }
  return Math.max(0, fromPercent);
}

export function formatRemainingGenerationLabel(remainingSec: number | null): string {
  if (remainingSec === null) return "Estimating time left…";
  if (remainingSec <= 0) return "Almost done…";
  return `~${formatGenerationDuration(remainingSec)} left`;
}
