/**
 * ClipAnnotation — the full editorial profile of one archive asset.
 * Stored as JSON in media_archive_assets.annotationJson.
 * Version-stamped so a schema change triggers re-annotation.
 *
 * v1: initial fields
 * v2: searchAliases, knowledgeGraphEntities, editorialDescription,
 *     qualityFlags, per-field confidence, extended editorial scores,
 *     facetEmbeddingKeys
 * v3: timeline segmentation, object/face tracks, OCR, audio events,
 *     shot importance, visual uniqueness, multi-level descriptions,
 *     cinematic tags, segment-level embeddings, camera movement detail
 * v4: multi-level segmentation (scene/shot/micro_event), OCR timeline with
 *     timestamps, storytelling labels, FFmpeg quality metrics, archive-level
 *     uniqueness, asset health score, object/face track confidence + timestamps,
 *     3 new facet embeddings (ocrTimeline, audioEvents, storytelling)
 * v5: Editorial Tagging Engine — primarySubject, secondarySubjects,
 *     personDetails (role/function/nationality/confidence), emotions array,
 *     searchIntentTags (50–100 retrieval-intent terms), negativeTags,
 *     retrievalPriority (ranked use-case scores), retrievalSummary,
 *     3 new facet embeddings (searchIntent, retrievalSummary, primarySubject)
 */

// ─── Quality flags ────────────────────────────────────────────────────────────

/**
 * Automatic quality-control flags set by the Archive Intelligence Pipeline.
 * A clip with multiple flags should get a significantly lower editorial score.
 */
export type ClipQualityFlags = {
  /** Frame is predominantly black (dead frame, missing signal). */
  isBlack?: boolean;
  /** Image is blurry beyond usability. */
  isBlurry?: boolean;
  /** Visible watermark or broadcast bug detected. */
  hasWatermark?: boolean;
  /** Clip appears to be a channel/show introduction sequence. */
  isIntroOrOutro?: boolean;
  /** Clip contains rolling credits or end titles. */
  isCreditSequence?: boolean;
  /** Clip is dominated by an on-screen title card or slate. */
  hasTitleCard?: boolean;
  /** Clip is near-identical to another asset (assetId of original). */
  nearDuplicateOf?: number | null;
  /** Clip is a test pattern, colour bars, or technical leader. */
  isTestPattern?: boolean;
};

// ─── Per-field confidence ─────────────────────────────────────────────────────

/** 0–1 confidence per annotation domain. */
export type AnnotationConfidence = {
  persons: number;
  location: number;
  historicalContext: number;
  objects: number;
  emotion: number;
};

// ─── Extended editorial scores ────────────────────────────────────────────────

/** v2 additions to the editorial score block. */
export type ExtendedEditorialScores = {
  /** How significant is this clip for news/current events reporting? */
  newsValue: number;
  /** How well suited is this clip for long-form documentary use? */
  documentaryValue: number;
  /** 0–100 trust score derived from source provenance. */
  sourceQualityScore: number;
  /** How easily can this clip be repurposed for different productions? */
  reusabilityScore: number;
};

// ─── Person detail (v5) ──────────────────────────────────────────────────────

/**
 * Rich person record beyond a simple name string.
 * Populates the `personDetails` array in ClipAnnotation (v5).
 */
export type PersonDetail = {
  /** Full name, e.g. "Winston Churchill". */
  name: string;
  /** Role/title at the time of footage, e.g. "Prime Minister", "General". */
  role?: string;
  /** Functional domain, e.g. "politician", "military officer", "scientist". */
  function?: string;
  /** Nationality / country, e.g. "United Kingdom", "United States". */
  nationality?: string;
  /** Identification confidence 0–1. 1.0 = name on screen; 0.5 = probable. */
  confidence: number;
};

// ─── Retrieval priority entry (v5) ───────────────────────────────────────────

/**
 * Ranked use-case score: how well-suited is this clip for a given topic/genre?
 * Allows retrieval to surface the best clips for each documentary angle.
 */
export type RetrievalPriorityEntry = {
  /** Topic or genre, e.g. "Churchill biography", "WWII documentary", "Cold War". */
  topic: string;
  /** Suitability score 0–100. 100 = perfect; 0 = wrong clip entirely. */
  score: number;
};

// ─── Facet embedding keys ─────────────────────────────────────────────────────

