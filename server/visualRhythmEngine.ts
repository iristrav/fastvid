/**
 * Visual Rhythm Engine — adapts the energy of clip selection to match narration pace.
 *
 * Classifies each beat's narration energy (HIGH / MEDIUM / LOW) from text keywords,
 * and produces a RhythmProfile that can be used to:
 *  - Prefer high-motion clips for HIGH-energy beats
 *  - Prefer slow/static clips for LOW-energy beats
 *  - Inform the Shot Sequence Optimizer about energy arc
 *
 * Also adjusts beatDurations proportionally to create visual rhythm:
 *  - HIGH energy: shorter clip durations (faster cutting)
 *  - LOW energy: longer clip durations (slower, contemplative)
 *  - Total duration is always preserved (normalization step)
 *  - Minimum clip duration: 1.0 s (never cut below this)
 *
 * Scene pace types (inferred from aggregate beat energy):
 *  - "intro"        — slow opening, contemplative, LOW dominant
 *  - "tension"      — fast cutting, HIGH dominant
 *  - "explanation"  — steady medium pace, MEDIUM dominant
 *  - "emotional"    — slow + close, LOW dominant with some HIGH peaks
 *  - "mixed"        — balanced
 *
 * Feature flag: VISUAL_RHYTHM_ENGINE_ENABLED (default: "true")
 */

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function visualRhythmEngineEnabled(): boolean {
  return process.env.VISUAL_RHYTHM_ENGINE_ENABLED !== "false";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type BeatEnergy = "high" | "medium" | "low";

export type ScenePace = "intro" | "tension" | "explanation" | "emotional" | "mixed";

export type RhythmProfile = {
  beatEnergies: BeatEnergy[];
  dominant: BeatEnergy;
  scenePace: ScenePace;
  /** Desired motionLevel range per beat: [min, max] 0–100 */
  motionTargets: Array<[number, number]>;
};

export type RhythmResult = {
  beatDurations: number[];
  profile: RhythmProfile;
};

// ─── Energy classification ─────────────────────────────────────────────────────

const HIGH_ENERGY_KEYWORDS = [
  "invaded", "invade", "attack", "attacked", "bomb", "bombed", "explosion", "exploded",
  "fell", "fall", "collapsed", "collapse", "began", "begin", "started", "broke out",
  "fled", "flee", "charged", "charge", "stormed", "storm", "revolution", "revolt",
  "declared war", "battle", "fought", "fight", "killed", "assassination", "crisis",
  "outbreak", "surrender", "defeat", "victory", "launched", "invasion", "fire",
  "burning", "destroyed", "destruction", "massacre", "coup", "seized",
];

const LOW_ENERGY_KEYWORDS = [
  "after", "following", "meanwhile", "later", "eventually", "peace", "peaceful",
  "slowly", "quietly", "rested", "rest", "reflected", "reflection", "mourned",
  "mourning", "remembered", "remembering", "buried", "funeral", "memorial",
  "rebuilt", "recovery", "silence", "silent", "calm", "serene", "gentle",
  "contemplated", "wondered", "described", "wrote", "read", "studied",
];

function classifyBeatEnergy(beatText: string): BeatEnergy {
  const lower = beatText.toLowerCase();
  const highCount = HIGH_ENERGY_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  const lowCount = LOW_ENERGY_KEYWORDS.filter((kw) => lower.includes(kw)).length;

  if (highCount > lowCount && highCount > 0) return "high";
  if (lowCount > highCount && lowCount > 0) return "low";
  return "medium";
}

function dominantEnergy(energies: BeatEnergy[]): BeatEnergy {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const e of energies) counts[e]++;
  if (counts.high >= counts.medium && counts.high >= counts.low) return "high";
  if (counts.low > counts.medium) return "low";
  return "medium";
}

