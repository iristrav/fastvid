import type {
  TextOverlay,
  TextOverlayStyle,
  TextOverlayType,
  TextAnimation,
  TextPosition,
  SceneTextPlan,
  VideoTextPlan,
} from "./types";

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

// ── Patterns ─────────────────────────────────────────────────────────────────

const YEAR_RE = /\b(1[0-9]{3}|20[0-2][0-9])\b/g;
const OPERATION_RE = /\boperation\s+([A-Z][A-Za-z\s]{2,30})/gi;
const BATTLE_RE = /\b(?:battle|siege|fall|invasion|landing[s]?)\s+of\s+([A-Z][A-Za-z\s]{2,30})/gi;
const LOCATION_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}),?\s+(?:[A-Z][a-z]+(?:\s*,\s*[A-Z][a-z]+)*)/g;
const PERSON_TITLE_RE = /\b(President|Prime Minister|General|Admiral|Chancellor|Emperor|King|Queen|CEO|Colonel|Captain|Major)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi;

// Chapter-start signals
const CHAPTER_SIGNALS = [
  /^chapter\s+\d+/i,
  /^part\s+\d+/i,
  /^section\s+\d+/i,
  /^act\s+\d+/i,
];

function extractYears(text: string): string[] {
  const matches = Array.from(text.matchAll(YEAR_RE));
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const m of matches) { if (!seen.has(m[1])) { seen.add(m[1]); unique.push(m[1]); } }
  return unique.slice(0, 2);
}

function extractOperationName(text: string): string | null {
  const m = OPERATION_RE.exec(text);
  OPERATION_RE.lastIndex = 0;
  if (!m) return null;
  const name = m[1].trim().toUpperCase();
  return name.length > 3 && name.length < 40 ? name : null;
}

function extractBattleName(text: string): string | null {
  const m = BATTLE_RE.exec(text);
  BATTLE_RE.lastIndex = 0;
  if (!m) return null;
  const noun = m[0].split(/\s+/)[0].toUpperCase(); // BATTLE / SIEGE / etc.
  const place = m[1].trim().toUpperCase();
  return `${noun} OF ${place}`;
}

function extractLocation(text: string): string | null {
  // Prefer pexelsQuery/visualCue — they're usually location-accurate
  return null; // handled per caller with visualCue
}

function extractPersons(text: string): Array<{ title: string; name: string }> {
  const results: Array<{ title: string; name: string }> = [];
  let m: RegExpExecArray | null;
  PERSON_TITLE_RE.lastIndex = 0;
  while ((m = PERSON_TITLE_RE.exec(text)) !== null) {
    results.push({ title: m[1], name: m[2] });
    if (results.length >= 2) break;
  }
  return results;
}

function isChapterStart(scene: SceneMeta): boolean {
  if (scene.chapterTitle || scene.sectionTitle) return true;
  return CHAPTER_SIGNALS.some(re => re.test(scene.text));
}

function animationForType(type: TextOverlayType, style: TextOverlayStyle): TextAnimation {
  if (style === "cinematic") {
    if (type === "headline") return "typewriter";
    if (type === "year") return "scale";
    return "fade";
  }
  if (style === "minimal") return "fade";
  // documentary
  if (type === "headline") return "fade";
  return "fade";
}

function positionForType(type: TextOverlayType): TextPosition {
  if (type === "headline" || type === "year" || type === "quote") return "center";
  return "bottom-left";
}

// Avoid overlapping overlays in the same time window
function noOverlap(overlays: TextOverlay[], start: number, end: number): boolean {
  return !overlays.some(o => o.startTime < end && o.endTime > start);
}

// ── Main planner ──────────────────────────────────────────────────────────────

