/**
 * Vidrush pacing + sharpness guards — hard minimum clip duration, opening hold, scale quality.
 */
import {
  archiveVisualMaxClipSec,
  archiveVisualMinClipSec,
  curatedArchiveOnlyVisuals,
} from "./sourcingPolicy";

export const VIDRUSH_OPENING_CLIP_SEC = 3.5;
export const VIDRUSH_STOCK_MIN_CLIP_SEC = 2.5;
export const VIDRUSH_MIN_SOURCE_VIDEO_SEC = 2.8;
export const VIDRUSH_MIN_STILL_WIDTH = 960;

/** Hard minimum on-screen time per montage clip (seconds). */
export function vidrushMinClipSec(): number {
  return curatedArchiveOnlyVisuals() ? archiveVisualMinClipSec() : VIDRUSH_STOCK_MIN_CLIP_SEC;
}

/** First clip of the entire video — slightly longer hold for a calm opening. */
export function vidrushOpeningClipSec(): number {
  return Math.max(vidrushMinClipSec(), VIDRUSH_OPENING_CLIP_SEC);
}

/** Minimum per-clip duration for a given montage slot. */
export function vidrushClipFloorSec(clipIndex: number, sceneIndex = 0): number {
  if (sceneIndex === 0 && clipIndex === 0) return vidrushOpeningClipSec();
  if (clipIndex === 0) return vidrushMinClipSec();
  return vidrushMinClipSec();
}

export function clampVidrushClipDuration(
  duration: number,
  clipIndex = 0,
  sceneIndex = 0
): number {
  const min = vidrushClipFloorSec(clipIndex, sceneIndex);
  const max = archiveVisualMaxClipSec();
  return Math.max(min, Math.min(max, duration));
}

/** Enforce Vidrush pacing floors on a montage duration array. */
export function enforceMontageDurationFloors(
  durations: number[],
  sceneIndex = 0
): number[] {
  return durations.map((d, i) => clampVidrushClipDuration(d, i, sceneIndex));
}

/** Lanczos scale for montage branches — sharper than default bilinear. */
export function montageSharpScaleChain(width: number, height: number): string {
  return (
    `scale=${width}:${height}:flags=lanczos:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x2a2a2a`
  );
}

/** Mat-framed still photo scale — larger = sharper on 1080p (avoid tiny upscaled thumb). */
export function vidrushStillPhotoScale(): number {
  return curatedArchiveOnlyVisuals() ? 0.86 : 0.78;
}

/** Max visual director beats that fit scene voice without sub-3s flashes. */
export function maxDirectorBeatsForSceneDuration(sceneDurationSec: number, minSec?: number): number {
  const floor = minSec ?? vidrushMinClipSec();
  return Math.max(1, Math.floor(sceneDurationSec / floor));
}
