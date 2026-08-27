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
import { createHash } from "crypto";
import { storagePut } from "./storage";
import { createMediaArchiveAsset, findMediaArchiveAssetBySourceUrlHash, getAllMediaArchives } from "./db";
import { formatPreviewRefusal, verifyArchivePreview } from "./archivePreviewCheck";
import { extractFrameAtFraction } from "./localClipVision";
import { indexArchiveAssetEmbedding } from "./archiveEmbeddingIndex";
import { cachedClipHasBakedEditText } from "./archiveClipFilter";
import { beatClipTextFilterMaxChecks } from "./sourcingPolicy";
import { recordVisualSearchMemory, type ClassifiedEntity } from "./visualSearchMemory";
import { Semaphore } from "./_core/semaphore";
import type { InsertMediaArchiveAsset } from "../drizzle/schema";

// Callers fire this fire-and-forget per winning beat with no cap of their own (videoPipeline.ts's
// funnel-clip loop), and each call reads the whole clip into memory + uploads it — several
// beats landing at once during a render could otherwise stack up unbounded concurrent
// read+upload work purely for this best-effort background feature.
const ingestionLimiter = new Semaphore(2);

// ─── Types ────────────────────────────────────────────────────────────────────

export type IngestMetadata = {
  title: string;
  tags: string[];
  /** e.g. "pexels:12345" or "wikimedia:File_Foo.mp4" */
  sourceNote: string;
  mediaType: "video" | "image";
  mimeType: string;
  durationSec?: number;
  /**
   * RONDE 9b: true only when the render this clip won was person-locked (a real name drives
   * the video). AWS Rekognition person-tagging runs ONLY then — celebrity recognition on
   * B-roll/place/object footage is wasted spend and adds nothing.
   */
  personContext?: boolean;
  /** License note, e.g. "CC0", "Pexels license" */
  licenseNote?: string;
  /** Override which archive to ingest into; defaults to the first active archive. */
  archiveId?: number;

  // F3-26: structured web-sourcing provenance (all optional — admin uploads and older callers
  // that don't have this data keep working unchanged).
  /** The original remote URL this clip was downloaded from. Used for duplicate detection. */
  sourceUrl?: string;
  /** Provider name, e.g. "internet_archive", "wikimedia", "pexels", "pixabay", "youtube_cc". */
  sourcePlatform?: string;
  /** Creator/uploader/channel name, when the source exposes one. */
  sourceCreator?: string;
  /** License URL, when the source exposes one (e.g. a Creative Commons deed link). */
  licenseUrl?: string;
  /** The original search query that led to this candidate being found. */
  originalQuery?: string;
  /** The specific query variant that actually matched (may equal originalQuery). */
  matchedQuery?: string;
  /** Recognized entities this clip is relevant to, e.g. ["Justin Bieber"]. */
  entities?: ClassifiedEntity[];
  /** General topics, e.g. ["music", "pop culture"]. */
  topics?: string[];
};

export type IngestResult = {
  assetId: number;
  storageKey: string;
  /** True when this reused an already-archived asset instead of ingesting a new one. */
  reused?: boolean;
};

function hashSourceUrl(sourceUrl: string): string {
  return createHash("sha256").update(sourceUrl.trim()).digest("hex");
}

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

// ─── F3-26: query/entity/source learning loop ─────────────────────────────────

/** Records one visual-search-memory row per recognized entity (or a single "topic" row when no
 *  entities were recognized) so a future beat about the same entity/topic can reuse the query +
 *  source that worked here. Best-effort — never throws. */
