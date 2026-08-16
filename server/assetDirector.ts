/**
 * Asset Director — editorial brain of the full clip-selection pipeline.
 *
 * Every clip decision runs through a single scoring engine built on five
 * pillars that cover 100% of the weighted score:
 *
 *   40%  LLM annotation fingerprint
 *          People · Objects · Actions · Location · Era · Emotion
 *          Shot type · Visual style · Topic affinity
 *          + Knowledge Graph entity expansion
 *   25%  Embedding similarity
 *          Cosine similarity between beat-text embedding and stored asset embedding
 *   15%  Editorial score
 *          annotation.editorialScore.total + quality sub-scores
 *   10%  Shot variety + style continuity
 *          Avoids repeating shot types; rewards editorial-memory style matches
 *   10%  Blueprint directive
 *          MasterDocumentaryDirector visual type + narrative act + callbacks
 *
 * Extra modifiers (applied after weights):
 *   Diversity modifier   — category saturation penalty
 *   Budget penalty       — visual-type over-budget (-30 flat)
 *   Editorial memory     — bonus for continuing previous-scene aesthetic
 *
 * No LLM calls. No retrieval. 100% from pre-computed metadata and state.
 * Feature flag: ASSET_DIRECTOR_ENABLED (default: "true")
 *
 * Explainability: every clip choice emits a structured log with per-signal
 * contributions so any pick can be fully traced.
 */

import path from "path";
import type {
  VideoBlueprint,
  VisualBudgetTracker,
  BeatVisualDirective,
} from "./masterDocumentaryDirector";
import { getBlueprintDirective, isBudgetExceeded, recordBudgetUsage } from "./masterDocumentaryDirector";
import type { ClipAnnotation } from "../drizzle/annotationTypes";
import {
  computeArchiveMetadataScores,
  computeTrimHint,
  archiveV4ScoringEnabled,
  type SegmentSimilarity,
  type TrimHint,
  type ArchiveMetadataScores,
} from "./archiveMetadataScorer";
import {
  decomposeQueryBeat,
  editorialIntentEnabled,
  logEditorialIntentChoice,
} from "./editorialIntentEngine";
import {
  documentaryPlanningEnabled,
  scoreRetrievalContract,
  type RetrievalContract,
} from "./documentaryPlanningEngine";

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function assetDirectorEnabled(): boolean {
  return process.env.ASSET_DIRECTOR_ENABLED !== "false";
}

// ─── CandidateMeta ───────────────────────────────────────────────────────────

/**
 * Rich metadata for one candidate clip.
 * `embeddingSimilarity` is the cosine similarity between the beat-text embedding
 * and the asset's stored embedding (pre-computed, 0–1). Pass null when unavailable.
 */
export type CandidateMeta = {
  assetId?: number;
  annotation?: ClipAnnotation | null;
  editorialScore?: number | null;
  plannerShotType?: string | null;
  plannerMotionTarget?: number | null;
  /** Cosine similarity of beat-text vs stored asset embedding (0–1). */
  embeddingSimilarity?: number | null;
  /**
   * Per-segment embedding similarities for this clip.
   * Populated by the pipeline when segment embedding files are available.
   * Used by archiveMetadataScorer to award segment-level bonuses and produce TrimHints.
   */
  segmentSimilarities?: SegmentSimilarity[];
  /**
   * P0/P1 image-quality patch: raw, unstructured provider-authored text for external
   * (non-archive) candidates — title/description/tags/categories as returned by the source
   * (Wikimedia page title, Internet Archive item title, SepiaSearch/Vimeo/GDELT metadata, …).
   *
   * Deliberately NOT a synthesized `ClipAnnotation` — none of these fields are parsed into
   * structured persons/objects/location data here, because that would itself be fabricated
   * annotation (a title string does not reliably decompose into "this object is in this
   * location"). It exists only so `scoreAnnotationFingerprint` has real, independently-authored
   * text to match against for candidates that have no curated-archive annotation, instead of
   * falling back to the positional download filename. It also doubles as the "reliable
   * evidence" source for the entity gate (see `hasReliableEntityEvidence` in videoPipeline.ts) —
   * independent of whatever query the pipeline itself searched with.
   */
  providerText?: {
    title?: string;
    description?: string;
    tags?: string;
  } | null;
};

// ─── Editorial Memory ─────────────────────────────────────────────────────────

/**
 * Style fingerprint extracted from the clips adopted in the previous scene.
 * Used to reward visual continuity when the narration stays on the same topic.
 */
export type SceneStyleMemory = {
  /** Named people who appeared most in the previous scene. */
  dominantPeople: string[];
  /** Location inferred from previous scene's clips. */
  dominantLocation: string;
  /** Era/period of previous scene (e.g. "1940s", "WWII"). */
  dominantEra: string;
  /** Visual style: "archival" | "modern" | "documentary" | etc. */
  dominantVisualStyle: string;
  /** Most common shot types in the previous scene. */
  dominantShotTypes: string[];
  /** Primary emotion of previous scene. */
  dominantEmotion: string;
};

// ─── Knowledge Graph ──────────────────────────────────────────────────────────

/**
 * Compact entity–relation graph.
 * Key = entity term (lowercase). Value = related terms that should count as
 * a semantic hit when the entity is active in the narration.
 *
 * The graph is intentionally flat (depth 1) to keep scoring O(1).
 * Add entries as topics expand.
 */
