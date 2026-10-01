
import { vidrushDocumentaryQualityEnabled } from "./sourcingPolicy";
import { asVideoTitleString } from "./stringCoercion";
import { extractBeatGeoPlaceTags } from "./visualBeatTags";
import {
  NL_GEO_SLUGS,
  US_GEO_SLUGS,
  FOREIGN_GEO_SLUGS,
  hayHasGeoMarker,
} from "./worldGeoSlugs";

export const VIDRUSH_MIN_SOURCE_VIDEO_SEC = 2.8;
export const VIDRUSH_MIN_STILL_WIDTH = 960;

export type BeatGeoRegion = "nl" | "us" | "both" | "neutral";

const NON_DOC_RE =
  /\b(simcity|simulation|isometric|3d render|3d model|video game|game footage|cgi render|mockup|illustration|infographic|cartoon|clip art|low poly|pixel art|suburban sprawl game|city builder|animated map|motion graphic template|green screen|screen recording|ui animation|logo animation|subscribe button|emoji|icon animation)\b/i;

/** Off-topic stock/archive for modern city/geography documentaries. */
export const GEO_URBAN_OFFTOPIC_RE =
  /\b(ford\b|chevrolet|cadillac|gmc\b|buick\b|dealer(?:ship)?|auto dealer|car lot|used car|showroom|walgreens|cvs\b|drugstore|pharmacy|chemist|great depression|dust bowl|florida vintage|1929 crash|electrical cabinet|breaker panel|fuse box|switchgear|distribution board|electrical panel|control panel|headshot|portrait photo|studio portrait|passport photo|linkedin|vintage storefront|1950s store|1960s store|retro shop|five and dime|classic car lot|vintage america|classic america|auto repair|mechanic shop|gas station vintage|pump attendant|cash register|checkout counter|grocery aisle|supermarket interior|electrical engineer|technician at panel|fuse board|meter box|substation interior|electrical room|portrait of man|portrait of woman|generic portrait|close.?up face|talking head interview|news anchor desk|columbus ohio|columbus city|city council meeting|city council chamber|wisconsin capitol|wisconsin state capitol|state capitol building|capitol dome|legislative chamber|municipal council|town hall meeting|county board|alderman|city hall interior)\b/i;

export function isOffTopicGeoUrbanVisual(hay: string): boolean {
  if (!vidrushDocumentaryQualityEnabled()) return false;
  return GEO_URBAN_OFFTOPIC_RE.test(hay.toLowerCase());
}

const NL_TITLE_RE = /\b(netherlands|nederland|dutch|holland|amsterdam)\b/i;
const US_TITLE_RE = /\b(u\.?s\.?|united states|america|american)\b/i;

export function vidrushStillPhotoScale(): number {
  return 0.72;
}

export function isNonDocumentaryVisualHay(hay: string): boolean {
  if (!vidrushDocumentaryQualityEnabled()) return false;
  const lower = hay.toLowerCase();
  if (NON_DOC_RE.test(lower)) return true;
  if (/\b(isometric|top.?down)\b/.test(lower) && /\b(city|suburb|neighborhood|housing)\b/.test(lower)) {
    return true;
  }
  return false;
}

export function isNonDocumentaryClipPath(
  clipPath: string,
  sourceQuery = "",
  beatText = ""
): boolean {
  const hay = `${sourceQuery} ${clipPath} ${beatText}`.toLowerCase();
  return isNonDocumentaryVisualHay(hay);
}

export function inferPrimaryGeoFromTitle(videoTitle?: string): BeatGeoRegion {
  const hay = asVideoTitleString(videoTitle).toLowerCase();
  const wantsNl = NL_TITLE_RE.test(hay);
  const wantsUs = US_TITLE_RE.test(hay);
  if (wantsNl && wantsUs) return "both";
  if (wantsNl) return "nl";
  if (wantsUs) return "us";
  return "neutral";
}

