/**
 * The still-style context the still encoders are handed, and the per-video budget it carries.
 *
 * RONDE 656 — the procedural motion-graphic stills (text cards, maps, news overlays drawn into the
 * clip before the timeline, with their own zoom) are gone: text and graphics are drawn by the
 * timeline (TEXT/GRAPHICS tracks) and a still's motion is the timeline camera's. Only these types
 * remain, because the encoders still thread the context through.
 */
export type MotionGraphicsBudget = { used: number; max: number };

export type StillStyleContext = {
  beatText?: string;
  videoTitle?: string;
  motionGraphicsBudget?: MotionGraphicsBudget;
};
