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
import { archiveClipHasBakedEditText } from "./archiveClipFilter";
import {
  archiveClipMatchesArchiveSubject,
  type ArchiveSubjectContext,
} from "./archiveClipRelevance";
import {
  buildArchiveFingerprintIndex,
  dedupeArchiveVisualDuplicates,
  dedupeSegmentsForArchiveUpload,
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
    let segments: VideoClipSegment[];
    const onSplitProgress = (p: ArchiveSplitProgress) => {
      progress({
        stage: p.stage,
        message: `${fileLabel}: ${p.message}`,
        percent: Math.min(85, p.percent),
        clipIndex: p.clipIndex,
        clipTotal: p.clipTotal,
      });
    };
    try {
      segments = await splitVideoBySceneChanges(
        input.buffer,
        mimeType,
        onSplitProgress,
        uploadShouldContinue(jobId),
        { subjectContext }
      );
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
        throw new ArchiveUploadError(
          400,
          appErrorMessage(APP_ERROR.FILE_TOO_LARGE, msg)
        );
      }
      throw err;
    }

    if (segments.length >= 1) {
      throwIfUploadCancelled(jobId);
      assertSplitSegmentsValid(segments, autoSplitScenes);

      const existingAssets = await getMediaArchiveAssets(input.archiveId);
      const archiveFingerIndex = await buildArchiveFingerprintIndex(existingAssets);
      const { kept: uniqueSegments, skipped: archiveDupes } = await dedupeSegmentsForArchiveUpload(
        segments,
        archiveFingerIndex,
        parentSource
      );
      if (uniqueSegments.length === 0) {
        finishArchiveUploadJob(jobId, false, "All clips were duplicates of existing archive footage");
        throw new ArchiveUploadError(
          400,
          appErrorMessage(
            APP_ERROR.SERVICE_ERROR,
            "All extracted clips were visual duplicates — nothing new to save. Use Remove duplicates on existing clips or upload different material."
          )
        );
      }
      segments = uniqueSegments;
      if (archiveDupes > 0) {
        console.log(`[ArchiveUpload] ${archiveDupes} duplicate clip(s) skipped before save`);
      }

      progress({
        stage: "ai_tags",
        message: `${fileLabel}: generating AI tags for ${segments.length} unique clips…`,
        percent: 86,
        clipTotal: segments.length,
      });
      const perClipAiTags = autoGenerateTags && segments.length <= 15;
      throwIfUploadCancelled(jobId);

      let savedCount = 0;
      progress({
        stage: "save_clips",
        message: `${fileLabel}: saving clips (0/${segments.length})…`,
        percent: 90,
        clipTotal: segments.length,
        clipsSaved: 0,
      });

      const createdAssets = (
        await mapPool(
          segments,
          3,
          async (seg) => {
            throwIfUploadCancelled(jobId);
            if (await archiveClipHasBakedEditText(seg.buffer, "video/mp4", { clipCount: segments.length })) {
            console.log(
              `[ArchiveUpload] skip clip ${seg.index + 1} (${formatTimecode(seg.startSec)}–${formatTimecode(seg.endSec)}): baked edit text`
            );
            progress({
              stage: "filter_overlay",
              message: `${fileLabel}: clip ${seg.index + 1} skipped (editor text)`,
              percent: 90 + Math.round((seg.index / segments.length) * 8),
              clipIndex: seg.index + 1,
              clipTotal: segments.length,
              clipsSaved: savedCount,
            });
            return null;
          }
            // Skip per-clip subject check for time-based fallback segments — these are
            // intervals of continuous footage where all clips share the same subject.
            if (!seg.timeFallback && !(await archiveClipMatchesArchiveSubject(seg.buffer, "video/mp4", subjectContext, { clipCount: segments.length }))) {
            console.log(
              `[ArchiveUpload] skip clip ${seg.index + 1} (${formatTimecode(seg.startSec)}–${formatTimecode(seg.endSec)}): off-topic for "${subjectContext.archiveName}"`
            );
            progress({
              stage: "filter_subject",
              message: `${fileLabel}: clip ${seg.index + 1} skipped (does not match archive subject)`,
              percent: 90 + Math.round((seg.index / segments.length) * 8),
              clipIndex: seg.index + 1,
              clipTotal: segments.length,
              clipsSaved: savedCount,
            });
            return null;
          }
          const storedDur = archiveStoredDurationSec(seg.durationSec);
          if (storedDur <= 0) {
            console.log(
              `[ArchiveUpload] skip clip ${seg.index + 1} (${formatTimecode(seg.startSec)}–${formatTimecode(seg.endSec)}): ` +
                `${seg.durationSec.toFixed(2)}s < ${minSavedArchiveClipSec()}s minimum`
            );
            progress({
              stage: "filter_duration",
              message: `${fileLabel}: clip ${seg.index + 1} skipped (shorter than ${minSavedArchiveClipSec()}s)`,
              percent: 90 + Math.round((seg.index / segments.length) * 8),
              clipIndex: seg.index + 1,
              clipTotal: segments.length,
              clipsSaved: savedCount,
            });
            return null;
          }
          const key = `media-archive/${input.archiveId}/${Date.now()}-clip${seg.index}-${Math.random().toString(36).slice(2, 10)}.mp4`;
          const fragmentNote = parentSource
            ? `Fragment uit ${parentSource} (${formatTimecode(seg.startSec)}–${formatTimecode(seg.endSec)})`
            : `Fragment ${formatTimecode(seg.startSec)}–${formatTimecode(seg.endSec)}`;
          const draftTitle = `${baseTitle} — clip ${seg.index + 1}`;
          const enriched = perClipAiTags
            ? await enrichArchiveAssetFields({
                buffer: seg.buffer,
                mimeType: "video/mp4",
                autoGenerateTags: true,
                baseTitle: draftTitle,
                userTags,
                sourceNote: fragmentNote,
                archiveNicheTags,
                parentFilename: input.filename,
                clipIndex: seg.index,
                userProvidedTitle,
              })
            : {
                title: draftTitle,
                tags: userTags,
                sourceNote: fragmentNote,
              };
          const { url } = await storagePut(key, seg.buffer, "video/mp4");
          const assetId = await createMediaArchiveAsset({
            archiveId: input.archiveId,
            title: enriched.title,
            mediaType: "video",
            mixKind,
            mimeType: "video/mp4",
            storageUrl: url,
            storageKey: key,
            tags: enriched.tags,
            sourceNote: enriched.sourceNote,
            durationSec: storedDur,
            isActive: 1,
          });
          if (!assetId) return null;
          scheduleArchiveEmbeddingIndex(assetId);
          scheduleClipEmbeddingFromBuffer(assetId, seg.buffer);
          savedCount += 1;
          progress({
            stage: "save_clips",
            message: `${fileLabel}: clip ${savedCount}/${segments.length} saved`,
            percent: 90 + Math.round((savedCount / segments.length) * 9),
            clipIndex: seg.index + 1,
            clipTotal: segments.length,
            clipsSaved: savedCount,
          });
          return getMediaArchiveAssetById(assetId);
          },
          uploadShouldContinue(jobId)
        )
      ).filter((a): a is NonNullable<typeof a> => a != null);

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

      void (async () => {
        try {
          const allAssets = await getMediaArchiveAssets(input.archiveId);
          if (allAssets.length < 2) return;
          const { deleteIds } = await dedupeArchiveVisualDuplicates(allAssets);
          if (deleteIds.length > 0) {
            await deleteMediaArchiveAssets(deleteIds);
            console.log(
              `[ArchiveUpload] post-upload dedup: removed ${deleteIds.length} duplicate(s) from archive ${input.archiveId}`
            );
          }
        } catch (err) {
          console.warn(
            "[ArchiveUpload] post-upload dedup failed:",
            (err as Error).message?.slice(0, 100)
          );
        }
      })();

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

  if (await archiveClipHasBakedEditText(input.buffer, mimeType)) {
    throw new ArchiveUploadError(
      400,
      appErrorMessage(
        APP_ERROR.SERVICE_ERROR,
        "This upload contains editor text (title/subtitle overlay). Only clean footage is allowed — add text in the editor instead."
      )
    );
  }
  if (!(await archiveClipMatchesArchiveSubject(input.buffer, mimeType, subjectContext))) {
    throw new ArchiveUploadError(
      400,
      appErrorMessage(
        APP_ERROR.SERVICE_ERROR,
        `This upload does not match the archive subject "${subjectContext.archiveName}". Check niche tags or choose different material.`
      )
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
  const { url } = await storagePut(key, input.buffer, mimeType);

  const assetId = await createMediaArchiveAsset({
    archiveId: input.archiveId,
    title: enriched.title,
    mediaType,
    mixKind,
    mimeType,
    storageUrl: url,
    storageKey: key,
    tags: enriched.tags,
    sourceNote: enriched.sourceNote,
    durationSec: minSavedArchiveClipSec(),
    isActive: 1,
  });
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

/** Register before express.json() — raw binary body, no base64 JSON bloat. */
export function registerArchiveUploadRoute(app: Express) {
  const bodyLimitMb = Math.ceil(maxArchiveUploadBytes() / (1024 * 1024)) + 32;
  app.get("/api/admin/archive/upload/progress", handleArchiveUploadProgress);
  app.post("/api/admin/archive/upload/cancel", handleArchiveUploadCancel);
  app.post(
    "/api/admin/archive/upload",
    express.raw({ type: () => true, limit: `${bodyLimitMb}mb` }),
    handleArchiveBinaryUpload
  );
}
