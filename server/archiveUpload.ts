/**
 * Media archive upload — shared logic for tRPC and direct binary HTTP upload.
 */
import type { Express, Request, Response } from "express";
import express from "express";
import { APP_ERROR, appErrorMessage } from "@shared/appErrors";
import { indexArchiveAssetEmbedding } from "./archiveEmbeddingIndex";
import {
  enrichArchiveAssetFields,
  inferArchiveMediaMime,
} from "./archiveAssetTagging";
import type { ArchiveSubjectContext } from "./archiveClipRelevance";
import {
  dedupeArchiveVisualDuplicates,
} from "./archiveClipDedup";
import {
  ArchiveSplitError,
  archiveStoredDurationSec,
  formatTimecode,
  mapPool,
  minSavedArchiveClipSec,
  archiveUploadRequestTimeoutMs,
  maxArchiveUploadBytes,
  MIN_SPLIT_VIDEO_SEC,
  splitVideoBySceneChanges,
  type ArchiveSplitProgress,
  type VideoClipSegment,
} from "./archiveVideoSplitter";
import {
  finishArchiveUploadJob,
  finishArchiveUploadJobCancelled,
  getArchiveUploadJob,
  initArchiveUploadJob,
  isArchiveUploadCancelRequested,
  patchArchiveUploadJob,
  requestArchiveUploadCancel,
} from "./archiveUploadProgress";
import { getUserFromRequest } from "./_core/context";
import {
  createMediaArchiveAsset,
  deleteMediaArchiveAssets,
  getMediaArchiveAssetById,
  getMediaArchiveAssets,
  getMediaArchiveById,
  normalizeMediaTags,
} from "./db";
import { storagePut } from "./storage";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function scheduleClipEmbeddingFromBuffer(assetId: number, buffer: Buffer): void {
  const tmp = path.join(os.tmpdir(), `fv_clip_emb_${assetId}_${Date.now()}.mp4`);
  try {
    fs.writeFileSync(tmp, buffer);
    scheduleArchiveClipEmbedding(assetId, tmp);
  } catch {
    /* ignore */
  }
}

function scheduleArchiveEmbeddingIndex(assetId: number): void {
  void getMediaArchiveAssetById(assetId)
    .then((asset) => (asset ? indexArchiveAssetEmbedding(asset) : undefined))
    .catch((err) =>
      console.warn(`[ArchiveIndex] asset ${assetId}:`, (err as Error).message?.slice(0, 80))
    );
}

function scheduleArchiveClipEmbedding(assetId: number, localPath: string): void {
  void import("./archiveClipEmbedding")
    .then(({ clipEmbeddingIndexEnabled, indexArchiveClipEmbedding }) => {
      if (!clipEmbeddingIndexEnabled()) return;
      return indexArchiveClipEmbedding(assetId, localPath);
    })
    .catch((err) =>
      console.warn(`[ClipEmbedding] asset ${assetId}:`, (err as Error).message?.slice(0, 80))
    );
}

function scheduleIntelligencePipeline(assetId: number): void {
  void import("./archiveIngestionV2")
    .then(({ scheduleV2IntelligencePipeline }) => scheduleV2IntelligencePipeline(assetId))
    .catch((err) =>
      console.warn(`[IngestionV2] pipeline schedule failed for asset ${assetId}:`, (err as Error).message?.slice(0, 80))
    );
}

export type ArchiveUploadInput = {
  archiveId: number;
  buffer: Buffer;
  mimeType: string;
  filename?: string;
  title?: string;
  tags?: string[];
  mixKind?: "real_video" | "photo" | "stock" | "screenshot" | "motion_graphics";
  sourceNote?: string;
  autoSplitScenes?: boolean;
  autoGenerateTags?: boolean;
  jobId?: string;
};

export type ArchiveUploadResult = {
  asset: Awaited<ReturnType<typeof getMediaArchiveAssetById>>;
  assets: NonNullable<Awaited<ReturnType<typeof getMediaArchiveAssetById>>>[];
  clipCount: number;
  split: boolean;
  aiTagged: boolean;
};

export class ArchiveUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly cancelled = false
  ) {
    super(message);
    this.name = "ArchiveUploadError";
  }
}

