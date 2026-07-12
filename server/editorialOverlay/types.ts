/**
 * Editorial Overlay Engine — types
 *
 * Beat-level, type-first overlay planning. For each beat the engine determines
 * WHAT kind of overlay is needed before deciding WHAT the text says.
 */

export type EditorialOverlayType =
  | "chapter_title"        // Opening or transition — "THE RISE OF NAPOLEON"
  | "person_introduction"  // First appearance of a named person
  | "historical_event"     // Battle, invasion, revolution, treaty…
  | "location"             // City, country, region
  | "date_era"             // Year or decade — "1933" or "1930s"
  | "quote"                // Direct quote from a speech or document
  | "statistic"            // Key number — "6 million", "45%", "$4B"
  | "closing_statement"    // Final beat of resolution act
  | "context_label";       // Generic lower-third label when nothing more specific fits

/** One overlay to burn into a scene clip. */
export interface BeatOverlay {
  /** Overlay category — determined before text is generated. */
  type: EditorialOverlayType;
  /** Primary display line (ALL CAPS for headline types, Title Case for labels). */
  line1: string;
  /** Optional second line — subtitle, year, role, location context. */
  line2?: string;
  /** Beat index (within scene) where overlay appears. */
  startBeatIndex: number;
  /** Beat index (inclusive) where overlay ends. */
  endBeatIndex: number;
  /** Seconds into the composed scene clip. */
  startSec: number;
  /** Seconds into the composed scene clip. */
  endSec: number;
  /** Why this overlay type was chosen. */
  reason: string;
  /** Which metadata fields drove the decision. */
  metadataUsed: string[];
}

/** All overlays for a single scene. */
export interface SceneOverlayPlan {
  sceneIndex: number;
  overlays: BeatOverlay[];
}

/** Full-video overlay plan. */
export interface VideoOverlayPlan {
  scenes: SceneOverlayPlan[];
}
