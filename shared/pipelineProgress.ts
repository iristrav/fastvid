export type PipelineDisplayStageKey =
  | "script"
  | "voiceover"
  | "visuals"
  | "finish";

export const PIPELINE_DISPLAY_STAGES: ReadonlyArray<{
  key: PipelineDisplayStageKey;
  label: string;
}> = [
  { key: "script", label: "Script schrijven" },
  { key: "voiceover", label: "Voiceover genereren" },
  { key: "visuals", label: "Beelden zoeken" },
  { key: "finish", label: "Video afronden" },
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
  if (/upload|samenvoegen|export|muziek|afrond/.test(s)) {
    return stage("finish");
  }
  if (
    /effect|overgang|jaartal|grade|nalopen|eindcontrole|final review|controleren|beeld.?tekst|visual review|assembly|montage|plakken|achter elkaar|compose|samenstellen/.test(
      s
    )
  ) {
    return stage("finish");
  }
  if (
    /visual|beeld|archive|fetching|beat|backfill|scene \d|matching archive|generating ai|tick \d|zoeken/.test(
      s
    )
  ) {
    return stage("visuals");
  }
  if (/voiceover|elevenlabs|voice|parsing|omzetten naar scenes/.test(s)) {
    return stage("voiceover");
  }
  if (/script|research|schrijven|prompt|outline|approv|refine|matching script|sections in parallel|assembling script/.test(s)) {
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
