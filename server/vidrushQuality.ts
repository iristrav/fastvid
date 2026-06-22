/**
 * Vidrush pacing, asset quality, geo-segment locks, and motion-graphics QA.
 */
import type { BeatLabelInput } from "./cinematicEffectsEngine";
import {
  extractMotionOverlayCandidates,
  standardMontageCrossfadeSec,
  type MotionOverlayPlan,
} from "./motionGraphicsLayer";
import {
  archiveVisualMaxClipSec,
  archiveVisualMinClipSec,
  curatedArchiveOnlyVisuals,
  vidrushDocumentaryQualityEnabled,
} from "./sourcingPolicy";
import { PIPELINE_ERROR, pipelineError } from "@shared/appErrors";
import { asVideoTitleString } from "./localClipVision";
import {
  extractBeatGeoPlaceTags,
  extractSalientBeatTokens,
  extractVisualSearchTags,
  inferVideoVisualTopic,
} from "./visualBeatTags";
import {
  NL_GEO_SLUGS,
  US_GEO_SLUGS,
  FOREIGN_GEO_SLUGS,
  hayHasGeoMarker,
} from "./worldGeoSlugs";

export const VIDRUSH_OPENING_CLIP_SEC = 3.5;
export const VIDRUSH_STOCK_MIN_CLIP_SEC = 2.5;
export const VIDRUSH_MIN_SOURCE_VIDEO_SEC = 2.8;
export const VIDRUSH_MIN_STILL_WIDTH = 960;

export type BeatGeoRegion = "nl" | "us" | "both" | "neutral";

const NON_DOC_RE =
  /\b(simcity|simulation|isometric|3d render|3d model|video game|game footage|cgi render|mockup|illustration|infographic|cartoon|clip art|low poly|pixel art|suburban sprawl game|city builder|animated map|motion graphic template|green screen|screen recording|ui animation|logo animation|subscribe button|emoji|icon animation)\b/i;

/** Off-topic stock/archive for modern city/geography documentaries. */
export const GEO_URBAN_OFFTOPIC_RE =
  /\b(ford\b|chevrolet|cadillac|gmc\b|buick\b|dealer(?:ship)?|auto dealer|car lot|used car|showroom|walgreens|cvs\b|drugstore|pharmacy|chemist|great depression|dust bowl|florida vintage|1929 crash|electrical cabinet|breaker panel|fuse box|switchgear|distribution board|electrical panel|control panel|headshot|portrait photo|studio portrait|passport photo|linkedin|vintage storefront|1950s store|1960s store|retro shop|five and dime|classic car lot|vintage america|classic america|auto repair|mechanic shop|gas station vintage|pump attendant|cash register|checkout counter|grocery aisle|supermarket interior|electrical engineer|technician at panel|fuse board|meter box|substation interior|electrical room|portrait of man|portrait of woman|generic portrait|close.?up face|talking head interview|news anchor desk|columbus ohio|columbus city|city council meeting|city council chamber|wisconsin capitol|wisconsin state capitol|state capitol building|capitol dome|legislative chamber|municipal council|town hall meeting|county board|alderman|city hall interior)\b/i;

/** Vintage US commercial/retail — wrong for NL/US city-comparison openings. */
const GEO_URBAN_OPENING_BLOCKED_RE =
  /\b(ford\b|chev(?:y|rolet)|cadillac|dealer(?:ship)?|auto dealer|car lot|used car|walgreens|cvs\b|drugstore|pharmacy|storefront|shop front|retail store|1950s|1960s|1970s|vintage america|classic america|great depression|florida vintage|gas station|mechanic|auto repair|showroom|classic car)\b/i;

export function isOffTopicGeoUrbanVisual(hay: string): boolean {
  if (!vidrushDocumentaryQualityEnabled()) return false;
  return GEO_URBAN_OFFTOPIC_RE.test(hay.toLowerCase());
}

export function isOffTopicGeoUrbanOpeningVisual(
  hay: string,
  primaryGeo: BeatGeoRegion
): boolean {
  if (isOffTopicGeoUrbanVisual(hay)) return true;
  if (primaryGeo !== "both" && primaryGeo !== "nl") return false;
  return GEO_URBAN_OPENING_BLOCKED_RE.test(hay.toLowerCase());
}

const NL_TITLE_RE = /\b(netherlands|nederland|dutch|holland|amsterdam)\b/i;
const US_TITLE_RE = /\b(u\.?s\.?|united states|america|american)\b/i;

/** Hard minimum on-screen time per montage clip (seconds). */
export function vidrushMinClipSec(): number {
  return Math.max(VIDRUSH_OPENING_CLIP_SEC, archiveVisualMinClipSec());
}

export function vidrushOpeningClipSec(): number {
  return Math.max(vidrushMinClipSec(), VIDRUSH_OPENING_CLIP_SEC);
}

export function vidrushClipFloorSec(clipIndex: number, sceneIndex = 0): number {
  if (sceneIndex === 0 && clipIndex === 0) return vidrushOpeningClipSec();
  return vidrushMinClipSec();
}

