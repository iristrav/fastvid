export type TextOverlayStyle = "documentary" | "cinematic" | "minimal";

export type TextOverlayType =
  | "headline"
  | "label"
  | "quote"
  | "year"
  | "location"
  | "person";

export type TextAnimation =
  | "typewriter"
  | "fade"
  | "slide"
  | "scale"
  | "blur";

export type TextPosition = "center" | "bottom-left";

export interface TextOverlay {
  type: TextOverlayType;
  text: string;
  subtitle?: string;
  startTime: number;  // seconds into the scene clip
  endTime: number;
  animation: TextAnimation;
  position: TextPosition;
  style: TextOverlayStyle;
}

export interface SceneTextPlan {
  sceneIndex: number;
  overlays: TextOverlay[];
}

export interface VideoTextPlan {
  scenes: SceneTextPlan[];
  style: TextOverlayStyle;
}