/**
 * Storage keys for per-facet text embeddings generated during ingestion.
 * Each key points to a JSON file in the archive-clip-embeddings directory.
 * Enables facet-specific semantic retrieval (search by persons only, etc.).
 */
export type FacetEmbeddingKeys = {
  /** Full editorial description embedding. */
  description?: string;
  /** Persons-only embedding. */
  persons?: string;
  /** Location-only embedding. */
  location?: string;
  /** Objects-only embedding. */
  objects?: string;
  /** Historical context / events embedding. */
  events?: string;
  /** Emotion / atmosphere embedding. */
  emotions?: string;
  /** Camera style / cinematography embedding. */
  style?: string;
  // ── v4 additional facets ────────────────────────────────────────────────────
  /** OCR text timeline embedding (all on-screen text combined). */
  ocrTimeline?: string;
  /** Audio events embedding (event types + timestamps). */
  audioEvents?: string;
  /** Storytelling labels embedding (primary + secondary functions). */
  storytelling?: string;
  // ── v5 editorial tagging facets ─────────────────────────────────────────────
  /** Search intent tags embedding (50-100 alternative retrieval terms). */
  searchIntent?: string;
  /** Retrieval summary embedding (~100-word editorial summary for retrieval). */
  retrievalSummary?: string;
  /** Primary subject embedding (single most important subject). */
  primarySubject?: string;
};

// ─── OCR timeline entry ───────────────────────────────────────────────────────

/**
 * A block of text detected on-screen with its temporal position.
 * Replaces the flat `ocrText: string[]` with a time-indexed alternative.
 */
export type OcrEntry = {
  /** The text string detected on screen. */
  text: string;
  /** Time (seconds from clip start) when this text first appears. */
  startSec: number;
  /** Time (seconds from clip start) when this text disappears. */
  endSec: number;
  /** Classification of what kind of text this is. */
  type?: "subtitle" | "title" | "map_label" | "document" | "sign" | "date_overlay" | "other";
};

// ─── Segment level & micro events ─────────────────────────────────────────────

/**
 * Granularity level of a timeline segment.
 * scene: major visual cut (new scene).
 * shot: camera-angle or composition change within a scene.
 * micro_event: notable action within a single shot.
 */
export type SegmentLevel = "scene" | "shot" | "micro_event";

/**
 * Recognized micro-event types detectable within a single shot.
 * Used by retrieval to find the exact visual moment.
 */
export type MicroEventType =
  | "speech_start"
  | "explosion"
  | "flag_appears"
  | "vehicle_enters"
  | "aircraft_takeoff"
  | "handshake"
  | "applause"
  | "door_opens"
  | "person_turns"
  | "crowd_reaction"
  | "title_card_appears"
  | "map_appears"
  | "document_shown"
  | "shot_fired"
  | "fire_appears"
  | "smoke_appears"
  | "crowd_disperses"
  | "other";

// ─── Storytelling labels ──────────────────────────────────────────────────────

/**
 * Primary editorial function of a clip in a documentary narrative.
 * Each clip has exactly one primary function; up to three secondary functions.
 */
export type StorytellingFunction =
  | "establishing"
  | "context"
  | "action"
  | "transition"
  | "reaction"
  | "emotion"
  | "detail"
  | "reveal"
  | "climax"
  | "ending";

export type StorytellingLabels = {
  /** The primary editorial function this clip serves best. */
  primary: StorytellingFunction;
  /** Up to three secondary editorial functions. */
  secondary?: StorytellingFunction[];
};

// ─── Clip quality metrics (FFmpeg-derived) ────────────────────────────────────

/**
 * Objective technical quality metrics computed from the actual video file
 * via FFmpeg signalstats + ffprobe. All values 0–100 (higher = better)
 * unless noted otherwise.
 */
export type ClipQualityMetrics = {
  /** Signal sharpness / detail level. 100 = razor-sharp; <30 = blurry. */
  sharpnessScore?: number;
  /** Motion blur amount. 0 = sharp action; 100 = heavy blur. Inverse: prefer 0. */
  motionBlurScore?: number;
  /** Compression quality. 100 = pristine; <30 = heavy artifacts. */
  compressionScore?: number;
  /** Noise level. 0 = clean; 100 = very noisy. Inverse: prefer 0. */
  noiseScore?: number;
  /** Exposure quality. 50 = perfect; 0 = severely underexposed; 100 = overexposed. */
  exposureScore?: number;
  /** Contrast quality. 100 = strong contrast; <20 = washed-out or flat. */
  contrastScore?: number;
  /** Stability. 100 = tripod-steady; <20 = very shaky. */
  stabilityScore?: number;
  /** Human-readable resolution: "4K", "1080p", "720p", "SD", "unknown". */
  resolutionLabel?: string;
  /** Frame-rate label: "24fps", "25fps", "30fps", "50fps", "60fps", "variable". */
  fpsLabel?: string;
  /** Composite 0–100 technical quality score. */
  overallTechnicalQuality?: number;
};