const KNOWLEDGE_GRAPH: Record<string, string[]> = {
  // ─── World War II ──────────────────────────────────────────────────────────
  "churchill": ["united kingdom", "london", "world war ii", "wwii", "1940", "1941", "1944", "parliament", "speech", "prime minister", "battle of britain", "raf", "blitz", "downing street", "winston", "microphone", "house of commons"],
  "hitler": ["germany", "berlin", "nazi", "world war ii", "wwii", "third reich", "1933", "1939", "1945", "reichstag", "führer", "nuremberg"],
  "roosevelt": ["united states", "usa", "washington", "white house", "1941", "1944", "war", "democracy", "new deal"],
  "stalin": ["soviet union", "russia", "moscow", "red army", "wwii", "1941", "1945", "kremlin"],
  "eisenhower": ["united states", "general", "d-day", "normandy", "1944", "supreme commander", "europe"],
  "d-day": ["normandy", "france", "1944", "beach", "landing", "allied forces", "operation overlord", "june"],
  "holocaust": ["auschwitz", "concentration camp", "nazi", "1942", "1943", "1944", "germany", "jewish", "genocide"],
  "pearl harbor": ["hawaii", "1941", "japan", "attack", "december", "pacific", "navy", "battleship"],
  "hiroshima": ["japan", "1945", "atomic bomb", "nuclear", "explosion", "mushroom cloud", "nagasaki"],

  // ─── Cold War ──────────────────────────────────────────────────────────────
  "berlin wall": ["germany", "berlin", "1961", "1989", "east germany", "west germany", "concrete", "wall", "division"],
  "kennedy": ["united states", "usa", "white house", "1961", "1963", "dallas", "assassination", "cuban missile crisis", "president", "cold war"],
  "khrushchev": ["soviet union", "russia", "cold war", "1950s", "1960s", "kremlin"],
  "cuban missile crisis": ["cuba", "1962", "usa", "soviet union", "nuclear", "kennedy", "khrushchev"],
  "vietnam war": ["vietnam", "saigon", "hanoi", "1965", "1975", "usa", "jungle", "soldiers"],
  "moon landing": ["nasa", "apollo", "1969", "moon", "armstrong", "houston", "rocket", "astronaut", "space"],

  // ─── Napoleonic Era ────────────────────────────────────────────────────────
  "napoleon": ["france", "paris", "empire", "1804", "1812", "1815", "waterloo", "elba", "military", "army", "emperor", "battlefield"],
  "waterloo": ["napoleon", "1815", "belgium", "battle", "wellington", "defeat", "france"],

  // ─── French Revolution ─────────────────────────────────────────────────────
  "french revolution": ["france", "paris", "1789", "1793", "guillotine", "bastille", "king", "louis xvi", "mob", "crowd", "republic"],
  "robespierre": ["france", "paris", "1793", "revolution", "terror", "guillotine"],

  // ─── American History ──────────────────────────────────────────────────────
  "lincoln": ["usa", "united states", "civil war", "1861", "1865", "washington", "slavery", "gettysburg", "assassination", "president"],
  "civil war": ["usa", "1861", "1865", "soldier", "battlefield", "north", "south", "lincoln"],
  "martin luther king": ["usa", "civil rights", "1963", "1968", "washington", "march", "speech", "birmingham", "montgomery"],
  "9/11": ["new york", "2001", "twin towers", "attack", "terrorism", "pentagon", "firefighter"],

  // ─── Modern Middle East ────────────────────────────────────────────────────
  "gulf war": ["iraq", "kuwait", "1991", "usa", "military", "desert", "baghdad", "operation desert storm"],
  "iraq war": ["iraq", "baghdad", "2003", "usa", "military", "soldier", "desert", "saddam"],
  "saddam hussein": ["iraq", "baghdad", "1990s", "2003", "dictator", "military", "gulf war"],
  "arab spring": ["egypt", "tunisia", "syria", "2011", "protest", "revolution", "cairo", "tahrir"],

  // ─── Russia / Ukraine ─────────────────────────────────────────────────────
  "ukraine": ["kiev", "kyiv", "russia", "war", "2022", "europe", "military", "zelenskyy", "nato"],
  "putin": ["russia", "moscow", "kremlin", "2000s", "ukraine", "military"],
  "crimea": ["ukraine", "russia", "2014", "peninsula", "black sea"],

  // ─── Technology ────────────────────────────────────────────────────────────
  "elon musk": ["tesla", "spacex", "twitter", "electric car", "rocket", "silicon valley", "billionaire"],
  "tesla": ["electric car", "elon musk", "silicon valley", "factory", "gigafactory", "battery", "model s"],
  "spacex": ["rocket", "elon musk", "nasa", "launch", "falcon", "starship", "cape canaveral", "space"],
  "apple": ["steve jobs", "iphone", "cupertino", "silicon valley", "technology", "computer"],
  "steve jobs": ["apple", "iphone", "macintosh", "1984", "silicon valley", "presentation", "stage"],
  "artificial intelligence": ["ai", "robot", "computer", "data center", "neural network", "machine learning", "openai", "chatgpt"],

  // ─── Climate & Energy ─────────────────────────────────────────────────────
  "climate change": ["global warming", "ice", "glacier", "flood", "fire", "storm", "carbon", "emissions", "renewable"],
  "chernobyl": ["ukraine", "1986", "nuclear", "reactor", "explosion", "radiation", "soviet union", "disaster"],
  "oil crisis": ["oil", "1973", "1979", "energy", "middle east", "opec", "petrol", "queue"],

  // ─── Historical empires ────────────────────────────────────────────────────
  "roman empire": ["rome", "italy", "colosseum", "senate", "legion", "caesar", "gladiator", "aqueduct", "ancient"],
  "julius caesar": ["rome", "senate", "1 bc", "44 bc", "ancient rome", "gaul", "rubicon", "assassination"],
  "egyptian": ["egypt", "cairo", "pyramid", "pharaoh", "nile", "ancient", "hieroglyph", "sphinx"],
  "ottoman empire": ["turkey", "istanbul", "1299", "1922", "sultan", "mosque", "constantinople"],
};

/**
 * Expands an entity string to all related KG terms.
 * Returns the expanded set including the original tokens.
 */
function expandWithKnowledgeGraph(entity: string): Set<string> {
  const lower = entity.toLowerCase();
  const tokens = lower.split(/[\s,]+/).filter((t) => t.length > 2);
  const expanded = new Set<string>(tokens);

  for (const [key, relations] of Object.entries(KNOWLEDGE_GRAPH)) {
    // Match if any token appears in the KG key, or if the key appears in the entity
    const matches = tokens.some((t) => key.includes(t) || t.includes(key)) || lower.includes(key);
    if (matches) {
      for (const r of relations) expanded.add(r);
    }
  }
  return expanded;
}

// ─── AssetDirectorContext ─────────────────────────────────────────────────────

export type AssetDirectorContext = {
  usedPaths: Set<string>;
  usedCategories: Map<string, number>;
  blueprint?: VideoBlueprint | null;
  budgetTracker?: VisualBudgetTracker | null;
  sceneAdoptedClips: string[];
  prevSceneClips: string[];
  /** Style memory extracted from the previous scene's adopted clips. */
  editorialMemory?: SceneStyleMemory | null;
  activeEntity?: string | null;
  activeLocation?: string | null;
  activeEra?: string | null;
  targetMotionLevel?: number | null;
  plannedShotType?: string | null;
  callbacksPlaced: Map<string, number>;
  /**
   * Expected audio event types for this beat (e.g. ["crowd", "speech"]).
   * Used by archiveMetadataScorer to boost clips with matching audio.
   */
  expectedAudioTypes?: string[];
  /**
   * Expected cinematic tags for this beat (e.g. ["aerial view", "establishing shot"]).
   * Set from blueprint visual type or editorial directive.
   */
  expectedCinematicTags?: string[];
  /** Beat duration in seconds — used for temporal best-window selection. */
  beatDurationSec?: number;
  /** Pre-computed retrieval contract for this beat (from DocumentaryPlanningEngine). */
  retrievalContract?: RetrievalContract | null;
};

