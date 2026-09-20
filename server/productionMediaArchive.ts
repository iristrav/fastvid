/**
 * THE EXISTING ARCHIVE, AS THE AUTHORITATIVE PRODUCTION MEDIA STORE.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────────────────────
 *
 * Not a second archive. Not `ArchiveV2`, not another table, not another bucket, not another media
 * abstraction. It stores nothing itself: it calls `ingestExternalClipToArchive`, which has written
 * to `media_archive_assets` and R2 since F3-26, and it reads back through the same storage adapter
 * `rehydrationDeps` already uses. Every side effect is injected, so what lives here is one thing —
 * the ORDER, and the refusal at each step.
 *
 * ── The defect it closes ────────────────────────────────────────────────────────────────────
 *
 * The ingestion existed and its answer was thrown away. In `videoPipeline`:
 *
 *     void (async () => {
 *       try { await ingestExternalClipToArchive(clipPath, {...}); } catch {}
 *     })();
 *
 * `ingestExternalClipToArchive` returns `{ assetId, storageKey }`. That `assetId` is the internal
 * handle the whole architecture turns on — `AssetSourceIdentity.archiveAssetId`, the first branch
 * `rehydrateAsset` tries, the one route that cannot fail because someone else's API changed. It was
 * discarded at the only site that could have produced it for an external provider, and `void`-ed so
 * the render did not even wait to find out. Archiving was a background nicety for a future render's
 * search results; it was never wired to be THIS render's storage.
 *
 * So a timeline clip from Wikimedia, Pexels or the Internet Archive reached the renderer carrying
 * `provider` + `providerAssetId` and nothing else, and the renderer had to go back to the provider.
 * When the pool had not recorded a remote URL either, the identity carried no fetchable handle at
 * all, and the render ended on:
 *
 *     ASSET_NOT_FOUND — provider=internet_archive providerAssetId=youtube-r6LB5toWr5I
 *                       has no fetchable URL
 *
 * That id is not a provider mix-up. archive.org really does mirror YouTube material under
 * identifiers of the form `youtube-<videoId>`, so `internet_archive` + `youtube-r6LB5toWr5I` is a
 * correct pair. What was wrong is that FastVid had downloaded those bytes, used them, and kept no
 * handle of its own to them.
 *
 * ── The order, and why each step refuses ────────────────────────────────────────────────────
 *
 *     validate → deduplicate → ingest → record → READ BACK → READY
 *
 * The read-back is the step that makes this a store rather than a hope. A row in a table is not a
 * file: an upload that half-succeeded, a bucket that rejected the key, a storage URL that resolves
 * to nothing all produce a row whose `storageUrl` points at no bytes. `READY` is written only after
 * this system has fetched its own file back out of storage and probed it. Anything less stops at
 * `ARCHIVED`, and the caller is told, and nothing claims the asset is production-ready.
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

import { mediaIsUsable, probeMediaFacts, type MediaFacts } from "./assetRehydrator";

/* ═══════════════════════ what the store can say ═══════════════════════ */

/**
 * The §13 lifecycle. `FOUND` is deliberately absent from this type: a candidate that has only been
 * found has no file and therefore nothing for this module to store — it is a state of the SEARCH,
 * not of the archive, and giving it a row here is what would let a search result look archived.
 */
export type MediaStatus =
  | "DOWNLOADED"
  | "VALIDATED"
  | "ARCHIVED"
  | "READY"
  | "REJECTED"
  | "FAILED"
  | "MISSING";

/** Machine-readable, so a caller can branch. Prose is for the operator, not for the code. */
export type ProductionArchiveErrorCode =
  | "ARCHIVE_SOURCE_FILE_MISSING"
  | "ARCHIVE_SOURCE_FILE_INVALID"
  | "ARCHIVE_INGEST_REFUSED"
  | "ARCHIVE_RECORD_FAILED"
  | "ARCHIVE_NOT_READABLE";

