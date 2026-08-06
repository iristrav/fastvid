/** Professional Render Engine — Camera Renderer (Phase 7).
 *
 *  Turns a CameraInstruction (already decided by Phase 4's CameraPlanner — this file makes no
 *  camera-movement decisions of its own) into a real FFmpeg `zoompan` filter string.
 *
 *  Five of the twelve CameraMovementType values already have real, live-production zoompan
 *  code — documentaryStyle.ts's buildKenBurnsTail(), confirmed by this phase's research —
 *  covering ken_burns/zoom_in/zoom_out/pan_left/pan_right (plus slow_push/slow_pull, which
 *  reuse the exact same zoom math at a gentler rate). That function is called directly, not
 *  reimplemented; only its hardcoded 1920x1080 output size is adapted per-call to this
 *  render's actual target dimensions (via withDimensions()) since the legacy function has no
 *  dimensions parameter and this engine must support 9:16/1:1 output too.
 *
 *  The remaining movements (tilt_up/tilt_down/parallax/virtual_dolly/camera_drift) have no
 *  prior implementation anywhere in this codebase (also confirmed by research) and are
 *  genuinely new here, built with a sine/power-based EASED progress curve rather than the
 *  legacy's constant-velocity linear stepping — per "use smooth easing, never robotic
 *  movement," an eased (accelerating/decelerating) curve reads as more deliberate than a
 *  constant-speed one. parallax specifically is a single-layer approximation (pan+zoom on one
 *  flat plane) — true multi-plane depth parallax would need foreground/background separation
 *  that no part of this pipeline extracts; camera_hold intentionally emits no filter fragment
 *  at all (it's a genuine no-op, not a filter that happens to do nothing).
 */
import { buildKenBurnsTail, stillOutputFrameCount, type KenBurnsVariant } from "../documentaryStyle";
import type { CameraInstruction, Dimensions, FilterFragment } from "./types";

const FPS = 25;

/** buildKenBurnsTail() hardcodes `s=1920x1080` (documentaryStyle.ts's own module constants) —
 *  this replaces that trailing size token with the render's actual target dimensions, without
 *  touching the zoom/pan expression math itself. If that function's own output format ever
 *  changes, this regex simply fails to match and the string passes through with its original
 *  1920x1080 baked in — a loud, easily-caught mismatch in a snapshot test, not a silent bug. */
function withDimensions(zoompanFilter: string, dims: Dimensions): string {
  return zoompanFilter.replace(/s=\d+x\d+/, `s=${dims.width}x${dims.height}`);
}

function easedZoomEnd(base: number, spread: number, intensity: number): number {
  return base + spread * Math.max(0, Math.min(1, intensity));
}

const REUSED_MOVEMENTS: Partial<Record<CameraInstruction["movement"], { variant: KenBurnsVariant; zoomEnd: (intensity: number) => number }>> = {
  ken_burns: { variant: "zoom-in", zoomEnd: (i) => easedZoomEnd(1.04, 0.08, i) },
  zoom_in: { variant: "zoom-in", zoomEnd: (i) => easedZoomEnd(1.05, 0.15, i) },
  zoom_out: { variant: "zoom-out", zoomEnd: (i) => easedZoomEnd(1.05, 0.15, i) },
  pan_left: { variant: "pan-left", zoomEnd: () => 1.02 },
  pan_right: { variant: "pan-right", zoomEnd: () => 1.02 },
  slow_push: { variant: "zoom-in", zoomEnd: (i) => easedZoomEnd(1.02, 0.06, i) },
  slow_pull: { variant: "zoom-out", zoomEnd: (i) => easedZoomEnd(1.02, 0.06, i) },
};

/** Sine-based ease-out progress term, embeddable directly in a zoompan expression: 0 at the
 *  first frame, smoothly approaching 1 by the clip's end, never linear. `totalFrames` is a
 *  compile-time constant (known from clip duration), so this is plain arithmetic FFmpeg's
 *  expression evaluator accepts, not a runtime variable lookup. */
