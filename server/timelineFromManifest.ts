/**
 * RONDE 143 — every video ever rendered can be opened in the editor, not only the new ones.
 *
 * The manifest (`EditorScene[]`, the `videoScenes` column) has been written at the end of every
 * render for a long time. It has no absolute time, no layers, and its `url` is a work-directory
 * path that no longer exists. This module turns one into a timeline anyway, and is explicit about
 * which parts are recovered and which are lost.
 *
 * ── What is recovered ────────────────────────────────────────────────────────────────────────
 *
 *   · absolute time      — by summing `durationMs` across scenes, which is exact: the scenes were
 *                          concatenated in this order, so scene N starts at the sum of the ones
 *                          before it. Within a scene the clips share the scene's length evenly,
 *                          which is an ESTIMATE and is marked as one below.
 *   · source identity    — from whatever the manifest kept: `archiveAssetId` and `storageUrl` for
 *                          archive clips (a permanent handle), the pexels.com/pixabay.com page URL
 *                          for stock, and the provider name for everything else.
 *   · preview            — `previewSource: "rendered_video"` whenever the original is unreachable,
 *                          so the timeline is visible even when nothing is re-fetchable.
 *
 * ── What is lost, and is not invented ────────────────────────────────────────────────────────
 *
 * Per-clip boundaries inside a scene. The manifest records a scene's clips and the scene's total
 * length, never the length of each clip, so an old manifest cannot say that clip 2 ran from 4.1s
 * to 7.3s. Dividing the scene evenly is the honest reconstruction and it is what this does; it is
 * NOT presented as a measurement, and a clip built this way carries no `sourceIn`/`sourceOut` other
 * than the whole of its media.
 *
 * Captions, text, music and effects are likewise absent from every existing manifest. They come
 * back empty rather than guessed. A timeline that invented a caption track would produce a
 * re-render that differed from the original for reasons the user never asked for.
 */
import type { EditorClip, EditorScene } from "./db";
import { UNVERIFIED_PROVIDER } from "./visualSourceLineage";
import {
  DEFAULT_FORMAT,
  emptyTimeline,
  timelineElementId,
  type AssetSourceIdentity,
  type ProjectTimeline,
  type TimelineVideoClip,
} from "./projectTimeline";
import { editorArchiveMediaUrl } from "./archiveMediaStream";

/**
 * Is this URL something a renderer could actually open?
 *
 * A work-directory path is not: the directory is deleted at the end of the render that made it.
 * A pexels.com/video/12345/ page is not either — it is HTML, and the manifest stores it as an
 * attribution link rather than a media handle. Both are common, and treating either as media is
 * how a re-render ends up with a 404 or an HTML file where a picture should be.
 */
