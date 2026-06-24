/**
 * Voice↔visual match QA — CLIP scores, fallbacks, compose-time guaranteed clips.
 */
import * as path from "path";
import type { ClipAdoptEntry } from "./clipAdoptAudit";
import { minClipQualityScore } from "./visualQualityGate";
import { strictVoiceVisualMatchEnabled } from "./sourcingPolicy";

export type VoiceVisualMatchSummary = {
  ok: boolean;
  fallbackBeats: number;
  rescueBeats: number;
  guaranteedClips: number;
  lowVisionBeats: number;
  sceneCriticalFailed: number[];
  warnings: string[];
};

export function isGuaranteedPipelineClip(filePath: string): boolean {
  return /guaranteed|_slot\d+_guaranteed/i.test(path.basename(filePath));
}

export function countGuaranteedClipsInPaths(clipPaths: string[]): number {
  return clipPaths.filter((p) => isGuaranteedPipelineClip(p)).length;
}

/** Min CLIP score for post-compose audits when strict voice↔visual match is on. */
export function voiceVisualAuditMinScore(): number {
  if (strictVoiceVisualMatchEnabled()) return minClipQualityScore();
  return Math.max(6, minClipQualityScore() - 1);
}

export function buildVoiceVisualMatchSummary(
  adoptAudit: ClipAdoptEntry[] | undefined,
  composedClipPaths: string[],
  sceneCriticalFailed: number[] = []
): VoiceVisualMatchSummary {
  const min = minClipQualityScore();
  const fallbackBeats = adoptAudit?.filter((e) => e.source === "fallback").length ?? 0;
  const rescueBeats =
    adoptAudit?.filter((e) => e.source.startsWith("rescue_")).length ?? 0;
  const guaranteedClips = countGuaranteedClipsInPaths(composedClipPaths);
  const lowVisionBeats = (adoptAudit ?? []).filter(
    (e) =>
      e.source !== "fallback" &&
      !isGuaranteedPipelineClip(e.basename) &&
      typeof e.visionScore10 === "number" &&
      e.visionScore10 < min
  ).length;
  const warnings: string[] = [];
  if (fallbackBeats > 0) {
    warnings.push(`${fallbackBeats} beat(s) zonder matchend beeld (kleur-fallback)`);
  }
  if (rescueBeats > 0) {
    warnings.push(`${rescueBeats} beat(s) via rescue-tier (degraded CLIP match of placeholder)`);
  }
  if (guaranteedClips > 0) {
    warnings.push(`${guaranteedClips} guaranteed clip(s) in montage — geen voice-match`);
  }
  if (lowVisionBeats > 0) {
    warnings.push(`${lowVisionBeats} beat(s) met CLIP-score onder ${min}/10`);
  }
  if (sceneCriticalFailed.length > 0) {
    warnings.push(
      `${sceneCriticalFailed.length} scene(s) faalden kritische visuele review (${sceneCriticalFailed.join(", ")})`
    );
  }
  const ok =
    fallbackBeats === 0 &&
    guaranteedClips === 0 &&
    rescueBeats === 0 &&
    lowVisionBeats === 0 &&
    sceneCriticalFailed.length === 0;
  return {
    ok,
    fallbackBeats,
    rescueBeats,
    guaranteedClips,
    lowVisionBeats,
    sceneCriticalFailed,
    warnings,
  };
}
