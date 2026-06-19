/**
 * Archive health summary for /api/health and quality hints.
 */
import { getAllMediaArchives, getMediaArchiveAssets } from "./db";
import { summarizeClipAuditor } from "./clipBackgroundAuditor";

export type ArchiveHealthSummary = {
  archiveCount: number;
  totalAssets: number;
  assetsWithoutGeoTags: number;
  clipAuditor: Awaited<ReturnType<typeof summarizeClipAuditor>>;
  hint: string;
};

export async function summarizeArchiveHealth(): Promise<ArchiveHealthSummary> {
  const archives = await getAllMediaArchives();
  let totalAssets = 0;

  for (const archive of archives) {
    const assets = await getMediaArchiveAssets(archive.id);
    totalAssets += assets.length;
  }

  let hint = `${totalAssets} archiefclips — tags + achtergrond CLIP-audit.`;
  if (totalAssets === 0) {
    hint = "Geen archiefclips — upload footage met duidelijke titel en tags in het media-archief.";
  }

  const clipAuditor = await summarizeClipAuditor();
  if (clipAuditor.enabled && clipAuditor.pendingEstimate > 0) {
    hint += ` Achtergrond-check: ${clipAuditor.totalAudited} geaudit, ~${clipAuditor.pendingEstimate} wachtend.`;
  } else if (clipAuditor.enabled && clipAuditor.totalAudited > 0) {
    hint += ` Achtergrond-check: ${clipAuditor.passed}/${clipAuditor.totalAudited} OK.`;
  }

  return {
    archiveCount: archives.length,
    totalAssets,
    assetsWithoutGeoTags: 0,
    clipAuditor,
    hint,
  };
}

/** Run bulk geo-retag across all archives (optional admin script — not required for matching). */
export async function runBulkGeoRetagAllArchives(): Promise<{
  archives: number;
  processed: number;
  updated: number;
}> {
  const { bulkRetagArchiveGeo } = await import("./archiveBulkGeoRetag");
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