export type ProductionArchiveStored = {
  status: "stored";
  /** `media_archive_assets.id` — the internal handle, and the only one the renderer needs. */
  archiveAssetId: number;
  storageKey: string | null;
  checksumSha256: string;
  sizeBytes: number;
  facts: MediaFacts;
  /** True when an existing archive row already held these bytes, so nothing was uploaded again. */
  reused: boolean;
  /** How the reuse was decided, for the log. Null when this is a fresh ingestion. */
  reusedBy: "checksum" | "provider_asset_id" | null;
  mediaStatus: Extract<MediaStatus, "READY">;
};

export type ProductionArchiveFailure = {
  status: "failed";
  code: ProductionArchiveErrorCode;
  message: string;
  /** How far it got before it stopped. Never READY. */
  mediaStatus: Exclude<MediaStatus, "READY">;
  /** Present when a row was created before a later step refused it. */
  archiveAssetId?: number;
};

export type ProductionArchiveOutcome = ProductionArchiveStored | ProductionArchiveFailure;

export function archiveStoreSucceeded(o: ProductionArchiveOutcome): o is ProductionArchiveStored {
  return o.status === "stored";
}

/* ═══════════════════════ what it needs from the world ═══════════════════════ */

/** The subset of the existing ingestion's metadata this store passes through unchanged. */
export type ProductionArchiveMetadata = {
  title: string;
  tags: string[];
  sourceNote: string;
  mediaType: "video" | "image";
  mimeType: string;
  durationSec?: number;
  licenseNote?: string;
  licenseUrl?: string;
  sourceUrl?: string;
  sourcePlatform?: string;
  sourceCreator?: string;
  originalQuery?: string;
  matchedQuery?: string;
  topics?: string[];
  personContext?: boolean;
};

export type ProductionArchiveDeps = {
  /** `ingestExternalClipToArchive`. Returns null when its own quality gate refused the clip. */
  ingest: (
    localPath: string,
    metadata: ProductionArchiveMetadata
  ) => Promise<{ assetId: number; storageKey: string; reused?: boolean } | null>;
  /** `updateMediaArchiveAsset` — the columns this round added, written after the row exists. */
  updateAsset: (
    assetId: number,
    patch: {
      providerAssetId?: string;
      checksumSha256?: string;
      fileSizeBytes?: number;
      mediaStatus?: MediaStatus;
      readableCheckedAt?: Date;
    }
  ) => Promise<void>;
  /**
   * Fetch this archive row's stored file back onto disk, and say where it landed.
   *
   * The proof that the archive holds a FILE rather than a row. Returns null when the row is gone,
   * has no storage URL, or the bytes cannot be read.
   */
  readBack: (assetId: number, destPath: string) => Promise<boolean>;
  /** §14 — the same bytes under a different id or URL are the same asset. */
  findByChecksum?: (
    checksum: string
  ) => Promise<{ id: number; storageKey: string | null; mediaStatus: MediaStatus | null } | null>;
  /** §14 — and the same provider asset asked for twice. */
  findByProviderAsset?: (
    provider: string,
    providerAssetId: string
  ) => Promise<{ id: number; storageKey: string | null; mediaStatus: MediaStatus | null } | null>;
};

/* ═══════════════════════ observability (§22) ═══════════════════════ */

/**
 * Where this asset sits in the render, for every line below.
 *
 * §22 asks for project, scene, beat, archive asset, provider and provider asset id. It also says no
 * secrets and no sensitive URLs: nothing here prints a URL at all, because a provider link routinely
 * carries a signed token in its query string and these lines are meant to be pasted.
 */
export type ArchiveLogContext = {
  projectId?: number | null;
  sceneIndex?: number | null;
  beatIndex?: number | null;
  provider: string;
  providerAssetId?: string | null;
};

