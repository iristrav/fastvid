/**
 * Editor manifest helpers — stable archive URLs for preview and re-render.
 */
import * as path from "path";
import type { EditorClip, EditorScene } from "./db";
import { getMediaArchiveAssetById } from "./db";
import type { MediaArchiveAsset } from "../drizzle/schema";
import { editorArchiveMediaUrl } from "./archiveMediaStream";
import { curatedClipPathAssetId, isPipelineBlurFillStillClip } from "./curatedMediaSourcing";
import { UNVERIFIED_PROVIDER } from "./visualSourceLineage";

export function editorClipFromArchiveAsset(asset: MediaArchiveAsset): EditorClip {
  const previewUrl = editorArchiveMediaUrl(asset.id);
  return {
    url: previewUrl,
    thumbnailUrl: previewUrl,
    type: asset.mediaType === "video" ? "video" : "image",
    source: "archive",
    archiveAssetId: asset.id,
    storageUrl: asset.storageUrl,
    title: asset.title ?? undefined,
  };
}

function parseStockClipFromPath(clipPath: string): EditorClip | null {
  const base = path.basename(clipPath);
  const pixMatch = base.match(/(?:^|_)pix_vid(\d+)\.mp4$/i);
  if (pixMatch) {
    const id = pixMatch[1];
    return {
      url: `https://pixabay.com/videos/${id}/`,
      type: "video",
      source: "pixabay",
      title: `Pixabay video ${id}`,
    };
  }
  const pexMatch = base.match(/_vid(\d+)\.mp4$/i);
  if (pexMatch && !/_pix_/i.test(base)) {
    const id = pexMatch[1];
    return {
      url: `https://www.pexels.com/video/${id}/`,
      type: "video",
      source: "pexels",
      title: `Pexels video ${id}`,
    };
  }
  return null;
}

/**
 * RONDE 87 — the editor manifest's `source` is an attribution shown to the user, so it obeys the
 * same rule as every other one: proven, or UNVERIFIED.
 *
 * `resolveSource` is the render's lineage ledger. When it can name the provider, that name wins
 * over anything read off the filename. The filename parsing below is kept for what it is genuinely
 * good for — reconstructing a stable pexels.com/pixabay.com preview URL from the numeric id the
 * downloader put in the name — and no longer for deciding WHERE a clip came from.
 */
export async function buildEditorClipFromPath(
  clipPath: string,
  resolveSource?: (clipPath: string) => string | null | undefined
): Promise<EditorClip> {
  const assetId = curatedClipPathAssetId(clipPath);
  const isVideo = clipPath.endsWith(".mp4") || clipPath.endsWith(".webm");
  const proven = resolveSource?.(clipPath)?.trim().toLowerCase() || null;

  if (assetId != null) {
    // Not an inference: the id is looked up in the archive table and the row itself is returned.
    const asset = await getMediaArchiveAssetById(assetId);
    if (asset) return editorClipFromArchiveAsset(asset);
  }

  const stock = parseStockClipFromPath(clipPath);
  if (stock) return proven ? { ...stock, source: proven } : stock;

  const base = path.basename(clipPath);
  if (isPipelineBlurFillStillClip(clipPath)) {
    const nameHint = /_wiki_/i.test(base)
      ? "wikimedia"
      : /_openverse_/i.test(base)
        ? "openverse"
        : /_serp_/i.test(base)
          ? "serp"
          : null;
    const source = proven ?? nameHint ?? UNVERIFIED_PROVIDER;
    return {
      url: clipPath,
      type: "video",
      source,
      title: nameHint ? `${nameHint} still` : "still",
      available: false,
    };
  }

  return {
    url: clipPath,
    type: isVideo ? "video" : "image",
    // This used to be a substring test on the temp path — if the name contained the word curated
    // the clip was labelled as coming from the archive, otherwise "unknown". Both were guesses
    // presented in the same field as a real provider name.
    source: proven ?? UNVERIFIED_PROVIDER,
    available: false,
  };
}

/** Build editor manifest from pipeline temp clip paths (stable URLs for archive/stock). */
export async function buildEditorScenesFromPipeline(
  scenes: Array<{ index: number; text: string; duration: number; chapterTitle?: string }>,
  clipPathsPerScene: string[][],
  /** RONDE 87: the render's lineage ledger, so the manifest reports proven sources. */
  resolveSource?: (clipPath: string) => string | null | undefined
): Promise<EditorScene[]> {
  const out: EditorScene[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    const paths = (clipPathsPerScene[i] ?? []).filter(Boolean);
    const clips = await Promise.all(paths.map((p) => buildEditorClipFromPath(p, resolveSource)));
    out.push({
      sceneIndex: scene.index,
      narration: scene.text,
      durationMs: Math.round(scene.duration * 1000),
      clips,
      chapterTitle: scene.chapterTitle,
    });
  }
  return out;
}

/** Resolve preview/play URL for client (handles legacy temp paths). */
export function resolveEditorClipPreviewUrl(clip: EditorClip): string {
  if (clip.archiveAssetId) return editorArchiveMediaUrl(clip.archiveAssetId);
  return clip.thumbnailUrl ?? clip.url;
}
