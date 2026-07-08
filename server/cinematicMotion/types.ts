// ── Cinematic Motion & Overlay Engine — types ────────────────────────────────

export type ImageAnimation =
  | "ken_burns_in"
  | "ken_burns_out"
  | "pan_left"
  | "pan_right"
  | "pop_in"
  | "fade"
  | "slow_zoom";

export type MapMarkerStyle = "pulse" | "pin" | "ring";

export interface CounterAnimation {
  /** The final numeric value to count up to (may include suffix like "%" or "k") */
  label: string;
  /** Starting value (default 0) */
  fromValue: number;
  /** Ending value */
  toValue: number;
  /** Suffix appended after the number (%, k, M, ...) */
  suffix: string;
  /** Position in the scene clip (seconds) */
  startSec: number;
  durationSec: number;
}

export interface MapOverlay {
  /** Location name shown in label */
  locationName: string;
  /** Normalised position 0–1 on the world map (x=longitude, y=latitude) */
  normX: number;
  normY: number;
  markerStyle: MapMarkerStyle;
  startSec: number;
  durationSec: number;
}

export interface SceneMotionPlan {
  sceneIndex: number;
  /** Animation applied when still image is encoded to video */
  imageAnimation: ImageAnimation;
  /** Use blurred background card treatment (always true for stills) */
  useImageCard: boolean;
  /** Animated number counters */
  counters: CounterAnimation[];
  /** Map overlays with pulsing location markers */
  maps: MapOverlay[];
}

export interface VideoMotionPlan {
  scenes: SceneMotionPlan[];
}