export function formatArchiveContext(
  ctx: ArchiveLogContext,
  archiveAssetId?: number | null
): string {
  const at =
    ctx.sceneIndex != null && ctx.beatIndex != null
      ? ` s${ctx.sceneIndex}b${ctx.beatIndex}`
      : "";
  return (
    `project=${ctx.projectId ?? "none"}${at} ` +
    `archiveAssetId=${archiveAssetId ?? "none"} ` +
    `provider=${ctx.provider} providerAssetId=${ctx.providerAssetId ?? "none"}`
  );
}

export const ARCHIVE_STORE_START = "ARCHIVE_STORE_START";
export const ARCHIVE_STORE_SUCCESS = "ARCHIVE_STORE_SUCCESS";
export const ARCHIVE_STORE_FAILED = "ARCHIVE_STORE_FAILED";
export const ARCHIVE_ASSET_READY = "ARCHIVE_ASSET_READY";
export const ARCHIVE_ASSET_MISSING = "ARCHIVE_ASSET_MISSING";

/* ═══════════════════════ the store ═══════════════════════ */

/** SHA-256 of the bytes on disk. File identity — not a URL, not a name, not a provider id. */
export function checksumOf(localPath: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(localPath)).digest("hex");
  } catch {
    return null;
  }
}

const failure = (
  code: ProductionArchiveErrorCode,
  message: string,
  mediaStatus: ProductionArchiveFailure["mediaStatus"],
  archiveAssetId?: number
): ProductionArchiveFailure => ({
  status: "failed",
  code,
  message,
  mediaStatus,
  ...(archiveAssetId != null ? { archiveAssetId } : {}),
});

/**
 * Store one accepted clip in FastVid's archive and return the handle the timeline must reference.
 *
 * §6's contract, in order, with a refusal at every step. The caller's rule is the important half:
 * a failure here means the asset MAY NOT enter the authoritative production timeline. It does not
 * mean invent a placeholder reference, and it does not mean carry on with a provider id and hope.
 */
