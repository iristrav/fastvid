/**
 * RONDE 118 — bring the assets that predate the preview check into line with it.
 *
 * The check itself now stands at every route INTO the archive, so nothing new can arrive without
 * a readable preview. That leaves the rows already in the table: written before the rule existed,
 * some of them the very assets whose previews the grid reports as broken.
 *
 * Deliberately not a delete. The archive is the user's own material and an unreadable preview is
 * not proof that the source is worthless — a storage backend can be misconfigured, a volume can
 * be detached, an old row can point at a file that a later migration moved. What it IS proof of
 * is that the asset must not be handed to a render as a candidate, and `isActive = 0` is the
 * column this schema already uses for exactly that: filterMediaArchiveAssets and every candidate
 * query filter on it.
 *
 * So a failing asset is deactivated with its reason recorded, and stays in the table where an
 * operator can see it, fix the storage, and run this again.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { getDb } from "./db";
import { mediaArchiveAssets } from "../drizzle/schema";
import { loadArchiveAssetFile } from "./archiveAssetLoad";
import { extractFrameAtFraction } from "./localClipVision";
import { verifyArchivePreview, type PreviewFailureReason } from "./archivePreviewCheck";

export type ArchivePreviewSweepResult = {
  scanned: number;
  /** Previews proven readable — previewCheckedAt stamped, left active. */
  verified: number;
  /** Previews that could not be read — deactivated with a reason. */
  deactivated: number;
  /** Rows whose file could not even be fetched to look at (left untouched, counted). */
  unreachable: number;
  byReason: Partial<Record<PreviewFailureReason | "load_failed", number>>;
};

/**
 * Check assets and mark the ones without a usable preview.
 *
 * Bounded by `limit` and resumable: a sweep over a large archive is meant to be run repeatedly
 * rather than to hold a connection open for an hour. `onlyUnchecked` (the default) skips rows a
 * previous run already proved good, so repeated runs converge instead of redoing the work.
 */
export async function sweepArchivePreviews(opts: {
  archiveId: number;
  ids?: number[];
  limit?: number;
  onlyUnchecked?: boolean;
}): Promise<ArchivePreviewSweepResult> {
  const result: ArchivePreviewSweepResult = {
    scanned: 0,
    verified: 0,
    deactivated: 0,
    unreachable: 0,
    byReason: {},
  };
  const db = await getDb();
  if (!db) return result;

  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const onlyUnchecked = opts.onlyUnchecked !== false;

  const where = [eq(mediaArchiveAssets.archiveId, opts.archiveId)];
  if (opts.ids?.length) where.push(inArray(mediaArchiveAssets.id, opts.ids));
  // Only look at assets that are currently considered usable — re-checking rows an operator has
  // already switched off would fight their decision.
  where.push(eq(mediaArchiveAssets.isActive, 1));
  if (onlyUnchecked) {
    where.push(
      or(isNull(mediaArchiveAssets.previewCheckedAt), isNull(mediaArchiveAssets.previewIssue))!
    );
  }

  const rows = await db
    .select()
    .from(mediaArchiveAssets)
    .where(and(...where))
    .limit(limit);

  for (const asset of rows) {
    result.scanned++;
    const mediaType = asset.mediaType === "image" ? "image" : "video";

    const loaded = await loadArchiveAssetFile(asset).catch(() => null);
    if (!loaded || !loaded.ok) {
      /**
       * The file could not be fetched at all. That is a storage problem rather than a verdict
       * about the asset, so it is counted and reported but NOT deactivated — an S3 outage must
       * not quietly disable half an archive.
       */
      result.unreachable++;
      result.byReason.load_failed = (result.byReason.load_failed ?? 0) + 1;
      continue;
    }

    try {
      const verdict = await verifyArchivePreview({
        localPath: loaded.result.localPath,
        mediaType,
        extractFrame: extractFrameAtFraction,
      });
      if (verdict.ok) {
        await db
          .update(mediaArchiveAssets)
          .set({ previewCheckedAt: new Date(), previewIssue: null })
          .where(eq(mediaArchiveAssets.id, asset.id));
        result.verified++;
        continue;
      }
      await db
        .update(mediaArchiveAssets)
        .set({ isActive: 0, previewCheckedAt: new Date(), previewIssue: verdict.reason })
        .where(eq(mediaArchiveAssets.id, asset.id));
      result.deactivated++;
      result.byReason[verdict.reason] = (result.byReason[verdict.reason] ?? 0) + 1;
      console.warn(
        `[PreviewSweep] asset=${asset.id} deactivated: ${verdict.reason}` +
          (verdict.detail ? ` (${verdict.detail})` : "")
      );
    } finally {
      loaded.result.cleanup?.();
    }
  }

  console.log(
    `[PreviewSweep] archive=${opts.archiveId} scanned=${result.scanned} verified=${result.verified} ` +
      `deactivated=${result.deactivated} unreachable=${result.unreachable}`
  );
  return result;
}