/** Which geography this beat narrates — used for segment locking. */
export function inferBeatGeoRegion(beatText: string, videoTitle?: string): BeatGeoRegion {
  const lower = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  const wantsNl =
    /\b(netherlands|nederland|holland|dutch|amsterdam|rotterdam|utrecht|gracht|fietspad)\b/.test(lower);
  const wantsUs =
    /\b(united states|u\.?s\.?|america|american|usa|new york|los angeles|chicago|washington)\b/.test(lower);
  if (wantsNl && wantsUs) return "both";
  if (wantsNl) return "nl";
  if (wantsUs) return "us";
  const geoTags = extractBeatGeoPlaceTags(beatText);
  if (geoTags.some((t) => /netherlands|holland|dutch|nederland|amsterdam/.test(t))) return "nl";
  if (geoTags.some((t) => /america|usa|united states|american/.test(t))) return "us";
  return inferPrimaryGeoFromTitle(videoTitle);
}

/** Re-export for tests and legacy imports. */
export { FOREIGN_GEO_SLUGS as FOREIGN_PLACE_MARKERS } from "./worldGeoSlugs";

function hayHasAny(hay: string, markers: readonly string[]): boolean {
  return hayHasGeoMarker(hay, markers);
}

/** Reject clip when active segment lock conflicts (NL block ≠ US footage). */
export function isWrongRegionForSegmentLock(
  hay: string,
  activeLock: BeatGeoRegion | null
): boolean {
  if (!activeLock || activeLock === "neutral" || activeLock === "both") return false;
  const lower = hay.toLowerCase();
  const hasNl = hayHasAny(lower, NL_GEO_SLUGS);
  const hasUs = hayHasAny(lower, US_GEO_SLUGS);
  const hasForeign = hayHasAny(lower, FOREIGN_GEO_SLUGS);
  if (activeLock === "nl") {
    if (hasForeign && !hasNl) return true;
    if (hasUs && !hasNl) return true;
    return false;
  }
  if (activeLock === "us") {
    if (hasForeign && !hasUs && !hasNl) return true;
    if (hasNl && !hasUs) return true;
    return false;
  }
  return false;
}

/** When clip metadata matches off-topic patterns, allow only if the beat narrates that subject. */
export function offTopicVisualAllowedForBeat(visualHay: string, beatText: string): boolean {
  const beat = beatText.toLowerCase();
  if (/\b(ford|chev(?:y|rolet)|cadillac|dealer(?:ship)?|car lot|automotive|car\b|vehicle)\b/.test(visualHay)) {
    return /\b(ford|chev(?:y|rolet)|cadillac|dealer(?:ship)?|car\b|automotive|vehicle|showroom)\b/.test(beat);
  }
  if (/\b(city council|capitol|legislative|municipal council|town hall)\b/.test(visualHay)) {
    return /\b(council|capitol|legislative|government|municipal|politics|mayor|alderman)\b/.test(beat);
  }
  if (/\b(walgreens|cvs|drugstore|pharmacy|chemist)\b/.test(visualHay)) {
    return /\b(pharmacy|drugstore|chemist|retail store|shop)\b/.test(beat);
  }
  if (/\b(columbus|ohio|wisconsin)\b/.test(visualHay)) {
    return /\b(columbus|ohio|wisconsin)\b/.test(beat);
  }
  return false;
}

/** Active region lock from beat places first, then video title — any documentary topic. */
export function resolveBeatRegionLock(beatText: string, videoTitle?: string): BeatGeoRegion {
  const beatRegion = inferBeatGeoRegion(beatText, videoTitle);
  if (beatRegion === "nl" || beatRegion === "us") return beatRegion;
  if (beatRegion === "both") {
    const fromTitle = inferPrimaryGeoFromTitle(videoTitle);
    return fromTitle === "both" ? "neutral" : fromTitle;
  }
  const geoTags = extractBeatGeoPlaceTags(beatText);
  if (geoTags.length > 0) {
    const fromTitle = inferPrimaryGeoFromTitle(videoTitle);
    if (fromTitle !== "neutral" && fromTitle !== "both") return fromTitle;
  }
  return inferPrimaryGeoFromTitle(videoTitle);
}

