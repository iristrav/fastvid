/**
 * Editorial planner — async wrapper that uses the Editorial Text Engine
 * per beat, then merges with the rule-based planner for any scenes/beats
 * that the engine skips.
 */

import type { SceneTextPlan, VideoTextPlan, TextOverlayStyle } from "./types";
import { generateEditorialOverlay, editorialToTextOverlay, type EditorialOverlayKind } from "./editorialTextEngine";
import { planSceneTextOverlays, textOverlayStyle } from "./planner";

interface BeatMeta {
  text: string;
  voiceStartSec?: number;
  voiceEndSec?: number;
  holdSec: number;
}

interface SceneMeta {
  index: number;
  text: string;
  visualCue?: string;
  pexelsQuery?: string;
  chapterTitle?: string;
  sectionTitle?: string;
  duration: number;
  beats?: BeatMeta[];
}

export async function planVideoTextOverlaysEditorial(
  scenes: SceneMeta[],
  style: TextOverlayStyle,
  videoTitle = ""
): Promise<VideoTextPlan> {
  const scenePlans: SceneTextPlan[] = await Promise.all(
    scenes.map(scene => planSceneEditorial(scene, style, videoTitle))
  );
  return { scenes: scenePlans, style };
}

async function planSceneEditorial(
  scene: SceneMeta,
  style: TextOverlayStyle,
  videoTitle: string
): Promise<SceneTextPlan> {
  const overlays: import("./types").TextOverlay[] = [];
  const usedKinds: EditorialOverlayKind[] = [];

  const beats = scene.beats ?? [];

  // Process beats in order; pass running list of used kinds for dedup
  for (const beat of beats) {
    if (overlays.length >= 3) break; // max 3 overlays per scene

    const voiceStart = beat.voiceStartSec ?? 0;
    const voiceEnd = beat.voiceEndSec ?? voiceStart + beat.holdSec;

    const editorial = await generateEditorialOverlay({
      beatText: beat.text,
      beatIndex: beats.indexOf(beat),
      sceneIndex: scene.index,
      videoTitle,
      voiceStartSec: voiceStart,
      voiceEndSec: voiceEnd,
      sceneDurationSec: scene.duration,
      previousOverlayKinds: usedKinds,
    });

    if (editorial) {
      overlays.push(editorialToTextOverlay(editorial, style));
      usedKinds.push(editorial.kind);
    }
  }

  // If no beat-level overlays were produced, fall back to rule-based scene-level planner
  if (overlays.length === 0) {
    const fallback = planSceneTextOverlays(scene, style, videoTitle);
    return fallback;
  }

  return { sceneIndex: scene.index, overlays };
}
