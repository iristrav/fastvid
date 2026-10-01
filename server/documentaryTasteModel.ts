/**
 * Documentary Taste Model — the final editor before a clip is locked in.
 *
 * Sits immediately after AssetDirector in the pipeline. It receives the
 * already-ranked candidate list and applies ten human-editor-style criteria:
 *
 *   1. Negative matching      — hard penalties for factual mismatches
 *   2. Confidence-aware       — lower-confidence annotation fields count less
 *   3. Source quality         — trusted archives score higher
 *   4. Historical consistency — flags anachronisms
 *   5. Multi-clip storytelling — scene-level sequence coherence
 *   6. Explainability++       — full breakdown + top-5 alternatives
 *   7. Adaptive weights       — auto-tune per documentary type
 *   8. Always on — one ranking chain: base → AssetDirector → this model
 *
 * ONE ROUTE — what this model does NOT own. Shot variety is the AssetDirector's
 * (`scoreShotVariety`, `computeDiversityModifier`, fed by the render's own category count).
 * How often an asset was used is the usage history's (same film: the hard dedup; other films:
 * `preferLessUsed`). This model's own shot progression and clip fatigue read a memory nothing has
 * written since the scene pool was removed, so they scored every candidate alike; they are gone.
 *
 * No LLM calls. No retrieval. 100% deterministic, driven by pre-computed
 * ClipAnnotation and pipeline state.
 */

import path from "path";
import type { ClipAnnotation } from "../drizzle/annotationTypes";
import type { CandidateMeta } from "./assetDirector";


// ─── Documentary type detection ────────────────────────────────────────────────

export type DocumentaryType =
  | "historical"
  | "biography"
  | "tech"
  | "science"
  | "geopolitical"
  | "general";

const HISTORICAL_KEYWORDS =
  /\b(war|battle|wwii|world war|empire|revolution|ancient|century|1[0-9]{3}|20[0-5][0-9]|medieval|napoleon|tudor|ottoman|roman|colonial|occupation|siege|dynasty)\b/i;
const BIOGRAPHY_KEYWORDS =
  /\b(born|childhood|early life|career|legacy|death|portrait|family|personal|struggled|achieved|founded|led|resigned|elected|appointed)\b/i;
const TECH_KEYWORDS =
  /\b(software|algorithm|startup|silicon valley|ai|robot|computer|blockchain|internet|data center|server|chip|smartphone|app|platform|neural)\b/i;
const SCIENCE_KEYWORDS =
  /\b(discovery|experiment|lab|molecule|galaxy|climate|evolution|dna|genome|atom|quantum|research|scientist|telescope|vaccine)\b/i;
const GEO_KEYWORDS =
  /\b(diplomacy|treaty|summit|sanction|election|parliament|president|minister|nato|un|eu|geopolit|territory|border|conflict|alliance)\b/i;

export function detectDocumentaryType(
  beatText: string,
  activeEra: string | null | undefined,
  activeEntity: string | null | undefined
): DocumentaryType {
  const combined = `${beatText} ${activeEra ?? ""} ${activeEntity ?? ""}`;
  if (BIOGRAPHY_KEYWORDS.test(combined) && (activeEntity ?? "").length > 2) return "biography";
  if (TECH_KEYWORDS.test(combined)) return "tech";
  if (SCIENCE_KEYWORDS.test(combined)) return "science";
  if (GEO_KEYWORDS.test(combined)) return "geopolitical";
  if (HISTORICAL_KEYWORDS.test(combined)) return "historical";
  return "general";
}

// ─── Adaptive weights ─────────────────────────────────────────────────────────

export type TasteWeights = {
  assetDirector: number;     // carry-over weight from upstream score
  negativePenalties: number; // how much hard penalties can override
  sourceQuality: number;
  historicalConsistency: number;
  confidence: number;        // confidence adjustment multiplier
};