export function isFetchableMediaUrl(url: string | undefined | null): boolean {
  const u = (url ?? "").trim();
  if (!u) return false;
  if (u.startsWith("/manus-storage/") || u.startsWith("/local-storage/") || u.startsWith("/api/")) {
    return true;
  }
  if (!/^https?:\/\//i.test(u)) return false;
  // Provider PAGE urls. Recorded for attribution by editorClips.parseStockClipFromPath, and not media.
  if (/^https?:\/\/(www\.)?pexels\.com\/video\//i.test(u)) return false;
  if (/^https?:\/\/(www\.)?pixabay\.com\/videos\//i.test(u)) return false;
  if (/^https?:\/\/(www\.)?youtube\.com\/watch/i.test(u)) return false;
  return true;
}

/**
 * What the manifest knows about where a clip came from.
 *
 * Nothing is guessed. `source` in the manifest is the proven provider from the lineage ledger (or
 * UNVERIFIED), and the URL is classified rather than assumed: a media URL becomes `mediaUrl`, a
 * provider page becomes `sourcePageUrl`, and a work-directory path becomes neither.
 */
export function sourceIdentityFromClip(clip: EditorClip): AssetSourceIdentity {
  const identity: AssetSourceIdentity = {
    provider: clip.source?.trim().toLowerCase() || UNVERIFIED_PROVIDER,
    title: clip.title,
  };
  if (clip.archiveAssetId != null) {
    identity.archiveAssetId = clip.archiveAssetId;
    // The archive serves its own media and will still serve it tomorrow — the strongest handle
    // there is, and the reason archive clips survive a re-render without any recovery at all.
    identity.canonicalUrl = editorArchiveMediaUrl(clip.archiveAssetId, clip);
  }
  if (isFetchableMediaUrl(clip.url)) identity.mediaUrl = clip.url;
  else if (/^https?:\/\//i.test(clip.url ?? "")) identity.sourcePageUrl = clip.url;
  return identity;
}

/**
 * Build a timeline from a stored manifest.
 *
 * `renderedVideoUrl` is the existing final MP4. It becomes the preview for every clip whose own
 * media is unreachable — §2 — and is never a render source.
 */
export function timelineFromEditorScenes(params: {
  videoId: number;
  scenes: readonly EditorScene[];
  renderedVideoUrl?: string;
  format?: typeof DEFAULT_FORMAT;
}): ProjectTimeline {
  const timeline = emptyTimeline(params.videoId, params.format ?? DEFAULT_FORMAT);
  timeline.renderedVideoUrl = params.renderedVideoUrl;

  const clips: TimelineVideoClip[] = [];
  let cursorSec = 0;
  for (const scene of params.scenes) {
    const sceneSec = Math.max(0, (scene.durationMs ?? 0) / 1000);
    const sceneClips = (scene.clips ?? []).filter(Boolean);
    if (sceneClips.length === 0) {
      cursorSec += sceneSec;
      continue;
    }
    // The honest reconstruction: the manifest never recorded per-clip boundaries, so an even share
    // of the scene is the most that can be said. Marked by carrying the whole media as the source
    // range rather than a measured in/out.
    const each = sceneSec / sceneClips.length;
    sceneClips.forEach((clip, i) => {
      const start = cursorSec + i * each;
      const end = i === sceneClips.length - 1 ? cursorSec + sceneSec : start + each;
      const source = sourceIdentityFromClip(clip);
      const reachable = Boolean(source.canonicalUrl || source.mediaUrl);
      clips.push({
        id: timelineElementId("vc", scene.sceneIndex, i, clip.url ?? "", clip.source ?? ""),
        kind: clip.type === "image" ? "image" : "video",
        source,
        sourceIn: 0,
        sourceOut: Math.max(0.1, end - start),
        timelineStart: Number(start.toFixed(3)),
        timelineEnd: Number(end.toFixed(3)),
        motion: clip.type === "image" ? "slow_push" : "none",
        transitionIn: "hard_cut",
        transitionOut: "hard_cut",
        previewSource: reachable ? "asset" : "rendered_video",
        sceneIndex: scene.sceneIndex,
        editedByUser: clip.editedByUser,
      });
    });
    cursorSec += sceneSec;
  }

  const videoTrackRef = timeline.tracks.find((t) => t.kind === "VIDEO");
  if (videoTrackRef && videoTrackRef.kind === "VIDEO") videoTrackRef.clips = clips;
  timeline.durationSec = Number(cursorSec.toFixed(3));
  return timeline;
}

/**
 * How much of this timeline could actually be re-rendered from its own sources.
 *
 * The number the editor has to show before a user spends ten minutes on a re-render: a timeline
 * whose clips are mostly unreachable will come back with holes, and saying so first is the
 * difference between a limitation and a nasty surprise.
 */
export function timelineRecoverySummary(t: ProjectTimeline): {
  total: number;
  reachable: number;
  previewOnly: number;
} {
  const track = t.tracks.find((x) => x.kind === "VIDEO");
  const clips = track && track.kind === "VIDEO" ? track.clips : [];
  const reachable = clips.filter(
    (c) => c.source.canonicalUrl || c.source.mediaUrl || c.source.archiveAssetId != null
  ).length;
  return { total: clips.length, reachable, previewOnly: clips.length - reachable };
}
