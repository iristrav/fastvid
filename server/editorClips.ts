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
import { MANIFEST_SCHEMA_VERSION } from "./db";
import {
  formatAssetIdentity,
  identityFromAdoption,
  identityIsRehydratable,
  type AdoptionRecordFacts,
} from "./assetIdentity";
import type { AssetSourceIdentity } from "./projectTimeline";

/**
 * RONDE 146 — what the render knows about one adopted clip, beyond its provider name.
 *
 * `resolveSource` (RONDE 87) answers "which provider", which is what the manifest needed when its
 * only job was attribution. `resolveAdoption` answers "which FILE at that provider", which is what
 * a re-render needs. Both read the same ledger record; the second simply stops throwing four
 * fifths of it away.
 *
 * Optional so every existing caller — tests, tools, the archive splitter — keeps working and
 * simply produces a manifest without identity, exactly as before.
 */
export type AdoptionResolver = (clipPath: string) => AdoptionRecordFacts | null | undefined;

/** Trim/duration facts, when the render measured them. Absent is not zero. */
export type ClipTimingFacts = {
  sourceIn?: number;
  sourceOut?: number;
  durationSec?: number;
};
export type TimingResolver = (clipPath: string) => ClipTimingFacts | null | undefined;

export function editorClipFromArchiveAsset(asset: MediaArchiveAsset): EditorClip {
  // RONDE 177: version the URL from the row, so a clip trimmed in the archive stops previewing as
  // the footage it had before the trim.
  const previewUrl = editorArchiveMediaUrl(asset.id, asset);
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
  resolveSource?: (clipPath: string) => string | null | undefined,
  resolveAdoption?: AdoptionResolver,
  resolveTiming?: TimingResolver
): Promise<EditorClip> {
  const assetId = curatedClipPathAssetId(clipPath);
  const isVideo = clipPath.endsWith(".mp4") || clipPath.endsWith(".webm");
  const proven = resolveSource?.(clipPath)?.trim().toLowerCase() || null;
  /**
   * RONDE 146 — the identity comes from the adoption record and nothing else.
   *
   * Computed once, up here, so every return path below carries it. The curated branch adds its
   * own archiveAssetId on top, because an archive row is a stronger handle than anything a
   * provider API can give: this system holds the file.
   */
  const adopted = identityFromAdoption(resolveAdoption?.(clipPath));
  const timing = resolveTiming?.(clipPath) ?? undefined;
  const withFacts = (clip: EditorClip, identity: AssetSourceIdentity | null): EditorClip => {
    const out: EditorClip = { ...clip };
    if (identity) out.sourceIdentity = identity;
    if (timing?.sourceIn != null) out.sourceIn = timing.sourceIn;
    if (timing?.sourceOut != null) out.sourceOut = timing.sourceOut;
    if (timing?.durationSec != null) out.durationSec = timing.durationSec;
    return out;
  };

  if (assetId != null) {
    // Not an inference: the id is looked up in the archive table and the row itself is returned.
    const asset = await getMediaArchiveAssetById(assetId);
    if (asset) {
      const base = editorClipFromArchiveAsset(asset);
      return withFacts(base, {
        ...(adopted ?? { provider: "curated" }),
        provider: adopted?.provider ?? "curated",
        archiveAssetId: asset.id,
        canonicalUrl: base.url,
        title: asset.title ?? adopted?.title,
      });
    }
  }

  const stock = parseStockClipFromPath(clipPath);
  if (stock) return withFacts(proven ? { ...stock, source: proven } : stock, adopted);

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
    return withFacts(
      {
        url: clipPath,
        type: "video",
        source,
        title: nameHint ? `${nameHint} still` : "still",
        available: false,
      },
      adopted
    );
  }

  return withFacts(
    {
      url: clipPath,
      type: isVideo ? "video" : "image",
      // This used to be a substring test on the temp path — if the name contained the word curated
      // the clip was labelled as coming from the archive, otherwise "unknown". Both were guesses
      // presented in the same field as a real provider name.
      source: proven ?? UNVERIFIED_PROVIDER,
      available: false,
    },
    adopted
  );
}

/** Build editor manifest from pipeline temp clip paths (stable URLs for archive/stock). */
export async function buildEditorScenesFromPipeline(
  scenes: Array<{ index: number; text: string; duration: number; chapterTitle?: string }>,
  clipPathsPerScene: string[][],
  /** RONDE 87: the render's lineage ledger, so the manifest reports proven sources. */
  resolveSource?: (clipPath: string) => string | null | undefined,
  /** RONDE 146: the same ledger, asked for the rest of what it knows. */
  resolveAdoption?: AdoptionResolver,
  /** RONDE 146: trim/duration, where the render measured it. */
  resolveTiming?: TimingResolver
): Promise<EditorScene[]> {
  const out: EditorScene[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    const paths = (clipPathsPerScene[i] ?? []).filter(Boolean);
    const clips = await Promise.all(
      paths.map((p) => buildEditorClipFromPath(p, resolveSource, resolveAdoption, resolveTiming))
    );
    out.push({
      sceneIndex: scene.index,
      narration: scene.text,
      durationMs: Math.round(scene.duration * 1000),
      clips,
      chapterTitle: scene.chapterTitle,
      manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    });
  }
  return out;
}

/** Per-clip identity lines plus one coverage line, for the render log. */
export function formatManifestIdentityReport(scenes: readonly EditorScene[]): string[] {
  const lines: string[] = [];
  const all: Array<AssetSourceIdentity | null> = [];
  for (const scene of scenes) {
    (scene.clips ?? []).forEach((clip, clipIndex) => {
      const identity = clip.sourceIdentity ?? null;
      all.push(identity);
      lines.push(formatAssetIdentity(scene.sceneIndex, clipIndex, identity));
    });
  }
  return lines;
}

/**
 * How much of a manifest could be fetched again.
 *
 * §15 — an old manifest reports honestly rather than optimistically: a clip with no
 * `sourceIdentity` counts as unrecoverable, which is exactly what it is.
 */
export function manifestRehydrationSummary(scenes: readonly EditorScene[]): {
  total: number;
  rehydratable: number;
  schemaVersion: number;
} {
  let total = 0;
  let rehydratable = 0;
  for (const scene of scenes) {
    for (const clip of scene.clips ?? []) {
      total++;
      if (identityIsRehydratable(clip.sourceIdentity ?? null)) rehydratable++;
    }
  }
  const versions = scenes.map((s) => s.manifestSchemaVersion ?? 1);
  return { total, rehydratable, schemaVersion: versions.length ? Math.min(...versions) : 1 };
}

/** Resolve preview/play URL for client (handles legacy temp paths). */
export function resolveEditorClipPreviewUrl(clip: EditorClip): string {
  // The manifest holds the storageUrl the clip had when the video was rendered — a snapshot, not
  // the live row. Versioning from it still breaks the cache the manifest itself was stored with;
  // a clip trimmed AFTER the manifest was written needs the manifest rebuilt, which
  // editorClipFromArchiveAsset above does from the current row.
  if (clip.archiveAssetId) return editorArchiveMediaUrl(clip.archiveAssetId, clip);
  return clip.thumbnailUrl ?? clip.url;
}
