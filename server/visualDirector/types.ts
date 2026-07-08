// ── Visual Director — types ───────────────────────────────────────────────────
// The Visual Director is the creative brain of the pipeline.
// It decides WHAT to show and WHY — not just HOW to animate.

export type DirectiveKind =
  | "person_label"      // Name + title for a named person
  | "counter"           // Animated number counting up
  | "map_marker"        // Pulsing location on world map
  | "timeline"          // Horizontal timeline with events
  | "comparison"        // Side-by-side A vs B
  | "bullet_list"       // Sequential bullet points appearing
  | "quote"             // Typewriter quote from person
  | "callout"           // Arrow + label pointing at something
  | "stat_highlight";   // Large isolated statistic

export interface PersonLabel {
  kind: "person_label";
  name: string;          // "Churchill"
  title: string;         // "Prime Minister, UK"
  startSec: number;
  durationSec: number;
}

export interface Counter {
  kind: "counter";
  value: number;
  suffix: string;        // "%" | "k" | "M" | " soldiers" | ""
  label: string;         // Full label shown below the number
  startSec: number;
  durationSec: number;
}

export interface MapMarker {
  kind: "map_marker";
  locationName: string;
  normX: number;         // 0–1 longitude
  normY: number;         // 0–1 latitude
  startSec: number;
  durationSec: number;
}

export interface Timeline {
  kind: "timeline";
  events: Array<{ year: string; label?: string }>;
  highlightYear?: string;
  startSec: number;
  durationSec: number;
}

export interface Comparison {
  kind: "comparison";
  leftLabel: string;
  rightLabel: string;
  connector?: string;    // "VS" | "→" | "vs"
  startSec: number;
  durationSec: number;
}

export interface BulletList {
  kind: "bullet_list";
  items: string[];
  startSec: number;
  durationSec: number;   // total; each bullet = durationSec / items.length
}

export interface Quote {
  kind: "quote";
  text: string;
  attribution?: string;
  startSec: number;
  durationSec: number;
}

export interface StatHighlight {
  kind: "stat_highlight";
  value: string;         // e.g. "€4.3 miljard"
  context?: string;      // e.g. "in oorlogsschade"
  startSec: number;
  durationSec: number;
}

export type Directive =
  | PersonLabel
  | Counter
  | MapMarker
  | Timeline
  | Comparison
  | BulletList
  | Quote
  | StatHighlight;

export interface SceneDirective {
  sceneIndex: number;
  /** Why the director chose these directives (for logging) */
  reasoning: string;
  directives: Directive[];
}

export interface VideoDirective {
  scenes: SceneDirective[];
}