// ─── Score types ──────────────────────────────────────────────────────────────

/**
 * Full explainable breakdown for one clip candidate.
 *
 * Main buckets (→ weighted sum = raw score):
 *   annotation  40%  — full fingerprint match from ClipAnnotation
 *   embedding   25%  — cosine similarity of beat-text vs stored embedding
 *   editorial   15%  — editorialScore.total + quality
 *   shotVariety 10%  — shot diversity + style continuity
 *   blueprint   10%  — MasterDocumentaryDirector directive
 *
 * Annotation sub-signals (shown in log, fed into annotation bucket):
 *   people · objects · actions · location · era · emotion · style · kg
 *
 * Flat modifiers applied after weighted sum:
 *   diversityModifier · budgetPenalty · editorialMemoryBonus
 */
export type AssetScore = {
  finalScore: number;
  breakdown: {
    // ── Main buckets ──────────────────────────────────────────────────────────
    annotation: number;    // 40%
    embedding: number;     // 25%
    editorial: number;     // 15%
    shotVariety: number;   // 10%
    blueprint: number;     // 10%
    // ── Annotation sub-signals ────────────────────────────────────────────────
    people: number;
    objects: number;
    actions: number;
    location: number;
    era: number;
    emotion: number;
    style: number;
    knowledgeGraph: number;
    // ── Editorial sub-signals ─────────────────────────────────────────────────
    editorialQuality: number;
    editorialStoryPotential: number;
    // ── Flat modifiers ────────────────────────────────────────────────────────
    diversityModifier: number;
    budgetPenalty: number;
    editorialMemoryBonus: number;
    // ── v4 Archive Metadata bonuses ───────────────────────────────────────────
    /** Best segment embedding similarity bonus (+0 to +6). */
    segmentBonus: number;
    /** Face dominance / close-up presence bonus (+0 to +6). */
    faceBonus: number;
    /** Object movement match bonus (+0 to +4). */
    objectBonus: number;
    /** Audio event atmosphere match bonus (+0 to +5). */
    audioBonus: number;
    /** Cinematic tags match bonus (+0 to +6). */
    cinematicBonus: number;
    /** Shot importance bonus (+0 to +5). */
    importanceBonus: number;
    /** Visual uniqueness tiebreaker (+0 to +3). */
    uniquenessBonus: number;
    /** Storytelling label match bonus (+0 to +4). */
    storytellingBonus: number;
    /** Technical quality bonus (+0 to +3). */
    qualityBonus: number;
    /** Asset health score bonus (+0 to +2). */
    healthBonus: number;
    /** Primary subject match bonus (+0 to +6). */
    primarySubjectBonus: number;
    /** Retrieval priority topic match bonus (+0 to +4). */
    retrievalPriorityBonus: number;
    /** Negative tags penalty (-5 to 0). */
    negativeTagsPenalty: number;
    /** Editorial capability match bonus (+0 to +8). */
    capabilityBonus: number;
    /** Editorial capability mismatch penalty (-6 to 0). */
    capabilityPenalty: number;
    /** Temporal best-window bonus (+0 to +5). */
    temporalBonus: number;
    /** Retrieval contract match bonus (+0 to +5) */
    contractBonus: number;
    /** Retrieval contract forbidden content penalty (-4 to 0) */
    contractPenalty: number;
    /** Sum of all v4/v5/v6/v7/planning bonuses including penalties. */
    v4Total: number;
    /** Best-matching segment (null if no segment embeddings). */
    bestSegment: SegmentSimilarity | null;
  };
  /** Human-readable reasons for the top choice. */
  reasons: string[];
};

export type AssetDirectorResult = {
  rankedPaths: string[];
  topScore: AssetScore | null;
  reordered: boolean;
  /**
   * Trim hints for candidates that have a better-matching temporal segment.
   * Key = clip path. Look up the winning path here to apply segment trimming.
   */
  trimHints?: Map<string, TrimHint>;
};

// ─── Path-based inference (fallback only) ─────────────────────────────────────

const ARCHIVAL_RE = /map|engraving|painting|illustration|newspaper|document|diagram|poster|chart|wikimedia|archive/i;
const FALLBACK_RE = /color_fallback|fallback|guaranteed|placeholder|color_clip/i;
const WIDE_RE     = /wide|aerial|panorama|establishing|cityscape|landscape|overhead|drone|overview/i;
const CLOSE_RE    = /close|face|detail|extreme|macro|portrait/i;
const MEDIUM_RE   = /medium|mid|waist|interview|talking|standing/i;
const MAP_RE      = /\bmap\b|globe|geographic|territory|region|country/i;
const PHOTO_RE    = /photo|jpg|jpeg|png|still|image/i;
const AI_RE       = /kling|ai_gen|veo|grok|stability|leonardo/i;

type InferredShotType = "wide" | "medium" | "close_up" | "archival" | "map" | "photo" | "ai" | "fallback" | "other";

function inferShotTypeFromPath(clipPath: string, beatText = ""): InferredShotType {
  const base = path.basename(clipPath).toLowerCase();
  const combined = base + " " + beatText.toLowerCase();
  if (FALLBACK_RE.test(base)) return "fallback";
  if (AI_RE.test(base) || clipPath.includes("ai_gen")) return "ai";
  if (MAP_RE.test(combined)) return "map";
  if (PHOTO_RE.test(base) && !base.endsWith(".mp4")) return "photo";
  if (ARCHIVAL_RE.test(base)) return "archival";
  if (CLOSE_RE.test(combined)) return "close_up";
  if (WIDE_RE.test(combined)) return "wide";
  if (MEDIUM_RE.test(combined)) return "medium";
  return "other";
}

function inferVisualTypeFromPath(clipPath: string): string {
  const base = path.basename(clipPath).toLowerCase();
  const dir = clipPath.toLowerCase();
  if (FALLBACK_RE.test(base)) return "fallback";
  if (MAP_RE.test(base)) return "map";
  if (AI_RE.test(dir)) return "animation";
  if (dir.includes("pexels") || dir.includes("pixabay")) return "live_footage";
  if (dir.includes("wikimedia") || dir.includes("archive") || dir.includes("curated")) return "archive_video";
  if (PHOTO_RE.test(base) && !base.endsWith(".mp4")) return "archive_photo";
  if (ARCHIVAL_RE.test(base)) return "archive_video";
  if (WIDE_RE.test(base)) return "aerial";
  if (CLOSE_RE.test(base)) return "close_up";
  return "live_footage";
}

function mapVisualStyleToType(style: string): string {
  const s = style.toLowerCase();
  if (s === "archival" || s === "newsreel" || s === "black and white" || s === "sepia") return "archive_video";
  if (s === "illustration" || s === "map" || s === "animation") return "archive_photo";
  if (s === "drone") return "aerial";
  if (s === "documentary" || s === "modern") return "live_footage";
  return s;
}