function easeOutTerm(totalFrames: number): string {
  return `sin(PI/2*min(on/${totalFrames},1))`;
}

function buildTilt(direction: "up" | "down", durationSec: number, intensity: number): string {
  const totalFrames = stillOutputFrameCount(durationSec, FPS);
  const amplitude = (0.05 + 0.06 * Math.max(0, Math.min(1, intensity))).toFixed(4);
  const sign = direction === "up" ? "-" : "+";
  const yExpr = `ih/2-(ih/zoom/2)${sign}ih*${amplitude}*${easeOutTerm(totalFrames)}`;
  return `zoompan=z='1.015':x='iw/2-(iw/zoom/2)':y='${yExpr}':d=${totalFrames}:s=WxH:fps=${FPS}`;
}

function buildDrift(durationSec: number, intensity: number): string {
  const totalFrames = stillOutputFrameCount(durationSec, FPS);
  const amp = (0.015 + 0.02 * Math.max(0, Math.min(1, intensity))).toFixed(4);
  const xExpr = `iw/2-(iw/zoom/2)+iw*${amp}*sin(2*PI*on/${totalFrames})`;
  const yExpr = `ih/2-(ih/zoom/2)+ih*${amp}*cos(2*PI*on/${totalFrames})`;
  return `zoompan=z='1.02':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=WxH:fps=${FPS}`;
}

function buildVirtualDolly(durationSec: number, intensity: number): string {
  const totalFrames = stillOutputFrameCount(durationSec, FPS);
  const spread = (0.05 + 0.08 * Math.max(0, Math.min(1, intensity))).toFixed(4);
  // Quadratic ease-in — a dolly builds momentum rather than moving at constant speed from
  // frame one, distinguishing it from zoom_in's constant-velocity push.
  const zExpr = `1+${spread}*pow(min(on/${totalFrames},1),2)`;
  return `zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=WxH:fps=${FPS}`;
}

function buildParallax(durationSec: number, intensity: number): string {
  const totalFrames = stillOutputFrameCount(durationSec, FPS);
  const zoomSpread = (0.02 + 0.02 * Math.max(0, Math.min(1, intensity))).toFixed(4);
  const panAmp = (0.02 + 0.03 * Math.max(0, Math.min(1, intensity))).toFixed(4);
  const zExpr = `1+${zoomSpread}*min(on/${totalFrames},1)`;
  const xExpr = `iw/2-(iw/zoom/2)+iw*${panAmp}*${easeOutTerm(totalFrames)}`;
  return `zoompan=z='${zExpr}':x='${xExpr}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=WxH:fps=${FPS}`;
}

/** Builds this beat's camera-movement filter fragment. Returns an empty array for
 *  camera_hold — a genuine no-op, not a filter that happens to render as a no-op. */
export function renderCameraMovement(instruction: CameraInstruction, durationSec: number, dims: Dimensions): FilterFragment[] {
  if (instruction.movement === "camera_hold") return [];

  const reused = REUSED_MOVEMENTS[instruction.movement];
  if (reused) {
    const filter = withDimensions(buildKenBurnsTail(durationSec, reused.zoomEnd(instruction.intensity), "center", reused.variant), dims);
    return [{ filter, reason: instruction.reason }];
  }

  let filter: string;
  switch (instruction.movement) {
    case "tilt_up":
      filter = buildTilt("up", durationSec, instruction.intensity);
      break;
    case "tilt_down":
      filter = buildTilt("down", durationSec, instruction.intensity);
      break;
    case "camera_drift":
      filter = buildDrift(durationSec, instruction.intensity);
      break;
    case "virtual_dolly":
      filter = buildVirtualDolly(durationSec, instruction.intensity);
      break;
    case "parallax":
      filter = buildParallax(durationSec, instruction.intensity);
      break;
    default:
      return [];
  }

  return [{ filter: filter.replace("s=WxH", `s=${dims.width}x${dims.height}`), reason: instruction.reason }];
}
