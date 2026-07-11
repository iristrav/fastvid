/**
 * Editorial planner — async wrapper that uses the Editorial Text Engine
 * per beat, then merges with the rule-based planner for any scenes/beats
 * that the engine skips.
 *
 * Performance guardrails:
 * - Global 30s budget for the entire overlay pass (env: EDITORIAL_TEXT_BUDGET_MS)
 * - Per-beat LLM call wrapped with 6s timeout in editorialTextEngine
 * - All scenes processed in parallel; beats within a scene sequential (dedup ordering)
 * - Falls back to rule-based planner instantly if budget is exceeded
 */

import type { SceneTextPlan, VideoTextPlan, TextOverlayStyle } from "./types";
import { generateEditorialOverlay, editorialToTextOverlay, type EditorialOverlayKind } from "./editorialTextEngine";
import { planSceneTextOverlays } from "./planner";

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

const DEFAULT_BUDGET_MS = 30_000; // 30s total for the overlay LLM pass

function editorialBudgetMs(): number {
  const raw = process.env.EDITORIAL_TEXT_BUDGET_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5_000 && n <= 120_000) return n;
  }
  return DEFAULT_BUDGET_MS;
}

export async function planVideoTextOverlaysEditorial(
  scenes: SceneMeta[],
  style: TextOverlayStyle,
  videoTitle = ""
): Promise<VideoTextPlan> {
  const deadline = Date.now() + editorialBudgetMs();

  const scenePlans: SceneTextPlan[] = await Promise.all(
    scenes.map(scene => planSceneEditorial(scene, style, videoTitle, deadline))
  );
  return { scenes: scenePlans, style };
}

async function planSceneEditorial(
  scene: SceneMeta,
  style: TextOverlayStyle,
  videoTitle: string,
  deadline: number
): Promise<SceneTextPlan> {
  // Budget expired — fall back immediately, no LLM calls
  if (Date.now() >= deadline) {
    return planSceneTextOverlays(scene, style, videoTitle);
  }

  const overlays: import("./types").TextOverlay[] = [];
  const usedKinds: EditorialOverlayKind[] = [];
  const beats = scene.beats ?? [];

  for (let i = 0; i < beats.length; i++) {
    if (overlays.length >= 3) break;
    if (Date.now() >= deadline) break; // budget gone mid-scene

    const beat = beats[i];
    const voiceStart = beat.voiceStartSec ?? 0;
    const voiceEnd = beat.voiceEndSec ?? voiceStart + beat.holdSec;

    try {
      const editorial = await generateEditorialOverlay({
        beatText: beat.text,
        beatIndex: i,
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
    } catch {
      // Individual beat failure is non-fatal — continue with next beat
    }
  }

  if (overlays.length === 0) {
    return planSceneTextOverlays(scene, style, videoTitle);
  }

  return { sceneIndex: scene.index, overlays };
}