const BASE_WEIGHTS: TasteWeights = {
  assetDirector:        0.60,
  negativePenalties:    1.00, // always applied at full weight
  sourceQuality:        0.12,
  historicalConsistency: 0.10,
  confidence:           0.80, // annotation confidence floor multiplier
};

export function adaptWeights(docType: DocumentaryType): TasteWeights {
  switch (docType) {
    case "historical":
      return { ...BASE_WEIGHTS, historicalConsistency: 0.20, sourceQuality: 0.18, assetDirector: 0.52 };
    case "biography":
      return { ...BASE_WEIGHTS, assetDirector: 0.55 };
    case "tech":
      return { ...BASE_WEIGHTS, historicalConsistency: 0.05, sourceQuality: 0.06, assetDirector: 0.69 };
    case "science":
      return { ...BASE_WEIGHTS, sourceQuality: 0.08, historicalConsistency: 0.06, assetDirector: 0.66 };
    case "geopolitical":
      return { ...BASE_WEIGHTS, historicalConsistency: 0.14, sourceQuality: 0.14, assetDirector: 0.56 };
    default:
      return BASE_WEIGHTS;
  }
}

// ─── Source quality registry ───────────────────────────────────────────────────

/**
 * Source quality bonus (flat points added to final taste score, –10..+20).
 * Values are calibrated so BBC Archive > Wikimedia > Pexels > AI.
 */
const SOURCE_QUALITY_MAP: Array<{ pattern: RegExp; label: string; bonus: number }> = [
  { pattern: /bbc[_-]archive|bbc_news|bbc_footage/i,             label: "BBC Archive",          bonus: 20 },
  { pattern: /imperial[_-]war[_-]museum|iwm/i,                   label: "Imperial War Museum",  bonus: 18 },
  { pattern: /bundesarchiv/i,                                     label: "Bundesarchiv",         bonus: 18 },
  { pattern: /national[_-]archives|nara/i,                       label: "National Archives",    bonus: 16 },
  { pattern: /library[_-]of[_-]congress|loc\b/i,                 label: "Library of Congress",  bonus: 16 },
  { pattern: /european[_-]film[_-]gateway|efg/i,                 label: "Eur. Film Gateway",    bonus: 14 },
  { pattern: /europeana/i,                                        label: "Europeana",            bonus: 12 },
  { pattern: /internet[_-]archive|archive\.org/i,                 label: "Internet Archive",     bonus: 10 },
  { pattern: /wikimedia|commons\.wikimedia/i,                     label: "Wikimedia",            bonus: 8  },
  { pattern: /pexels/i,                                           label: "Pexels",               bonus: 2  },
  { pattern: /pixabay/i,                                          label: "Pixabay",              bonus: 1  },
  { pattern: /kling|ai_gen|veo|grok|stability|leonardo|runway/i, label: "AI Generated",         bonus: -5 },
];

function resolveSourceQuality(clipPath: string): { label: string; bonus: number } {
  const full = clipPath.toLowerCase();
  for (const entry of SOURCE_QUALITY_MAP) {
    if (entry.pattern.test(full)) return { label: entry.label, bonus: entry.bonus };
  }
  // Default: curated/archive directories get modest bonus
  if (full.includes("/archive/") || full.includes("/curated/")) return { label: "Curated Archive", bonus: 6 };
  return { label: "Unknown Source", bonus: 0 };
}


// ─── Confidence-aware annotation quality ──────────────────────────────────────

/**
 * Returns an adjustment multiplier (0.5–1.0) based on how confident the
 * annotation is about its key fields. Low-confidence annotations count less.
 */