// ─── Archive-level uniqueness ─────────────────────────────────────────────────

/**
 * How unique this clip is WITHIN our specific archive (not just globally).
 * Computed by comparing clip embedding against all other archive embeddings.
 * A common Churchill speech gets nearDuplicateCount > 3; a rare field recording gets 0.
 */
export type ArchiveUniqueness = {
  /** 0–100. 100 = one of a kind; 0 = many similar clips in archive. */
  score: number;
  /** How many clips in our archive have cosine similarity ≥ 0.85. */
  nearDuplicateCount: number;
  /** One-sentence reasoning. */
  reason?: string;
};

// ─── Asset health score ───────────────────────────────────────────────────────

/**
 * Composite readiness / quality score for an archive asset.
 * Computed at annotation time and updated whenever metadata changes.
 * Drives automatic de-prioritization of low-health assets during retrieval.
 */
export type AssetHealthScore = {
  /** 0–100 composite health score. */
  score: number;
  /** Fraction of annotation fields that are non-empty (0–100). */
  metadataCompleteness: number;
  /** Average of the quality sub-scores (0–100). */
  technicalQuality: number;
  /** editorial score total (0–100). */
  editorialQuality: number;
  /** Uniqueness within archive (from ArchiveUniqueness.score). */
  archiveUniqueness: number;
  /** ISO date when this score was last computed. */
  computedAt: string;
};

// ─── Timeline segment ─────────────────────────────────────────────────────────

/**
 * One temporal segment within a clip.
 * A clip of 8 s may contain 3–5 distinct visual moments.
 * Generated by the v3 multi-frame vision analysis.
 */
export type ClipSegment = {
  /** Segment start time in seconds from clip start. */
  startSec: number;
  /** Segment end time in seconds. */
  endSec: number;
  /** Shot type for this segment: wide | medium | close-up | etc. */
  shotType: string;
  /** One-sentence visual description of what happens in this segment. */
  description: string;
  /** Named persons visible in this segment. */
  persons?: string[];
  /** Key objects visible in this segment. */
  objects?: string[];
  /** Dominant emotion in this segment. */
  emotion?: string;
  /** Camera movement in this segment: static | pan | tilt | zoom | etc. */
  cameraMovement?: string;
  /** Any OCR text detected in this segment. */
  ocrText?: string;
  /** Storage key for segment-level embedding (set by pipeline). */
  embeddingKey?: string;
  /** Granularity level: "scene" (hard cut) | "shot" (angle change) | "micro_event" (action within shot). */
  level?: SegmentLevel;
  /** For micro_event segments: what specific event occurs. */
  microEventType?: MicroEventType;
};

// ─── Object track ─────────────────────────────────────────────────────────────

/**
 * Describes how a specific object moves through the clip.
 * Enables queries like "tank enters frame from left" or "person walks to camera".
 */
export type ObjectTrack = {
  /** Object identifier, e.g. "tank", "Churchill", "Spitfire aircraft". */
  object: string;
  /** Frame position at start: "left" | "center" | "right" | "top" | "bottom" | "offscreen". */
  startPosition: string;
  /** Frame position at end. */
  endPosition: string;
  /** Direction of movement, e.g. "left→right", "towards camera", "away from camera", "stationary". */
  direction: string;
  /** Descriptive movement: "enters frame left", "exits frame right", "crosses frame", "approaches camera". */
  movement: string;
  /** Time (seconds from clip start) when this object first becomes visible. */
  startSec?: number;
  /** Time (seconds from clip start) when this object exits or is last visible. */
  endSec?: number;
  /** Detection confidence 0–1. */
  confidence?: number;
};

// ─── Face track ──────────────────────────────────────────────────────────────

/**
 * Temporal presence of a specific person's face within the clip.
 * Enables precise retrieval of close-ups and dominant-subject shots.
 */