function inferMotionLevel(clipPath: string, meta?: CandidateMeta): number | null {
  if (meta?.annotation?.motionLevel != null) return meta.annotation.motionLevel;
  const base = path.basename(clipPath).toLowerCase();
  if (FALLBACK_RE.test(base)) return 0;
  if (MAP_RE.test(base) || ARCHIVAL_RE.test(base)) return 15;
  if (AI_RE.test(clipPath.toLowerCase())) return 60;
  if (WIDE_RE.test(base)) return 50;
  if (CLOSE_RE.test(base)) return 30;
  return null;
}

// ─── Annotation fingerprint scorer (40%) ──────────────────────────────────────

type FingerprintResult = {
  /** 0–100 composite annotation score */
  score: number;
  /** 0–100 per sub-signal */
  people: number;
  objects: number;
  actions: number;
  location: number;
  era: number;
  emotion: number;
  style: number;
  knowledgeGraph: number;
};

/**
 * Scores the annotation's full editorial fingerprint against the beat text
 * and active context (entity, location, era).
 *
 * Sub-signals (each 0–100) are averaged with weights:
 *   people      25%  — named persons + categories match (entity-critical)
 *   location    20%  — country/city/region match
 *   era         15%  — year/decade/period/event match
 *   objects     15%  — physical objects in frame
 *   actions     10%  — on-screen activities
 *   emotion      8%  — mood alignment with beat energy
 *   style        4%  — visual style (archival/modern/etc.)
 *   kg           3%  — Knowledge Graph entity expansion bonus
 */
function scoreAnnotationFingerprint(
  clipPath: string,
  beatText: string,
  activeEntity: string | null | undefined,
  activeLocation: string | null | undefined,
  activeEra: string | null | undefined,
  meta?: CandidateMeta
): FingerprintResult {
  const ann = meta?.annotation;
  if (!ann) {
    // No curated-archive annotation (external provider). Match beat words against whatever
    // real, independently-authored text is available for this candidate — provider
    // title/description/tags (see CandidateMeta.providerText) first, the positional download
    // filename only as a last, much weaker resort. providerText is real evidence (the source
    // describing its own asset); the filename is usually just `scene_0_ccc_0.mp4` and rarely
    // carries content words, which is why it alone was previously only a "weak signal".
    const words = beatText.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const base = path.basename(clipPath).toLowerCase().replace(/[_.-]/g, " ");
    const providerHay = meta?.providerText
      ? [meta.providerText.title, meta.providerText.description, meta.providerText.tags]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
      : "";
    const hits = words.filter((w) => base.includes(w) || providerHay.includes(w)).length;
    // providerHay carries a higher ceiling (up to 55) than filename-only ever did (35) — it is
    // real third-party text, not a guess — but still capped well below a genuine annotation
    // match, since a title/tag mention is not proof the beat's exact claim is depicted.
    const ceiling = providerHay ? 55 : 35;
    const fallback = Math.round(25 + (words.length > 0 ? (hits / words.length) * ceiling : 0));
    return { score: fallback, people: 0, objects: 0, actions: 0, location: 0, era: 0, emotion: 0, style: 0, knowledgeGraph: 0 };
  }

  const beatLower = beatText.toLowerCase();
  const beatWords = beatLower.split(/\s+/).filter((w) => w.length > 2);

  // ── People (25%) ──────────────────────────────────────────────────────────
  const entityTokens = (activeEntity ?? "").toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const namedLower = ann.persons.named.map((p) => p.toLowerCase());
  const catLower   = ann.persons.categories.map((c) => c.toLowerCase());

  let people = 50; // neutral when no entity context
  if (entityTokens.length > 0) {
    const namedMatch = entityTokens.filter((t) => namedLower.some((p) => p.includes(t))).length;
    if (namedMatch === entityTokens.length) people = 100; // perfect named match
    else if (namedMatch > 0) people = 75;
    else if (catLower.some((c) => beatWords.some((w) => c.includes(w)))) people = 55;
    else if (namedLower.length > 0 || catLower.length > 0) people = 20; // annotation has people but wrong person
    else people = 40;
  } else if (namedLower.length > 0) {
    // No specific entity expected — any named person in beat text is a bonus
    const beatMatch = namedLower.some((p) => beatWords.some((w) => p.includes(w)));
    people = beatMatch ? 80 : 55;
  }

  // ── Objects (15%) ─────────────────────────────────────────────────────────
  const objectsLower = ann.objects.map((o) => o.toLowerCase());
  const objectHits = beatWords.filter((w) => objectsLower.some((o) => o.includes(w) || w.includes(o))).length;
  const objects = objectsLower.length === 0 ? 50
    : Math.round(40 + Math.min(60, (objectHits / Math.max(1, objectsLower.length)) * 80));

  // ── Actions (10%) ─────────────────────────────────────────────────────────
  const actionsLower = ann.actions.map((a) => a.toLowerCase());
  const actionHits = beatWords.filter((w) => actionsLower.some((a) => a.includes(w) || w.includes(a))).length;
  const actions = actionsLower.length === 0 ? 50
    : Math.round(40 + Math.min(60, (actionHits / Math.max(1, actionsLower.length)) * 80));

  // ── Location (20%) ────────────────────────────────────────────────────────
  const locFields = [
    ann.location.continent, ann.location.country, ann.location.region, ann.location.city,
    ann.environment.setting,
  ].join(" ").toLowerCase();

  let location = 50;
  if (activeLocation) {
    const locTokens = activeLocation.toLowerCase().split(/[\s,]+/).filter((t) => t.length > 2);
    const locMatch = locTokens.filter((t) => locFields.includes(t)).length;
    if (locMatch === locTokens.length) location = 100;
    else if (locMatch > 0) location = 75;
    else if (ann.location.confidence === "high" || ann.location.confidence === "medium") location = 20;
    else location = 50;
  } else {
    // No active location — check if beat words mention the clip's location
    const beatLocHit = beatWords.some((w) => locFields.includes(w));
    location = beatLocHit ? 80 : 55;
  }

  // ── Era / historical context (15%) ────────────────────────────────────────
  const eraFields = [
    ann.historicalContext.event, ann.historicalContext.period,
    ann.historicalContext.year, ann.historicalContext.decade,
    ann.historicalContext.century,
  ].join(" ").toLowerCase();

  let era = 50;
  if (activeEra) {
    const eraTokens = activeEra.toLowerCase().split(/[\s,]+/).filter((t) => t.length > 2);
    const eraMatch = eraTokens.filter((t) => eraFields.includes(t)).length;
    if (eraMatch === eraTokens.length) era = 100;
    else {
      const decade = activeEra.replace(/\d$/, "0");
      era = eraFields.includes(decade) ? 75
          : (ann.historicalContext.year || ann.historicalContext.decade) ? 25
          : 50;
    }
  } else {
    const beatEraHit = beatWords.some((w) => eraFields.includes(w));
    era = beatEraHit ? 80 : 55;
  }

  // ── Emotion (8%) ──────────────────────────────────────────────────────────
  const emotionMap: Record<string, string[]> = {
    tension:  ["war", "battle", "attack", "crisis", "fight", "conflict", "bomb", "threat"],
    triumph:  ["victory", "won", "won", "success", "liberated", "achievement", "celebrate"],
    grief:    ["death", "funeral", "mourning", "loss", "tragedy", "killed", "victims"],
    hope:     ["peace", "recovery", "rebuilt", "new", "future", "opportunity", "free"],
    fear:     ["fled", "panic", "refugee", "escape", "hiding", "danger"],
    chaos:    ["explosion", "destruction", "ruins", "crowd", "protest", "revolution"],
    pride:    ["flag", "independence", "national", "honour", "ceremony"],
    calm:     ["meeting", "diplomatic", "signed", "negotiation", "agreement"],
  };
  const clipEmotion = ann.emotion.toLowerCase();
  let emotion = 55; // neutral default
  for (const [em, keywords] of Object.entries(emotionMap)) {
    if (em === clipEmotion && keywords.some((kw) => beatLower.includes(kw))) {
      emotion = 100;
      break;
    }
  }
  // Opposite emotions are a mild penalty
  const opposites: Record<string, string> = { triumph: "grief", grief: "triumph", hope: "fear", fear: "hope", calm: "chaos", chaos: "calm" };
  if (opposites[clipEmotion] && (emotionMap[opposites[clipEmotion]] ?? []).some((kw) => beatLower.includes(kw))) {
    emotion = Math.min(emotion, 30);
  }

  // ── Visual style (4%) ─────────────────────────────────────────────────────
  const vs = ann.cinematography.visualStyle.toLowerCase();
  const isHistorical = beatLower.includes("war") || beatLower.includes("histor") || beatLower.includes("ancient") || (activeEra && parseInt(activeEra) < 1990);
  const style = (vs === "archival" || vs === "newsreel" || vs === "black and white") && isHistorical ? 90
    : (vs === "documentary" || vs === "modern") && !isHistorical ? 85
    : 55;

  // ── Knowledge Graph bonus (3%) ─────────────────────────────────────────────
  const entityForKg = [activeEntity ?? "", beatText].join(" ");
  const kgExpanded = expandWithKnowledgeGraph(entityForKg);
  const kgDoc = [
    ...ann.persons.named, ...ann.objects, ...ann.actions,
    ann.historicalContext.event, ann.historicalContext.period, ann.historicalContext.year,
    ann.location.country, ann.location.city, ...ann.usageHints.topicAffinity,
  ].join(" ").toLowerCase();

  let kgHits = 0;
  for (const term of Array.from(kgExpanded)) {
    if (kgDoc.includes(term)) kgHits++;
  }
  const knowledgeGraph = kgExpanded.size <= 3 ? 50
    : Math.round(40 + Math.min(60, (kgHits / Math.min(kgExpanded.size, 8)) * 80));

  // ── Composite annotation score ────────────────────────────────────────────
  const score = Math.round(
    people     * 0.25 +
    location   * 0.20 +
    era        * 0.15 +
    objects    * 0.15 +
    actions    * 0.10 +
    emotion    * 0.08 +
    style      * 0.04 +
    knowledgeGraph * 0.03
  );

  return { score, people, objects, actions, location, era, emotion, style, knowledgeGraph };
}