function confidenceMultiplier(ann: ClipAnnotation | null | undefined): number {
  if (!ann) return 0.70; // no annotation — moderate confidence in filename fallback

  let totalConf = 0;
  let fields = 0;

  // Location confidence from the annotation
  const locConf = ann.location.confidence;
  if (locConf === "high")    { totalConf += 1.0; fields++; }
  else if (locConf === "medium") { totalConf += 0.65; fields++; }
  else if (locConf === "low")    { totalConf += 0.35; fields++; }
  else                           { totalConf += 0.50; fields++; } // unknown

  // Historical context: if year/decade is filled, annotation is confident
  if (ann.historicalContext.year && ann.historicalContext.year !== "unknown") {
    totalConf += 0.90; fields++;
  } else if (ann.historicalContext.decade) {
    totalConf += 0.70; fields++;
  } else {
    totalConf += 0.40; fields++;
  }

  // Named persons: presence means annotator was confident
  if (ann.persons.named.length > 0)   { totalConf += 0.90; fields++; }
  else if (ann.persons.categories.length > 0) { totalConf += 0.60; fields++; }
  else                                 { totalConf += 0.40; fields++; }

  // Quality: sharpness > 50 means the image was readable enough to annotate well
  const sharpConf = ann.quality.sharpness > 60 ? 0.90 : ann.quality.sharpness > 30 ? 0.65 : 0.40;
  totalConf += sharpConf; fields++;

  const avgConf = fields > 0 ? totalConf / fields : 0.60;
  // Scale to 0.50–1.0 range (never fully zero even for uncertain annotations)
  return 0.50 + avgConf * 0.50;
}

// ─── Historical consistency ────────────────────────────────────────────────────

/**
 * Objects that only exist in a modern context (post-1990).
 * Presence in a historically-dated clip is an anachronism.
 */
const MODERN_OBJECTS = new Set([
  "smartphone", "mobile phone", "laptop", "tablet", "computer screen", "led screen",
  "digital display", "drone", "electric car", "solar panel", "wind turbine",
  "satellite dish", "credit card terminal", "selfie stick", "flat screen tv",
  "smart watch", "headphones", "earbuds", "virtual reality",
]);

/**
 * Objects that strongly signal a historical (pre-1950) context.
 */
const HISTORICAL_OBJECTS = new Set([
  "horse", "horse-drawn cart", "telegraph", "gramophone", "biplane", "zeppelin",
  "typewriter", "steam engine", "musket", "cannon", "parchment", "quill",
  "lantern", "gas lamp", "film reel projector", "slide rule",
]);

/**
 * Returns a score (0–100) and a description of any anachronism found.
 */
function scoreHistoricalConsistency(
  ann: ClipAnnotation | null | undefined,
  activeEra: string | null | undefined,
  beatText: string
): { score: number; issues: string[] } {
  if (!ann) return { score: 70, issues: [] }; // no annotation — neutral

  const issues: string[] = [];
  let score = 100;

  // Determine if the beat is historical or modern from the active era
  const eraYear = activeEra ? parseInt(activeEra.replace(/[^0-9]/g, ""), 10) : NaN;
  const clipYear = ann.historicalContext.year
    ? parseInt(ann.historicalContext.year.replace(/[^0-9]/g, ""), 10)
    : NaN;

  const beatLower = beatText.toLowerCase();

  // Detect if beat context is historical (pre-1980)
  const beatIsHistorical = (!isNaN(eraYear) && eraYear < 1980)
    || /\b(wwii|world war|ancient|medieval|napoleon|roman|ottoman|colonial|revolution|1[0-9]{3})\b/i.test(beatLower);

  // Detect if beat context is modern (post-2000)
  const beatIsModern = (!isNaN(eraYear) && eraYear >= 2000)
    || /\b(ai|smartphone|internet|social media|startup|2[0-9]{3})\b/i.test(beatLower);

  // Check clip objects for anachronisms
  const clipObjectsLower = ann.objects.map((o) => o.toLowerCase());

  if (beatIsHistorical) {
    for (const obj of clipObjectsLower) {
      if (MODERN_OBJECTS.has(obj)) {
        score -= 25;
        issues.push(`modern object "${obj}" in historical scene`);
      }
    }
    // Check visual style — modern footage in a historical beat
    const vs = ann.cinematography.visualStyle.toLowerCase();
    if (vs === "modern" || vs === "documentary") {
      score -= 10;
      issues.push("modern visual style for historical beat");
    }
  }

  if (beatIsModern) {
    for (const obj of clipObjectsLower) {
      if (HISTORICAL_OBJECTS.has(obj)) {
        score -= 15;
        issues.push(`historical object "${obj}" in modern scene`);
      }
    }
  }

  // Era clash: clip's own year clearly conflicts with beat's era
  if (!isNaN(eraYear) && !isNaN(clipYear)) {
    const yearDiff = Math.abs(eraYear - clipYear);
    if (yearDiff > 80) {
      score -= 40;
      issues.push(`year mismatch: beat era ${eraYear}, clip year ${clipYear} (Δ${yearDiff}y)`);
    } else if (yearDiff > 40) {
      score -= 20;
      issues.push(`year divergence: beat era ${eraYear}, clip year ${clipYear} (Δ${yearDiff}y)`);
    } else if (yearDiff > 20) {
      score -= 8;
    }
  }

  return { score: Math.max(0, score), issues };
}