export function clampVidrushClipDuration(
  duration: number,
  clipIndex = 0,
  sceneIndex = 0
): number {
  const min = vidrushClipFloorSec(clipIndex, sceneIndex);
  const max = archiveVisualMaxClipSec();
  return Math.max(min, Math.min(max, duration));
}

export function enforceMontageDurationFloors(
  durations: number[],
  sceneIndex = 0
): number[] {
  return durations.map((d, i) => clampVidrushClipDuration(d, i, sceneIndex));
}

/**
 * Max montage clips for a voice duration (Vidrush min on-screen + xfade overlap).
 * Must cover voice at min clip length — archive first per beat, then Pexels as needed.
 */
export function maxMontageClipsForVoiceSec(
  outDur: number,
  xfadeSec = standardMontageCrossfadeSec()
): number {
  const min = vidrushMinClipSec();
  if (outDur <= min + 0.05) return 1;
  const netPerClip = Math.max(0.55, min - xfadeSec * 0.92);
  const pacingCap = Math.max(1, Math.floor((outDur + xfadeSec * 0.35) / netPerClip));
  // n*min - (n-1)*xfade >= outDur  →  enough clips when sources are short (Pexels backfill).
  const coverageMin = Math.max(2, Math.ceil((outDur - xfadeSec) / netPerClip));
  // +2 headroom: extra Pexels clips when probed sources run shorter than min hold.
  return Math.max(pacingCap, coverageMin) + 2;
}

export function maxDirectorBeatsForSceneDuration(sceneDurationSec: number, minSec?: number): number {
  const floor = minSec ?? vidrushMinClipSec();
  return Math.max(1, Math.floor(sceneDurationSec / floor));
}

export function montageSharpScaleChain(width: number, height: number): string {
  return (
    `scale=${width}:${height}:flags=lanczos:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x2a2a2a`
  );
}

