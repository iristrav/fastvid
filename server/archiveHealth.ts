/**
 * Archive health summary for /api/health and quality hints.
 */
import { summarizeActiveArchiveCounts } from "./db";
import { summarizeClipAuditor } from "./clipBackgroundAuditor";

export type ArchiveHealthSummary = {
  archiveCount: number;
  totalAssets: number;
  assetsWithoutGeoTags: number;
  clipAuditor: Awaited<ReturnType<typeof summarizeClipAuditor>>;
  hint: string;
};

let cachedSummary: { at: number; data: ArchiveHealthSummary } | null = null;
const CACHE_MS = 120_000;

export async function summarizeArchiveHealth(): Promise<ArchiveHealthSummary> {
  const counts = await summarizeActiveArchiveCounts();
  const { archiveCount, totalAssets } = counts;

  let hint = `${totalAssets} archiefclips — tags + achtergrond CLIP-audit.`;
  if (totalAssets === 0) {
    hint = "Geen archiefclips — upload footage met duidelijke titel en tags in het media-archief.";
  }

  const clipAuditor = await summarizeClipAuditor(counts.videoAssets);
  if (clipAuditor.enabled && clipAuditor.pendingEstimate > 0) {
    hint += ` Achtergrond-check: ${clipAuditor.totalAudited} geaudit, ~${clipAuditor.pendingEstimate} wachtend.`;
  } else if (clipAuditor.enabled && clipAuditor.totalAudited > 0) {
    hint += ` Achtergrond-check: ${clipAuditor.passed}/${clipAuditor.totalAudited} OK.`;
  }

  return {
    archiveCount,
    totalAssets,
    assetsWithoutGeoTags: 0,
    clipAuditor,
    hint,
  };
}

/** Cached archive block for /api/health (Railway probes this often). */
export async function summarizeArchiveHealthCached(): Promise<ArchiveHealthSummary> {
  const now = Date.now();
  if (cachedSummary && now - cachedSummary.at < CACHE_MS) {
    return cachedSummary.data;
  }
  const data = await summarizeArchiveHealth();
  cachedSummary = { at: now, data };
  return data;
}

/** Run bulk geo-retag across all archives (optional admin script — not required for matching). */
export async function runBulkGeoRetagAllArchives(): Promise<{
  archives: number;
  processed: number;
  updated: number;
}> {
  const { bulkRetagArchiveGeo } = await import("./archiveBulkGeoRetag");
  const { getAllMediaArchives } = await import("./db");
  const archives = await getAllMediaArchives();
  let processed = 0;
  let updated = 0;
  for (const archive of archives) {
    const result = await bulkRetagArchiveGeo({ archiveId: archive.id });
    processed += result.processed;
    updated += result.updated;
  }
  return { archives: archives.length, processed, updated };
}
