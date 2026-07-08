import type { SceneMotionPlan, ImageAnimation, CounterAnimation, MapOverlay, VideoMotionPlan } from "./types";
import { WORLD_LOCATIONS } from "./locationMap";

interface BeatMeta {
  text: string;
  voiceStartSec?: number;
  voiceEndSec?: number;
  holdSec: number;
  isStill?: boolean;
}

interface SceneMeta {
  index: number;
  text: string;
  visualCue?: string;
  pexelsQuery?: string;
  duration: number;
  beats?: BeatMeta[];
}

// ── Number extraction ─────────────────────────────────────────────────────────

const NUMBER_RE = /\b([\d][0-9,.]*)\s*(million|billion|miljoen|miljard|k|M|B|%|percent|procent)?\b/gi;

function extractCounters(text: string, sceneStartSec: number): CounterAnimation[] {
  const results: CounterAnimation[] = [];
  NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_RE.exec(text)) !== null) {
    const raw = m[1].replace(/,/g, ".");
    const num = parseFloat(raw);
    if (isNaN(num) || num < 10 || num > 1_000_000_000) continue;
    const suffix = m[2]
      ? (m[2] === "percent" || m[2] === "procent" ? "%" : m[2])
      : "";
    results.push({
      label: `${m[1]}${suffix ? " " + suffix : ""}`,
      fromValue: 0,
      toValue: num,
      suffix,
      startSec: sceneStartSec,
      durationSec: Math.min(2.5, sceneStartSec + 1.5),
    });
    if (results.length >= 1) break; // max 1 counter per scene
  }
  return results;
}

// ── Location detection ────────────────────────────────────────────────────────

function extractMapOverlay(text: string): MapOverlay | null {
  const hay = text.toLowerCase();
  for (const loc of WORLD_LOCATIONS) {
    if (loc.keywords.some(kw => hay.includes(kw.toLowerCase()))) {
      return {
        locationName: loc.name,
        normX: loc.normX,
        normY: loc.normY,
        markerStyle: "pulse",
        startSec: 0.5,
        durationSec: 4.0,
      };
    }
  }
  return null;
}

// ── Image animation picker ────────────────────────────────────────────────────

function pickImageAnimation(scene: SceneMeta, sceneIndex: number): ImageAnimation {
  const text = [scene.text, scene.visualCue ?? ""].join(" ").toLowerCase();

  // Battle / action → energetic zoom
  if (/\b(battle|attack|explosion|war|combat|charge|assault)\b/.test(text)) return "pop_in";
  // Establishing / landscape → slow pan
  if (/\b(landscape|panorama|coast|city|skyline|aerial|from above)\b/.test(text)) return "pan_left";
  // Historical figures → zoom in on face
  if (/\b(portrait|face|general|president|king|queen|chancellor)\b/.test(text)) return "ken_burns_in";
  // Default rotation based on scene index
  const variants: ImageAnimation[] = ["ken_burns_in", "ken_burns_out", "pan_left", "pan_right", "slow_zoom"];
  return variants[sceneIndex % variants.length];
}

// ── Main planner ──────────────────────────────────────────────────────────────

export function planSceneMotion(scene: SceneMeta): SceneMotionPlan {
  const fullText = [scene.text, scene.visualCue ?? "", scene.pexelsQuery ?? ""].join(" ");
  const counters = extractCounters(fullText, 0.8);
  const map = extractMapOverlay(fullText);

  return {
    sceneIndex: scene.index,
    imageAnimation: pickImageAnimation(scene, scene.index),
    useImageCard: true, // always use blurred card treatment for stills
    counters,
    maps: map ? [map] : [],
  };
}

export function planVideoMotion(scenes: SceneMeta[]): VideoMotionPlan {
  return { scenes: scenes.map(planSceneMotion) };
}

export function cinematicMotionEnabled(): boolean {
  return process.env.CINEMATIC_MOTION !== "false";
}