export type FaceTrack = {
  /** Full name if identified, else "unknown person". */
  name: string;
  /** Time (seconds from clip start) when the face first appears. */
  firstAppearsSec: number;
  /** Time (seconds from clip start) when the face last appears. */
  lastAppearsSec: number;
  /** Fraction of total clip duration the face is visible (0–1). */
  dominanceFraction: number;
  /** Duration in seconds where the face is at close-up scale (>50% of frame height). */
  closeUpDurationSec: number;
  /** Whether this person is the primary visual subject of the clip. */
  isPrimarySubject: boolean;
  /** Face recognition confidence 0–1. 1.0 = name on screen / unmistakable. 0.5 = likely. */
  confidence?: number;
};

// ─── Audio events ─────────────────────────────────────────────────────────────

/**
 * A detected audio event within the clip.
 * Populated by FFmpeg analysis and/or LLM inference.
 */
export type AudioEvent = {
  /**
   * Event type:
   * "applause" | "explosion" | "gunfire" | "speech" | "crowd" | "music"
   * | "silence" | "engines" | "aircraft" | "rain" | "wind" | "gejuich"
   * | "radio" | "march" | string
   */
  type: string;
  /** Approximate start time in seconds (null = throughout). */
  startSec?: number | null;
  /** Approximate duration in seconds. */
  durationSec?: number | null;
  /** Detection confidence 0–1. */
  confidence: number;
};

// ─── Shot importance ──────────────────────────────────────────────────────────

/**
 * Editorial assessment of how important / iconic this clip is.
 * Affects retrieval ranking: iconic clips are surfaced first.
 */
export type ShotImportance = {
  /** Overall importance score 0–100. 100 = Moon landing; 22 = generic skyline. */
  score: number;
  /** Qualitative label: "iconic" (90+), "unique" (70+), "rare" (50+), "generic" (<50). */
  label: "iconic" | "unique" | "rare" | "generic";
  /** One-sentence explanation of this score. */
  reason: string;
};

// ─── Multiple descriptions ────────────────────────────────────────────────────

/**
 * Three description granularities so each consumer uses the right level of detail.
 */
export type ClipDescriptions = {
  /** One sentence. For UI tooltips, search snippets, quick preview. */
  short: string;
  /** One paragraph (3–5 sentences). For standard metadata display. */
  normal: string;
  /** 150–300 words for AI consumers (AssetDirector, Documentary Taste Model). */
  extended: string;
};

// ─── Cinematic tags ──────────────────────────────────────────────────────────

/**
 * Visual and editorial tags for fine-grained retrieval and AssetDirector filtering.
 * These are free-form strings — common values are listed for consistency.
 *
 * Examples: "leading lines", "symmetry", "silhouette", "crowd shot", "aerial view",
 * "skyline", "smoke", "fire", "destruction", "celebration", "interview",
 * "establishing shot", "insert shot", "reaction shot", "cutaway", "b-roll",
 * "portrait", "propaganda", "newsreel", "action", "aftermath", "procession",
 * "ceremony", "ruins", "landscape", "battle", "documentary".
 */
export type CinematicTag = string;

// ─── Visual uniqueness ────────────────────────────────────────────────────────

/**
 * Assessment of how unique/rare this clip is relative to all known footage.
 * Scores 0–100: 100 = Moon landing (one shot ever), 22 = generic city skyline.
 */
export type VisualUniqueness = {
  /** 0–100 uniqueness score. */
  score: number;
  /** One-sentence reasoning. */
  reason: string;
};

// ─── Clip annotation (main type) ─────────────────────────────────────────────

