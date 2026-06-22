/**
 * Check whether curated media archives have footage for a video topic.
 */
import {
  buildCuratedQueryTags,
  rankArchivesForVisualQuery,
  resolveArchivesForVisualQuery,
} from "./curatedMediaSourcing";
import { getMediaArchiveAssets, normalizeMediaTags } from "./db";
import { asVideoTitleString } from "./stringCoercion";

export type ArchiveCoverageResult = {
  hasCoverage: boolean;
  matchingAssetCount: number;
  totalActiveAssets: number;
  nicheHint: string | null;
  autoArchiveNames: string[];
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
  const titleHay = asVideoTitleString(videoTitle ?? prompt);
  const topicAnchors = queryTags.filter((t) => titleHay.toLowerCase().includes(t));

  const routedArchives = await resolveArchivesForVisualQuery(queryTags, topicAnchors);
  const ranked = await rankArchivesForVisualQuery(queryTags, topicAnchors);
  const autoArchiveNames = ranked.filter((r) => r.score >= 8).map((r) => r.name);

  let matchingAssetCount = 0;
  let totalActiveAssets = 0;
  let nicheHint: string | null = autoArchiveNames[0] ?? ranked[0]?.name ?? null;

  for (const archive of routedArchives) {
    const assets = await getMediaArchiveAssets(archive.id);
    totalActiveAssets += assets.length;

    for (const asset of assets) {
      const assetTags = normalizeMediaTags(asset.tags ?? []);
      const title = (asset.title ?? "").toLowerCase();
      const hit =
        queryTags.some(
          (q) => title.includes(q) || assetTags.some((t) => t === q || t.includes(q) || q.includes(t))
        ) ||
        tagsOverlap(queryTags, assetTags) ||
        queryTags.length === 0;
      if (hit) matchingAssetCount++;
    }
  }

  const hasCoverage = matchingAssetCount >= 3 || (totalActiveAssets > 0 && matchingAssetCount >= 1);

  return { hasCoverage, matchingAssetCount, totalActiveAssets, nicheHint, autoArchiveNames };
}
