/**
 * Geo / map-label extraction from archive vision tagging — blocks wrong-country assets at metadata layer.
 */
import { normalizeMediaTags } from "./db";
import { ALL_GEO_SLUGS, beatTextMentionsGeoSlug } from "./worldGeoSlugs";

export type ArchiveVisionGeoFields = {
  title?: string;
  description?: string;
  countries?: string[];
  cities?: string[];
  locations?: string[];
  mapLabels?: string[];
  visibleTextOnScreen?: string[];
};

/** Scan vision output for known geo slugs (maps, OCR labels, cities). */
export function extractGeoSlugsFromVisionPayload(parsed: ArchiveVisionGeoFields): string[] {
  const hay = [
    parsed.title ?? "",
    parsed.description ?? "",
    ...(parsed.countries ?? []),
    ...(parsed.cities ?? []),
    ...(parsed.locations ?? []),
    ...(parsed.mapLabels ?? []),
    ...(parsed.visibleTextOnScreen ?? []),
  ]
    .join(" ")
    .toLowerCase();

  if (!hay.trim()) return [];

  const hits: string[] = [];
  const sorted = [...ALL_GEO_SLUGS].sort((a, b) => b.length - a.length);
  for (const slug of sorted) {
    if (!beatTextMentionsGeoSlug(hay, slug)) continue;
    if (hits.some((h) => h.includes(slug) || slug.includes(h))) continue;
    hits.push(slug);
  }
  return hits.slice(0, 4);
}

/** Prepend geo slugs so pipeline geo-block sees Philadelphia/Kansas City before vision runs. */
export function mergeGeoSlugsIntoArchiveTags(tags: string[], geoSlugs: string[], maxTags: number): string[] {
  if (geoSlugs.length === 0) return normalizeMediaTags(tags).slice(0, maxTags);
  const geoTags = geoSlugs.map((s) => s.toLowerCase().trim()).filter((s) => s.length >= 2);
  const rest = tags.filter((t) => {
    const lower = t.toLowerCase();
    return !geoTags.some((g) => lower.includes(g) || g.includes(lower));
  });
  return normalizeMediaTags([...geoTags, ...rest]).slice(0, maxTags);
}

export function appendMapLabelsToSourceNote(
  sourceNote: string | null | undefined,
  mapLabels: string[] | undefined,
  geoSlugs: string[]
): string | null {
  const parts: string[] = [];
  if (mapLabels?.length) parts.push(`Map labels: ${mapLabels.slice(0, 6).join(", ")}`);
  if (geoSlugs.length) parts.push(`Geo: ${geoSlugs.join(", ")}`);
  if (parts.length === 0) return sourceNote?.trim() || null;
  const extra = parts.join(" | ");
  return sourceNote?.trim() ? `${sourceNote.trim()} | ${extra}` : extra;
}