// ─── Negative matching ────────────────────────────────────────────────────────

const HARD_PENALTIES = {
  wrongNamedPerson: -60,    // a different specific person is in frame
  wrongEvent:       -70,    // clip documents a different specific event
  wrongEra:         -50,    // era mismatch detected
  modernInHistoric: -40,    // modern visual in historical context
  historicInModern: -25,    // historical visual in modern context
};

type NegativePenaltyResult = {
  totalPenalty: number;
  penalties: string[];
};

function computeNegativePenalties(
  ann: ClipAnnotation | null | undefined,
  activeEntity: string | null | undefined,
  activeEra: string | null | undefined,
  beatText: string,
  historicalConsistencyIssues: string[]
): NegativePenaltyResult {
  const penalties: string[] = [];
  let totalPenalty = 0;

  if (!ann) {
    // No annotation — no hard penalties possible
    return { totalPenalty: 0, penalties: [] };
  }

  const beatLower = beatText.toLowerCase();
  const entityLower = (activeEra ?? "").toLowerCase() + " " + (activeEntity ?? "").toLowerCase();

  // ── Wrong named person ─────────────────────────────────────────────────────
  // If the beat mentions a specific person AND the clip shows a different named person
  if (activeEntity && ann.persons.named.length > 0) {
    const entityTokens = activeEntity.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const clipNamedLower = ann.persons.named.map((p) => p.toLowerCase());
    const entityMatch = entityTokens.some((t) => clipNamedLower.some((p) => p.includes(t) || t.includes(p)));

    if (!entityMatch) {
      // The clip shows named people, but not the expected person
      // Check if the beat text itself mentions the named persons in the clip
      const clipPersonInBeat = clipNamedLower.some((p) =>
        p.split(" ").some((token) => token.length > 3 && beatLower.includes(token))
      );
      if (!clipPersonInBeat) {
        penalties.push(`wrong person: expected "${activeEntity}", clip shows "${ann.persons.named.join(", ")}"`);
        totalPenalty += HARD_PENALTIES.wrongNamedPerson;
      }
    }
  }

  // ── Wrong event ────────────────────────────────────────────────────────────
  // The clip is annotated with a specific historical event that contradicts the beat
  if (ann.historicalContext.event && ann.historicalContext.event.toLowerCase() !== "unknown") {
    const eventLower = ann.historicalContext.event.toLowerCase();
    const eventTokens = eventLower.split(/\s+/).filter((t) => t.length > 3);
    const beatHasEvent = eventTokens.some((t) => beatLower.includes(t));
    const entityHasEvent = eventTokens.some((t) => entityLower.includes(t));

    if (!beatHasEvent && !entityHasEvent) {
      // The clip's event is not mentioned anywhere in the context
      // Only apply the penalty if the event seems clearly different
      const clipEventYear = ann.historicalContext.year
        ? parseInt(ann.historicalContext.year.replace(/[^0-9]/g, ""), 10)
        : NaN;
      const eraYear = activeEra ? parseInt(activeEra.replace(/[^0-9]/g, ""), 10) : NaN;

      if (!isNaN(clipEventYear) && !isNaN(eraYear) && Math.abs(clipEventYear - eraYear) > 30) {
        penalties.push(`wrong event: clip event "${ann.historicalContext.event}" doesn't match beat`);
        totalPenalty += HARD_PENALTIES.wrongEvent;
      }
    }
  }

  // ── Wrong era ──────────────────────────────────────────────────────────────
  if (activeEra) {
    const eraYear = parseInt(activeEra.replace(/[^0-9]/g, ""), 10);
    const clipYear = ann.historicalContext.year
      ? parseInt(ann.historicalContext.year.replace(/[^0-9]/g, ""), 10)
      : NaN;
    if (!isNaN(eraYear) && !isNaN(clipYear) && Math.abs(eraYear - clipYear) > 80) {
      penalties.push(`wrong era: beat year ≈${eraYear}, clip year ${clipYear}`);
      totalPenalty += HARD_PENALTIES.wrongEra;
    }
  }

  // ── Historical consistency issues propagated ────────────────────────────────
  for (const issue of historicalConsistencyIssues) {
    if (issue.includes("modern object") || issue.includes("modern visual")) {
      penalties.push(issue);
      totalPenalty += HARD_PENALTIES.modernInHistoric;
    } else if (issue.includes("historical object")) {
      penalties.push(issue);
      totalPenalty += HARD_PENALTIES.historicInModern;
    }
  }

  return { totalPenalty, penalties };
}

