import { generationBudgetMinutes, targetVideoDurationMinutes } from "./videoLengths";

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
  if (
    /assembl|samenvoeg|concatenat|upload|export|muziek|afrond|effect|overgang|jaartal|grade|nalopen|eindcontrole|final review|controleren|beeld.?tekst|visual review|montage|plakken|achter elkaar|compose|samenstellen|stitch/.test(
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

/**
 * The 8 canonical stage labels for Phase 1's real-time (SSE) progress feed — a finer-grained
 * sibling of resolvePipelineDisplayStage's 4-stage mapping above, added alongside it (not a
 * replacement) so the existing Dashboard/Admin polling UI is unaffected. Added for
 * GET /api/events/video/:id (server/_core/index.ts) and the useVideoProgressStream frontend
 * hook.
 */
export const CANONICAL_PROGRESS_STAGES = [
  "Queued",
  "Preparing",
  "Generating Script",
  "Generating Voice",
  "Searching Media",
  "Rendering",
  "Uploading",
  "Completed",
] as const;

export type CanonicalProgressStage = (typeof CANONICAL_PROGRESS_STAGES)[number];

/** Map a video's DB status + raw progressStep string onto one of the 8 canonical stages. */
export function resolveCanonicalProgressStage(
  status: string,
  rawStage: string | null | undefined
): CanonicalProgressStage {
  if (status === "queued") return "Queued";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Completed"; // terminal either way — stream closes on both

  const s = (rawStage ?? "").toLowerCase();

  if (/complete|klaar|video ready|re-render complete/.test(s)) return "Completed";
  if (/upload|export/.test(s)) return "Uploading";
  if (
    /assembl|samenvoeg|concatenat|muziek|afrond|effect|overgang|jaartal|grade|nalopen|eindcontrole|final review|controleren|beeld.?tekst|visual review|montage|plakken|achter elkaar|compose|samenstellen|stitch/.test(
      s
    )
  ) {
    return "Rendering";
  }
  if (
    /visual|beeld|archive|fetching|beat|backfill|scene \d|matching archive|generating ai|tick \d|zoeken|finding visuals/.test(
      s
    )
  ) {
    return "Searching Media";
  }
  if (/voiceover|elevenlabs|voice/.test(s)) return "Generating Voice";
  if (/converting script to scenes|omzetten naar scenes|parsing/.test(s)) return "Preparing";
  if (status === "generating_script" || /script|research|schrijven|prompt|outline|approv|refine|matching script|sections in parallel|assembling script|writing script/.test(s)) {
    return "Generating Script";
  }

  // Fallback by DB status when the free-text label doesn't match anything above.
  if (status === "generating_voiceover") return "Generating Voice";
  if (status === "generating_visuals") return "Searching Media";
  if (status === "generating_effects" || status === "awaiting_approval") return "Rendering";
  return "Preparing";
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

/** Rough max generation window for UI estimates — 10 min hard cap for 1-min videos. */
export function maxGenerationEstimateSec(videoLength?: string | null): number {
  const mins = targetVideoDurationMinutes(videoLength);
  if (mins <= 1) return 10 * 60;
  const ratio = 10;
  return generationBudgetMinutes(videoLength, ratio) * 60;
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
