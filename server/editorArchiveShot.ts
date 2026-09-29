/**
 * VIDEO 619 — an archive asset, shaped as the shot the editor puts on its draft.
 *
 * Pure, so the rule for a hand-added shot is readable and testable in one place: a video starts at
 * the beginning of its source and runs for at most `ADDED_VIDEO_SHOT_SEC` (the person can make it
 * longer or shorter afterwards); a still is held for `ADDED_STILL_SHOT_SEC` with a slow push, the
 * same move the pipeline gives a photograph.
 */
import { timelineElementId, type TimelineVideoClip } from "./projectTimeline";

export const ADDED_VIDEO_SHOT_SEC = 5;
export const ADDED_STILL_SHOT_SEC = 4;

export function archiveAssetAsShot(params: {
  asset: { id: number; mediaType: "video" | "image"; durationSec?: number | null; title?: string | null };
  provider: string;
  canonicalUrl: string;
  idSeed: string;
}): TimelineVideoClip {
  const { asset } = params;
  const isVideo = asset.mediaType === "video";
  const len = isVideo
    ? Math.max(0.5, Math.min(ADDED_VIDEO_SHOT_SEC, asset.durationSec && asset.durationSec > 0 ? asset.durationSec : ADDED_VIDEO_SHOT_SEC))
    : ADDED_STILL_SHOT_SEC;
  return {
    id: timelineElementId("clip_user", params.idSeed),
    kind: isVideo ? "video" : "image",
    source: {
      provider: params.provider,
      archiveAssetId: asset.id,
      canonicalUrl: params.canonicalUrl,
      ...(asset.title ? { title: asset.title } : {}),
    },
    ...(isVideo ? { sourceIn: 0, sourceOut: Number(len.toFixed(3)) } : {}),
    timelineStart: 0,
    timelineEnd: Number(len.toFixed(3)),
    motion: isVideo ? "none" : "slow_push",
    ...(isVideo ? {} : { camera: { type: "slow_push", startScale: 1, endScale: 1.12, intensity: 1 } }),
    sourceKind: "archive",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
    editedByUser: true,
  };
}
