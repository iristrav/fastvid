/**
 * ClipAnnotation — the full editorial profile of one archive asset.
 * Stored as JSON in media_archive_assets.annotationJson.
 * Version-stamped so a schema change triggers re-annotation.
 */

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
};