export type ClipAnnotation = {
  /** Annotator version — bump when the prompt changes significantly */
  version: string;

  // ── Personen ──────────────────────────────────────────────────────────────
  persons: {
    /** Known named individuals, e.g. "Churchill", "Hitler", "Kennedy" */
    named: string[];
    /** Generic person categories visible in frame */
    categories: string[];
    // e.g. "soldiers", "civilians", "children", "women", "politicians",
    //      "military officers", "workers", "crowd", "protesters"
  };

  // ── Objecten ─────────────────────────────────────────────────────────────
  objects: string[];
  // e.g. "tank", "aircraft", "ship", "rifle", "flag", "helmet", "church",
  //      "factory", "bridge", "explosion", "fire", "smoke", "ruins"

  // ── Acties ───────────────────────────────────────────────────────────────
  actions: string[];
  // e.g. "marching", "shooting", "running", "speaking", "loading", "flying",
  //      "demonstrating", "cheering", "crying", "waving"

  // ── Omgeving ─────────────────────────────────────────────────────────────
  environment: {
    setting: string;
    // "city" | "village" | "forest" | "desert" | "beach" | "sea" | "sky"
    // | "indoors" | "outdoors" | "office" | "factory" | "battlefield" | "trench"
    isInterior: boolean;
    lighting: string;
    // "daylight" | "night" | "golden hour" | "artificial" | "low key"
  };

  // ── Historische context ───────────────────────────────────────────────────
  historicalContext: {
    /** Best guess at the specific event, e.g. "D-Day landings", "Berlin Wall fall" */
    event: string;
    /** Named historical period, e.g. "World War II", "Cold War", "French Revolution" */
    period: string;
    /** ISO-format if known, else approximate: "1944", "1940s", "20th century" */
    year: string;
    /** Decade, e.g. "1940s" */
    decade: string;
    /** Century, e.g. "20th century" */
    century: string;
  };

  // ── Locatie ───────────────────────────────────────────────────────────────
  location: {
    continent: string;
    country: string;
    region: string;
    city: string;
    /** Confidence: "high" | "medium" | "low" | "unknown" */
    confidence: string;
  };

  // ── Cinematografie ────────────────────────────────────────────────────────
  cinematography: {
    /**
     * "establishing" | "extreme wide" | "wide" | "medium" | "medium close-up"
     * | "close-up" | "extreme close-up"
     */
    shotType: string;
    /**
     * "static" | "handheld" | "pan" | "tilt" | "zoom" | "dolly"
     * | "crane" | "tracking" | "drone" | "orbit"
     */
    cameraMovement: string;
    /**
     * "symmetrical" | "asymmetrical" | "silhouette" | "horizon"
     * | "overhead" | "low angle" | "high angle" | "rule of thirds"
     */
    composition: string;
    /**
     * "archival" | "modern" | "black and white" | "sepia" | "drone"
     * | "illustration" | "map" | "animation" | "newsreel" | "documentary"
     */
    visualStyle: string;
  };

  // ── Emotie & sfeer ────────────────────────────────────────────────────────
  /**
   * Primary emotion conveyed:
   * "tension" | "calm" | "grief" | "triumph" | "defeat" | "fear"
   * | "chaos" | "mystery" | "hope" | "pride" | "awe" | "neutral"
   */
  emotion: string;

  // ── Bewegingsniveau ───────────────────────────────────────────────────────
  /** 0–100: 0 = completely static, 100 = maximum kinetic energy */
  motionLevel: number;

  // ── Visuele kwaliteit ─────────────────────────────────────────────────────
  quality: {
    /** 0–100 overall quality */
    overall: number;
    /** 0–100 sharpness */
    sharpness: number;
    /** 0–100 exposure quality */
    exposure: number;
    /** 0–100 stability (0 = very shaky) */
    stability: number;
    /** 0–100 (100 = pristine, 0 = heavy compression artifacts) */
    compression: number;
  };

  // ── Editorial Score ───────────────────────────────────────────────────────
  editorialScore: {
    /** Overall editorial value 0–100 */
    total: number;
    /** Historical usability: does this clip illustrate a historical moment? */
    historicalUsability: number;
    /** How cinematic/well-composed is the shot? */
    cinematicQuality: number;
    /** Storytelling potential: could this open, develop, or close a scene? */
    storytellingPotential: number;
    /** Emotional value: does it convey a clear, strong emotion? */
    emotionalValue: number;
    /** Movement quality: smooth, purposeful motion scores high */
    movementQuality: number;
    /** Originality: rare/unique content vs. generic stock footage */
    originality: number;
  };

  // ── Hergebruik-hints ─────────────────────────────────────────────────────
  usageHints: {
    /** Best used as: "establishing", "cutaway", "close detail", "transition", "title card" */
    bestUsedAs: string;
    /** Topics this clip pairs well with */
    topicAffinity: string[];
    /** Topics to avoid (e.g. graphic content, wrong era) */
    avoid: string[];
  };

  // ── v2 Archive Intelligence fields (all optional — backward compatible) ──────

  /**
   * 15–25 alternative search phrases that a retrieval system might use to find
   * this clip. Generated by LLM during ingestion.
   * Example: "Churchill speech 1940", "House of Commons wartime address", "British PM WWII"
   */
  searchAliases?: string[];

  /**
   * Flat list of Knowledge Graph entities this clip is connected to.
   * Includes the originating entity + all KG-expanded related terms.
   * Example: ["Churchill", "United Kingdom", "World War II", "1940", "RAF", "Blitz"]
   */
  knowledgeGraphEntities?: string[];

  /**
   * Full editorial description (150–300 words) written for AI consumers.
   * Covers what is visible, who is present, where/when, why it matters,
   * and how it can best be used in a documentary context.
   */
  editorialDescription?: string;

  /**
   * Automatic quality-control flags. Clips with multiple flags receive
   * a lower effective editorial score during retrieval.
   */
  qualityFlags?: ClipQualityFlags;

  /**
   * Confidence scores (0–1) per annotation domain.
   * Used by the Documentary Taste Model to down-weight uncertain annotations.
   */
  confidence?: AnnotationConfidence;

  /**
   * Extended editorial scores (v2). Added alongside the existing editorialScore.
   */
  extendedEditorialScore?: ExtendedEditorialScores;

  /**
   * Keys pointing to per-facet embedding files on disk.
   * Enables targeted semantic retrieval beyond the single full-description embedding.
   */
  facetEmbeddingKeys?: FacetEmbeddingKeys;

  // ── v3 Vision-first fields (all optional — backward compatible) ───────────────

  /**
   * Temporal breakdown of the clip into distinct visual moments.
   * Generated by multi-frame vision analysis. A 10 s clip may have 3–5 segments.
   */
  timeline?: ClipSegment[];

  /**
   * Tracked objects and their movement through the clip.
   * Enables queries like "tank enters frame from left" or "person approaches camera".
   */
  objectTracks?: ObjectTrack[];

  /**
   * Temporal presence of named/unknown faces in the clip.
   * Enables close-up retrieval and dominant-subject filtering.
   */
  faceTracks?: FaceTrack[];

  /**
   * All text strings detected via OCR across multiple frames.
   * Includes: street names, dates, subtitles, posters, newspapers, maps, credits.
   */
  ocrText?: string[];

  /**
   * Audio events detected in the clip (speech, explosions, music, applause, etc.).
   * Populated by FFmpeg analysis and LLM inference.
   */
  audioEvents?: AudioEvent[];

  /**
   * Detailed camera movement description across the clip.
   * More specific than cinematography.cameraMovement — e.g. "slow pan left then zoom in".
   */
  cameraMovementDetail?: string;

  /**
   * Editorial importance assessment: how iconic/rare/unique is this clip?
   * Affects ranking in retrieval — iconic clips are surfaced first.
   */
  shotImportance?: ShotImportance;

  /**
   * Multi-level descriptions for different consumers.
   * Short (1 sentence) → normal (1 paragraph) → extended (150–300 words for AI).
   */
  descriptions?: ClipDescriptions;

  /**
   * Visual and editorial tags for fine-grained retrieval.
   * E.g. ["leading lines", "silhouette", "aerial view", "establishing shot"].
   */
  cinematicTags?: CinematicTag[];

  /**
   * Assessment of how unique this clip is relative to all known footage.
   * 100 = Moon landing; 22 = generic city skyline. Used in ranking.
   */
  visualUniqueness?: VisualUniqueness;

  // ── v4 Archive Intelligence fields (all optional — backward compatible) ───────

  /**
   * Structured OCR timeline: each entry has the text plus the time window
   * when it was visible on screen. Supersedes the flat `ocrText: string[]`.
   */
  ocrTimeline?: OcrEntry[];

  /**
   * Primary and secondary editorial function this clip serves in documentary montage.
   * E.g. primary: "establishing"; secondary: ["context", "transition"].
   */
  storytellingLabels?: StorytellingLabels;

  /**
   * Objective technical quality metrics derived from FFmpeg signalstats + ffprobe.
   * Complements the LLM-inferred `quality` block with actual signal measurements.
   */
  qualityMetrics?: ClipQualityMetrics;

  /**
   * How unique this clip is within our specific archive (not just globally).
   * Computed by comparing embedding against all other archive embeddings.
   */
  archiveUniqueness?: ArchiveUniqueness;

  /**
   * Composite asset health / readiness score.
   * Aggregates metadata completeness, technical quality, editorial quality,
   * and archive-level uniqueness into a single 0–100 score.
   */
  healthScore?: AssetHealthScore;

  // ── v5 Editorial Tagging Engine fields ──────────────────────────────────────

  /**
   * Single most important subject of this clip.
   * E.g. "Winston Churchill", "D-Day", "Berlin Wall", "Apollo 11".
   * Used as the canonical retrieval anchor for this clip.
   */
  primarySubject?: string;

  /**
   * Up to 10 secondary subjects also present or highly relevant.
   * E.g. ["British Army", "RAF", "Parliament", "Microphone", "Flag"].
   */
  secondarySubjects?: string[];

  /**
   * Rich person records with role, function, nationality, and confidence.
   * Complements persons.named with structured metadata per individual.
   */
  personDetails?: PersonDetail[];

  /**
   * Multiple emotions conveyed (in contrast to the single `emotion` field).
   * Ordered by prominence. E.g. ["triumph", "relief", "pride"].
   */
  emotions?: string[];

  /**
   * 50–100 alternative search terms covering every way a documentary editor
   * might search for this clip. Goes far beyond synonyms — includes context,
   * role, event, location, era, visual style, and conceptual alternatives.
   * This is the primary retrieval-improvement field of the v5 engine.
   */
  searchIntentTags?: string[];

  /**
   * Explicit NOT-tags: what this clip is definitively NOT about.
   * Used by retrieval to avoid false-positive matches.
   * E.g. ["NOT Hitler", "NOT Berlin", "NOT Soviet Union", "NOT Cold War"].
   */
  negativeTags?: string[];

  /**
   * Ranked list of topics/genres this clip is most useful for.
   * E.g. [{topic: "Churchill biography", score: 100}, {topic: "WWII documentary", score: 95}].
   */
  retrievalPriority?: RetrievalPriorityEntry[];

  /**
   * ~100-word editorial summary written for the retrieval engine, not for users.
   * Explains why an editor would choose this specific clip over alternatives.
   * Structured around: what, who, where, when, why this clip is the right choice.
   */
  retrievalSummary?: string;

  /**
   * Editorial Intent Engine result (v6).
   * Computed at ingest time only — no LLM, pure derivation from existing annotation.
   * Answers: WHY would an editor choose this clip?
   */
  editorialIntent?: EditorialIntent;

  // ── Ingestion V2 fields ───────────────────────────────────────────────────

  /**
   * Standardized shot type labels derived from cinematicTags + timeline + cameraMovement.
   * Examples: ["Wide", "Static", "Establishing"] | ["Close-up", "Handheld"] | ["Aerial"]
   */
  shotClassification?: string[];

  /**
   * Recommended boundary trims (black frames, fades) detected at ingest time.
   * Advisory — not automatically applied to the stored file.
   */
  boundaryRefinement?: BoundaryRefinement;

  /**
   * Named entities extracted from OCR text via regex NER.
   * Enables retrieval by person name, date, or location found on-screen.
   */
  ocrNamedEntities?: OcrNamedEntity[];

  /**
   * Structured log of decisions made during the ingestion pipeline.
   * Answers WHY the clip was tagged, split, scored, or flagged as it was.
   */
  ingestionLog?: IngestionLogEntry[];

  /**
   * Temporal Scene Intelligence profile (Phase 7).
   * Aggregates existing annotation data into a structured second-by-second view.
   * Enables smart partial retrieval, highlight detection, and explainability.
   * Computed at ingest time — no LLM calls.
   */
  temporalProfile?: TemporalSceneProfile;
};

