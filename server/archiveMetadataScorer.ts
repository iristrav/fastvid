/**
 * Archive Metadata Scorer v4 — uses all v3 annotation signals during retrieval.
 *
 * Provides additive bonus modifiers for the AssetDirector based on:
 *   - Segment-level embedding similarity (finds best temporal moment in clip)
 *   - Face presence, dominance, and close-up duration
 *   - Object movement direction matching
 *   - Audio event atmosphere matching
 *   - Cinematic tags matching expected visual style
 *   - Shot importance (iconic → bonus)
 *   - Visual uniqueness (tiebreaker)
 *
 * All bonuses are flat additive modifiers (+0 to +35 total max) applied on top
 * of the existing AssetDirector weighted score.
 *
 * No LLM calls. No network traffic. All computation is local on pre-stored metadata.
 * Feature flag: ARCHIVE_V4_METADATA_SCORING_ENABLED (default: "true")
 *
 * Integration:
 *   1. Call computeSegmentSimilarities() when building CandidateMeta (pipeline)
 *   2. computeArchiveMetadataScores() is called inside AssetDirector scoreCandidate()
 *   3. applySegmentTrimIfNeeded() is called after clip selection in videoPipeline
 */

import fs from "fs";
import path from "path";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import type {
  ClipAnnotation,
  FaceTrack,
  ObjectTrack,
  AudioEvent,
  ShotImportance,
  VisualUniqueness,
} from "../drizzle/annotationTypes";

