/**
 * Vision-detected geography vs beat/title requirements — hard reject wrong-country frames.
 */
import { resolveRequiredGeoTagsForBeat } from "./curatedMediaSourcing";
import { isWrongGeoForBeat } from "./visualBeatTags";
import { NL_GEO_SLUGS, US_GEO_SLUGS, FOREIGN_GEO_SLUGS } from "./worldGeoSlugs";
import type { BeatGeoRegion } from "./vidrushQuality";

export type VisionGeoDetection = {
  detectedPlaces: string[];
  showsMap: boolean;
  mapLabels: string[];
  wrongSubject: boolean;
};

function slugSetIncludes(tags: string[], pool: readonly string[]): boolean {
  return tags.some((t) => pool.some((p) => t === p || t.includes(p) || p.includes(t)));
}

function geoHitCount(
  asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">,
  required: string[]
): number {
  if (!required.length) return 0;
  const title = (asset.title ?? "").toLowerCase();
  const assetTags = (asset.tags ?? []).map((t) => t.toLowerCase());
  let hits = 0;
  for (const vt of required) {
    const v = vt.toLowerCase();
    if (title.includes(v)) hits += 2;
    for (const t of assetTags) {
      if (t === v || t.includes(v) || v.includes(t)) hits++;
    }
  }
  return hits;
}

function visionHay(detection: VisionGeoDetection): string {
  return [...detection.detectedPlaces, ...detection.mapLabels].join(" ").toLowerCase();
}

/** True when ENABLE_VISION_GEO_GATE is not false and required geo tags exist for this beat. */
export function visionGeoGateEnabled(): boolean {
  return process.env.ENABLE_VISION_GEO_GATE !== "false";
}

/** Hard reject when vision sees a map or place that conflicts with beat/title geography. */
export function visionDetectedGeoConflict(
  detection: VisionGeoDetection,
  beatText: string,
  videoTitle?: string,
  segmentLock?: BeatGeoRegion | null
): { conflict: boolean; reason?: string } {
  if (!visionGeoGateEnabled()) return { conflict: false };

  const required = resolveRequiredGeoTagsForBeat(beatText, videoTitle, segmentLock);
  if (required.length === 0) return { conflict: false };

  const places = detection.detectedPlaces.map((p) => p.trim()).filter((p) => p.length >= 2);
  const labels = detection.mapLabels.map((p) => p.trim()).filter((p) => p.length >= 2);
  const synthetic = {
    title: [...places, ...labels].join(" "),
    tags: labels.length > 0 ? labels : places,
  };

  if (detection.wrongSubject) {
    return { conflict: true, reason: "wrongSubject flagged by vision" };
  }

  if (synthetic.title.trim() && isWrongGeoForBeat(synthetic, required)) {
    return {
      conflict: true,
      reason: `vision places "${synthetic.title.slice(0, 80)}" vs required ${required.slice(0, 4).join(", ")}`,
    };
  }

  const hay = visionHay(detection);
  if (hay.trim()) {
    const needsNl = slugSetIncludes(required, NL_GEO_SLUGS);
    const needsUs = slugSetIncludes(required, US_GEO_SLUGS);
    const needsForeign = slugSetIncludes(required, FOREIGN_GEO_SLUGS) && !needsNl && !needsUs;

    const mentionsUs = US_GEO_SLUGS.some((m) => hay.includes(m));
    const mentionsNl = NL_GEO_SLUGS.some((m) => hay.includes(m));
    const mentionsForeign = FOREIGN_GEO_SLUGS.some((m) => hay.includes(m));

    if (needsNl && !needsUs && (mentionsUs || (mentionsForeign && !mentionsNl))) {
      return { conflict: true, reason: `vision shows non-NL geography in: ${hay.slice(0, 80)}` };
    }
    if (needsUs && !needsNl && (mentionsNl || (mentionsForeign && !mentionsUs))) {
      return { conflict: true, reason: `vision shows non-US geography in: ${hay.slice(0, 80)}` };
    }
    if (needsForeign && (mentionsUs || mentionsNl) && geoHitCount(synthetic, required) === 0) {
      return { conflict: true, reason: `vision shows US/NL on foreign-topic beat: ${hay.slice(0, 80)}` };
    }
  }

  if (detection.showsMap && labels.length > 0 && geoHitCount(synthetic, required) === 0) {
    return {
      conflict: true,
      reason: `map labels "${labels.slice(0, 3).join(", ")}" do not match required geo`,
    };
  }

  if (detection.showsMap && places.length > 0 && geoHitCount(synthetic, required) === 0) {
    return {
      conflict: true,
      reason: `map/place "${places.slice(0, 3).join(", ")}" does not match required geo`,
    };
  }

  return { conflict: false };
}