export const ARCHIVE_UPLOAD_CANCELLED_MESSAGE = "Upload cancelled";

function throwIfUploadCancelled(jobId: string | undefined): void {
  if (jobId && isArchiveUploadCancelRequested(jobId)) {
    throw new ArchiveUploadError(
      400,
      appErrorMessage(APP_ERROR.SERVICE_ERROR, ARCHIVE_UPLOAD_CANCELLED_MESSAGE),
      true
    );
  }
}

function uploadShouldContinue(jobId: string | undefined): () => boolean {
  return () => !jobId || !isArchiveUploadCancelRequested(jobId);
}

/** Block single long clip when auto-split expected multiple shots but got the whole video. */
function assertSplitSegmentsValid(
  segments: VideoClipSegment[],
  autoSplitScenes: boolean
): void {
  if (!autoSplitScenes || segments.length !== 1) return;
  if (segments[0].durationSec <= MIN_SPLIT_VIDEO_SEC) return;
  if (segments[0].startSec >= 0.5) return;

  console.warn(
    "[ArchiveUpload] Auto-split produced only 1 clip (no reliable shot changes) — saving as single asset"
  );
}

export async function processArchiveAssetUpload(input: ArchiveUploadInput): Promise<ArchiveUploadResult> {
  const jobId = input.jobId;
  const fileLabel = input.filename?.trim() || "upload";
  const progress = (patch: Parameters<typeof patchArchiveUploadJob>[1]) =>
    patchArchiveUploadJob(jobId, patch);

  throwIfUploadCancelled(jobId);
  progress({ stage: "validating", message: `${fileLabel}: validating file…`, percent: 3 });

  const archive = await getMediaArchiveById(input.archiveId);
  if (!archive) {
    throw new ArchiveUploadError(404, appErrorMessage(APP_ERROR.NOT_FOUND, "Archive not found"));
  }

  const maxBytes = maxArchiveUploadBytes();
  if (input.buffer.length > maxBytes) {
    throw new ArchiveUploadError(
      400,
      appErrorMessage(APP_ERROR.FILE_TOO_LARGE, `File too large (max ${Math.round(maxBytes / (1024 * 1024))}MB)`)
    );
  }
  if (input.buffer.length === 0) {
    throw new ArchiveUploadError(400, appErrorMessage(APP_ERROR.SERVICE_ERROR, "Empty file"));
  }

  const mimeType = inferArchiveMediaMime(input.mimeType, input.filename);
  const isVideo = mimeType.startsWith("video/");
  const isImage = mimeType.startsWith("image/");
  if (!isVideo && !isImage) {
    throw new ArchiveUploadError(
      400,
      appErrorMessage(APP_ERROR.FILE_TOO_LARGE, "Only video and image files are supported")
    );
  }

  const baseTitle = input.title?.trim()
    || input.filename?.replace(/\.[^.]+$/, "").trim()
    || `${isVideo ? "video" : "image"}-${Date.now()}`;
  const userProvidedTitle = Boolean(input.title?.trim());
  const mixKind = input.mixKind ?? (isVideo ? "real_video" : "photo");
  const userTags = normalizeMediaTags(input.tags ?? []);
  const archiveNicheTags = normalizeMediaTags(archive.nicheTags ?? []);
  const subjectContext: ArchiveSubjectContext = {
    archiveName: archive.name,
    archiveDescription: archive.description ?? null,
    nicheTags: archiveNicheTags,
  };
  const parentSource = input.filename?.trim() || input.sourceNote?.trim() || null;
  const autoSplitScenes = input.autoSplitScenes ?? true;
  const autoGenerateTags = input.autoGenerateTags ?? true;

  if (isVideo && autoSplitScenes) {
    // Pipeline: each clip is extracted → read → uploaded → file deleted before the next clip.
    // This keeps disk usage bounded to extractConcurrency × clipSize (never 300 files at once).
    const { getStorageBackend } = await import("./storageBackend");
    console.log(`[ArchiveUpload] storage backend: ${getStorageBackend()} archiveId=${input.archiveId} file="${fileLabel}"`);
    let totalRanges = 0; // filled by onProgress before extraction starts
    let savedCount = 0;
    const createdAssets: NonNullable<Awaited<ReturnType<typeof getMediaArchiveAssetById>>>[] = [];

    const onSplitProgress = (p: ArchiveSplitProgress) => {
      if (p.stage === "split_extract" && p.clipIndex === 0 && p.clipTotal) {
        totalRanges = p.clipTotal;
        progress({
          stage: "ai_tags",
          message: `${fileLabel}: extracting & saving ${totalRanges} clips…`,
          percent: 52,
          clipTotal: totalRanges,
        });
      }
      progress({
        stage: p.stage,
        message: `${fileLabel}: ${p.message}`,
        percent: Math.min(85, p.percent),
        clipIndex: p.clipIndex,
        clipTotal: (p.clipTotal ?? totalRanges) || undefined,
      });
    };

    // Per-segment pipeline callback — called by the splitter immediately after each clip is ready.
    // The file at localPath is deleted by the splitter after this callback returns.
    const onSegment = async (localPath: string, meta: Omit<VideoClipSegment, "buffer" | "localPath">) => {
      console.log(
        `[ArchiveUpload] onSegment clip ${meta.index + 1} (${formatTimecode(meta.startSec)}–${formatTimecode(meta.endSec)}, ${meta.durationSec.toFixed(2)}s) cancelled=${!uploadShouldContinue(jobId)()}`
      );
      if (!uploadShouldContinue(jobId)()) return;
      const storedDur = archiveStoredDurationSec(meta.durationSec);
      if (storedDur <= 0) {
        console.log(
          `[ArchiveUpload] skip clip ${meta.index + 1} (${formatTimecode(meta.startSec)}–${formatTimecode(meta.endSec)}): ` +
            `${meta.durationSec.toFixed(2)}s < ${minSavedArchiveClipSec()}s minimum`
        );
        return;
      }

      let clipBuffer: Buffer;
      try {
        clipBuffer = fs.readFileSync(localPath);
        console.log(`[ArchiveUpload] clip ${meta.index + 1} read ok (${(clipBuffer.length / 1024).toFixed(0)}KB)`);
      } catch (readErr) {
        console.error(`[ArchiveUpload] read failed for clip ${meta.index + 1}:`, (readErr as Error).message?.slice(0, 120));
        return;
      }

      const key = `media-archive/${input.archiveId}/${Date.now()}-clip${meta.index}-${Math.random().toString(36).slice(2, 10)}.mp4`;
      const fragmentNote = parentSource
        ? `Fragment uit ${parentSource} (${formatTimecode(meta.startSec)}–${formatTimecode(meta.endSec)})`
        : `Fragment ${formatTimecode(meta.startSec)}–${formatTimecode(meta.endSec)}`;
      const draftTitle = `${baseTitle} — clip ${meta.index + 1}`;

      // Use bulk mode for batches > 15 clips (faster, still full metadata per clip).
      const perClipAiTags = autoGenerateTags;
      const perClipAiBulk = perClipAiTags && (totalRanges || 999) > 15;
      let enriched: { title: string; tags: string[]; sourceNote: string | null };
      if (perClipAiTags) {
        try {
          enriched = await enrichArchiveAssetFields({
            buffer: clipBuffer,
            mimeType: "video/mp4",
            autoGenerateTags: true,
            baseTitle: draftTitle,
            userTags,
            sourceNote: fragmentNote,
            archiveNicheTags,
            parentFilename: input.filename,
            clipIndex: meta.index,
            userProvidedTitle,
            bulk: perClipAiBulk,
          });
        } catch {
          enriched = { title: draftTitle, tags: userTags, sourceNote: fragmentNote };
        }
      } else {
        enriched = { title: draftTitle, tags: userTags, sourceNote: fragmentNote };
      }

      let url: string, storedKey: string;
      try {
        console.log(`[ArchiveUpload] clip ${meta.index + 1} uploading to storage (key=${key})`);
        ({ url, key: storedKey } = await storagePut(key, clipBuffer, "video/mp4"));
        console.log(`[ArchiveUpload] clip ${meta.index + 1} stored at url=${url} key=${storedKey}`);
      } catch (uploadErr) {
        console.error(`[ArchiveUpload] S3 upload failed for clip ${meta.index + 1}:`, (uploadErr as Error).message?.slice(0, 120));
        return;
      }

      let assetId: number | null | undefined;
      try {
        assetId = await createMediaArchiveAsset({
          archiveId: input.archiveId,
          title: enriched.title,
          mediaType: "video",
          mixKind,
          mimeType: "video/mp4",
          storageUrl: url,
          storageKey: storedKey,
          tags: enriched.tags,
          sourceNote: enriched.sourceNote,
          durationSec: storedDur,
          isActive: 1,
        });
      } catch (dbErr) {
        console.error(`[ArchiveUpload] DB insert failed for clip ${meta.index + 1}:`, (dbErr as Error).message?.slice(0, 120));
        return;
      }
      if (!assetId) return;

      scheduleArchiveEmbeddingIndex(assetId);
      scheduleClipEmbeddingFromBuffer(assetId, clipBuffer);

      // V2: schedule full intelligence pipeline (LLM annotation + quality + editorial analysis)
      if (process.env.ARCHIVE_INGESTION_V2_ENABLED !== "false") {
        scheduleIntelligencePipeline(assetId);
      }

      savedCount += 1;
      progress({
        stage: "save_clips",
        message: `${fileLabel}: clip ${savedCount} saved`,
        percent: 52 + Math.round((meta.index / Math.max(totalRanges, 1)) * 45),
        clipIndex: meta.index + 1,
        clipTotal: totalRanges || undefined,
        clipsSaved: savedCount,
      });
      try {
        const asset = await getMediaArchiveAssetById(assetId);
        if (asset) createdAssets.push(asset);
      } catch { /* ignore */ }
    };

    let segments: VideoClipSegment[];
    let splitCleanup: (() => void) | undefined;
    try {
      const splitResult = await splitVideoBySceneChanges(
        input.buffer,
        mimeType,
        onSplitProgress,
        uploadShouldContinue(jobId),
        { subjectContext, onSegment }
      );
      segments = splitResult.segments;
      splitCleanup = splitResult.cleanup;
      console.log(`[ArchiveUpload] split complete: ${segments.length} segment(s) returned, savedCount=${savedCount}`);
      // The original video buffer is no longer needed — clear reference so GC can reclaim it.
      (input as Record<string, unknown>).buffer = Buffer.alloc(0);
    } catch (err) {
      if (err instanceof ArchiveSplitError && isArchiveUploadCancelRequested(jobId)) {
        finishArchiveUploadJobCancelled(jobId);
        throw new ArchiveUploadError(
          400,
          appErrorMessage(APP_ERROR.SERVICE_ERROR, ARCHIVE_UPLOAD_CANCELLED_MESSAGE),
          true
        );
      }
      if (err instanceof ArchiveSplitError) {
        finishArchiveUploadJob(jobId, false, err.message);
        throw new ArchiveUploadError(400, appErrorMessage(APP_ERROR.SERVICE_ERROR, err.message));
      }
      const msg = (err as Error).message ?? "Scene split failed";
      finishArchiveUploadJob(jobId, false, msg);
      if (msg.includes("too long")) {
        throw new ArchiveUploadError(400, appErrorMessage(APP_ERROR.FILE_TOO_LARGE, msg));
      }
      throw err;
    }
    splitCleanup?.();

    if (segments.length >= 1) {
      throwIfUploadCancelled(jobId);
      assertSplitSegmentsValid(segments, autoSplitScenes);

      throwIfUploadCancelled(jobId);

      if (createdAssets.length === 0) {
        finishArchiveUploadJob(jobId, false, "No clips saved");
        throw new ArchiveUploadError(
          500,
          appErrorMessage(
            APP_ERROR.SERVICE_ERROR,
            "No clips saved — all segments contained editor text, did not match the archive subject, or split failed"
          )
        );
      }

      // V2: perceptual hash dedup — remove near-identical clips saved in this upload batch.
      if (process.env.ARCHIVE_INGESTION_V2_ENABLED !== "false") {
        void (async () => {
          try {
            const allAssets = await getMediaArchiveAssets(input.archiveId);
            if (allAssets.length < 2) return;
            const { deleteIds } = await dedupeArchiveVisualDuplicates(allAssets);
            if (deleteIds.length > 0) {
              await deleteMediaArchiveAssets(deleteIds);
              console.log(
                `[ArchiveUpload] V2 perceptual dedup: removed ${deleteIds.length} duplicate(s) from archive ${input.archiveId}`
              );
            }
          } catch (err) {
            console.warn(
              "[ArchiveUpload] perceptual dedup failed:",
              (err as Error).message?.slice(0, 100)
            );
          }
        })();
      }

      finishArchiveUploadJob(jobId, true, `${createdAssets.length} unique clip(s) saved`, {
        clipsSaved: createdAssets.length,
        clipTotal: segments.length,
      });

      return {
        assets: createdAssets,
        asset: createdAssets[0],
        clipCount: createdAssets.length,
        split: createdAssets.length > 1,
        aiTagged: autoGenerateTags,
      };
    }
  }

  if (isVideo && autoSplitScenes) {
    throw new ArchiveUploadError(
      400,
      appErrorMessage(APP_ERROR.SERVICE_ERROR, "Automatic splitting produced no clips.")
    );
  }

  throwIfUploadCancelled(jobId);

  progress({
    stage: "save_clips",
    message: `${fileLabel}: saving ${isVideo ? "video" : "image"}…`,
    percent: 92,
  });

  const mediaType = isVideo ? "video" as const : "image" as const;
  const ext = isVideo
    ? (mimeType.includes("webm") ? "webm" : mimeType.includes("quicktime") || mimeType.includes("mov") ? "mov" : "mp4")
    : (mimeType.includes("png") ? "png" : mimeType.includes("gif") ? "gif" : mimeType.includes("webp") ? "webp" : "jpg");
  const enriched = await enrichArchiveAssetFields({
    buffer: input.buffer,
    mimeType,
    autoGenerateTags,
    baseTitle,
    userTags,
    sourceNote: input.sourceNote?.trim() || null,
    archiveNicheTags,
    parentFilename: input.filename,
    userProvidedTitle,
  });
  const key = `media-archive/${input.archiveId}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const { url, key: storedKey } = await storagePut(key, input.buffer, mimeType);

  let assetId: number | null | undefined;
  try {
    assetId = await createMediaArchiveAsset({
      archiveId: input.archiveId,
      title: enriched.title,
      mediaType,
      mixKind,
      mimeType,
      storageUrl: url,
      storageKey: storedKey,
      tags: enriched.tags,
      sourceNote: enriched.sourceNote,
      durationSec: minSavedArchiveClipSec(),
      isActive: 1,
    });
  } catch (dbErr) {
    const cause = (dbErr as { cause?: { sqlMessage?: string; code?: string } }).cause;
    console.error("[ArchiveUpload] INSERT failed:", (dbErr as Error).message?.slice(0, 200), "cause:", cause?.code, cause?.sqlMessage);
    throw new ArchiveUploadError(500, appErrorMessage(APP_ERROR.SERVICE_ERROR,
      `DB insert failed: ${cause?.sqlMessage ?? cause?.code ?? (dbErr as Error).message?.slice(0, 120) ?? "unknown"}`));
  }
  if (!assetId) {
    throw new ArchiveUploadError(500, appErrorMessage(APP_ERROR.SERVICE_ERROR, "Failed to save asset"));
  }
  scheduleArchiveEmbeddingIndex(assetId);
  if (isVideo) scheduleClipEmbeddingFromBuffer(assetId, input.buffer);

  const asset = await getMediaArchiveAssetById(assetId);
  finishArchiveUploadJob(jobId, true, `${isVideo ? "Video" : "Image"} saved`, {
    clipsSaved: 1,
    clipTotal: 1,
  });
  return {
    asset,
    assets: asset ? [asset] : [],
    clipCount: 1,
    split: false,
    aiTagged: autoGenerateTags,
  };
}

function parseBoolQuery(value: unknown, defaultValue: boolean): boolean {
  if (value == null || value === "") return defaultValue;
  const s = String(value).toLowerCase();
  if (s === "1" || s === "true" || s === "yes") return true;
  if (s === "0" || s === "false" || s === "no") return false;
  return defaultValue;
}

async function handleArchiveBinaryUpload(req: Request, res: Response) {
  const jobId = String(req.query.jobId ?? "").trim() || undefined;
  const filename = String(req.query.filename ?? "upload").slice(0, 256);

  const uploadTimeoutMs = Math.round(archiveUploadRequestTimeoutMs());
  req.setTimeout(uploadTimeoutMs);
  res.setTimeout(uploadTimeoutMs);

  if (jobId) {
    initArchiveUploadJob(jobId, filename);
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: appErrorMessage(APP_ERROR.UNAUTHED, "Please login") });
      return;
    }
    if (user.role !== "admin") {
      res.status(403).json({ error: appErrorMessage(APP_ERROR.NOT_ADMIN, "You do not have required permission") });
      return;
    }

    const archiveId = parseInt(String(req.query.archiveId ?? ""), 10);
    if (!archiveId || Number.isNaN(archiveId)) {
      res.status(400).json({ error: appErrorMessage(APP_ERROR.SERVICE_ERROR, "archiveId is required") });
      return;
    }

    const rawBody = req.body;
    const buffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? []);
    patchArchiveUploadJob(jobId, {
      stage: "validating",
      message: `${filename}: ${Math.round(buffer.length / (1024 * 1024))}MB received — processing…`,
      percent: 2,
    });
    const mimeType = String(req.query.mimeType ?? req.headers["content-type"] ?? "").slice(0, 128);
    const tagsRaw = String(req.query.tags ?? "");
    const tags = tagsRaw ? normalizeMediaTags(tagsRaw.split(/[,;]+/)) : [];
    const mixKindRaw = String(req.query.mixKind ?? "");
    const mixKind = ["real_video", "photo", "stock", "screenshot", "motion_graphics"].includes(mixKindRaw)
      ? (mixKindRaw as ArchiveUploadInput["mixKind"])
      : undefined;

    const uploadInput: ArchiveUploadInput = {
      archiveId,
      buffer,
      mimeType,
      filename,
      tags,
      mixKind,
      autoSplitScenes: parseBoolQuery(req.query.autoSplitScenes, true),
      autoGenerateTags: parseBoolQuery(req.query.autoGenerateTags, true),
      jobId,
    };

    // Respond immediately so Railway/proxy does not 502 while split + AI filters run.
    res.status(202).json({
      accepted: true,
      jobId,
      message: "Upload received — processing in background",
    });

    void processArchiveAssetUpload(uploadInput)
      .then((result) => {
        finishArchiveUploadJob(jobId, true, `${result.clipCount} clip(s) saved`, {
          clipsSaved: result.clipCount,
          clipTotal: result.clipCount,
          resultClipCount: result.clipCount,
          resultSplit: result.split,
        });
      })
      .catch((err) => {
        if (err instanceof ArchiveUploadError) {
          if (err.cancelled) {
            finishArchiveUploadJobCancelled(jobId);
          } else {
            finishArchiveUploadJob(jobId, false, err.message);
          }
          return;
        }
        console.error("[ArchiveUpload] background processing failed:", err);
        finishArchiveUploadJob(
          jobId,
          false,
          (err as Error).message ?? appErrorMessage(APP_ERROR.SERVICE_ERROR, "Upload failed")
        );
      });
  } catch (err) {
    if (err instanceof ArchiveUploadError) {
      if (err.cancelled) {
        finishArchiveUploadJobCancelled(jobId);
      } else {
        finishArchiveUploadJob(jobId, false, err.message);
      }
      res.status(err.status).json({ error: err.message, cancelled: err.cancelled });
      return;
    }
    console.error("[ArchiveUpload] HTTP upload failed:", err);
    finishArchiveUploadJob(jobId, false, "Upload failed");
    res.status(500).json({ error: appErrorMessage(APP_ERROR.SERVICE_ERROR, "Upload failed") });
  }
}

async function handleArchiveUploadCancel(req: Request, res: Response) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: appErrorMessage(APP_ERROR.UNAUTHED, "Please login") });
      return;
    }
    if (user.role !== "admin") {
      res.status(403).json({ error: appErrorMessage(APP_ERROR.NOT_ADMIN, "You do not have required permission") });
      return;
    }

    const jobId = String(req.query.jobId ?? "").trim();
    if (!jobId) {
      res.status(400).json({ error: "jobId is required" });
      return;
    }

    const ok = requestArchiveUploadCancel(jobId);
    if (!ok) {
      res.status(404).json({ error: "No active upload found for this jobId" });
      return;
    }

    res.json({ success: true, jobId });
  } catch (err) {
    console.error("[ArchiveUpload] cancel failed:", err);
    res.status(500).json({ error: appErrorMessage(APP_ERROR.SERVICE_ERROR, "Cancel failed") });
  }
}

async function handleArchiveUploadProgress(req: Request, res: Response) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: appErrorMessage(APP_ERROR.UNAUTHED, "Please login") });
      return;
    }
    if (user.role !== "admin") {
      res.status(403).json({ error: appErrorMessage(APP_ERROR.NOT_ADMIN, "You do not have required permission") });
      return;
    }

    const jobId = String(req.query.jobId ?? "").trim();
    if (!jobId) {
      res.status(400).json({ error: "jobId is required" });
      return;
    }

    const job = getArchiveUploadJob(jobId);
    if (!job) {
      res.status(404).json({ error: "No active upload found for this jobId" });
      return;
    }

    res.json(job);
  } catch (err) {
    console.error("[ArchiveUpload] progress failed:", err);
    res.status(500).json({ error: appErrorMessage(APP_ERROR.SERVICE_ERROR, "Progress failed") });
  }
}

// Chunk size the client uses (10 MB). Each chunk passes through Railway's proxy easily.
const CHUNK_LIMIT = "12mb";

async function handleArchiveChunk(req: Request, res: Response) {
  const uploadId = String(req.query.uploadId ?? "").trim();
  const chunkIndex = parseInt(String(req.query.chunk ?? ""), 10);
  const filename = String(req.query.filename ?? "upload").slice(0, 256);

  if (!uploadId || isNaN(chunkIndex)) {
    res.status(400).json({ error: "uploadId and chunk are required" });
    return;
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) { res.status(401).json({ error: appErrorMessage(APP_ERROR.UNAUTHED, "Please login") }); return; }
    if (user.role !== "admin") { res.status(403).json({ error: appErrorMessage(APP_ERROR.NOT_ADMIN, "You do not have required permission") }); return; }

    const uploadBase =
      (process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() && fs.existsSync(process.env.RAILWAY_VOLUME_MOUNT_PATH.trim()))
        ? process.env.RAILWAY_VOLUME_MOUNT_PATH.trim()
        : fs.existsSync("/data") ? "/data" : os.tmpdir();

    const assembledPath = path.join(uploadBase, `fv-upload-${uploadId}.bin`);
    const chunkData: Buffer = req.body as Buffer;

    const stream = fs.createWriteStream(assembledPath, { flags: chunkIndex === 0 ? "w" : "a" });
    await new Promise<void>((resolve, reject) => {
      stream.on("finish", resolve);
      stream.on("error", reject);
      stream.end(chunkData);
    });

    console.log(`[ArchiveUpload] chunk ${chunkIndex} for ${uploadId} (${(chunkData.length / 1024).toFixed(0)}KB) → ${assembledPath}`);
    res.json({ ok: true, chunk: chunkIndex, filename });
  } catch (err) {
    console.error("[ArchiveUpload] chunk failed:", err);
    res.status(500).json({ error: appErrorMessage(APP_ERROR.SERVICE_ERROR, "Chunk upload failed") });
  }
}

async function handleArchiveAssemble(req: Request, res: Response) {
  const jobId = String(req.query.jobId ?? "").trim() || undefined;
  const filename = String(req.query.filename ?? "upload").slice(0, 256);
  const uploadId = String(req.query.uploadId ?? jobId ?? "").trim();

  if (jobId) initArchiveUploadJob(jobId, filename);

  try {
    const user = await getUserFromRequest(req);
    if (!user) { res.status(401).json({ error: appErrorMessage(APP_ERROR.UNAUTHED, "Please login") }); return; }
    if (user.role !== "admin") { res.status(403).json({ error: appErrorMessage(APP_ERROR.NOT_ADMIN, "You do not have required permission") }); return; }

    const archiveId = parseInt(String(req.query.archiveId ?? ""), 10);
    if (!archiveId || Number.isNaN(archiveId)) {
      res.status(400).json({ error: appErrorMessage(APP_ERROR.SERVICE_ERROR, "archiveId is required") });
      return;
    }

    const uploadBase =
      (process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() && fs.existsSync(process.env.RAILWAY_VOLUME_MOUNT_PATH.trim()))
        ? process.env.RAILWAY_VOLUME_MOUNT_PATH.trim()
        : fs.existsSync("/data") ? "/data" : os.tmpdir();

    const assembledBin = path.join(uploadBase, `fv-upload-${uploadId}.bin`);
    if (!fs.existsSync(assembledBin)) {
      res.status(400).json({ error: appErrorMessage(APP_ERROR.SERVICE_ERROR, "No chunks found — upload may have failed") });
      return;
    }

    const mimeType = String(req.query.mimeType ?? "video/mp4").slice(0, 128);
    const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("quicktime") || mimeType.includes("mov") ? "mov" : "mp4";
    const finalPath = assembledBin.replace(/\.bin$/, `.${ext}`);
    fs.renameSync(assembledBin, finalPath);

    const fileSizeMb = Math.round(fs.statSync(finalPath).size / (1024 * 1024));
    console.log(`[ArchiveUpload] assembled ${fileSizeMb}MB → ${finalPath}`);
    patchArchiveUploadJob(jobId, { stage: "validating", message: `${filename}: ${fileSizeMb}MB received — processing…`, percent: 2 });

    const tagsRaw = String(req.query.tags ?? "");
    const tags = tagsRaw ? normalizeMediaTags(tagsRaw.split(/[,;]+/)) : [];
    const mixKindRaw = String(req.query.mixKind ?? "");
    const mixKind = ["real_video", "photo", "stock", "screenshot", "motion_graphics"].includes(mixKindRaw)
      ? (mixKindRaw as ArchiveUploadInput["mixKind"])
      : undefined;

    const buffer = fs.readFileSync(finalPath);
    const cleanupFinal = () => { try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch { /* ignore */ } };

    res.status(202).json({ accepted: true, jobId, message: "Processing started" });

    const uploadInput: ArchiveUploadInput = {
      archiveId,
      buffer,
      mimeType,
      filename,
      tags,
      mixKind,
      autoSplitScenes: parseBoolQuery(req.query.autoSplitScenes, true),
      autoGenerateTags: parseBoolQuery(req.query.autoGenerateTags, true),
      jobId,
    };

    void processArchiveAssetUpload(uploadInput)
      .then((result) => {
        finishArchiveUploadJob(jobId, true, `${result.clipCount} clip(s) saved`, {
          clipsSaved: result.clipCount, clipTotal: result.clipCount,
          resultClipCount: result.clipCount, resultSplit: result.split,
        });
        cleanupFinal();
      })
      .catch((err) => {
        cleanupFinal();
        if (err instanceof ArchiveUploadError) {
          err.cancelled ? finishArchiveUploadJobCancelled(jobId) : finishArchiveUploadJob(jobId, false, err.message);
          return;
        }
        console.error("[ArchiveUpload] assemble processing failed:", err);
        finishArchiveUploadJob(jobId, false, (err as Error).message ?? appErrorMessage(APP_ERROR.SERVICE_ERROR, "Upload failed"));
      });
  } catch (err) {
    console.error("[ArchiveUpload] assemble failed:", err);
    finishArchiveUploadJob(jobId, false, "Upload failed");
    res.status(500).json({ error: appErrorMessage(APP_ERROR.SERVICE_ERROR, "Assemble failed") });
  }
}

/** Register before express.json() — chunks use raw middleware; assemble triggers processing. */
export function registerArchiveUploadRoute(app: Express) {
  const bodyLimitMb = Math.ceil(maxArchiveUploadBytes() / (1024 * 1024)) + 32;
  app.get("/api/admin/archive/upload/progress", handleArchiveUploadProgress);
  app.post("/api/admin/archive/upload/cancel", handleArchiveUploadCancel);
  // Chunked upload routes — each chunk is ≤12MB, well under Railway proxy limits
  app.post("/api/admin/archive/upload/chunk", express.raw({ type: () => true, limit: CHUNK_LIMIT }), handleArchiveChunk);
  app.post("/api/admin/archive/upload/assemble", handleArchiveAssemble);
  // Legacy single-request route (works for small files <~100MB)
  app.post(
    "/api/admin/archive/upload",
    express.raw({ type: () => true, limit: `${bodyLimitMb}mb` }),
    handleArchiveBinaryUpload
  );
}