async function recordSearchMemoryForIngestion(
  metadata: IngestMetadata,
  assetId: number,
  success: boolean
): Promise<void> {
  const query = metadata.matchedQuery ?? metadata.originalQuery;
  const source = metadata.sourcePlatform;
  if (!query || !source) return; // nothing to remember without a query + source

  const entities = metadata.entities && metadata.entities.length > 0
    ? metadata.entities
    : metadata.topics && metadata.topics.length > 0
      ? metadata.topics.map((t) => ({ type: "topic" as const, value: t }))
      : [];
  if (entities.length === 0) return;

  await Promise.all(
    entities.map((e) =>
      recordVisualSearchMemory({
        entity: e.value,
        entityType: e.type,
        query,
        source,
        sourceUrl: metadata.sourceUrl,
        assetId,
        success,
      })
    )
  );
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
  return ingestionLimiter.run(() => ingestExternalClipToArchiveInner(localPath, metadata));
}

async function ingestExternalClipToArchiveInner(
  localPath: string,
  metadata: IngestMetadata
): Promise<IngestResult | null> {
  try {
    // RONDE 9 (render 519 + admin evidence): stock footage is never archive material. A generic
    // Pexels clip that won a Hitler beat was ingested tagged "adolf hitler" and then outranked
    // real archival footage on every later render about the same person (self-poisoning loop).
    // Defense-in-depth: the funnel call site already refuses, this blocks every other caller.
    const platform = (metadata.sourcePlatform ?? "").toLowerCase();
    const sourcePrefix = metadata.sourceNote.toLowerCase();
    if (
      platform === "pexels" || platform === "pixabay" ||
      sourcePrefix.startsWith("pexels:") || sourcePrefix.startsWith("pixabay:")
    ) {
      console.log(
        `[Ingestion] Skipping ${metadata.sourcePlatform ?? metadata.sourceNote.split(":")[0]} clip — stock footage is never ingested into the curated archive`
      );
      return null;
    }

    if (!passesQualityGate(localPath, metadata)) {
      return null;
    }

    // RONDE 24: never let footage with baked-in on-screen text into the archive.
    //
    // This archive fills itself from what the pipeline finds while searching, so anything admitted
    // here is permanent and gets re-offered to every later render. Ingestion had no text check at
    // all, which is how burnt-in subtitles and news chyrons accumulated: renders 526/527 found 10
    // of 17 assets flagged, leaving only 7 usable. Rejecting at the door — before the upload and
    // the DB row — is what stops that from growing, and it costs nothing extra for the common
    // case: the beat gate (RONDE 23) has usually already judged this exact clip, and the shared
    // memo in archiveClipFilter returns that verdict instead of re-running the vision call.
    const overlayKey = metadata.sourceUrl || `${metadata.sourceNote}:${path.basename(localPath)}`;
    if (await cachedClipHasBakedEditText(localPath, metadata.mimeType, overlayKey, beatClipTextFilterMaxChecks())) {
      console.log(
        `[Ingestion] Skipping "${metadata.title.slice(0, 60)}" — baked-in on-screen text, not archive material`
      );
      return null;
    }

    // F3-26: duplicate protection — the same web source URL must not be archived twice. Checked
    // before touching R2/DB so a repeat hit is a cheap read instead of a second upload+insert.
    const sourceUrlHash = metadata.sourceUrl ? hashSourceUrl(metadata.sourceUrl) : undefined;
    if (sourceUrlHash) {
      const existing = await findMediaArchiveAssetBySourceUrlHash(sourceUrlHash);
      if (existing) {
        console.log(
          `[Ingestion] Source already archived — reusing assetId=${existing.id} instead of re-ingesting ` +
          `(${metadata.sourceUrl})`
        );
        await recordSearchMemoryForIngestion(metadata, existing.id, true);
        return { assetId: existing.id, storageKey: existing.storageKey ?? "", reused: true };
      }
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

    // RONDE 9: content-true person tags via AWS Rekognition celebrity recognition — tags must
    // describe what is SHOWN, never what the narration said (the old beat-keyword tags poisoned
    // the archive). Best-effort: no keys or any error → no person tags, ingestion continues.
    let recognizedPersonTags: string[] = [];
    try {
      // RONDE 9b: only for person-locked renders (metadata.personContext) — Rekognition is a
      // PERSON check, running it on place/object/B-roll footage is pure wasted spend.
      // Lazy import: the AWS SDK is heavyweight and only needed when keys are configured.
      const { isRekognitionEnabled, recognizeCelebritiesInFile } = await import("./rekognitionCelebrity");
      if (metadata.personContext === true && isRekognitionEnabled()) {
        const rek = await recognizeCelebritiesInFile(localPath, metadata.mediaType, metadata.durationSec ?? null);
        recognizedPersonTags = rek.persons.map((p) => p.name);
        if (recognizedPersonTags.length > 0) {
          console.log(
            `[Ingestion] Rekognition identified in "${metadata.title.slice(0, 60)}": ${recognizedPersonTags.join(", ")}`
          );
        }
      }
    } catch (err) {
      console.warn(`[Ingestion] Rekognition tagging skipped:`, (err as Error).message?.slice(0, 120));
    }
    const contentTags = Array.from(new Set([...(metadata.tags ?? []), ...recognizedPersonTags]));

    /**
     * RONDE 118 — prove the preview before anything is stored or registered.
     *
     * Ingested assets arrive from the open internet, so a truncated download or a container with
     * no decodable picture is the normal failure here, not the exotic one. `localPath` is the
     * real downloaded file, which makes this the cheapest and most honest place to ask.
     */
    const preview = await verifyArchivePreview({
      localPath,
      mediaType: metadata.mediaType,
      extractFrame: extractFrameAtFraction,
    });
    if (!preview.ok) {
      console.warn(formatPreviewRefusal(`"${metadata.title.slice(0, 60)}"`, preview));
      return null;
    }

    const data = await fs.promises.readFile(localPath);
    const { key, url } = await storagePut(storageKey, data, metadata.mimeType);

    const insertData: InsertMediaArchiveAsset = {
      archiveId,
      title: metadata.title.slice(0, 512),
      mediaType: metadata.mediaType,
      mixKind: metadata.mediaType === "video" ? "real_video" : "photo",
      mimeType: metadata.mimeType,
      storageUrl: url,
      storageKey: key,
      tags: contentTags,
      sourceNote: metadata.sourceNote.slice(0, 512),
      licenseNote: (metadata.licenseNote ?? "").slice(0, 256) || undefined,
      durationSec: metadata.durationSec,
      isActive: 1,
      sourceUrl: metadata.sourceUrl,
      sourceUrlHash,
      sourcePlatform: metadata.sourcePlatform?.slice(0, 64),
      sourceCreator: metadata.sourceCreator?.slice(0, 256),
      licenseUrl: metadata.licenseUrl?.slice(0, 512),
      downloadedAt: new Date(),
      originalQuery: metadata.originalQuery?.slice(0, 512),
      matchedQuery: metadata.matchedQuery?.slice(0, 512),
      entities: metadata.entities?.map((e) => e.value),
      topics: metadata.topics,
      // RONDE 24: we only get here because the overlay check above cleared this clip, so record
      // that verdict now. Without it the asset lands with hasBakedEditText=null and the very first
      // render that considers it pays a fresh vision call to rediscover what we already know.
      hasBakedEditText: 0,
      // RONDE 118: verified a few lines above, before the bytes were even stored.
      previewCheckedAt: new Date(),
    };

    const assetId = await createMediaArchiveAsset(insertData);
    if (!assetId) return null;

    // Index embedding in background — non-blocking
    void indexArchiveAssetEmbedding({
      id: assetId,
      title: metadata.title,
      tags: contentTags,
      sourceNote: metadata.sourceNote,
    }).catch(() => {});

    // F3-26: remember which query/entity/source combination found this asset — best-effort,
    // never blocks or fails the ingestion itself.
    void recordSearchMemoryForIngestion(metadata, assetId, true).catch(() => {});

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
