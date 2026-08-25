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
  /** Every beat adopted through a rescue route, degraded or not. Kept for continuity. */
  rescueBeats: number;
  /**
   * RONDE 64: of those, the ones that are genuinely a step down in quality — a placeholder, a
   * held previous clip, a motion graphic, generated footage. See DEGRADED_RESCUE_SOURCES.
   */
  degradedBeats: number;
  /** The rest: real footage that merely arrived via a rescue route. Informational only. */
  rescueSourcedBeats: number;
  guaranteedClips: number;
  lowVisionBeats: number;
  sceneCriticalFailed: number[];
  warnings: string[];
};

/**
 * RONDE 64: which rescue routes actually mean the montage settled for less.
 *
 * Render 532 reported "21 beat(s) via rescue-tier (degraded CLIP match of placeholder)", which
 * reads like 21 broken beats and is not what happened. `source.startsWith("rescue_")` counts
 * every rescue route alike, and most of them are not degradations at all: rescue_archive,
 * rescue_wikimedia, rescue_similar and rescue_stock are real footage of the right subject that
 * happened to be found on the second pass. For an archive documentary that IS the normal route,
 * so the number could never be zero — which also left `ok` permanently false and the warning
 * permanently on, saying nothing.
 *
 * These four are the ones that mean something is missing from the montage.
 */
const DEGRADED_RESCUE_SOURCES = new Set([
  "rescue_placeholder", // no footage at all
  "rescue_extend",      // the previous clip held longer because there was no new one
  "rescue_graphic",     // a motion graphic standing in for footage
  "rescue_ai",          // generated, not real footage
]);

export function isDegradedRescueSource(source: string): boolean {
  return DEGRADED_RESCUE_SOURCES.has(source);
}

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
  const rescueEntries = adoptAudit?.filter((e) => e.source.startsWith("rescue_")) ?? [];
  const rescueBeats = rescueEntries.length;
  const degradedBeats = rescueEntries.filter((e) => isDegradedRescueSource(e.source)).length;
  const rescueSourcedBeats = rescueBeats - degradedBeats;
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
  if (degradedBeats > 0) {
    warnings.push(
      `${degradedBeats} beat(s) zonder eigen beeld (placeholder, vastgehouden clip of graphic)`
    );
  }
  if (rescueSourcedBeats > 0) {
    // Not a warning about quality — a note about which pass found the footage. Kept separate so
    // the line above stays a signal instead of firing on every archive render.
    warnings.push(`${rescueSourcedBeats} beat(s) gevonden via een rescue-route (echt beeld)`);
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
  // `ok` used to require rescueBeats === 0, which for an archive documentary is unreachable —
  // it was false on every render and therefore said nothing. It now turns on the rescues that
  // actually cost the montage something.
  const ok =
    fallbackBeats === 0 &&
    guaranteedClips === 0 &&
    degradedBeats === 0 &&
    lowVisionBeats === 0 &&
    sceneCriticalFailed.length === 0;
  return {
    ok,
    fallbackBeats,
    rescueBeats,
    degradedBeats,
    rescueSourcedBeats,
    guaranteedClips,
    lowVisionBeats,
    sceneCriticalFailed,
    warnings,
  };
}