// ─── Embedding scorer (25%) ───────────────────────────────────────────────────

function scoreEmbedding(meta?: CandidateMeta): number {
  const sim = meta?.embeddingSimilarity;
  if (sim == null) return 50; // unknown — neutral
  // Cosine similarity 0–1 → score 0–100 with non-linear scaling
  // sim 0.90+ → score ~100, sim 0.50 → score ~50, sim <0.30 → score ~20
  if (sim >= 0.90) return 100;
  if (sim >= 0.75) return Math.round(75 + (sim - 0.75) / 0.15 * 25);
  if (sim >= 0.50) return Math.round(50 + (sim - 0.50) / 0.25 * 25);
  if (sim >= 0.30) return Math.round(20 + (sim - 0.30) / 0.20 * 30);
  return Math.round(sim / 0.30 * 20);
}

// ─── Editorial scorer (15%) ───────────────────────────────────────────────────

function scoreEditorial(meta?: CandidateMeta): { score: number; quality: number; storyPotential: number } {
  const ann = meta?.annotation;
  if (!ann) {
    const direct = meta?.editorialScore;
    return { score: direct ?? 50, quality: 50, storyPotential: 50 };
  }
  const es = ann.editorialScore;
  // Weighted sub-mix: story potential + emotional value matter most for documentary
  const score = Math.round(
    es.total                * 0.40 +
    es.storytellingPotential * 0.20 +
    es.emotionalValue        * 0.15 +
    es.historicalUsability   * 0.15 +
    es.cinematicQuality      * 0.10
  );
  const quality = Math.round(
    ann.quality.overall   * 0.40 +
    ann.quality.sharpness * 0.25 +
    ann.quality.stability * 0.20 +
    ann.quality.exposure  * 0.15
  );
  // Blend editorial total with quality as a minimum floor
  const finalScore = Math.round(score * 0.75 + quality * 0.25);
  return { score: finalScore, quality, storyPotential: es.storytellingPotential };
}

// ─── Shot variety + editorial memory scorer (10%) ─────────────────────────────

function scoreShotVariety(
  clipPath: string,
  beatText: string,
  sceneAdoptedClips: string[],
  meta?: CandidateMeta,
  plannedShotType?: string | null,
  editorialMemory?: SceneStyleMemory | null
): { score: number; shotType: string } {
  const shotType = meta?.annotation?.cinematography?.shotType
    ?? inferShotTypeFromPath(clipPath, beatText);

  // Consecutive penalty
  let consecutive = 0;
  for (let i = sceneAdoptedClips.length - 1; i >= 0; i--) {
    const prevType = inferShotTypeFromPath(sceneAdoptedClips[i]!, beatText);
    if (prevType === shotType) consecutive++;
    else break;
  }

  // Base variety score
  let varietyScore: number;
  if (consecutive === 0) varietyScore = 100;
  else if (consecutive === 1) varietyScore = 70;
  else if (consecutive === 2) varietyScore = 40;
  else varietyScore = 10;

  // Planned shot type match: overrides 1 level of penalty
  if (plannedShotType) {
    const planned = plannedShotType.toLowerCase();
    if (shotType.toLowerCase().includes(planned.split(" ")[0]!)) {
      varietyScore = Math.min(100, varietyScore + 25);
    }
  }

  // Editorial memory: bonus for continuing the previous scene's dominant style
  if (editorialMemory) {
    const memStyle = editorialMemory.dominantVisualStyle.toLowerCase();
    const clipStyle = (meta?.annotation?.cinematography?.visualStyle ?? "").toLowerCase();
    if (memStyle && clipStyle && (memStyle === clipStyle || clipStyle.includes(memStyle) || memStyle.includes(clipStyle))) {
      varietyScore = Math.min(100, varietyScore + 15);
    }
  }

  return { score: Math.max(0, Math.min(100, varietyScore)), shotType };
}