// ─── Scene-level storytelling check ──────────────────────────────────────────

/**
 * The clip's own storytelling value: its annotated storytelling potential, and a small bonus for a
 * calm clip. ONE ROUTE — the scene-history parts (style repeats, emotion runs, static/dynamic
 * alternation) read a memory nothing ever wrote; shot variety across a scene is the AssetDirector's.
 * The score is exactly what those parts produced with that empty memory.
 */
function scoreMultiClipStorytelling(ann: ClipAnnotation | null | undefined): number {
  if (!ann) return 60;
  let score = 70;
  if (ann.editorialScore.storytellingPotential >= 75) score += 15;
  else if (ann.editorialScore.storytellingPotential >= 55) score += 8;
  if (ann.motionLevel < 25) score += 8;
  return Math.max(0, Math.min(100, score));
}

// ─── Score types ──────────────────────────────────────────────────────────────

export type TasteScore = {
  finalScore: number;
  assetDirectorScore: number;
  breakdown: {
    negativePenalty: number;
    confidenceAdjusted: number;
    sourceQuality: number;
    historicalConsistency: number;
    storytelling: number;
  };
  penalties: string[];
  reasons: string[];
  docType: DocumentaryType;
  sourceLabel: string;
  confidenceMultiplier: number;
};

export type TasteModelResult = {
  rankedPaths: string[];
  topScore: TasteScore | null;
  top5Alternatives: Array<{ path: string; score: TasteScore; reason: string }>;
  reordered: boolean;
};

// ─── Context ──────────────────────────────────────────────────────────────────

export type TasteModelContext = {
  /** Active entity from the beat narration. */
  activeEntity?: string | null;
  /** Active era from the beat narration. */
  activeEra?: string | null;
  /** Full beat narration text. */
  beatText: string;
  /** Documentary type (auto-detected if not provided). */
  docType?: DocumentaryType;
};

// ─── Core per-candidate scorer ────────────────────────────────────────────────

