/**
 * Media archive upload — shared logic for tRPC and direct binary HTTP upload.
 */
import type { Express, Request, Response } from "express";
import express from "express";
import { APP_ERROR, appErrorMessage } from "@shared/appErrors";
import {
  applySharedAiToClipFields,
  enrichArchiveAssetFields,
  generateArchiveAssetAiMetadata,
  inferArchiveMediaMime,
} from "./archiveAssetTagging";
import { archiveClipHasBakedEditText } from "./archiveClipFilter";
import {
  ArchiveSplitError,
  formatTimecode,
  mapPool,
  maxArchiveUploadBytes,
  MIN_SPLIT_VIDEO_SEC,
  splitVideoBySceneChanges,
  type ArchiveSplitProgress,
  type VideoClipSegment,
} from "./archiveVideoSplitter";
import {
  finishArchiveUploadJob,
  getArchiveUploadJob,
  initArchiveUploadJob,
  patchArchiveUploadJob,
} from "./archiveUploadProgress";
import { getUserFromRequest } from "./_core/context";
import {
  createMediaArchiveAsset,
  getMediaArchiveAssetById,
  getMediaArchiveById,
  normalizeMediaTags,
} from "./db";
import { storagePut } from "./storage";

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
    message: string
  ) {
    super(message);
    this.name = "ArchiveUploadError";
  }
}

/** Block single long clip when auto-split expected multiple shots but got the whole video. */
function assertSplitSegmentsValid(
  segments: VideoClipSegment[],
  autoSplitScenes: boolean
): void {
  if (!autoSplitScenes || segments.length !== 1) return;
  if (segments[0].durationSec <= MIN_SPLIT_VIDEO_SEC) return;
  // Partial fragment (e.g. only clean shot left after text filter) is valid.
  if (segments[0].startSec >= 0.5) return;

  throw new ArchiveUploadError(
    400,
    appErrorMessage(
      APP_ERROR.SERVICE_ERROR,
      "Automatisch knippen leverde maar 1 clip — geen betrouwbare shot-wisselingen. Probeer opnieuw of schakel automatisch knippen uit."
    )
  );
}

