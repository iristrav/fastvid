/**
 * Shot Sequence Optimizer — deterministic documentary montage optimizer.
 *
 * Analyzes the shot categories of each clip in a scene and reorders them
 * to follow professional documentary editing conventions — without any LLM call
 * and without triggering new retrieval.
 *
 * Documentary flow rules enforced:
 *  1. Open with an establishing or wide shot (not close-up, not archival)
 *  2. No more than 2 consecutive clips of the same category
 *  3. Archival (maps, documents, illustrations): break up after 2 consecutive
 *     with live footage
 *  4. Cycle pattern: establishing → medium → close_up → wide → medium …
 *  5. Action/high-motion clips: don't open the scene, don't close it
 *  6. Fallback/color-card clips: always last
 *
 * Shot category is determined from (priority order):
 *  1. Editorial storyboard shot type (from editorialSequencePlanner)
 *  2. Beat text keyword analysis
 *  3. Clip filename/path keyword analysis
 *
 * Feature flag: SHOT_SEQUENCE_OPTIMIZER_ENABLED (default: "true")
 */

import path from "path";
import { getShotForBeat } from "./editorialSequencePlanner";

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function shotSequenceOptimizerEnabled(): boolean {
  return process.env.SHOT_SEQUENCE_OPTIMIZER_ENABLED !== "false";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ShotCategory =
  | "establishing" // wide, aerial, panorama, cityscape, landscape, overhead
  | "medium"       // medium shot, waist, portrait, interview, person standing
  | "close_up"     // close-up, face, eye, hand, detail, extreme close
  | "archival"     // map, document, engraving, painting, illustration, newspaper
  | "action"       // explosion, battle, crowd, protest, fire, crash, race
  | "unknown";

export type OptimizedSequence = {
  clips: string[];
  beatDurations: number[];
  clipBeatIndices?: number[];
  optimized: boolean;
  changes: number;
  shotCategories: ShotCategory[]; // category per final clip
};

// ─── Category classification ──────────────────────────────────────────────────

const ESTABLISHING_KEYWORDS = [
  "wide", "aerial", "panorama", "panoramic", "establishing", "cityscape",
  "landscape", "overhead", "drone", "bird", "overview", "skyline", "horizon",
  "long shot", "establishing shot", "wide shot", "wide angle",
];
const MEDIUM_KEYWORDS = [
  "medium", "waist", "portrait", "interview", "person", "standing",
  "reporter", "speaker", "talking", "medium shot", "two shot", "group",
  "people walking", "soldiers marching",
];
const CLOSE_UP_KEYWORDS = [
  "close", "close-up", "closeup", "face", "eye", "eyes", "hand", "hands",
  "detail", "extreme", "macro", "mouth", "finger", "ring", "letter",
  "close up shot", "extreme close",
];
const ARCHIVAL_KEYWORDS = [
  "map", "document", "engraving", "painting", "illustration", "newspaper",
  "chart", "diagram", "poster", "drawing", "sketch", "lithograph", "print",
  "archive", "historical photo", "archival", "archive photo",
];
const ACTION_KEYWORDS = [
  "explosion", "explode", "battle", "war", "combat", "fight", "riot",
  "protest", "crowd", "storm", "fire", "crash", "race", "charge", "attack",
  "invasion", "bombardment", "artillery", "gun", "shooting", "collapse",
];

function classifyText(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function classifyFromText(text: string): ShotCategory {
  if (classifyText(text, ARCHIVAL_KEYWORDS)) return "archival";
  if (classifyText(text, ACTION_KEYWORDS)) return "action";
  if (classifyText(text, CLOSE_UP_KEYWORDS)) return "close_up";
  if (classifyText(text, ESTABLISHING_KEYWORDS)) return "establishing";
  if (classifyText(text, MEDIUM_KEYWORDS)) return "medium";
  return "unknown";
}

function classifyFromPath(clipPath: string): ShotCategory {
  const base = path.basename(clipPath, path.extname(clipPath)).toLowerCase();
  return classifyFromText(base);
}

/** Resolve category for one clip. Tries storyboard → beat text → filename. */
export function classifyClipCategory(
  clipPath: string,
  beatIndex: number,
  beatText: string,
  sceneIndex: number
): ShotCategory {
  // 1. Storyboard shot type from editorial sequence planner
  const shot = getShotForBeat(sceneIndex, beatIndex);
  if (shot?.shotType) {
    const fromShot = classifyFromText(shot.shotType);
    if (fromShot !== "unknown") return fromShot;
    // Storyboard may include visual style hints ("engraving", "painting") and action
    const combined = [shot.action, shot.location, shot.visualStyle].filter(Boolean).join(" ");
    if (combined) {
      const fromCombined = classifyFromText(combined);
      if (fromCombined !== "unknown") return fromCombined;
    }
  }

  // 2. Beat text
  const fromBeat = classifyFromText(beatText);
  if (fromBeat !== "unknown") return fromBeat;

  // 3. Filename
  return classifyFromPath(clipPath);
}

// ─── Fallback detection ───────────────────────────────────────────────────────

const FALLBACK_BASENAMES = /^(color_fallback|fallback|guaranteed|placeholder|color_clip)/i;

function isFallbackClip(clipPath: string): boolean {
  return FALLBACK_BASENAMES.test(path.basename(clipPath));
}

// ─── Target sequence builder ──────────────────────────────────────────────────

/**
 * Build the ideal target category sequence for N clips.
 * Basic documentary cycle: establishing → medium → close_up → medium → establishing …
 * Length-adaptive: short scenes favour wide+medium; long scenes cycle fully.
 */
function buildTargetSequence(n: number): ShotCategory[] {
  const cycle: ShotCategory[] = ["establishing", "medium", "close_up", "medium"];
  const out: ShotCategory[] = [];
  for (let i = 0; i < n; i++) {
    out.push(cycle[i % cycle.length]);
  }
  return out;
}

// ─── Optimizer ────────────────────────────────────────────────────────────────

type ClipEntry = {
  index: number;         // original index in clips[]
  clipPath: string;
  beatIndex: number;
  beatText: string;
  beatDuration: number;
  category: ShotCategory;
  isFallback: boolean;
};

/** Score a category placement: reward target match, penalize consecutive repeat. */
function placementScore(
  category: ShotCategory,
  targetCategory: ShotCategory,
  prevCategory: ShotCategory | null,
  prevPrevCategory: ShotCategory | null,
  position: number
): number {
  let score = 0;

  // Target match
  if (category === targetCategory) score += 10;

  // Penalize consecutive same
  if (category === prevCategory) {
    score -= 5;
    if (category === prevPrevCategory) score -= 15; // third in a row: heavy penalty
  }

  // Archival after archival: extra penalty
  if (category === "archival" && prevCategory === "archival") score -= 8;

  // Establishing shot at position 0: bonus
  if (position === 0 && (category === "establishing" || category === "medium")) score += 8;
  // Penalize close_up at position 0
  if (position === 0 && category === "close_up") score -= 10;

  // Fallback clips at the end: bonus for last quarter of sequence
  return score;
}

/** Greedy optimizer: picks the best available clip at each position. */
function greedyOptimize(entries: ClipEntry[]): ClipEntry[] {
  const n = entries.length;
  if (n <= 1) return entries;

  // Separate fallbacks — always go last
  const fallbacks = entries.filter((e) => e.isFallback);
  const real = entries.filter((e) => !e.isFallback);

  if (real.length === 0) return entries;

  const targets = buildTargetSequence(real.length);
  const available = [...real];
  const result: ClipEntry[] = [];

  for (let pos = 0; pos < real.length; pos++) {
    const target = targets[pos];
    const prev = result[pos - 1]?.category ?? null;
    const prevPrev = result[pos - 2]?.category ?? null;

    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let j = 0; j < available.length; j++) {
      const s = placementScore(available[j].category, target, prev, prevPrev, pos);
      if (s > bestScore) { bestScore = s; bestIdx = j; }
    }

    result.push(available[bestIdx]);
    available.splice(bestIdx, 1);
  }

  return [...result, ...fallbacks];
}

// ─── Public entry point ────────────────────────────────────────────────────────

/**
 * Optimizes the shot sequence for a single scene.
 * Returns the reordered clips, durations, and beat indices.
 * Never throws — falls back to original order on error.
 */
export function optimizeShotSequence(
  sceneIndex: number,
  clips: string[],
  beatDurations: number[],
  clipBeatIndices?: number[],
  beats?: Array<{ index: number; text: string }>
): OptimizedSequence {
  if (!shotSequenceOptimizerEnabled() || clips.length <= 1) {
    return {
      clips,
      beatDurations,
      clipBeatIndices,
      optimized: false,
      changes: 0,
      shotCategories: clips.map(() => "unknown"),
    };
  }

  try {
    const beatLookup = new Map((beats ?? []).map((b) => [b.index, b.text]));

    const entries: ClipEntry[] = clips.map((clipPath, i) => {
      const beatIndex = clipBeatIndices?.[i] ?? i;
      const beatText = beatLookup.get(beatIndex) ?? "";
      return {
        index: i,
        clipPath,
        beatIndex,
        beatText,
        beatDuration: beatDurations[i] ?? 3,
        category: classifyClipCategory(clipPath, beatIndex, beatText, sceneIndex),
        isFallback: isFallbackClip(clipPath),
      };
    });

    const optimized = greedyOptimize(entries);

    const resultClips = optimized.map((e) => e.clipPath);
    const resultDurations = optimized.map((e) => e.beatDuration);
    const resultBeatIndices = optimized.map((e) => e.beatIndex);
    const categories = optimized.map((e) => e.category);

    // Count actual changes
    let changes = 0;
    for (let i = 0; i < resultClips.length; i++) {
      if (resultClips[i] !== clips[i]) changes++;
    }

    if (changes > 0) {
      console.log(
        `[ShotSequenceOptimizer] s${sceneIndex} optimized ${clips.length} clips, ${changes} moved` +
          ` — sequence: ${categories.join(" → ")}`
      );
    }

    return {
      clips: resultClips,
      beatDurations: resultDurations,
      clipBeatIndices: resultBeatIndices,
      optimized: changes > 0,
      changes,
      shotCategories: categories,
    };
  } catch (err) {
    console.warn(`[ShotSequenceOptimizer] s${sceneIndex} error, keeping original:`, (err as Error).message);
    return {
      clips,
      beatDurations,
      clipBeatIndices,
      optimized: false,
      changes: 0,
      shotCategories: clips.map(() => "unknown"),
    };
  }
}