export function planSceneTextOverlays(
  scene: SceneMeta,
  style: TextOverlayStyle,
  videoTitle = ""
): SceneTextPlan {
  const overlays: TextOverlay[] = [];
  const dur = scene.duration;
  const fullText = [videoTitle, scene.text, scene.visualCue ?? "", scene.pexelsQuery ?? ""].join(" ");

  // ── 1. Chapter headline (cinematic + documentary, including first scene) ──
  if (style !== "minimal" && isChapterStart(scene)) {
    const title = (scene.chapterTitle || scene.sectionTitle || "").toUpperCase().trim();
    if (title && title.length > 2) {
      const end = Math.min(4.5, dur * 0.4);
      overlays.push({
        type: "headline",
        text: title,
        startTime: 0.5,
        endTime: end,
        animation: animationForType("headline", style),
        position: "center",
        style,
      });
    }
  }

  // ── 2. Operation / battle headline ──
  if (style !== "minimal") {
    const op = extractOperationName(fullText) ?? extractBattleName(fullText);
    if (op && noOverlap(overlays, 0.3, 5.0)) {
      const years = extractYears(fullText);
      overlays.push({
        type: "headline",
        text: op,
        subtitle: years[0] ?? undefined,
        startTime: 0.5,
        endTime: Math.min(5.0, dur * 0.45),
        animation: style === "cinematic" ? "typewriter" : "fade",
        position: "center",
        style,
      });
    }
  }

  // ── 3. Year overlay — shown in all styles (including documentary where it matters most) ──
  const years = extractYears(fullText);
  if (years.length > 0) {
    const y = years[0];
    const start = overlays.length === 0 ? 0.5 : Math.min(5.5, dur * 0.4);
    const end = Math.min(start + 3.5, dur - 0.5);
    if (end > start + 1 && noOverlap(overlays, start, end)) {
      overlays.push({
        type: "year",
        text: y,
        startTime: start,
        endTime: end,
        animation: style === "cinematic" ? "scale" : "fade",
        position: "center",
        style,
      });
    }
  }

  // ── 4. Location label (bottom-left) ──
  // Search visualCue first (most reliable), then pexelsQuery, then narration text
  const locationSources = [
    scene.visualCue ?? "",
    scene.pexelsQuery ?? "",
    scene.text,
  ];
  let detectedLocation: string | null = null;
  for (const src of locationSources) {
    if (!src || src.length < 3) continue;
    // Require 2+ consecutive capitalized words — reduces false positives from narration
    const m = src.match(/\b([A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})+)\b/);
    if (m && m[1].split(" ").length >= 2 && m[1].length >= 5) {
      detectedLocation = m[1];
      break;
    }
  }
  if (detectedLocation) {
    const locYear = years[0];
    const start = overlays.length === 0 ? 0.8 : Math.max(overlays[overlays.length - 1].endTime + 0.5, 1.0);
    const end = Math.min(start + 4.0, dur - 0.5);
    if (end > start + 1.5 && noOverlap(overlays, start, end)) {
      overlays.push({
        type: "location",
        text: detectedLocation.toUpperCase(),
        subtitle: locYear ?? undefined,
        startTime: start,
        endTime: end,
        animation: "fade",
        position: "bottom-left",
        style,
      });
    }
  }

  // ── 5. Person labels from beats (documentary + cinematic) ──
  if (style !== "minimal" && scene.beats?.length) {
    for (const beat of scene.beats) {
      const persons = extractPersons(beat.text);
      for (const p of persons) {
        const beatStart = beat.voiceStartSec ?? 0;
        const beatEnd = beat.voiceEndSec ?? beatStart + beat.holdSec;
        const labelStart = beatStart + 0.3;
        const labelEnd = Math.min(beatEnd, dur - 0.3);
        if (labelEnd - labelStart > 1.5 && noOverlap(overlays, labelStart, labelEnd)) {
          overlays.push({
            type: "person",
            text: p.name.toUpperCase(),
            subtitle: p.title,
            startTime: labelStart,
            endTime: labelEnd,
            animation: "fade",
            position: "bottom-left",
            style,
          });
          break; // one person per beat
        }
      }
    }
  }

  // Max 3 overlays per scene to avoid clutter
  return { sceneIndex: scene.index, overlays: overlays.slice(0, 3) };
}

export function planVideoTextOverlays(
  scenes: SceneMeta[],
  style: TextOverlayStyle,
  videoTitle = ""
): VideoTextPlan {
  return {
    scenes: scenes.map(s => planSceneTextOverlays(s, style, videoTitle)),
    style,
  };
}

export function textOverlayStyle(): TextOverlayStyle {
  const env = process.env.TEXT_OVERLAY_STYLE;
  if (env === "cinematic" || env === "documentary" || env === "minimal") return env;
  return "documentary";
}

import { burnedInTextAllowed } from "../onScreenTextPolicy";
export function textOverlayEnabled(): boolean {
  // RONDE 113: one rule, asked first — see onScreenTextPolicy.
  if (!burnedInTextAllowed()) return false;
  return process.env.TEXT_OVERLAY === "true";
}