// ─── Editorial Intent Engine (v6) ────────────────────────────────────────────

/**
 * 21 editorial capabilities, each scored 0–100.
 * Derived at ingest time from existing ClipAnnotation fields — no LLM.
 */
export type EditorialCapability = {
  canOpenDocumentary?: number;
  canCloseDocumentary?: number;
  canIntroducePerson?: number;
  canIntroduceLocation?: number;
  canIntroduceEra?: number;
  canShowScale?: number;
  canShowDestruction?: number;
  canShowVictory?: number;
  canShowDefeat?: number;
  canBuildSuspense?: number;
  canIncreaseEmotion?: number;
  canSupportVoiceOver?: number;
  canBridgeScenes?: number;
  canServeAsBroll?: number;
  canRevealInformation?: number;
  canVisualizeStatistics?: number;
  canExplainTimeline?: number;
  canSupportMapSequence?: number;
  canSupportBiography?: number;
  canSupportHistoricalExplanation?: number;
  canSupportTechnicalExplanation?: number;
};

/**
 * Narrative role a clip can fulfil within a documentary structure.
 */
export type NarrativeFunction =
  | "opening"
  | "establishing"
  | "context"
  | "background"
  | "character_introduction"
  | "historical_context"
  | "buildup"
  | "tension"
  | "conflict"
  | "turning_point"
  | "climax"
  | "aftermath"
  | "reflection"
  | "ending"
  | "transition"
  | "broll";

