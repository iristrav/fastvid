/**
 * Editor manifest helpers — stable archive URLs for preview and re-render.
 */
import * as path from "path";
import type { EditorClip } from "./db";
import { getMediaArchiveAssetById } from "./db";
import type { MediaArchiveAsset } from "../drizzle/schema";
import { editorArchiveMediaUrl } from "./archiveMediaStream";
import { curatedClipPathAssetId, isPipelineBlurFillStillClip } from "./curatedMediaSourcing";

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

export async function buildEditorClipFromPath(clipPath: string): Promise<EditorClip> {
  const assetId = curatedClipPathAssetId(clipPath);
  const isVideo = clipPath.endsWith(".mp4") || clipPath.endsWith(".webm");

  if (assetId != null) {
    const asset = await getMediaArchiveAssetById(assetId);
    if (asset) return editorClipFromArchiveAsset(asset);
  }

  const stock = parseStockClipFromPath(clipPath);
  if (stock) return stock;

  const base = path.basename(clipPath);
  if (isPipelineBlurFillStillClip(clipPath)) {
    const source = /_wiki_/i.test(base)
      ? "wikimedia"
      : /_openverse_/i.test(base)
        ? "openverse"
        : /_serp_/i.test(base)
          ? "serp"
          : "still";
    return {
      url: clipPath,
      type: "video",
      source,
      title: `${source} still`,
    };
  }

  return {
    url: clipPath,
    type: isVideo ? "video" : "image",
    source: clipPath.includes("curated") ? "archive" : "unknown",
  };
}

/** Resolve preview/play URL for client (handles legacy temp paths). */
export function resolveEditorClipPreviewUrl(clip: EditorClip): string {
  if (clip.archiveAssetId) return editorArchiveMediaUrl(clip.archiveAssetId);
  return clip.thumbnailUrl ?? clip.url;
}
