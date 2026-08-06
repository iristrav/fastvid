/** AI Director — Pacing Advisor (Phase 5).
 *
 *  Decides whether a scene's pacing should slow down or speed up, whether its energy is
 *  building or settling, its default transition style, and any scene-level text/sound
 *  suggestion — the "documentary editor's instinct" layer above Cinematic Editing Engine's
 *  per-beat mechanics. Reuses TransitionType from cinematicEditingEngine/types.ts (not a
 *  parallel vocabulary) since this is a scene-level DEFAULT that planTransition's per-beat
 *  decisions can start from, same relationship as shotOrderPlanner.ts's ShotType reuse.
 */
import type { Scene } from "../pipeline/types";
import type { TransitionType } from "../cinematicEditingEngine/types";
import type { DirectorContext, DirectorEmotion, EnergyTrend, NarrativeFunction, PacingLabel, VisualStrategy } from "./types";

const YEAR_RE = /\b(1[0-9]{3}|20[0-9]{2})\b/;

function combinedText(intents: DirectorContext["beatIntents"]): string {
  return intents.map((i) => i.spokenText).join(" ");
}

/** The video's typical scene length — shared with attentionManager.ts's retention-risk
 *  scoring so "this scene runs long" is computed the same way in both places. */
export function averageSceneDurationSec(context: DirectorContext): number {
  return context.totalScenes > 0 ? context.totalVideoDurationSec / context.totalScenes : context.sceneDurationSec;
}

/** Duration-relative-to-average is the primary signal (a scene that runs noticeably longer or
 *  shorter than the video's typical scene has an inherent pacing already), with narrative
 *  function and hook-window position as tie-breakers only when duration alone is ambiguous. */
export function decidePacing(context: DirectorContext, narrativeFunction: NarrativeFunction): PacingLabel {
  const avgSceneDuration = averageSceneDurationSec(context);
  const ratio = avgSceneDuration > 0 ? context.sceneDurationSec / avgSceneDuration : 1;

  if (ratio < 0.7) return "fast";
  if (ratio > 1.3) return "slow";

  if (narrativeFunction === "climax") return "fast";
  if (narrativeFunction === "resolve") return "slow";
  if (context.sceneStartSec < 30) return "fast";
  return "medium";
}

export function decideEnergyTrend(context: DirectorContext, narrativeFunction: NarrativeFunction): EnergyTrend {
  if (narrativeFunction === "climax" || narrativeFunction === "reveal") return "increasing";
  if (narrativeFunction === "resolve") return "decreasing";
  if (context.sceneStartSec < 30) return "increasing";
  return "steady";
}

export function decideTransitionStyle(narrativeFunction: NarrativeFunction, visualStrategy: VisualStrategy, pacing: PacingLabel): TransitionType {
  if (narrativeFunction === "transition") return "fade";
  if (narrativeFunction === "resolve") return "cross_dissolve";
  if (visualStrategy === "archive_footage") return "film_burn";
  if (narrativeFunction === "climax" && pacing === "fast") return "whip";
  return "cut";
}

export function suggestTextOverlay(scene: Scene, intents: DirectorContext["beatIntents"]): string | null {
  if (scene.statCallout) return `Show statistic: ${scene.statCallout}.`;

  const spokenYear = combinedText(intents).match(YEAR_RE);
  if (spokenYear) return `Show year ${spokenYear[0]}.`;

  const visualTimeYear = intents.map((i) => i.visualTime.match(YEAR_RE)).find((m): m is RegExpMatchArray => m !== null);
  if (visualTimeYear) return `Show year ${visualTimeYear[0]}.`;

  if (scene.isChapterCard && scene.chapterTitle) return `Show chapter title: "${scene.chapterTitle}".`;

  return null;
}

export function suggestSoundCue(narrativeFunction: NarrativeFunction, visualStrategy: VisualStrategy, emotion: DirectorEmotion): string | null {
  if (visualStrategy === "keynote_or_stage_footage") return "Audience applause.";
  if (emotion === "tension") return "Dramatic tension underscore.";
  if (emotion === "triumph") return "Triumphant musical swell.";
  if (narrativeFunction === "climax") return "Impact/hit sound cue.";
  return null;
}