// ─── Blueprint scorer (10%) ───────────────────────────────────────────────────

function scoreBlueprint(
  clipPath: string,
  directive: BeatVisualDirective | null,
  sceneIndex: number,
  beatText: string,
  blueprint: VideoBlueprint | null | undefined,
  meta?: CandidateMeta
): number {
  if (!directive && !blueprint) return 50;

  let score = 50;

  // Visual type match
  if (directive) {
    const inferred = meta?.annotation?.cinematography?.visualStyle
      ? mapVisualStyleToType(meta.annotation.cinematography.visualStyle)
      : inferVisualTypeFromPath(clipPath);
    if (inferred === directive.visualType) score = 100;
    else {
      const CLOSE_FAMILY: Record<string, string[]> = {
        archive_video: ["archive_photo", "archival"],
        archive_photo: ["archive_video"],
        live_footage:  ["aerial", "close_up"],
        aerial:        ["live_footage", "wide"],
        close_up:      ["live_footage"],
      };
      if ((CLOSE_FAMILY[directive.visualType] ?? []).includes(inferred)) score = 70;
      else score = 25;
    }
  }

  // Callback support
  if (blueprint && blueprint.visualCallbacks.length > 0) {
    const combined = (path.basename(clipPath) + " " + beatText).toLowerCase();
    for (const cb of blueprint.visualCallbacks) {
      if (!cb.sceneIndices.includes(sceneIndex)) continue;
      const motifTokens = cb.motif.toLowerCase().split(/\s+/);
      if (motifTokens.some((t) => combined.includes(t))) {
        score = Math.min(100, score + 20);
        break;
      }
    }
  }

  return Math.min(100, score);
}

// ─── Diversity modifier ───────────────────────────────────────────────────────

function computeDiversityModifier(clipPath: string, usedCategories: Map<string, number>): number {
  const category = inferShotTypeFromPath(clipPath);
  const catUsed = usedCategories.get(category) ?? 0;
  if (catUsed === 0) return 8;
  if (catUsed === 1) return 4;
  if (catUsed === 2) return 0;
  if (catUsed <= 4) return -5;
  return -12;
}

// ─── Budget penalty ───────────────────────────────────────────────────────────

function computeBudgetPenalty(clipPath: string, tracker: VisualBudgetTracker | null | undefined): number {
  if (!tracker) return 0;
  const vt = inferVisualTypeFromPath(clipPath) as Parameters<typeof isBudgetExceeded>[1];
  return isBudgetExceeded(tracker, vt) ? -30 : 0;
}

// ─── Editorial memory bonus ───────────────────────────────────────────────────

function computeEditorialMemoryBonus(
  clipPath: string,
  meta?: CandidateMeta,
  editorialMemory?: SceneStyleMemory | null
): number {
  if (!editorialMemory || !meta?.annotation) return 0;
  const ann = meta.annotation;
  let bonus = 0;

  // Same dominant people → strong continuity
  const clipPeople = ann.persons.named.map((p) => p.toLowerCase());
  const prevPeople = editorialMemory.dominantPeople.map((p) => p.toLowerCase());
  if (prevPeople.length > 0 && clipPeople.some((cp) => prevPeople.some((pp) => pp.includes(cp) || cp.includes(pp)))) {
    bonus += 6;
  }

  // Same location continuity
  const clipLoc = [ann.location.country, ann.location.city].join(" ").toLowerCase();
  if (editorialMemory.dominantLocation && clipLoc.includes(editorialMemory.dominantLocation.toLowerCase())) {
    bonus += 4;
  }

  // Same era
  const clipEra = [ann.historicalContext.decade, ann.historicalContext.period].join(" ").toLowerCase();
  if (editorialMemory.dominantEra && clipEra.includes(editorialMemory.dominantEra.toLowerCase())) {
    bonus += 4;
  }

  return Math.min(10, bonus);
}

// ─── Weights ──────────────────────────────────────────────────────────────────

const WEIGHTS = {
  annotation:  0.40,
  embedding:   0.25,
  editorial:   0.15,
  shotVariety: 0.10,
  blueprint:   0.10,
};

// ─── Main scorer ──────────────────────────────────────────────────────────────