export function vidrushStillPhotoScale(): number {
  return curatedArchiveOnlyVisuals() ? 0.86 : 0.72;
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

/** Sticky segment — stay in NL or US block until beat explicitly switches. */
export function resolveSegmentGeoLock(
  beatRegion: BeatGeoRegion,
  priorLock: BeatGeoRegion | null,
  videoTitle?: string
): BeatGeoRegion {
  if (beatRegion === "nl" || beatRegion === "us") return beatRegion;
  if (beatRegion === "both") {
    if (priorLock === "nl" || priorLock === "us") return priorLock;
    return "nl";
  }
  if (priorLock && priorLock !== "neutral" && priorLock !== "both") return priorLock;
  const fromTitle = inferPrimaryGeoFromTitle(videoTitle);
  return fromTitle === "both" ? "nl" : fromTitle;
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

/** Opening beat queries — real drone/video B-roll, topic- and geo-aware for any subject. */
export function buildVidrushOpeningQueries(videoTitle?: string, beatText?: string): string[] {
  const hay = `${videoTitle ?? ""} ${beatText ?? ""}`.trim();
  const topic = inferVideoVisualTopic(videoTitle, beatText);
  const queries: string[] = [];

  if (topic === "wwii") {
    queries.push(
      "world war ii archival footage establishing video",
      "1930s europe city street documentary broll",
      "historical war documentary aerial video",
      "black white archive city footage video"
    );
  } else if (topic === "cold_war") {
    queries.push(
      "cold war era city documentary footage video",
      "berlin wall archival broll video",
      "soviet bloc urban street documentary video"
    );
  }

  const primary = inferPrimaryGeoFromTitle(videoTitle);
  if (primary === "both") {
    queries.push(
      "netherlands city aerial drone establishing shot",
      "amsterdam canals drone video",
      "dutch cycling street modern city",
      "rotterdam skyline timelapse video",
      "american city skyline aerial drone",
      "usa downtown drone broll video",
      "city comparison aerial documentary"
    );
  } else if (primary === "nl") {
    queries.push(
      "netherlands aerial drone landscape video",
      "amsterdam canals drone broll",
      "dutch city cycling street video",
      "netherlands windmill countryside video",
      "rotterdam skyline timelapse video"
    );
  } else if (primary === "us") {
    queries.push(
      "united states city aerial drone video",
      "american downtown skyline timelapse",
      "usa urban street traffic broll",
      "new york city aerial video"
    );
  }

  const geoTags = extractBeatGeoPlaceTags(beatText ?? hay);
  for (const tag of geoTags.slice(0, 3)) {
    queries.push(`${tag} aerial drone documentary video`, `${tag} city street broll video`);
  }

  const visualTags = extractVisualSearchTags(hay, videoTitle).slice(0, 5);
  const salient = extractSalientBeatTokens(beatText ?? videoTitle ?? "").slice(0, 4);
  for (const tag of [...new Set([...visualTags, ...salient])]) {
    if (tag.length >= 4 && !/^(the|and|that|this|with|from|have|were|been)$/.test(tag)) {
      queries.push(`${tag} documentary establishing shot video`, `${tag} aerial broll video`);
    }
  }

  queries.push(
    "documentary establishing shot aerial video",
    "city aerial drone landscape video",
    "urban skyline timelapse video",
    "downtown street documentary broll video"
  );

  return [...new Set(queries.map((q) => q.trim()).filter((q) => q.length > 8))].slice(0, 14);
}

export function clipPassesVidrushOpeningGate(
  clipPath: string,
  sourceQuery = "",
  beatText = "",
  videoTitle?: string
): boolean {
  if (!vidrushDocumentaryQualityEnabled()) return true;
  if (isNonDocumentaryClipPath(clipPath, sourceQuery, beatText)) return false;
  const hay = `${sourceQuery} ${pathBasename(clipPath)} ${beatText} ${videoTitle ?? ""}`.toLowerCase();
  const titleGeo = inferPrimaryGeoFromTitle(videoTitle);
  if (titleGeo !== "neutral" && titleGeo !== "both" && isWrongRegionForSegmentLock(hay, titleGeo)) {
    return false;
  }
  if (
    isOffTopicGeoUrbanOpeningVisual(hay, titleGeo) &&
    !offTopicVisualAllowedForBeat(hay, beatText)
  ) {
    return false;
  }
  return true;
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

/**
 * Universal per-beat clip gate — all topics. Driven by beat + title anchors, not topic enum.
 */
export function clipPassesDocumentaryBeatGate(
  clipPath: string,
  sourceQuery = "",
  beatText = "",
  videoTitle?: string
): boolean {
  if (!vidrushDocumentaryQualityEnabled()) return true;
  if (isNonDocumentaryClipPath(clipPath, sourceQuery, beatText)) return false;
  const hay = `${sourceQuery} ${pathBasename(clipPath)} ${beatText} ${videoTitle ?? ""}`.toLowerCase();
  if (isOffTopicGeoUrbanVisual(hay) && !offTopicVisualAllowedForBeat(hay, beatText)) return false;
  const lockRegion = resolveBeatRegionLock(beatText, videoTitle);
  if (lockRegion !== "neutral" && lockRegion !== "both" && isWrongRegionForSegmentLock(hay, lockRegion)) {
    return false;
  }
  return true;
}

/** @deprecated Use clipPassesDocumentaryBeatGate — kept as alias for imports. */
export const clipPassesGeoUrbanBeatGate = clipPassesDocumentaryBeatGate;

/** Wikimedia / stock metadata gate — same rules as adoptClip, all topics. */
export function visualMetadataPassesBeatGate(
  metadataHay: string,
  beatText: string,
  videoTitle?: string
): boolean {
  if (!vidrushDocumentaryQualityEnabled()) return true;
  const hay = metadataHay.toLowerCase();
  if (isNonDocumentaryVisualHay(hay)) return false;
  if (isOffTopicGeoUrbanVisual(hay) && !offTopicVisualAllowedForBeat(hay, beatText)) return false;
  const lockRegion = resolveBeatRegionLock(beatText, videoTitle);
  if (lockRegion !== "neutral" && lockRegion !== "both" && isWrongRegionForSegmentLock(hay, lockRegion)) {
    return false;
  }
  return true;
}

function pathBasename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
}

/** Warn when voice contains overlay candidates but plan is empty. */
export function auditMotionGraphicsCoverage(
  beats: BeatLabelInput[],
  overlays: MotionOverlayPlan[]
): string[] {
  const warnings: string[] = [];
  const planned = new Set(overlays.map((o) => o.text.toLowerCase()));
  for (const beat of beats) {
    for (const c of extractMotionOverlayCandidates(beat.text, beat)) {
      if (!planned.has(c.text.toLowerCase())) {
        warnings.push(`overlay "${c.text}" not planned for beat "${beat.text.slice(0, 48)}…"`);
      }
    }
  }
  return warnings;
}

export function logMotionGraphicsQa(
  sceneIndex: number,
  beats: BeatLabelInput[],
  overlays: MotionOverlayPlan[]
): void {
  if (overlays.length > 0) {
    console.log(
      `[MotionGraphics QA] Scene ${sceneIndex}: ${overlays.length} overlay(s) planned [${overlays.map((o) => o.text).join(" | ")}]`
    );
    return;
  }
  const warnings = auditMotionGraphicsCoverage(beats, overlays);
  if (warnings.length > 0) {
    const msg = `[MotionGraphics QA] Scene ${sceneIndex}: ${warnings.length} candidate(s) missing — ${warnings.slice(0, 3).join("; ")}`;
    if (process.env.ENABLE_SCENE_CRITICAL_REVIEW !== "false" && vidrushDocumentaryQualityEnabled()) {
      throw pipelineError(PIPELINE_ERROR.NO_SCENES, msg);
    }
    console.warn(msg);
  }
}

/** Trim clip list to what voice duration can hold at Vidrush pacing. */
export function trimMontageDurationsToMaxClips(
  durations: number[],
  maxClips: number,
  sceneIndex = 0
): number[] {
  if (durations.length <= maxClips) return enforceMontageDurationFloors(durations, sceneIndex);
  const trimmed = durations.slice(0, maxClips);
  return enforceMontageDurationFloors(trimmed, sceneIndex);
}