function scoreTasteCandidate(
  clipPath: string,
  meta: CandidateMeta | undefined,
  assetDirectorScore: number,
  ctx: TasteModelContext,
  weights: TasteWeights
): TasteScore {
  const ann = meta?.annotation ?? null;
  const reasons: string[] = [];
  const penalties: string[] = [];

  // ── 1. Confidence multiplier ──────────────────────────────────────────────
  const confMult = confidenceMultiplier(ann);

  // ── 2. Historical consistency ─────────────────────────────────────────────
  const histResult = scoreHistoricalConsistency(ann, ctx.activeEra, ctx.beatText);

  // ── 3. Negative penalties ─────────────────────────────────────────────────
  const negResult = computeNegativePenalties(
    ann, ctx.activeEntity, ctx.activeEra, ctx.beatText, histResult.issues
  );
  penalties.push(...negResult.penalties);

  // ── 4. Source quality ─────────────────────────────────────────────────────
  const { label: sourceLabel, bonus: sourceBonus } = resolveSourceQuality(clipPath);
  const sourceScore = Math.min(100, Math.max(0, 50 + sourceBonus * 2.5));

  // ── 5. Multi-clip storytelling ────────────────────────────────────────────
  const storytellingScore = scoreMultiClipStorytelling(ann);

  // ── Confidence-adjusted asset director score ──────────────────────────────
  // The upstream AssetDirector score is good, but if the annotation that generated
  // it has low confidence, we should trust it less.
  const confidenceAdjustedAd = Math.round(
    assetDirectorScore * (weights.confidence * confMult + (1 - weights.confidence))
  );

  // ── Composite score (0–100) ───────────────────────────────────────────────
  // Start from the confidence-adjusted AssetDirector score, then add weighted deltas
  const tasteContribution = Math.round(
    sourceScore         * weights.sourceQuality       +
    histResult.score    * weights.historicalConsistency +
    storytellingScore   * 0.08
  ) / (weights.sourceQuality + weights.historicalConsistency + 0.08);

  // Blend: 60% upstream AssetDirector (confidence-adjusted), 40% taste signals
  const blended = Math.round(
    confidenceAdjustedAd * weights.assetDirector +
    tasteContribution    * (1 - weights.assetDirector)
  );

  // Apply hard negative penalties (uncapped — can drive score to 0)
  const afterPenalty = Math.max(0, blended + negResult.totalPenalty);

  // Source quality applied as flat bonus/penalty (–12..+20)
  const finalScore = Math.max(0, Math.min(100, afterPenalty + Math.round(sourceBonus * 0.6)));

  // ── Reasons ───────────────────────────────────────────────────────────────
  if (sourceBonus >= 14)            reasons.push(`trusted source: ${sourceLabel}`);
  if (histResult.score >= 95)       reasons.push("historically consistent");
  if (histResult.score < 50)        reasons.push(`⚠ anachronism detected`);
  if (storytellingScore >= 85)      reasons.push("strong storytelling value");
  if (confMult < 0.60)              reasons.push(`low annotation confidence (×${confMult.toFixed(2)})`);
  if (negResult.totalPenalty < -40) reasons.push("❌ hard factual mismatch");

  return {
    finalScore,
    assetDirectorScore,
    breakdown: {
      negativePenalty: negResult.totalPenalty,
      confidenceAdjusted: confidenceAdjustedAd,
      sourceQuality: sourceScore,
      historicalConsistency: histResult.score,
      storytelling: storytellingScore,
    },
    penalties,
    reasons,
    docType: ctx.docType ?? "general",
    sourceLabel,
    confidenceMultiplier: confMult,
  };
}

// ─── Explainability logger ────────────────────────────────────────────────────