function scoreCandidate(
  clipPath: string,
  beatText: string,
  sceneIndex: number,
  beatIndex: number,
  ctx: AssetDirectorContext,
  directive: BeatVisualDirective | null,
  meta?: CandidateMeta
): AssetScore {
  const reasons: string[] = [];

  // ── 1. Annotation fingerprint (40%) ──────────────────────────────────────
  const fp = scoreAnnotationFingerprint(
    clipPath, beatText, ctx.activeEntity, ctx.activeLocation, ctx.activeEra, meta
  );

  // ── 2. Embedding similarity (25%) ────────────────────────────────────────
  const embedding = scoreEmbedding(meta);

  // ── 3. Editorial score (15%) ──────────────────────────────────────────────
  const { score: editorial, quality: editorialQuality, storyPotential: editorialStoryPotential } = scoreEditorial(meta);

  // ── 4. Shot variety + continuity (10%) ────────────────────────────────────
  const { score: shotVariety, shotType } = scoreShotVariety(
    clipPath, beatText, ctx.sceneAdoptedClips, meta, ctx.plannedShotType, ctx.editorialMemory
  );

  // ── 5. Blueprint (10%) ────────────────────────────────────────────────────
  const blueprint = scoreBlueprint(clipPath, directive, sceneIndex, beatText, ctx.blueprint, meta);

  // ── Flat modifiers ────────────────────────────────────────────────────────
  const diversityModifier   = computeDiversityModifier(clipPath, ctx.usedCategories);
  const budgetPenalty       = computeBudgetPenalty(clipPath, ctx.budgetTracker);
  const editorialMemoryBonus = computeEditorialMemoryBonus(clipPath, meta, ctx.editorialMemory);

  // ── v4/v6/v7 Archive Metadata + Editorial Capability + Temporal bonuses ──
  const beatDecomposition = editorialIntentEnabled() ? decomposeQueryBeat(beatText) : undefined;
  const v4: ArchiveMetadataScores = computeArchiveMetadataScores(
    meta?.annotation,
    beatText,
    ctx.activeEntity,
    meta?.embeddingSimilarity,
    meta?.segmentSimilarities ?? [],
    ctx.expectedAudioTypes,
    ctx.expectedCinematicTags,
    beatDecomposition,
    ctx.beatDurationSec
  );

  // ── Retrieval contract scoring (Documentary Planning Engine) ─────────────
  let contractBonus = 0;
  let contractPenalty = 0;
  let contractExplanation = "";
  if (documentaryPlanningEnabled() && ctx.retrievalContract) {
    const ann = meta?.annotation;
    const cs = scoreRetrievalContract(
      ctx.retrievalContract,
      ann?.persons?.named,
      ann?.objects,
      ann?.cinematicTags,
      ann?.emotion
    );
    contractBonus = cs.bonus;
    contractPenalty = cs.penalty;
    contractExplanation = cs.explanation;
  }

  // ── Weighted sum ──────────────────────────────────────────────────────────
  const weighted =
    fp.score   * WEIGHTS.annotation +
    embedding  * WEIGHTS.embedding  +
    editorial  * WEIGHTS.editorial  +
    shotVariety * WEIGHTS.shotVariety +
    blueprint  * WEIGHTS.blueprint;

  const finalScore = Math.max(0, Math.min(100, Math.round(
    weighted + diversityModifier + budgetPenalty + editorialMemoryBonus + v4.total + contractBonus + contractPenalty
  )));

  // ── Reasons ───────────────────────────────────────────────────────────────
  if (fp.people >= 90)       reasons.push(`person match "${ctx.activeEntity ?? ""}"`);
  if (fp.location >= 90)     reasons.push(`location match "${ctx.activeLocation ?? ""}"`);
  if (fp.era >= 90)          reasons.push(`era match "${ctx.activeEra ?? ""}"`);
  if (fp.knowledgeGraph >= 80) reasons.push("Knowledge Graph chain hit");
  if (embedding >= 85)       reasons.push(`strong embedding sim (${meta?.embeddingSimilarity?.toFixed(2) ?? "n/a"})`);
  if (editorial >= 80)       reasons.push(`high editorial score (${editorial})`);
  if (shotVariety >= 95)     reasons.push("introduces new shot type");
  if (blueprint >= 90)       reasons.push(`matches blueprint type`);
  if (editorialMemoryBonus >= 6) reasons.push("continues previous scene style");
  if (ctx.plannedShotType && shotType.includes(ctx.plannedShotType.split(" ")[0]!)) {
    reasons.push(`matches planned shot: ${ctx.plannedShotType}`);
  }
  if (budgetPenalty < 0)      reasons.push("⚠ visual type over budget");
  if (v4.segmentBonus >= 4)   reasons.push(`segment match +${v4.segmentBonus} (best seg sim ${v4.bestSegment?.similarity.toFixed(2) ?? "?"})`);
  if (v4.faceBonus >= 4)      reasons.push(`face dominant +${v4.faceBonus}`);
  if (v4.audioBonus >= 3)     reasons.push(`audio match +${v4.audioBonus}`);
  if (v4.cinematicBonus >= 4) reasons.push(`cinematic tags +${v4.cinematicBonus}`);
  if (v4.importanceBonus >= 4) {
    const imp = meta?.annotation?.shotImportance;
    reasons.push(`iconic shot [${imp?.label ?? ""}] +${v4.importanceBonus}`);
  }

  return {
    finalScore,
    breakdown: {
      annotation: fp.score,
      embedding,
      editorial,
      shotVariety,
      blueprint,
      people: fp.people,
      objects: fp.objects,
      actions: fp.actions,
      location: fp.location,
      era: fp.era,
      emotion: fp.emotion,
      style: fp.style,
      knowledgeGraph: fp.knowledgeGraph,
      editorialQuality,
      editorialStoryPotential,
      diversityModifier,
      budgetPenalty,
      editorialMemoryBonus,
      segmentBonus:     v4.segmentBonus,
      faceBonus:        v4.faceBonus,
      objectBonus:      v4.objectBonus,
      audioBonus:       v4.audioBonus,
      cinematicBonus:   v4.cinematicBonus,
      importanceBonus:  v4.importanceBonus,
      uniquenessBonus:  v4.uniquenessBonus,
      storytellingBonus:     v4.storytellingBonus,
      qualityBonus:          v4.qualityBonus,
      healthBonus:           v4.healthBonus,
      primarySubjectBonus:   v4.primarySubjectBonus,
      retrievalPriorityBonus: v4.retrievalPriorityBonus,
      negativeTagsPenalty:   v4.negativeTagsPenalty,
      capabilityBonus:       v4.capabilityBonus,
      capabilityPenalty:     v4.capabilityPenalty,
      temporalBonus:         v4.temporalBonus,
      contractBonus,
      contractPenalty,
      v4Total:               v4.total + contractBonus + contractPenalty,
      bestSegment:      v4.bestSegment,
    },
    reasons,
  };
}

// ─── Explainability logger ─────────────────────────────────────────────────────

/**
 * Emits a full per-beat clip-choice explanation to stdout.
 * Format example:
 *
 *   [AssetDirector] s3b7 "Churchill delivers speech to Parliament" → churchill_1940.mp4
 *     Annotation:   78  (40%) — People:95 Objects:72 Location:88 Era:91 Emotion:80 KG:85
 *     Embedding:    82  (25%) — sim: 0.86
 *     Editorial:    71  (15%) — quality:68 story:74
 *     ShotVariety:  90  (10%) — close-up, planned match
 *     Blueprint:    85  (10%) — archive_video
 *     ─ Diversity: +4  Budget: 0  Memory: +6
 *     ─ Final: 82  (People match "Churchill", era match "1940", KG hit, continues style)
 */
