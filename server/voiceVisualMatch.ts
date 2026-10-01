/**
 * Voice↔visual match QA — CLIP scores, fallbacks, compose-time guaranteed clips.
 */
import * as path from "path";
import type { ClipAdoptEntry } from "./clipAdoptAudit";
import { minClipQualityScore } from "./visualQualityGate";
import { coverageOfAdoptEntry } from "./beatVisualStatus";

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

export function isGuaranteedPipelineClip(filePath: string): boolean {
  return /guaranteed|_slot\d+_guaranteed/i.test(path.basename(filePath));
}

export function countGuaranteedClipsInPaths(clipPaths: string[]): number {
  return clipPaths.filter((p) => isGuaranteedPipelineClip(p)).length;
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
  /**
   * RONDE 105 — "beat without its own picture" is now defined in ONE place.
   *
   * This used to count only rescue routes whose name was on DEGRADED_RESCUE_SOURCES, while the
   * quality score counted only the routes "fallback" and "rescue_placeholder", and the two
   * disagreed: a render reported "13 beat(s) zonder eigen beeld" next to a score of 100/100 that
   * had seen none of them. Both now read `coverageOfAdoptEntry` from ./beatVisualStatus, so the
   * warning and the number are answering the same question.
   */
  const degradedBeats = (adoptAudit ?? []).filter(
    (e) => coverageOfAdoptEntry(e) !== "own_footage"
  ).length;
  // Clamped: `degradedBeats` now counts every beat without its own footage, which includes
  // non-rescue routes, so the subtraction could otherwise go negative and report a nonsense count.
  const rescueSourcedBeats = Math.max(
    0,
    rescueEntries.filter((e) => coverageOfAdoptEntry(e) === "own_footage").length
  );
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