function inferScenePace(energies: BeatEnergy[]): ScenePace {
  const dom = dominantEnergy(energies);
  const n = energies.length;
  const highFrac = energies.filter((e) => e === "high").length / n;
  const lowFrac = energies.filter((e) => e === "low").length / n;

  if (highFrac >= 0.6) return "tension";
  if (lowFrac >= 0.6) {
    // Low + mostly medium → intro or emotional
    const medFrac = energies.filter((e) => e === "medium").length / n;
    return medFrac >= 0.3 ? "emotional" : "intro";
  }
  if (dom === "medium" && highFrac < 0.25 && lowFrac < 0.25) return "explanation";
  return "mixed";
}

// ─── Motion target ranges ─────────────────────────────────────────────────────

function motionTargetForEnergy(energy: BeatEnergy): [number, number] {
  switch (energy) {
    case "high":   return [60, 100]; // fast-moving action footage
    case "low":    return [0, 35];   // static or slow-motion
    case "medium": return [25, 70];  // moderate movement
  }
}

// ─── Duration adjustment ──────────────────────────────────────────────────────

const ENERGY_MULTIPLIERS: Record<BeatEnergy, number> = {
  high:   0.82, // shorter clips = faster cutting
  medium: 1.00,
  low:    1.22, // longer clips = slower, contemplative
};

const MIN_CLIP_DURATION_S = 1.0;

/**
 * Redistributes beatDurations based on energy profile while keeping the total constant.
 * Only applied when VISUAL_RHYTHM_ENGINE_ENABLED.
 */
function applyRhythmTodurations(
  durations: number[],
  energies: BeatEnergy[]
): number[] {
  if (durations.length === 0) return durations;
  const total = durations.reduce((a, b) => a + b, 0);

  // Apply multipliers
  const raw = durations.map((d, i) => {
    const energy = energies[i] ?? "medium";
    return Math.max(MIN_CLIP_DURATION_S, d * ENERGY_MULTIPLIERS[energy]);
  });

  // Normalize to preserve total
  const rawTotal = raw.reduce((a, b) => a + b, 0);
  if (rawTotal <= 0) return durations;
  const scale = total / rawTotal;
  return raw.map((d) => Math.max(MIN_CLIP_DURATION_S, d * scale));
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds a RhythmProfile for a scene from its beat texts.
 * Pure analysis — does not modify any state.
 */
export function buildRhythmProfile(beatTexts: string[]): RhythmProfile {
  const beatEnergies = beatTexts.map(classifyBeatEnergy);
  const dominant = dominantEnergy(beatEnergies);
  const scenePace = inferScenePace(beatEnergies);
  const motionTargets = beatEnergies.map(motionTargetForEnergy);
  return { beatEnergies, dominant, scenePace, motionTargets };
}

/**
 * Adjusts beatDurations to reflect rhythm profile.
 * Returns adjusted durations + rhythm profile for downstream use.
 * Never throws.
 */
export function applyVisualRhythm(
  sceneIndex: number,
  beatTexts: string[],
  beatDurations: number[]
): RhythmResult {
  const profile = buildRhythmProfile(beatTexts);

  if (!visualRhythmEngineEnabled() || beatDurations.length === 0) {
    return { beatDurations, profile };
  }

  try {
    // Only adjust durations when there's clear energy variation — otherwise not worth it
    const hasVariation = profile.beatEnergies.some((e) => e !== profile.dominant);
    const adjusted = hasVariation
      ? applyRhythmTodurations(beatDurations, profile.beatEnergies)
      : beatDurations;

    if (hasVariation) {
      console.log(
        `[VisualRhythm] s${sceneIndex} pace=${profile.scenePace} ` +
          `energies=[${profile.beatEnergies.join(",")}]`
      );
    }

    return { beatDurations: adjusted, profile };
  } catch (err) {
    console.warn(`[VisualRhythm] s${sceneIndex} error:`, (err as Error).message);
    return { beatDurations, profile };
  }
}
