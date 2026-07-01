/**
 * Self-learning archive ingestion — promote winning external clips into the own archive.
 *
 * When an external (Pexels / Pixabay / Wikimedia / Internet Archive) clip wins a beat
 * and passes quality gates, it is automatically uploaded to R2, persisted as a
 * MediaArchiveAsset, and indexed so future retrievals can find it via embedding search.
 *
 * Over time the archive grows and internet retrieval is needed less.
 *
 * Feature flag: ENABLE_EXTERNAL_ASSET_INGESTION=true
 *
 * Entry point: ingestExternalClipToArchive(localPath, metadata) → assetId | null
 * All errors are swallowed — ingestion is always best-effort.
 */

import fs from "fs";
import path from "path";
import { storagePut } from "./storage";
import { createMediaArchiveAsset, getAllMediaArchives } from "./db";
import { indexArchiveAssetEmbedding } from "./archiveEmbeddingIndex";
import type { InsertMediaArchiveAsset } from "../drizzle/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export type IngestMetadata = {
  title: string;
  tags: string[];
  /** e.g. "pexels:12345" or "wikimedia:File_Foo.mp4" */
  sourceNote: string;
  mediaType: "video" | "image";
  mimeType: string;
  durationSec?: number;
  /** License note, e.g. "CC0", "Pexels license" */
  licenseNote?: string;
  /** Override which archive to ingest into; defaults to the first active archive. */
  archiveId?: number;
};

export type IngestResult = {
  assetId: number;
  storageKey: string;
};

// ─── Quality gates ────────────────────────────────────────────────────────────

/** Minimum file size in bytes — reject placeholder / broken downloads. */
const MIN_FILE_BYTES = 50_000; // 50 KB
/** Minimum video duration to admit (seconds). */
const MIN_VIDEO_DURATION_SEC = 3;
/** Maximum video duration — very long clips waste storage and encode time. */
const MAX_VIDEO_DURATION_SEC = 120;

function passesQualityGate(localPath: string, metadata: IngestMetadata): boolean {
  try {
    const stat = fs.statSync(localPath);
    if (stat.size < MIN_FILE_BYTES) return false;
    if (metadata.mediaType === "video") {
      const dur = metadata.durationSec ?? 0;
      if (dur > 0 && dur < MIN_VIDEO_DURATION_SEC) return false;
      if (dur > MAX_VIDEO_DURATION_SEC) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ingests a locally available external clip into the archive.
 * Runs quality gate → uploads to R2 → persists DB record → indexes embedding.
 * Returns the new assetId on success, null on any failure.
 * Never throws.
 */
export async function ingestExternalClipToArchive(
  localPath: string,
  metadata: IngestMetadata
): Promise<IngestResult | null> {
  try {
    if (!passesQualityGate(localPath, metadata)) {
      return null;
    }

    // Resolve archive to ingest into
    let archiveId = metadata.archiveId;
    if (!archiveId) {
      const archives = await getAllMediaArchives();
      const active = archives?.find(a => a.isActive !== 0) ?? archives?.[0];
      if (!active) return null;
      archiveId = active.id;
    }

    // Build a deterministic storage key to avoid duplicates
    const ext = path.extname(localPath) || (metadata.mediaType === "video" ? ".mp4" : ".jpg");
    const safeSource = metadata.sourceNote.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 64);
    const storageKey = `archive-ingested/${archiveId}/${safeSource}${ext}`;

    const data = fs.readFileSync(localPath);
    const { key, url } = await storagePut(storageKey, data, metadata.mimeType);

    const insertData: InsertMediaArchiveAsset = {
      archiveId,
      title: metadata.title.slice(0, 512),
      mediaType: metadata.mediaType,
      mixKind: metadata.mediaType === "video" ? "real_video" : "photo",
      mimeType: metadata.mimeType,
      storageUrl: url,
      storageKey: key,
      tags: metadata.tags,
      sourceNote: metadata.sourceNote.slice(0, 512),
      licenseNote: (metadata.licenseNote ?? "").slice(0, 256) || undefined,
      durationSec: metadata.durationSec,
      isActive: 1,
    };

    const assetId = await createMediaArchiveAsset(insertData);
    if (!assetId) return null;

    // Index embedding in background — non-blocking
    void indexArchiveAssetEmbedding({
      id: assetId,
      title: metadata.title,
      tags: metadata.tags,
      sourceNote: metadata.sourceNote,
    }).catch(() => {});

    console.log(
      `[Ingestion] Admitted external clip to archive: assetId=${assetId} source=${metadata.sourceNote} ` +
      `size=${Math.round(data.length / 1024)}KB`
    );
    return { assetId, storageKey: key };
  } catch (err) {
    console.warn("[Ingestion] Failed to ingest external clip:", (err as Error).message?.slice(0, 100));
    return null;
  }
}