/**
 * The full editorial intent profile stored per asset.
 */
export type EditorialIntent = {
  capabilities: EditorialCapability;
  narrativeFunctions: NarrativeFunction[];
  /** Human-readable sentence explaining why an editor would choose this clip. */
  visualPurpose: string;
  computedAt: string;
};

// ─── Ingestion V2 types ───────────────────────────────────────────────────────

/**
 * Recommended boundary trims detected at ingest time (black frames, fades).
 * Advisory only — not applied to the stored file automatically.
 */
export type BoundaryRefinement = {
  /** Seconds to trim from clip start (0 = no trim). */
  trimStartSec: number;
  /** Seconds to trim from clip end (0 = no trim). */
  trimEndSec: number;
  /** Number of leading black-frame spans detected. */
  leadingBlackFrames: number;
  /** Number of trailing black-frame spans detected. */
  trailingBlackFrames: number;
  /** True when the first frames ramp up from black (broadcast fade-in). */
  fadeInDetected: boolean;
  /** True when the last frames ramp down to black (broadcast fade-out). */
  fadeOutDetected: boolean;
  /** Human-readable description of what was found and why. */
  reason: string;
};

/**
 * A named entity extracted from OCR text via regex-based NER.
 */
export type OcrNamedEntity = {
  /** The extracted text string. */
  text: string;
  /** Entity category. */
  type: "person" | "date" | "location" | "organization" | "headline" | "other";
  /** Detection confidence 0–1. */
  confidence: number;
  /** Source timestamp in the clip (seconds), if known. */
  timestamp?: number;
};