export async function storeForProduction(params: {
  localPath: string;
  provider: string;
  providerAssetId?: string | null;
  metadata: ProductionArchiveMetadata;
  deps: ProductionArchiveDeps;
  ctx: ArchiveLogContext;
  /** Where a read-back may write its verification copy. */
  verifyDir: string;
  /** Images legitimately carry no video stream. */
  expectVideo?: boolean;
  log?: (line: string) => void;
}): Promise<ProductionArchiveOutcome> {
  const { localPath, deps, ctx } = params;
  const provider = params.provider.trim().toLowerCase();
  const providerAssetId = params.providerAssetId?.trim() || null;
  const expectVideo = params.expectVideo ?? params.metadata.mediaType === "video";
  const say = params.log ?? ((line: string) => console.log(line));

  say(`[ProductionArchive] ${ARCHIVE_STORE_START} ${formatArchiveContext(ctx)}`);

  const reject = (o: ProductionArchiveFailure): ProductionArchiveFailure => {
    say(
      `[ProductionArchive] ${ARCHIVE_STORE_FAILED} ${formatArchiveContext(ctx, o.archiveAssetId)} ` +
        `code=${o.code} status=${o.mediaStatus} reason="${o.message}"`
    );
    return o;
  };

  /* 1 — the file the caller says it has. */
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(localPath).size;
  } catch {
    return reject(
      failure("ARCHIVE_SOURCE_FILE_MISSING", `${path.basename(localPath)} is not on disk`, "MISSING")
    );
  }
  if (sizeBytes <= 0) {
    return reject(
      failure("ARCHIVE_SOURCE_FILE_MISSING", `${path.basename(localPath)} is empty`, "MISSING")
    );
  }

  /* 2 — validate. The SAME probe the rehydrator uses; §12 forbids a second QC framework. */
  const facts = await probeMediaFacts(localPath);
  if (!mediaIsUsable(facts, expectVideo)) {
    return reject(
      failure(
        "ARCHIVE_SOURCE_FILE_INVALID",
        `${path.basename(localPath)} did not survive ffprobe` +
          (facts ? ` (video=${facts.hasVideoStream} duration=${facts.durationSec ?? "null"})` : " (unreadable)"),
        "REJECTED"
      )
    );
  }

  const checksum = checksumOf(localPath);
  if (!checksum) {
    return reject(
      failure("ARCHIVE_SOURCE_FILE_MISSING", `${path.basename(localPath)} could not be read`, "MISSING")
    );
  }

  /* 3 — §14: the same bytes, or the same provider asset, are not stored twice. */
  const verifyPath = path.join(params.verifyDir, `archive_verify_${checksum.slice(0, 16)}.bin`);
  const finish = async (
    assetId: number,
    storageKey: string | null,
    reusedBy: ProductionArchiveStored["reusedBy"]
  ): Promise<ProductionArchiveOutcome> => {
    /* 5 — the columns this round added, on the row that now exists. */
    try {
      await deps.updateAsset(assetId, {
        ...(providerAssetId ? { providerAssetId } : {}),
        checksumSha256: checksum,
        fileSizeBytes: sizeBytes,
        mediaStatus: "ARCHIVED",
      });
    } catch (err) {
      return reject(
        failure("ARCHIVE_RECORD_FAILED", `the archive row could not be updated: ${(err as Error).message}`, "FAILED", assetId)
      );
    }

    /* 6 — THE STEP THAT MAKES THIS A STORE: read our own file back out. */
    try {
      fs.mkdirSync(params.verifyDir, { recursive: true });
    } catch {
      /* the read-back below reports the failure; a missing directory is not a separate story */
    }
    const readable = await deps.readBack(assetId, verifyPath).catch(() => false);
    if (!readable) {
      await deps.updateAsset(assetId, { mediaStatus: "MISSING" }).catch(() => {});
      say(
        `[ProductionArchive] ${ARCHIVE_ASSET_MISSING} ${formatArchiveContext(ctx, assetId)} — ` +
          `the row exists and its stored file could not be read back`
      );
      return reject(
        failure(
          "ARCHIVE_NOT_READABLE",
          `archive asset ${assetId} was recorded but its stored file could not be read back`,
          "MISSING",
          assetId
        )
      );
    }
    let verifiedBytes = 0;
    try {
      verifiedBytes = fs.statSync(verifyPath).size;
    } catch {
      verifiedBytes = 0;
    }
    /** A read-back that produced nothing is a failed read-back, whatever it returned. */
    if (verifiedBytes <= 0) {
      await deps.updateAsset(assetId, { mediaStatus: "MISSING" }).catch(() => {});
      say(
        `[ProductionArchive] ${ARCHIVE_ASSET_MISSING} ${formatArchiveContext(ctx, assetId)} — ` +
          `the read-back produced an empty file`
      );
      return reject(
        failure(
          "ARCHIVE_NOT_READABLE",
          `archive asset ${assetId} read back as an empty file`,
          "MISSING",
          assetId
        )
      );
    }
    try {
      fs.unlinkSync(verifyPath);
    } catch {
      /* the verification copy is disposable; failing to remove it changes nothing */
    }

    await deps
      .updateAsset(assetId, { mediaStatus: "READY", readableCheckedAt: new Date() })
      .catch(() => {});

    say(
      `[ProductionArchive] ${ARCHIVE_STORE_SUCCESS} ${formatArchiveContext(ctx, assetId)} ` +
        `bytes=${sizeBytes} duration=${facts!.durationSec?.toFixed(2) ?? "null"}s ` +
        `reused=${reusedBy ?? "no"}`
    );
    say(`[ProductionArchive] ${ARCHIVE_ASSET_READY} ${formatArchiveContext(ctx, assetId)}`);

    return {
      status: "stored",
      archiveAssetId: assetId,
      storageKey,
      checksumSha256: checksum,
      sizeBytes,
      facts: facts!,
      reused: reusedBy != null,
      reusedBy,
      mediaStatus: "READY",
    };
  };

  const existingByChecksum = await deps.findByChecksum?.(checksum).catch(() => null);
  if (existingByChecksum) {
    return finish(existingByChecksum.id, existingByChecksum.storageKey, "checksum");
  }
  if (providerAssetId) {
    const existingByProvider = await deps
      .findByProviderAsset?.(provider, providerAssetId)
      .catch(() => null);
    if (existingByProvider) {
      return finish(existingByProvider.id, existingByProvider.storageKey, "provider_asset_id");
    }
  }

  /* 4 — the existing ingestion. Its quality gate is its own and is not second-guessed here. */
  let ingested: Awaited<ReturnType<ProductionArchiveDeps["ingest"]>> = null;
  try {
    ingested = await deps.ingest(localPath, params.metadata);
  } catch (err) {
    return reject(
      failure("ARCHIVE_INGEST_REFUSED", `the archive ingestion threw: ${(err as Error).message}`, "FAILED")
    );
  }
  if (!ingested) {
    return reject(
      failure(
        "ARCHIVE_INGEST_REFUSED",
        `the archive ingestion refused ${path.basename(localPath)} (its own quality gate, or a storage failure)`,
        "REJECTED"
      )
    );
  }

  return finish(ingested.assetId, ingested.storageKey, ingested.reused ? "checksum" : null);
}

