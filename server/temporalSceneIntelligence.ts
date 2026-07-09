/**
 * Temporal Scene Intelligence Engine — Phase 7
 *
 * Reorganises existing ClipAnnotation data (timeline, faceTracks, objectTracks,
 * audioEvents, ocrTimeline, qualityMetrics, cinematicTags) into a structured
 * temporal profile that enables:
 *   - Per-second motion classification
 *   - Best N-second entry/window detection
 *   - Internal highlight detection (first explosion, first close-up, …)
 *   - Subject / object temporal tracking
 *   - Smart partial retrieval (use best 4 s of a 12 s clip)
 *   - Explainability (why this window, why this clip)
 *
 * All computation is pure / local — no LLM, no network, no FFmpeg in this module.
 * Heavy FFmpeg work stays in archiveIngestionV2.ts.
 *
 * Feature flag: TEMPORAL_SCENE_INTELLIGENCE_ENABLED (default: on)
 */

import type {
  ClipAnnotation,
  ClipSegment,
  FaceTrack,
  ObjectTrack,
  AudioEvent,
  OcrEntry,
  MicroEventType,
} from "../drizzle/annotationTypes";

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function temporalSceneEnabled(): boolean {
  return process.env.TEMPORAL_SCENE_INTELLIGENCE_ENABLED !== "false";
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** One distinct temporal event derived from a timeline segment. */
export type TemporalEvent = {
  startSec: number;
  endSec: number;
  subject: string;
  action: string;
  shotType: string;
  cameraMove: string;
  emotion: string;
  /** Micro-event type if this is a micro_event segment. */
  microEvent?: MicroEventType;
  /** 0–1 derived confidence (from segment quality / LLM confidence). */
  confidence: number;
};

/** Temporal presence of a person or object across the clip. */
export type SubjectTrack = {
  name: string;
  type: "person" | "object";
  firstSeenSec: number;
  lastSeenSec: number;
  totalVisibleSec: number;
  segments: Array<{ startSec: number; endSec: number }>;
  /** Whether this subject is the dominant visual focus of the clip. */
  isPrimary: boolean;
};

/** Camera movement classification for one time window. */
export type CameraSegment = {
  startSec: number;
  endSec: number;
  movement: "zoom" | "pan" | "tilt" | "tracking" | "handheld" | "drone" | "static" | "other";
};

/** Motion intensity for one time window. */
export type MotionSegment = {
  startSec: number;
  endSec: number;
  level: "low" | "medium" | "high";
  /** Raw motionLevel 0–100 if available. */
  rawScore?: number;
};

/** Dominant emotion for one time window. */
export type EmotionSegment = {
  startSec: number;
  endSec: number;
  emotion: string;
};

/** A notable internal moment worth highlighting. */
export type InternalHighlight = {
  /** Category of highlight. */
  type:
    | "first_close_up"
    | "first_face"
    | "first_explosion"
    | "first_fire"
    | "first_speech"
    | "first_applause"
    | "strongest_emotion"
    | "peak_motion"
    | "title_card"
    | "best_shot_quality"
    | "micro_event"
    | "audio_peak"
    | "ocr_text";
  timestampSec: number;
  description: string;
  confidence: number;
};

/** A scored time window (N-second span) within the clip. */
export type BestWindow = {
  startSec: number;
  endSec: number;
  durationSec: number;
  /** Composite quality + relevance score for this window (0–100). */
  score: number;
  /** Human-readable explanation for why this window was chosen. */
  reason: string;
};

/**
 * Full temporal profile for one clip.
 * All sub-arrays are derived at ingest time from existing ClipAnnotation fields.
 */
export type TemporalSceneProfile = {
  /** Temporal events derived from timeline segments. */
  events: TemporalEvent[];
  /** Subject (person + object) temporal tracks. */
  subjectTracks: SubjectTrack[];
  /** Per-segment camera movement classification. */
  cameraTimeline: CameraSegment[];
  /** Per-segment motion intensity. */
  motionTimeline: MotionSegment[];
  /** Per-segment emotion classification. */
  emotionTimeline: EmotionSegment[];
  /** OCR text with temporal placement (re-exported for quick access). */
  ocrTimeline: Array<{ text: string; startSec: number; endSec: number }>;
  /** Audio event timeline (re-exported for quick access). */
  audioTimeline: Array<{ type: string; startSec: number; endSec: number; confidence: number }>;
  /** Best N-second windows for common beat durations. */
  bestEntryPoints: BestWindow[];
  /** Notable internal moments suitable for teaser / highlight retrieval. */
  internalHighlights: InternalHighlight[];
  /** ISO timestamp when this profile was computed. */
  computedAt: string;
  /** Total clip duration used when building this profile. */
  durationSec: number;
};

// ─── Camera movement normaliser ───────────────────────────────────────────────

function normaliseCameraMove(raw?: string): CameraSegment["movement"] {
  if (!raw) return "static";
  const r = raw.toLowerCase();
  if (r.includes("zoom")) return "zoom";
  if (r.includes("pan")) return "pan";
  if (r.includes("tilt")) return "tilt";
  if (r.includes("track") || r.includes("dolly") || r.includes("follow")) return "tracking";
  if (r.includes("hand") || r.includes("shake") || r.includes("shaky")) return "handheld";
  if (r.includes("drone") || r.includes("aerial") || r.includes("crane")) return "drone";
  if (r.includes("static") || r.includes("still") || r.includes("tripod")) return "static";
  return "other";
}

// ─── Motion level from segment / clip ────────────────────────────────────────

function motionLevelFromScore(score: number): MotionSegment["level"] {
  if (score >= 60) return "high";
  if (score >= 25) return "medium";
  return "low";
}

// ─── buildTemporalEvents ─────────────────────────────────────────────────────

function buildTemporalEvents(annotation: ClipAnnotation): TemporalEvent[] {
  const tl = annotation.timeline;
  if (!tl || tl.length === 0) return [];

  return tl.map((seg: ClipSegment) => ({
    startSec: seg.startSec,
    endSec: seg.endSec,
    subject: (seg.persons?.join(", ") || seg.objects?.join(", ") || annotation.primarySubject || "").slice(0, 80),
    action: (annotation.actions?.[0] ?? ""),
    shotType: seg.shotType || annotation.cinematography?.shotType || "",
    cameraMove: seg.cameraMovement || annotation.cameraMovementDetail || annotation.cinematography?.cameraMovement || "",
    emotion: seg.emotion || annotation.emotion || "",
    microEvent: seg.microEventType,
    confidence: 0.8,
  }));
}

// ─── buildSubjectTracks ───────────────────────────────────────────────────────

export function buildSubjectTracks(annotation: ClipAnnotation, durationSec: number): SubjectTrack[] {
  const tracks: SubjectTrack[] = [];

  // Persons from faceTracks
  for (const ft of (annotation.faceTracks ?? [])) {
    const segs: Array<{ startSec: number; endSec: number }> = [
      { startSec: ft.firstAppearsSec, endSec: ft.lastAppearsSec },
    ];
    tracks.push({
      name: ft.name,
      type: "person",
      firstSeenSec: ft.firstAppearsSec,
      lastSeenSec: ft.lastAppearsSec,
      totalVisibleSec: ft.lastAppearsSec - ft.firstAppearsSec,
      segments: segs,
      isPrimary: ft.isPrimarySubject,
    });
  }

  // Objects from objectTracks
  for (const ot of (annotation.objectTracks ?? [])) {
    const start = ot.startSec ?? 0;
    const end = ot.endSec ?? durationSec;
    tracks.push({
      name: ot.object,
      type: "object",
      firstSeenSec: start,
      lastSeenSec: end,
      totalVisibleSec: end - start,
      segments: [{ startSec: start, endSec: end }],
      isPrimary: false,
    });
  }

  return tracks;
}

// ─── buildCameraTimeline ──────────────────────────────────────────────────────

export function buildCameraTimeline(annotation: ClipAnnotation): CameraSegment[] {
  const tl = annotation.timeline;
  if (!tl || tl.length === 0) {
    // Fall back to clip-level camera movement
    const clipDur = 0; // unknown here, caller fills in
    return [{
      startSec: 0,
      endSec: clipDur,
      movement: normaliseCameraMove(annotation.cameraMovementDetail || annotation.cinematography?.cameraMovement),
    }];
  }

  return tl.map((seg: ClipSegment) => ({
    startSec: seg.startSec,
    endSec: seg.endSec,
    movement: normaliseCameraMove(seg.cameraMovement || annotation.cameraMovementDetail || annotation.cinematography?.cameraMovement),
  }));
}

// ─── buildMotionTimeline ──────────────────────────────────────────────────────

export function buildMotionTimeline(annotation: ClipAnnotation): MotionSegment[] {
  const tl = annotation.timeline;
  const clipMotion = annotation.motionLevel ?? 50;

  if (!tl || tl.length === 0) {
    return [{ startSec: 0, endSec: 0, level: motionLevelFromScore(clipMotion), rawScore: clipMotion }];
  }

  // Use clip-level motion as the baseline — per-segment overrides not stored yet
  return tl.map((seg: ClipSegment) => ({
    startSec: seg.startSec,
    endSec: seg.endSec,
    level: motionLevelFromScore(clipMotion),
    rawScore: clipMotion,
  }));
}

// ─── buildEmotionTimeline ─────────────────────────────────────────────────────

export function buildEmotionTimeline(annotation: ClipAnnotation): EmotionSegment[] {
  const tl = annotation.timeline;
  if (!tl || tl.length === 0) {
    return [{ startSec: 0, endSec: 0, emotion: annotation.emotion || "" }];
  }

  return tl.map((seg: ClipSegment) => ({
    startSec: seg.startSec,
    endSec: seg.endSec,
    emotion: seg.emotion || annotation.emotion || "",
  }));
}

// ─── detectInternalHighlights ─────────────────────────────────────────────────

export function detectInternalHighlights(annotation: ClipAnnotation): InternalHighlight[] {
  const highlights: InternalHighlight[] = [];
  const tl = annotation.timeline ?? [];
  const audioEvs = annotation.audioEvents ?? [];
  const ocrTl = annotation.ocrTimeline ?? [];

  // First close-up shot
  const firstCloseUp = tl.find(
    (s) => s.shotType && (s.shotType.includes("close") || s.shotType.includes("extreme"))
  );
  if (firstCloseUp) {
    highlights.push({
      type: "first_close_up",
      timestampSec: firstCloseUp.startSec,
      description: `Close-up shot at ${firstCloseUp.startSec.toFixed(1)}s: "${firstCloseUp.description?.slice(0, 60)}"`,
      confidence: 0.85,
    });
  }

  // First visible face
  const firstFace = (annotation.faceTracks ?? []).slice().sort((a, b) => a.firstAppearsSec - b.firstAppearsSec)[0];
  if (firstFace) {
    highlights.push({
      type: "first_face",
      timestampSec: firstFace.firstAppearsSec,
      description: `${firstFace.name} first appears at ${firstFace.firstAppearsSec.toFixed(1)}s`,
      confidence: firstFace.confidence ?? 0.7,
    });
  }

  // First explosion / fire from micro events
  for (const seg of tl) {
    if (seg.microEventType === "explosion") {
      highlights.push({
        type: "first_explosion",
        timestampSec: seg.startSec,
        description: `Explosion detected at ${seg.startSec.toFixed(1)}s`,
        confidence: 0.9,
      });
      break;
    }
    if (seg.microEventType === "fire_appears") {
      highlights.push({
        type: "first_fire",
        timestampSec: seg.startSec,
        description: `Fire appears at ${seg.startSec.toFixed(1)}s`,
        confidence: 0.85,
      });
      break;
    }
  }

  // First speech / applause from audio
  const firstSpeech = audioEvs.find((e) => e.type === "speech" && e.startSec != null);
  if (firstSpeech) {
    highlights.push({
      type: "first_speech",
      timestampSec: firstSpeech.startSec!,
      description: `Speech detected at ${(firstSpeech.startSec!).toFixed(1)}s`,
      confidence: firstSpeech.confidence,
    });
  }
  const firstApplause = audioEvs.find((e) => e.type === "applause" && e.startSec != null);
  if (firstApplause) {
    highlights.push({
      type: "first_applause",
      timestampSec: firstApplause.startSec!,
      description: `Applause at ${(firstApplause.startSec!).toFixed(1)}s`,
      confidence: firstApplause.confidence,
    });
  }

  // Strongest emotion segment
  const STRONG_EMOTIONS = ["grief", "triumph", "chaos", "fear", "panic", "celebration", "rage", "awe"];
  const emotionSeg = tl.find(
    (s) => s.emotion && STRONG_EMOTIONS.some((e) => s.emotion!.toLowerCase().includes(e))
  );
  if (emotionSeg) {
    highlights.push({
      type: "strongest_emotion",
      timestampSec: emotionSeg.startSec,
      description: `Strong emotion (${emotionSeg.emotion}) at ${emotionSeg.startSec.toFixed(1)}s`,
      confidence: 0.75,
    });
  }

  // First OCR text appearance
  const firstOcr = ocrTl.slice().sort((a, b) => a.startSec - b.startSec)[0] as OcrEntry | undefined;
  if (firstOcr) {
    highlights.push({
      type: "ocr_text",
      timestampSec: firstOcr.startSec,
      description: `Text on screen: "${firstOcr.text.slice(0, 50)}" at ${firstOcr.startSec.toFixed(1)}s`,
      confidence: 0.9,
    });
  }

  // Title card from micro events
  const titleCard = tl.find((s) => s.microEventType === "title_card_appears");
  if (titleCard) {
    highlights.push({
      type: "title_card",
      timestampSec: titleCard.startSec,
      description: `Title card at ${titleCard.startSec.toFixed(1)}s`,
      confidence: 0.85,
    });
  }

  // Best shot quality segment (highest technical quality proxy = establishing or wide + static)
  const qualitySeg = tl.find(
    (s) =>
      s.shotType &&
      (s.shotType.includes("wide") || s.shotType.includes("establishing")) &&
      (s.cameraMovement === "static" || !s.cameraMovement)
  );
  if (qualitySeg) {
    highlights.push({
      type: "best_shot_quality",
      timestampSec: qualitySeg.startSec,
      description: `High-quality ${qualitySeg.shotType} at ${qualitySeg.startSec.toFixed(1)}s`,
      confidence: 0.7,
    });
  }

  return highlights;
}

// ─── scoreWindowForRetrieval ──────────────────────────────────────────────────

/**
 * Score a specific time window [startSec, endSec] for retrieval against beatText.
 * Uses existing segment quality signals — no LLM, no network.
 * Returns 0–100.
 */
export function scoreWindowForRetrieval(
  annotation: ClipAnnotation,
  startSec: number,
  endSec: number,
  beatText?: string
): number {
  const tl = annotation.timeline ?? [];
  if (tl.length === 0) return 50;

  // Find segments that overlap this window
  const overlapping = tl.filter(
    (s) => s.endSec > startSec && s.startSec < endSec
  );
  if (overlapping.length === 0) return 30;

  let score = 50;
  const dur = endSec - startSec;

  // Bonus for close-up or medium shots
  const hasCloseUp = overlapping.some(
    (s) => s.shotType && (s.shotType.includes("close") || s.shotType.includes("medium"))
  );
  if (hasCloseUp) score += 10;

  // Bonus for named persons present
  const hasPersons = overlapping.some((s) => (s.persons?.length ?? 0) > 0);
  if (hasPersons) score += 8;

  // Bonus for strong emotion
  const STRONG = ["triumph", "grief", "chaos", "fear", "awe", "celebration"];
  const hasEmotion = overlapping.some(
    (s) => s.emotion && STRONG.some((e) => s.emotion!.toLowerCase().includes(e))
  );
  if (hasEmotion) score += 7;

  // Bonus for micro events
  const hasMicro = overlapping.some((s) => s.microEventType);
  if (hasMicro) score += 8;

  // Penalty for very long window (prefers tight windows)
  if (dur > 10) score -= 5;

  // beatText keyword overlap bonus (crude but O(1))
  if (beatText) {
    const lowerBeat = beatText.toLowerCase();
    const keywordHits = overlapping.filter(
      (s) =>
        (s.description && lowerBeat.split(" ").some((w) => w.length > 4 && s.description.toLowerCase().includes(w))) ||
        (s.persons ?? []).some((p) => lowerBeat.includes(p.toLowerCase()))
    ).length;
    score += Math.min(10, keywordHits * 4);
  }

  return Math.max(0, Math.min(100, score));
}

// ─── computeBestWindows ───────────────────────────────────────────────────────

const WINDOW_DURATIONS = [3, 5, 8, 10];

/**
 * Find the best N-second window for each standard beat duration.
 * Steps through the clip in 0.5 s increments and scores each window.
 */
export function computeBestWindows(
  annotation: ClipAnnotation,
  durationSec: number,
  beatText?: string
): BestWindow[] {
  if (durationSec < 2) return [];

  const windows: BestWindow[] = [];

  for (const winDur of WINDOW_DURATIONS) {
    if (winDur > durationSec) continue;

    let bestStart = 0;
    let bestScore = -1;

    const step = 0.5;
    for (let s = 0; s + winDur <= durationSec; s += step) {
      const sc = scoreWindowForRetrieval(annotation, s, s + winDur, beatText);
      if (sc > bestScore) {
        bestScore = sc;
        bestStart = s;
      }
    }

    // Build reason from overlapping segments
    const overlapping = (annotation.timeline ?? []).filter(
      (seg) => seg.endSec > bestStart && seg.startSec < bestStart + winDur
    );
    const reason = overlapping.length > 0
      ? overlapping.map((s) => s.description?.slice(0, 40) ?? s.shotType).join("; ")
      : `Best ${winDur}s window at ${bestStart.toFixed(1)}s`;

    windows.push({
      startSec: bestStart,
      endSec: bestStart + winDur,
      durationSec: winDur,
      score: bestScore,
      reason: reason.slice(0, 120),
    });
  }

  return windows;
}

// ─── buildTemporalSceneProfile ────────────────────────────────────────────────

/**
 * Build the full TemporalSceneProfile from an existing ClipAnnotation.
 * Pure function — reads existing fields, writes nothing.
 *
 * Called as Stage 23 in the Archive Intelligence Pipeline.
 */
export function buildTemporalSceneProfile(
  annotation: ClipAnnotation,
  durationSec: number,
  beatText?: string
): TemporalSceneProfile {
  const tl = annotation.timeline ?? [];

  const events = buildTemporalEvents(annotation);
  const subjectTracks = buildSubjectTracks(annotation, durationSec);
  const cameraTimeline = buildCameraTimeline(annotation).map((cs) =>
    cs.endSec === 0 ? { ...cs, endSec: durationSec } : cs
  );
  const motionTimeline = buildMotionTimeline(annotation).map((ms) =>
    ms.endSec === 0 ? { ...ms, endSec: durationSec } : ms
  );
  const emotionTimeline = buildEmotionTimeline(annotation).map((es) =>
    es.endSec === 0 ? { ...es, endSec: durationSec } : es
  );

  const ocrTimeline = (annotation.ocrTimeline ?? []).map((e) => ({
    text: e.text,
    startSec: e.startSec,
    endSec: e.endSec,
  }));

  const audioTimeline = (annotation.audioEvents ?? [])
    .filter((e) => e.startSec != null)
    .map((e: AudioEvent) => ({
      type: e.type,
      startSec: e.startSec!,
      endSec: e.startSec! + (e.durationSec ?? 1),
      confidence: e.confidence,
    }));

  const internalHighlights = detectInternalHighlights(annotation);
  const bestEntryPoints = computeBestWindows(annotation, durationSec, beatText);

  // Log profile summary
  console.log(
    `[TemporalScene] built profile: ${events.length} events, ` +
    `${subjectTracks.length} tracks, ${internalHighlights.length} highlights, ` +
    `${bestEntryPoints.length} windows (${durationSec.toFixed(1)}s clip)`
  );

  return {
    events,
    subjectTracks,
    cameraTimeline,
    motionTimeline,
    emotionTimeline,
    ocrTimeline,
    audioTimeline,
    bestEntryPoints,
    internalHighlights,
    computedAt: new Date().toISOString(),
    durationSec,
  };
}

// ─── Smart partial retrieval helper ──────────────────────────────────────────

/**
 * Given a desired beat duration and an asset's temporalProfile,
 * return the best BestWindow to use for trimming (or null if full clip is best).
 *
 * Used by assetDirector / videoPipeline for smart partial retrieval.
 */
export function selectBestWindowForBeat(
  profile: TemporalSceneProfile | undefined | null,
  beatDuration: number
): BestWindow | null {
  if (!profile || profile.bestEntryPoints.length === 0) return null;
  if (beatDuration >= profile.durationSec) return null; // full clip fits

  // Find the window closest to the beat duration with highest score
  const candidates = profile.bestEntryPoints.filter(
    (w) => w.durationSec <= beatDuration + 1.5
  );
  if (candidates.length === 0) return null;

  return candidates.reduce((best, w) =>
    w.score > best.score ? w : best
  );
}
