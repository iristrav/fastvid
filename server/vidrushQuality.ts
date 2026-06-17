/**
 * Vidrush pacing, asset quality, geo-segment locks, and motion-graphics QA.
 */
import { extractMotionOverlayCandidates, type BeatLabelInput } from "./cinematicEffectsEngine";
import type { MotionOverlayPlan } from "./motionGraphicsLayer";
import { standardMontageCrossfadeSec } from "./motionGraphicsLayer";
import {
  archiveVisualMaxClipSec,
  archiveVisualMinClipSec,
  curatedArchiveOnlyVisuals,
} from "./sourcingPolicy";

export const VIDRUSH_OPENING_CLIP_SEC = 3.5;
export const VIDRUSH_STOCK_MIN_CLIP_SEC = 2.5;
export const VIDRUSH_MIN_SOURCE_VIDEO_SEC = 2.8;
export const VIDRUSH_MIN_STILL_WIDTH = 960;

export type BeatGeoRegion = "nl" | "us" | "both" | "neutral";

const NON_DOC_RE =
  /\b(simcity|simulation|isometric|3d render|3d model|video game|game footage|cgi render|mockup|illustration|infographic|cartoon|clip art|low poly|pixel art|suburban sprawl game|city builder|animated map|motion graphic template|green screen|screen recording|ui animation|logo animation|subscribe button|emoji|icon animation)\b/i;

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

/** Max clips that fit voice duration without sub-min flashes (accounts for xfade overlap). */
export function maxMontageClipsForVoiceSec(
  outDur: number,
  xfadeSec = standardMontageCrossfadeSec()
): number {
  const min = vidrushMinClipSec();
  if (outDur <= min + 0.05) return 1;
  const netPerClip = Math.max(0.55, min - xfadeSec * 0.92);
  return Math.max(1, Math.floor((outDur + xfadeSec * 0.35) / netPerClip));
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
  return curatedArchiveOnlyVisuals() ? 0.86 : 0.78;
}

export function isNonDocumentaryVisualHay(hay: string): boolean {
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
  const hay = (videoTitle ?? "").toLowerCase();
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
  return inferPrimaryGeoFromTitle(videoTitle);
}

/** Sticky segment — stay in NL or US block until beat explicitly switches. */
export function resolveSegmentGeoLock(
  beatRegion: BeatGeoRegion,
  priorLock: BeatGeoRegion | null,
  videoTitle?: string
): BeatGeoRegion {
  if (beatRegion === "nl" || beatRegion === "us") return beatRegion;
  if (beatRegion === "both") return priorLock ?? inferPrimaryGeoFromTitle(videoTitle);
  if (priorLock && priorLock !== "neutral" && priorLock !== "both") return priorLock;
  const fromTitle = inferPrimaryGeoFromTitle(videoTitle);
  return fromTitle === "both" ? "nl" : fromTitle;
}

const NL_MARKERS = [
  "netherlands", "holland", "dutch", "nederland", "amsterdam", "rotterdam", "utrecht",
  "gracht", "windmill", "molen", "haarlem", "den haag", "hague", "fietspad",
];
const US_MARKERS = [
  "united states", "usa", "america", "american", "new york", "nyc", "chicago",
  "los angeles", "washington", "usa downtown", "american city",
];

function hayHasAny(hay: string, markers: string[]): boolean {
  return markers.some((m) => hay.includes(m));
}

/** Reject clip when active segment lock conflicts (NL block ≠ US footage). */
export function isWrongRegionForSegmentLock(
  hay: string,
  activeLock: BeatGeoRegion | null
): boolean {
  if (!activeLock || activeLock === "neutral" || activeLock === "both") return false;
  const lower = hay.toLowerCase();
  const hasNl = hayHasAny(lower, NL_MARKERS);
  const hasUs = hayHasAny(lower, US_MARKERS);
  if (activeLock === "nl") return hasUs && !hasNl;
  if (activeLock === "us") return hasNl && !hasUs;
  return false;
}

/** Opening beat queries — real drone/video B-roll only, geo from title. */
export function buildVidrushOpeningQueries(videoTitle?: string, beatText?: string): string[] {
  const primary = inferPrimaryGeoFromTitle(videoTitle);
  if (primary === "nl" || (primary === "both" && !US_TITLE_RE.test(beatText ?? ""))) {
    return [
      "netherlands aerial drone landscape video",
      "amsterdam canals drone broll",
      "dutch city cycling street video",
      "netherlands windmill countryside video",
      "rotterdam skyline timelapse video",
    ];
  }
  if (primary === "us") {
    return [
      "united states city aerial drone video",
      "american downtown skyline timelapse",
      "usa urban street traffic broll",
      "new york city aerial video",
    ];
  }
  return [
    "city aerial drone establishing shot video",
    "urban skyline timelapse video",
    "downtown street broll video",
  ];
}

export function clipPassesVidrushOpeningGate(
  clipPath: string,
  sourceQuery = "",
  beatText = "",
  videoTitle?: string
): boolean {
  if (isNonDocumentaryClipPath(clipPath, sourceQuery, beatText)) return false;
  const hay = `${sourceQuery} ${pathBasename(clipPath)} ${beatText} ${videoTitle ?? ""}`.toLowerCase();
  if (isWrongRegionForSegmentLock(hay, inferPrimaryGeoFromTitle(videoTitle))) return false;
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
    console.warn(
      `[MotionGraphics QA] Scene ${sceneIndex}: ${warnings.length} candidate(s) missing — ${warnings.slice(0, 3).join("; ")}`
    );
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