/**
 * One entry in the structured ingestion decision trail.
 * Answers: why did the pipeline do X to this clip?
 */
export type IngestionLogEntry = {
  /** Pipeline stage name/number. */
  stage: string;
  /** Short verb describing the action taken. */
  action: string;
  /** Human-readable explanation of the decision. */
  reason: string;
  /** ISO-8601 timestamp of when this decision was made. */
  timestamp: string;
  /** Optional scalar value associated with the decision. */
  value?: string;
};

// ─── Temporal Scene Intelligence types (Phase 7) ─────────────────────────────

export type TemporalEvent = {
  startSec: number;
  endSec: number;
  subject: string;
  action: string;
  shotType: string;
  cameraMove: string;
  emotion: string;
  microEvent?: MicroEventType;
  confidence: number;
};

export type SubjectTrack = {
  name: string;
  type: "person" | "object";
  firstSeenSec: number;
  lastSeenSec: number;
  totalVisibleSec: number;
  segments: Array<{ startSec: number; endSec: number }>;
  isPrimary: boolean;
};

export type CameraSegment = {
  startSec: number;
  endSec: number;
  movement: "zoom" | "pan" | "tilt" | "tracking" | "handheld" | "drone" | "static" | "other";
};

export type MotionSegment = {
  startSec: number;
  endSec: number;
  level: "low" | "medium" | "high";
  rawScore?: number;
};

export type EmotionSegment = {
  startSec: number;
  endSec: number;
  emotion: string;
};

export type InternalHighlight = {
  type:
    | "first_close_up"
    | "first_face"
    | "first_explosion"
    | "first_fire"
    | "first_speech"
    | "first_applause"
    | "strongest_emotion"
    | "peak_motion"
    | "title_card"
    | "best_shot_quality"
    | "micro_event"
    | "audio_peak"
    | "ocr_text";
  timestampSec: number;
  description: string;
  confidence: number;
};

export type BestWindow = {
  startSec: number;
  endSec: number;
  durationSec: number;
  score: number;
  reason: string;
};

export type TemporalSceneProfile = {
  events: TemporalEvent[];
  subjectTracks: SubjectTrack[];
  cameraTimeline: CameraSegment[];
  motionTimeline: MotionSegment[];
  emotionTimeline: EmotionSegment[];
  ocrTimeline: Array<{ text: string; startSec: number; endSec: number }>;
  audioTimeline: Array<{ type: string; startSec: number; endSec: number; confidence: number }>;
  bestEntryPoints: BestWindow[];
  internalHighlights: InternalHighlight[];
  computedAt: string;
  durationSec: number;
};
