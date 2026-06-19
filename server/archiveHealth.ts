/**
 * Archive health summary for /api/health and quality hints.
 */
import { getAllMediaArchives, getMediaArchiveAssets } from "./db";
import { extractGeoSlugsFromVisionPayload } from "./archiveGeoTagging";

const GEO_TAG_HINT =
  /\b(amsterdam|rotterdam|berlin|paris|london|singapore|netherlands|dutch|german|france|usa|american|europe|asia)\b/i;

export type ArchiveHealthSummary = {
  archiveCount: number;
  totalAssets: number;
  assetsWithoutGeoTags: number;
  hint: string;
};

export async function summarizeArchiveHealth(): Promise<ArchiveHealthSummary> {
  const archives = await getAllMediaArchives();
  let totalAssets = 0;
  let assetsWithoutGeoTags = 0;

  for (const archive of archives) {
    const assets = await getMediaArchiveAssets(archive.id);
    for (const asset of assets) {
      totalAssets += 1;
      const hay = `${asset.title ?? ""} ${(asset.tags ?? []).join(" ")} ${asset.sourceNote ?? ""}`;
      const slugs = extractGeoSlugsFromVisionPayload({
        title: hay,
        description: asset.sourceNote ?? "",
        mapLabels: [],
        visibleTextOnScreen: [],
      });
      const hasGeo = slugs.length > 0 || GEO_TAG_HINT.test(hay);
      if (!hasGeo) assetsWithoutGeoTags += 1;
    }
  }

  let hint = "Archive OK for geo-tagged sourcing.";
  if (totalAssets === 0) {
    hint = "No archive assets — upload geo-tagged clips for better quality than stock.";
  } else if (assetsWithoutGeoTags > totalAssets * 0.4) {
    hint = `${assetsWithoutGeoTags}/${totalAssets} assets lack geo tags — run bulkGeoRetag or AUTO_ARCHIVE_GEO_RETAG_ON_START=true.`;
  } else if (assetsWithoutGeoTags > 0) {
    hint = `${assetsWithoutGeoTags} asset(s) without geo tags — bulk retag recommended.`;
  }

  return {
    archiveCount: archives.length,
    totalAssets,
    assetsWithoutGeoTags,
    hint,
  };
}

/** Run bulk geo-retag across all archives (worker startup / admin script). */
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