export function logTasteModelChoice(
  clipPath: string,
  sceneIndex: number,
  beatIndex: number,
  beatText: string,
  topScore: TasteScore,
  top5: Array<{ path: string; score: TasteScore; reason: string }>
): void {
  const base = path.basename(clipPath);
  const bk = topScore.breakdown;

  const penaltyStr = topScore.penalties.length
    ? `\n    Penalties:    ${topScore.penalties.map((p) => `⛔ ${p}`).join("; ")}`
    : "";

  const altStr = top5.length > 1
    ? "\n  Top alternatives:\n" +
      top5.slice(1, 5).map((alt, i) => {
        const altBase = path.basename(alt.path);
        return `    ${i + 2}. ${altBase} → ${alt.score.finalScore} (AD:${alt.score.assetDirectorScore}) — ${alt.reason}`;
      }).join("\n")
    : "";

  console.log(
    `[TasteModel] s${sceneIndex}b${beatIndex} "${beatText.slice(0, 50)}" → ${base}\n` +
    `  DocType:      ${topScore.docType}\n` +
    `  AssetDir:     ${topScore.assetDirectorScore}  (conf×${topScore.confidenceMultiplier.toFixed(2)} → ${bk.confidenceAdjusted})\n` +
    `  Source:       ${topScore.sourceLabel}(${bk.sourceQuality})\n` +
    `  HistConsist:  ${bk.historicalConsistency}  Storytelling: ${bk.storytelling}` +
    `  NegPenalty:   ${bk.negativePenalty}` +
    penaltyStr + "\n" +
    `  ─ Final: ${topScore.finalScore}  (${topScore.reasons.join(", ") || "no special reasons"})` +
    altStr
  );
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Applies the Documentary Taste Model to an already-ranked candidate list.
 *
 * The `assetDirectorScores` map must contain a pre-computed score (0–100) for each
 * candidate path — this is the output of `rankCandidatesWithContext()`. When a
 * path has no entry, a neutral score of 50 is assumed.
 *
 * Returns a re-ranked list with full explainability.
 */
export function applyDocumentaryTasteModel(
  candidatePaths: string[],
  beatText: string,
  sceneIndex: number,
  beatIndex: number,
  ctx: TasteModelContext,
  candidateMeta?: Map<string, CandidateMeta>,
  assetDirectorScores?: Map<string, number>
): TasteModelResult {
  if (candidatePaths.length <= 1) {
    return {
      rankedPaths: candidatePaths,
      topScore: null,
      top5Alternatives: [],
      reordered: false,
    };
  }

  const docType = ctx.docType ?? detectDocumentaryType(beatText, ctx.activeEra, ctx.activeEntity);
  const weights = adaptWeights(docType);
  const enrichedCtx: TasteModelContext = { ...ctx, docType };

  const scored = candidatePaths.map((p) => {
    const meta = candidateMeta?.get(p);
    const adScore = assetDirectorScores?.get(p) ?? 50;
    const tasteScore = scoreTasteCandidate(p, meta, adScore, enrichedCtx, weights);
    return { path: p, score: tasteScore };
  });

  scored.sort((a, b) => b.score.finalScore - a.score.finalScore);

  const originalTop = candidatePaths[0];
  const reordered = originalTop !== scored[0]!.path;

  const top5: Array<{ path: string; score: TasteScore; reason: string }> = scored.slice(0, 5).map((s, i) => ({
    path: s.path,
    score: s.score,
    reason: i === 0
      ? `WINNER: ${s.score.reasons.join(", ") || "balanced score"}`
      : `AD:${s.score.assetDirectorScore} → Taste:${s.score.finalScore} — ${
          s.score.penalties.length > 0
            ? `penalised (${s.score.penalties[0]})`
            : s.score.reasons.slice(0, 2).join(", ") || "lower taste score"
        }`,
  }));

  if (reordered && scored[0]) {
    logTasteModelChoice(
      scored[0].path, sceneIndex, beatIndex, beatText, scored[0].score, top5
    );
  }

  return {
    rankedPaths: scored.map((s) => s.path),
    topScore: scored[0]!.score,
    top5Alternatives: top5,
    reordered,
  };
}

// ─── State helpers ────────────────────────────────────────────────────────────