export async function processArchiveAssetUpload(input: ArchiveUploadInput): Promise<ArchiveUploadResult> {
  const jobId = input.jobId;
  const fileLabel = input.filename?.trim() || "upload";
  const progress = (patch: Parameters<typeof patchArchiveUploadJob>[1]) =>
    patchArchiveUploadJob(jobId, patch);

  progress({ stage: "validating", message: `${fileLabel}: bestand valideren…`, percent: 3 });

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
      segments = await splitVideoBySceneChanges(input.buffer, mimeType, onSplitProgress);
    } catch (err) {
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
      assertSplitSegmentsValid(segments, autoSplitScenes);

      progress({
        stage: "ai_tags",
        message: `${fileLabel}: AI-tags voor ${segments.length} clips…`,
        percent: 86,
        clipTotal: segments.length,
      });
      const sharedAi = autoGenerateTags
        ? await generateArchiveAssetAiMetadata(segments[0].buffer, "video/mp4", {
            archiveNicheTags,
            parentFilename: input.filename,
            userTags,
            clipLabel: "eerste fragment (tags gelden voor alle clips)",
          })
        : null;

      let savedCount = 0;
      progress({
        stage: "save_clips",
        message: `${fileLabel}: clips opslaan (0/${segments.length})…`,
        percent: 90,
        clipTotal: segments.length,
        clipsSaved: 0,
      });

      const createdAssets = (
        await mapPool(segments, 2, async (seg) => {
          if (await archiveClipHasBakedEditText(seg.buffer, "video/mp4", { clipCount: segments.length })) {
            console.log(
              `[ArchiveUpload] skip clip ${seg.index + 1} (${formatTimecode(seg.startSec)}–${formatTimecode(seg.endSec)}): baked edit text`
            );
            progress({
              stage: "filter_overlay",
              message: `${fileLabel}: clip ${seg.index + 1} overgeslagen (editor-tekst)`,
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
          const enriched = sharedAi
            ? applySharedAiToClipFields({
                baseTitle: draftTitle,
                userTags,
                sourceNote: fragmentNote,
                ai: sharedAi,
                clipIndex: seg.index,
                userProvidedTitle,
              })
            : await enrichArchiveAssetFields({
                buffer: seg.buffer,
                mimeType: "video/mp4",
                autoGenerateTags: false,
                baseTitle: draftTitle,
                userTags,
                sourceNote: fragmentNote,
                archiveNicheTags,
                parentFilename: input.filename,
                clipIndex: seg.index,
                userProvidedTitle,
              });
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
            durationSec: Math.round(seg.durationSec),
            isActive: 1,
          });
          if (!assetId) return null;
          savedCount += 1;
          progress({
            stage: "save_clips",
            message: `${fileLabel}: clip ${savedCount}/${segments.length} opgeslagen`,
            percent: 90 + Math.round((savedCount / segments.length) * 9),
            clipIndex: seg.index + 1,
            clipTotal: segments.length,
            clipsSaved: savedCount,
          });
          return getMediaArchiveAssetById(assetId);
        })
      ).filter((a): a is NonNullable<typeof a> => a != null);

      if (createdAssets.length === 0) {
        finishArchiveUploadJob(jobId, false, "Geen clips opgeslagen");
        throw new ArchiveUploadError(
          500,
          appErrorMessage(
            APP_ERROR.SERVICE_ERROR,
            "Geen clips opgeslagen — alle fragmenten bevatten editor-tekst of split mislukt"
          )
        );
      }

      finishArchiveUploadJob(jobId, true, `${createdAssets.length} clip(s) opgeslagen`, {
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
      appErrorMessage(APP_ERROR.SERVICE_ERROR, "Automatisch knippen leverde geen clips op.")
    );
  }

  if (await archiveClipHasBakedEditText(input.buffer, mimeType)) {
    throw new ArchiveUploadError(
      400,
      appErrorMessage(
        APP_ERROR.SERVICE_ERROR,
        "Deze upload bevat editor-tekst (titel/ondertitel overlay). Alleen puur beeldmateriaal toegestaan — tekst hoort in het editprogramma."
      )
    );
  }

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
    isActive: 1,
  });
  if (!assetId) {
    throw new ArchiveUploadError(500, appErrorMessage(APP_ERROR.SERVICE_ERROR, "Failed to save asset"));
  }

  const asset = await getMediaArchiveAssetById(assetId);
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
      message: `${filename}: ${Math.round(buffer.length / (1024 * 1024))}MB ontvangen — verwerken…`,
      percent: 2,
    });
    const mimeType = String(req.query.mimeType ?? req.headers["content-type"] ?? "").slice(0, 128);
    const tagsRaw = String(req.query.tags ?? "");
    const tags = tagsRaw ? normalizeMediaTags(tagsRaw.split(/[,;]+/)) : [];
    const mixKindRaw = String(req.query.mixKind ?? "");
    const mixKind = ["real_video", "photo", "stock", "screenshot", "motion_graphics"].includes(mixKindRaw)
      ? (mixKindRaw as ArchiveUploadInput["mixKind"])
      : undefined;

    const result = await processArchiveAssetUpload({
      archiveId,
      buffer,
      mimeType,
      filename,
      tags,
      mixKind,
      autoSplitScenes: parseBoolQuery(req.query.autoSplitScenes, true),
      autoGenerateTags: parseBoolQuery(req.query.autoGenerateTags, true),
      jobId,
    });

    res.json(result);
  } catch (err) {
    if (err instanceof ArchiveUploadError) {
      finishArchiveUploadJob(jobId, false, err.message);
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[ArchiveUpload] HTTP upload failed:", err);
    finishArchiveUploadJob(jobId, false, "Upload failed");
    res.status(500).json({ error: appErrorMessage(APP_ERROR.SERVICE_ERROR, "Upload failed") });
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
      res.status(404).json({ error: "Geen actieve upload gevonden voor dit jobId" });
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
  app.get("/api/admin/archive/upload/progress", handleArchiveUploadProgress);
  app.post(
    "/api/admin/archive/upload",
    express.raw({ type: () => true, limit: "620mb" }),
    handleArchiveBinaryUpload
  );
}