const execPromise = promisify(execCb);

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function archiveV4ScoringEnabled(): boolean {
  return process.env.ARCHIVE_V4_METADATA_SCORING_ENABLED !== "false";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type SegmentSimilarity = {
  segmentIndex: number;
  startSec: number;
  endSec: number;
  similarity: number;
};

/** Recommendation to trim a clip to a specific time window. */
export type TrimHint = {
  startSec: number;
  endSec: number;
  segmentIndex: number;
  similarity: number;
  /** Human-readable reason for this trim. */
  reason: string;
};

export type ArchiveMetadataScores = {
  /** +0 to +6: best segment similarity bonus over clip-level similarity. */
  segmentBonus: number;
  /** +0 to +6: face dominance / close-up presence for the active entity. */
  faceBonus: number;
  /** +0 to +4: object movement matches expected direction / entry/exit. */
  objectBonus: number;
  /** +0 to +5: audio events match beat atmosphere expectations. */
  audioBonus: number;
  /** +0 to +6: cinematic tags match expected visual style from blueprint. */
  cinematicBonus: number;
  /** +0 to +5: shot importance bonus for iconic/unique clips. */
  importanceBonus: number;
  /** +0 to +3: visual uniqueness tiebreaker bonus. */
  uniquenessBonus: number;
  /** Sum of all bonuses (max ~35). */
  total: number;
  /** The best-matching temporal segment, used to produce a TrimHint. */
  bestSegment: SegmentSimilarity | null;
};

// ─── Cosine similarity ────────────────────────────────────────────────────────

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Segment similarity computation ──────────────────────────────────────────

const SEG_FILE_RE = /^(\d+)_seg_(\d+)\.json$/;

/**
 * Load segment embedding files for one asset and compute cosine similarity
 * against the beat embedding. Returns sorted by similarity (highest first).
 *
 * Called by the pipeline when building CandidateMeta — purely local I/O, no network.
 */
export function computeSegmentSimilarities(
  assetId: number,
  annotation: ClipAnnotation,
  beatEmbedding: number[],
  embeddingDir: string
): SegmentSimilarity[] {
  if (!archiveV4ScoringEnabled()) return [];
  if (!beatEmbedding || beatEmbedding.length === 0) return [];
  if (!annotation.timeline?.length) return [];

  const results: SegmentSimilarity[] = [];

  try {
    if (!fs.existsSync(embeddingDir)) return [];

    const segFiles = fs.readdirSync(embeddingDir).filter((f) => {
      const m = SEG_FILE_RE.exec(f);
      return m && parseInt(m[1]!, 10) === assetId;
    });

    for (const file of segFiles) {
      const m = SEG_FILE_RE.exec(file);
      if (!m) continue;
      const segIndex = parseInt(m[2]!, 10);
      const seg = annotation.timeline?.[segIndex];
      if (!seg) continue;

      try {
        const stored = JSON.parse(fs.readFileSync(path.join(embeddingDir, file), "utf8")) as {
          embedding?: number[];
          startSec?: number;
          endSec?: number;
        };
        if (!Array.isArray(stored.embedding) || stored.embedding.length !== beatEmbedding.length) continue;
        const similarity = cosineSim(beatEmbedding, stored.embedding);
        results.push({
          segmentIndex: segIndex,
          startSec: stored.startSec ?? seg.startSec,
          endSec: stored.endSec ?? seg.endSec,
          similarity,
        });
      } catch { /* corrupt file — skip */ }
    }
  } catch (err) {
    console.warn(
      `[ArchiveV4] segment similarity load failed for asset ${assetId}:`,
      (err as Error).message?.slice(0, 80)
    );
  }

  return results.sort((a, b) => b.similarity - a.similarity);
}

// ─── Scoring: segment bonus ───────────────────────────────────────────────────

/**
 * Award a bonus when the best segment embedding matches the beat much better
 * than the overall clip embedding. This identifies "needle in a haystack" clips
 * where only one segment is relevant.
 *
 * Returns: segmentBonus (0–6) + the best SegmentSimilarity (for TrimHint).
 */
function scoreSegmentMatch(
  segmentSimilarities: SegmentSimilarity[],
  clipLevelSim: number | null
): { bonus: number; best: SegmentSimilarity | null } {
  if (!segmentSimilarities.length) return { bonus: 0, best: null };

  const best = segmentSimilarities[0]!;
  const clipSim = clipLevelSim ?? 0.5; // neutral if unknown
  const delta = best.similarity - clipSim;

  if (delta <= 0.02) return { bonus: 0, best: null }; // not meaningfully better

  // Linear: +1 per 0.025 delta, capped at +6
  const bonus = Math.min(6, Math.round((delta / 0.025)));
  return { bonus, best };
}

// ─── Scoring: face bonus ──────────────────────────────────────────────────────

/**
 * Award a bonus when the requested person (active entity) is:
 *   - present in the clip at all            → +2
 *   - dominant (>30% of clip)               → +2 more
 *   - dominant (>60% of clip)               → +4 more (instead of +2)
 *   - present in close-up (>2 s)            → +2 more
 *   - is the primary subject                → +1 more
 *
 * Maximum: +6 (capped)
 */
function scoreFacePresence(
  activeEntity: string | null | undefined,
  faceTracks: FaceTrack[] | undefined
): number {
  if (!faceTracks?.length) return 0;

  // If no specific entity requested, reward clips with a primary-subject face
  if (!activeEntity) {
    const primary = faceTracks.find((f) => f.isPrimarySubject);
    if (primary && primary.dominanceFraction >= 0.5 && primary.closeUpDurationSec >= 2) return 3;
    return 0;
  }

  const entityTokens = activeEntity.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const match = faceTracks.find((f) => {
    const nameLower = f.name.toLowerCase();
    return entityTokens.some((t) => nameLower.includes(t));
  });

  if (!match) return 0;

  let bonus = 2; // present
  if (match.dominanceFraction > 0.6) bonus += 4;
  else if (match.dominanceFraction > 0.3) bonus += 2;
  if (match.closeUpDurationSec >= 2) bonus += 2;
  if (match.isPrimarySubject) bonus += 1;

  return Math.min(6, bonus);
}

// ─── Scoring: object movement bonus ──────────────────────────────────────────

const OBJECT_MOVEMENT_SIGNALS: Array<[RegExp, string[]]> = [
  [/enters?\s*(frame|beeld|shot)|komt\s*in\s*beeld/i, ["enters frame left", "enters frame right", "enters frame bottom", "enters frame"]],
  [/exits?\s*(frame|beeld)|verdwijnt\s*uit\s*beeld/i, ["exits frame left", "exits frame right", "exits frame"]],
  [/(approaches|towards|toward|naar camera|nadert)/i, ["approaches camera", "towards camera"]],
  [/(moves?\s*away|retreats?|weg van camera)/i, ["away from camera"]],
  [/left.{0,8}right|van links|links.{0,8}rechts/i, ["left→right"]],
  [/right.{0,8}left|van rechts|rechts.{0,8}links/i, ["right→left"]],
  [/(stationary|staat stil|beweegt niet|still)/i, ["stationary"]],
  [/(crosses?\s*frame|doorsteekt\s*beeld)/i, ["crosses frame"]],
];

/**
 * Award a bonus when the beat text requests specific object movements that
 * match the ObjectTrack data in the annotation.
 *
 * Maximum: +4
 */
function scoreObjectMovement(
  beatText: string,
  objectTracks: ObjectTrack[] | undefined
): number {
  if (!objectTracks?.length) return 0;

  let bonus = 0;
  for (const [pattern, movementVariants] of OBJECT_MOVEMENT_SIGNALS) {
    if (!pattern.test(beatText)) continue;
    const hasMatch = objectTracks.some((t) =>
      movementVariants.some((mv) => t.movement.toLowerCase().includes(mv.toLowerCase()) ||
                                    t.direction.toLowerCase().includes(mv.toLowerCase()))
    );
    if (hasMatch) bonus += 2;
  }

  return Math.min(4, bonus);
}

// ─── Scoring: audio bonus ─────────────────────────────────────────────────────

const AUDIO_KEYWORD_MAP: Array<{ beatKeywords: RegExp; eventTypes: string[]; bonus: number }> = [
  { beatKeywords: /\b(crowd|menigte|publiek|massa)\b/i,       eventTypes: ["crowd"],       bonus: 3 },
  { beatKeywords: /\b(speech|toespraak|address|redevoering)\b/i, eventTypes: ["speech"],   bonus: 3 },
  { beatKeywords: /\b(applaus|applause|cheering|gejuich)\b/i, eventTypes: ["applause", "crowd"], bonus: 3 },
  { beatKeywords: /\b(explosion|explosie|blast|bomb)\b/i,     eventTypes: ["loud event"],  bonus: 4 },
  { beatKeywords: /\b(music|muziek|anthem|hymn)\b/i,          eventTypes: ["music"],       bonus: 3 },
  { beatKeywords: /\b(silence|stilte|quiet|rustig)\b/i,       eventTypes: ["silence"],     bonus: 2 },
  { beatKeywords: /\b(gunfire|shots|schoten|shooting)\b/i,    eventTypes: ["loud event"],  bonus: 3 },
  { beatKeywords: /\b(engines?|motors?|aircraft|vliegtuig)\b/i, eventTypes: ["engines", "loud event"], bonus: 2 },
  { beatKeywords: /\b(radio|broadcast|uitzending)\b/i,        eventTypes: ["radio", "speech"], bonus: 2 },
  { beatKeywords: /\b(march|marching|drums?)\b/i,             eventTypes: ["music", "march"], bonus: 2 },
];

/**
 * Award a bonus when audio events in the clip match the atmosphere expected
 * by the beat text or explicitly requested audio types.
 *
 * Maximum: +5
 */
function scoreAudioMatch(
  beatText: string,
  audioEvents: AudioEvent[] | undefined,
  expectedAudioTypes?: string[]
): number {
  if (!audioEvents?.length) return 0;

  const clipEventTypes = audioEvents.map((e) => e.type.toLowerCase());
  let bonus = 0;

  // Direct expectedAudioTypes match (from blueprint/context)
  if (expectedAudioTypes?.length) {
    for (const expected of expectedAudioTypes) {
      if (clipEventTypes.some((t) => t.includes(expected.toLowerCase()))) bonus += 3;
    }
  }

  // Beat text keyword matching
  for (const entry of AUDIO_KEYWORD_MAP) {
    if (!entry.beatKeywords.test(beatText)) continue;
    const hasEvent = clipEventTypes.some((t) =>
      entry.eventTypes.some((et) => t.includes(et))
    );
    if (hasEvent) bonus += entry.bonus;
  }

  return Math.min(5, bonus);
}

// ─── Scoring: cinematic tags bonus ───────────────────────────────────────────

const CINEMATIC_KEYWORD_MAP: Array<[RegExp, string[]]> = [
  [/\b(aerial|drone|bird.?s eye|vanuit de lucht|luchtopname)\b/i, ["aerial view", "aerial", "drone"]],
  [/\b(skyline|horizon|panorama|stadsaanzicht)\b/i, ["skyline", "landscape"]],
  [/\b(crowd|massa|menigte|protest)\b/i, ["crowd shot", "crowd"]],
  [/\b(establishing|opening|introductie|overzicht)\b/i, ["establishing shot", "aerial view"]],
  [/\b(interview|conversation|gesprek|talking head)\b/i, ["interview", "portrait"]],
  [/\b(reaction|reactie|response)\b/i, ["reaction shot", "insert shot"]],
  [/\b(destruction|ruin|vernieling|ruins?)\b/i, ["destruction", "ruins", "aftermath"]],
  [/\b(fire|flame|vuur|brand)\b/i, ["fire", "destruction"]],
  [/\b(smoke|rook|mist)\b/i, ["smoke"]],
  [/\b(celebration|overwinning|feest|victory)\b/i, ["celebration"]],
  [/\b(ceremony|plechtigheid|parade)\b/i, ["ceremony", "procession"]],
  [/\b(silhouette|schaduw|backlit)\b/i, ["silhouette"]],
  [/\b(battle|gevecht|combat|fight)\b/i, ["battle", "action"]],
  [/\b(archive|historical|archief|oud materiaal)\b/i, ["archive footage", "newsreel"]],
  [/\b(insert|detail|close.?up|close shot)\b/i, ["insert shot", "close detail"]],
  [/\b(b.?roll|context shot|sfeer)\b/i, ["b-roll", "cutaway"]],
  [/\b(symmetr|balanced|centraal)\b/i, ["symmetry", "leading lines"]],
];

/**
 * Award a bonus when cinematic tags in the clip match what the beat/blueprint expects.
 *
 * Maximum: +6
 */
function scoreCinematicTags(
  beatText: string,
  cinematicTags: string[] | undefined,
  expectedCinematicTags?: string[]
): number {
  if (!cinematicTags?.length) return 0;

  const tagsLower = cinematicTags.map((t) => t.toLowerCase());
  let bonus = 0;

  // Direct match from expectedCinematicTags (blueprint / editorial directive)
  if (expectedCinematicTags?.length) {
    for (const expected of expectedCinematicTags) {
      if (tagsLower.some((t) => t.includes(expected.toLowerCase()))) bonus += 2;
    }
  }

  // Beat text keyword matching
  for (const [pattern, relatedTags] of CINEMATIC_KEYWORD_MAP) {
    if (!pattern.test(beatText)) continue;
    const hasTag = tagsLower.some((t) => relatedTags.some((rt) => t.includes(rt)));
    if (hasTag) bonus += 1;
  }

  return Math.min(6, bonus);
}

// ─── Scoring: importance + uniqueness bonus ───────────────────────────────────

/**
 * Iconic clips (shotImportance.score > 70) get a small bonus so they surface
 * when relevance is otherwise comparable. Unique clips get a tie-breaker bonus.
 *
 * importanceBonus max: +5
 * uniquenessBonus max: +3
 */
function scoreImportanceAndUniqueness(
  shotImportance: ShotImportance | undefined,
  visualUniqueness: VisualUniqueness | undefined
): { importanceBonus: number; uniquenessBonus: number } {
  const importanceBonus = shotImportance
    ? Math.min(5, Math.max(0, Math.round((shotImportance.score - 50) / 10)))
    : 0;

  const uniquenessBonus = visualUniqueness
    ? Math.min(3, Math.max(0, Math.round((visualUniqueness.score - 50) / 17)))
    : 0;

  return { importanceBonus, uniquenessBonus };
}

// ─── Main scorer ──────────────────────────────────────────────────────────────

/**
 * Compute all v4 archive metadata bonus scores for one clip candidate.
 *
 * Called inside AssetDirector.scoreCandidate() — pure, synchronous.
 * All signals are derived from pre-stored annotation metadata (no I/O here).
 */
export function computeArchiveMetadataScores(
  annotation: ClipAnnotation | null | undefined,
  beatText: string,
  activeEntity: string | null | undefined,
  clipLevelSim: number | null | undefined,
  segmentSimilarities: SegmentSimilarity[],
  expectedAudioTypes?: string[],
  expectedCinematicTags?: string[]
): ArchiveMetadataScores {
  const zero: ArchiveMetadataScores = {
    segmentBonus: 0, faceBonus: 0, objectBonus: 0, audioBonus: 0,
    cinematicBonus: 0, importanceBonus: 0, uniquenessBonus: 0,
    total: 0, bestSegment: null,
  };

  if (!archiveV4ScoringEnabled() || !annotation) return zero;

  const { bonus: segmentBonus, best: bestSegment } = scoreSegmentMatch(segmentSimilarities, clipLevelSim ?? null);

  const faceBonus     = scoreFacePresence(activeEntity, annotation.faceTracks);
  const objectBonus   = scoreObjectMovement(beatText, annotation.objectTracks);
  const audioBonus    = scoreAudioMatch(beatText, annotation.audioEvents, expectedAudioTypes);
  const cinematicBonus = scoreCinematicTags(beatText, annotation.cinematicTags, expectedCinematicTags);
  const { importanceBonus, uniquenessBonus } = scoreImportanceAndUniqueness(
    annotation.shotImportance,
    annotation.visualUniqueness
  );

  const total = segmentBonus + faceBonus + objectBonus + audioBonus +
                cinematicBonus + importanceBonus + uniquenessBonus;

  return {
    segmentBonus, faceBonus, objectBonus, audioBonus,
    cinematicBonus, importanceBonus, uniquenessBonus,
    total, bestSegment,
  };
}

// ─── Trim hint ────────────────────────────────────────────────────────────────

const TRIM_SIM_THRESHOLD = 0.08;   // segment must be this much better than clip
const MIN_SEGMENT_DURATION = 1.5;  // don't trim to segments shorter than this

/**
 * Produce a TrimHint when a specific segment is meaningfully better than
 * the overall clip-level embedding match.
 *
 * Returns null when trimming is not beneficial or segments are too short.
 */
export function computeTrimHint(
  bestSegment: SegmentSimilarity | null,
  clipLevelSim: number | null | undefined,
  annotation: ClipAnnotation | null | undefined
): TrimHint | null {
  if (!bestSegment || !annotation?.timeline) return null;

  const clipSim = clipLevelSim ?? 0.5;
  const delta = bestSegment.similarity - clipSim;
  if (delta < TRIM_SIM_THRESHOLD) return null;

  const dur = bestSegment.endSec - bestSegment.startSec;
  if (dur < MIN_SEGMENT_DURATION) return null;

  const seg = annotation.timeline[bestSegment.segmentIndex];
  if (!seg) return null;

  return {
    startSec:     bestSegment.startSec,
    endSec:       bestSegment.endSec,
    segmentIndex: bestSegment.segmentIndex,
    similarity:   bestSegment.similarity,
    reason: `segment ${bestSegment.segmentIndex} sim=${bestSegment.similarity.toFixed(3)} vs clip sim=${clipSim.toFixed(3)} (Δ=${delta.toFixed(3)}): "${seg.description.slice(0, 60)}"`,
  };
}

// ─── Segment trim application ─────────────────────────────────────────────────

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN ?? process.env.FFMPEG_PATH ?? "ffmpeg";
}