export function logAssetDirectorChoice(
  clipPath: string,
  sceneIndex: number,
  beatIndex: number,
  beatText: string,
  score: AssetScore,
  annotation?: import("../drizzle/annotationTypes").ClipAnnotation | null
): void {
  const bk = score.breakdown;
  const base = path.basename(clipPath);
  const pct = (w: number) => `(${Math.round(w * 100)}%)`;

  const annDetail = `People:${bk.people} Objects:${bk.objects} Actions:${bk.actions} Loc:${bk.location} Era:${bk.era} Emotion:${bk.emotion} Style:${bk.style} KG:${bk.knowledgeGraph}`;
  const embDetail = bk.embedding === 50 ? "no embedding" : `sim scored ${bk.embedding}`;
  const editDetail = `quality:${bk.editorialQuality} story:${bk.editorialStoryPotential}`;
  const modifiers = `Diversity:${bk.diversityModifier >= 0 ? "+" : ""}${bk.diversityModifier}  Budget:${bk.budgetPenalty}  Memory:+${bk.editorialMemoryBonus}`;
  const reasonStr = score.reasons.length ? `  (${score.reasons.join(", ")})` : "";
  const v4Detail = bk.v4Total !== 0
    ? `seg:+${bk.segmentBonus} face:+${bk.faceBonus} obj:+${bk.objectBonus} audio:+${bk.audioBonus} cine:+${bk.cinematicBonus} imp:+${bk.importanceBonus} uniq:+${bk.uniquenessBonus} story:+${bk.storytellingBonus} qual:+${bk.qualityBonus} health:+${bk.healthBonus} subj:+${bk.primarySubjectBonus} prio:+${bk.retrievalPriorityBonus} neg:${bk.negativeTagsPenalty} cap:+${bk.capabilityBonus}/${bk.capabilityPenalty} temp:+${bk.temporalBonus} contract:+${bk.contractBonus}/${bk.contractPenalty} → ${bk.v4Total >= 0 ? "+" : ""}${bk.v4Total}`
    : "no v4/v5/v6/v7/plan bonus";

  console.log(
    `[AssetDirector] s${sceneIndex}b${beatIndex} "${beatText.slice(0, 50)}" → ${base}\n` +
    `  Annotation:  ${bk.annotation.toString().padEnd(4)} ${pct(WEIGHTS.annotation)} — ${annDetail}\n` +
    `  Embedding:   ${bk.embedding.toString().padEnd(4)} ${pct(WEIGHTS.embedding)} — ${embDetail}\n` +
    `  Editorial:   ${bk.editorial.toString().padEnd(4)} ${pct(WEIGHTS.editorial)} — ${editDetail}\n` +
    `  ShotVariety: ${bk.shotVariety.toString().padEnd(4)} ${pct(WEIGHTS.shotVariety)}\n` +
    `  Blueprint:   ${bk.blueprint.toString().padEnd(4)} ${pct(WEIGHTS.blueprint)}\n` +
    `  ─ ${modifiers}\n` +
    `  ─ v4 Metadata: ${v4Detail}\n` +
    `  ─ Final: ${score.finalScore}${reasonStr}`
  );

  if (editorialIntentEnabled() && annotation?.editorialIntent) {
    const decomposition = decomposeQueryBeat(beatText);
    logEditorialIntentChoice(
      clipPath,
      annotation.editorialIntent,
      decomposition,
      score.breakdown.capabilityBonus,
      score.breakdown.capabilityPenalty,
      ""
    );
  }
}

// ─── recordAdoptedClip ────────────────────────────────────────────────────────

export function recordAdoptedClip(clipPath: string, ctx: AssetDirectorContext): void {
  if (ctx.budgetTracker) {
    const vt = inferVisualTypeFromPath(clipPath) as Parameters<typeof recordBudgetUsage>[1];
    recordBudgetUsage(ctx.budgetTracker, vt);
  }
  const category = inferShotTypeFromPath(clipPath);
  ctx.usedCategories.set(category, (ctx.usedCategories.get(category) ?? 0) + 1);
}

// ─── buildSceneStyleMemory ────────────────────────────────────────────────────

/**
 * Extracts editorial style memory from the clips adopted in a just-completed scene.
 * Call this at the end of each scene compose loop and store the result in
 * dedup.editorialMemory so the next scene's AssetDirector can use it.
 */
export function buildSceneStyleMemory(
  adoptedClipPaths: string[],
  candidateMeta: Map<string, CandidateMeta>
): SceneStyleMemory {
  const allPeople: string[] = [];
  const allLocations: string[] = [];
  const allEras: string[] = [];
  const allStyles: string[] = [];
  const allShotTypes: string[] = [];
  const allEmotions: string[] = [];

  for (const clipPath of adoptedClipPaths) {
    const meta = candidateMeta.get(clipPath);
    const ann = meta?.annotation;
    if (!ann) continue;
    allPeople.push(...ann.persons.named);
    allLocations.push(ann.location.city || ann.location.country);
    allEras.push(ann.historicalContext.decade || ann.historicalContext.period);
    allStyles.push(ann.cinematography.visualStyle);
    allShotTypes.push(ann.cinematography.shotType);
    allEmotions.push(ann.emotion);
  }

  const mostCommon = (arr: string[]): string => {
    const counts: Record<string, number> = {};
    for (const s of arr) if (s) counts[s] = (counts[s] ?? 0) + 1;
    let best = "";
    let bestCount = 0;
    for (const [k, v] of Object.entries(counts)) if (v > bestCount) { best = k; bestCount = v; }
    return best;
  };

  const uniquePeople = Array.from(new Set(allPeople.filter(Boolean))).slice(0, 3);

  return {
    dominantPeople: uniquePeople,
    dominantLocation: mostCommon(allLocations),
    dominantEra: mostCommon(allEras),
    dominantVisualStyle: mostCommon(allStyles),
    dominantShotTypes: Array.from(new Set(allShotTypes.filter(Boolean))).slice(0, 3),
    dominantEmotion: mostCommon(allEmotions),
  };
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Re-ranks candidate clip paths using full editorial context.
 *
 * Weights: annotation 40% · embedding 25% · editorial 15% · shotVariety 10% · blueprint 10%
 */
export function rankCandidatesWithContext(
  candidatePaths: string[],
  beatText: string,
  sceneIndex: number,
  beatIndex: number,
  ctx: AssetDirectorContext,
  candidateMeta?: Map<string, CandidateMeta>
): AssetDirectorResult {
  if (!assetDirectorEnabled() || candidatePaths.length <= 1) {
    return { rankedPaths: candidatePaths, topScore: null, reordered: false };
  }

  const directive = getBlueprintDirective(ctx.blueprint, sceneIndex, beatIndex);

  const scored = candidatePaths.map((p) => ({
    path: p,
    score: scoreCandidate(p, beatText, sceneIndex, beatIndex, ctx, directive, candidateMeta?.get(p)),
  }));

  scored.sort((a, b) => b.score.finalScore - a.score.finalScore);

  const reordered = candidatePaths[0] !== scored[0]!.path;

  // Build trim hints for candidates that have a better-matching segment
  const trimHints = new Map<string, TrimHint>();
  if (archiveV4ScoringEnabled()) {
    for (const { path: p, score } of scored) {
      const meta = candidateMeta?.get(p);
      const hint = computeTrimHint(
        score.breakdown.bestSegment ?? null,
        meta?.embeddingSimilarity ?? 0,
        meta?.annotation,
        ctx.beatDurationSec
      );
      if (hint) trimHints.set(p, hint);
    }
  }

  return {
    rankedPaths: scored.map((s) => s.path),
    topScore: scored[0]!.score,
    reordered,
    trimHints: trimHints.size > 0 ? trimHints : undefined,
  };
}
