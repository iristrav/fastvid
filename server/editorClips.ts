/**
 * Editor manifest helpers — stable archive URLs for preview and re-render.
 */
import type { EditorClip } from "./db";
import { getMediaArchiveAssetById } from "./db";
import type { MediaArchiveAsset } from "../drizzle/schema";
import { editorArchiveMediaUrl } from "./archiveMediaStream";
import { curatedClipPathAssetId } from "./curatedMediaSourcing";

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

export async function buildEditorClipFromPath(clipPath: string): Promise<EditorClip> {
  const assetId = curatedClipPathAssetId(clipPath);
  const isVideo = clipPath.endsWith(".mp4") || clipPath.endsWith(".webm");

  if (assetId != null) {
    const asset = await getMediaArchiveAssetById(assetId);
    if (asset) return editorClipFromArchiveAsset(asset);
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