/**
 * Apply a TrimHint to a clip file using FFmpeg stream copy (fast, no re-encode).
 * The trimmed file is written next to the original with a `_seg{N}` suffix.
 * Returns the trimmed path, or null if the trim failed.
 */
export async function applySegmentTrimIfNeeded(
  clipPath: string,
  trimHint: TrimHint | null | undefined,
  workDir: string
): Promise<string | null> {
  if (!trimHint) return null;
  if (!fs.existsSync(clipPath)) return null;

  const dur = trimHint.endSec - trimHint.startSec;
  if (dur < MIN_SEGMENT_DURATION) return null;

  const ext = path.extname(clipPath);
  const base = path.basename(clipPath, ext);
  const outPath = path.join(workDir, `${base}_seg${trimHint.segmentIndex}${ext}`);

  if (fs.existsSync(outPath)) return outPath; // already trimmed

  try {
    await execPromise(
      `${ffmpegBin()} -ss ${trimHint.startSec.toFixed(3)} -t ${dur.toFixed(3)} -i "${clipPath}" -c copy "${outPath}" -y`,
      { timeout: 30_000 }
    );
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
      console.log(
        `[ArchiveV4] trimmed clip to segment ${trimHint.segmentIndex}: ` +
        `${trimHint.startSec.toFixed(2)}–${trimHint.endSec.toFixed(2)}s — ${path.basename(outPath)}\n  Reason: ${trimHint.reason}`
      );
      return outPath;
    }
  } catch (err) {
    console.warn(`[ArchiveV4] trim failed for ${path.basename(clipPath)}:`, (err as Error).message?.slice(0, 80));
  }

  try { fs.unlinkSync(outPath); } catch { /* ignore cleanup failure */ }
  return null;
}