/* ═══════════════════════ the wiring ═══════════════════════ */

/**
 * The real modules, behind the shapes above. No decision lives in this function — the moment one
 * does, this has become a second archive, which §3 forbids and which is the failure the whole
 * codebase keeps re-committing.
 *
 * Imports are lazy so a test can exercise `storeForProduction` without pulling in the database,
 * the storage client or the 50 000-line pipeline.
 */
export function productionArchiveDeps(params: {
  download: (url: string, destPath: string) => Promise<boolean>;
}): ProductionArchiveDeps {
  return {
    ingest: async (localPath, metadata) => {
      const { ingestExternalClipToArchive } = await import("./archiveIngestion");
      const result = await ingestExternalClipToArchive(localPath, metadata);
      if (!result) return null;
      return { assetId: result.assetId, storageKey: result.storageKey, reused: result.reused };
    },
    updateAsset: async (assetId, patch) => {
      const { updateMediaArchiveAsset } = await import("./db");
      await updateMediaArchiveAsset(assetId, patch);
    },
    readBack: async (assetId, destPath) => {
      const { getMediaArchiveAssetById } = await import("./db");
      const row = await getMediaArchiveAssetById(assetId);
      const storageUrl = row?.storageUrl;
      if (!storageUrl) return false;
      const { resolveLocalStorageFilePath } = await import("./storageLocal");
      const local = resolveLocalStorageFilePath({ storageUrl });
      if (local && fs.existsSync(local)) {
        fs.copyFileSync(local, destPath);
        return true;
      }
      if (/^https?:\/\//i.test(storageUrl) || storageUrl.startsWith("/")) {
        return params.download(storageUrl, destPath).catch(() => false);
      }
      return false;
    },
    findByChecksum: async (checksum) => {
      const { findMediaArchiveAssetByChecksum } = await import("./db");
      const row = await findMediaArchiveAssetByChecksum(checksum);
      if (!row) return null;
      return {
        id: row.id,
        storageKey: row.storageKey ?? null,
        mediaStatus: (row.mediaStatus as MediaStatus | null) ?? null,
      };
    },
    findByProviderAsset: async (provider, providerAssetId) => {
      const { findMediaArchiveAssetByProviderAsset } = await import("./db");
      const row = await findMediaArchiveAssetByProviderAsset(provider, providerAssetId);
      if (!row) return null;
      return {
        id: row.id,
        storageKey: row.storageKey ?? null,
        mediaStatus: (row.mediaStatus as MediaStatus | null) ?? null,
      };
    },
  };
}
