/**
 * Check whether curated media archives have footage for a video topic.
 */
import { buildCuratedQueryTags } from "./curatedMediaSourcing";
import { getAllMediaArchives, getMediaArchiveAssets, normalizeMediaTags } from "./db";

export type ArchiveCoverageResult = {
  hasCoverage: boolean;
  matchingAssetCount: number;
  totalActiveAssets: number;
  nicheHint: string | null;
};

function tagsOverlap(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y || x.includes(y) || y.includes(x)) return true;
    }
  }
  return false;
}

export async function assessArchiveCoverageForPrompt(
  prompt: string,
  videoTitle?: string
): Promise<ArchiveCoverageResult> {
  const queryTags = buildCuratedQueryTags(
    { keywords: [], text: prompt, index: 0, searchQuery: prompt },
    { text: prompt, visualCue: prompt, pexelsQuery: videoTitle ?? prompt },
    videoTitle
  );

  const archives = (await getAllMediaArchives()).filter((a) => a.isActive === 1);
  let matchingAssetCount = 0;
  let totalActiveAssets = 0;
  let nicheHint: string | null = null;

  for (const archive of archives) {
    const nicheTags = normalizeMediaTags(archive.nicheTags ?? []);
    const archiveMatches =
      queryTags.length === 0 ||
      tagsOverlap(queryTags, nicheTags) ||
      queryTags.some((q) => archive.name.toLowerCase().includes(q));

    const assets = await getMediaArchiveAssets(archive.id);
    totalActiveAssets += assets.length;

    if (!archiveMatches) continue;

    for (const asset of assets) {
      const assetTags = normalizeMediaTags(asset.tags ?? []);
      const title = (asset.title ?? "").toLowerCase();
      const hit =
        queryTags.some((q) => title.includes(q) || assetTags.some((t) => t === q || t.includes(q) || q.includes(t))) ||
        queryTags.length === 0;
      if (hit) matchingAssetCount++;
    }

    if (archiveMatches && !nicheHint) nicheHint = archive.name;
  }

  const hasCoverage = matchingAssetCount >= 3 || (totalActiveAssets > 0 && matchingAssetCount >= 1);

  return { hasCoverage, matchingAssetCount, totalActiveAssets, nicheHint };
}
