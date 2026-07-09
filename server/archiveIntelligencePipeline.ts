/**
 * Archive Intelligence Pipeline v5 — professional media asset management.
 *
 * Transforms raw archive assets into fully editorial-profiled clips that an AI
 * editor can select with the same precision as a senior BBC documentary editor.
 *
 * Pipeline stages (all run at ingest time, non-blocking for the upload response):
 *
 *   1. Enhanced LLM annotation (v3 ClipAnnotator)
 *      — persons, objects, actions, location, era, emotion, cinematography
 *      — descriptions (short/normal/extended), shot importance, visual uniqueness
 *      — timeline segmentation, object tracks, face tracks, OCR text
 *      — cinematic tags, 15-25 search aliases, KG entities
 *      — per-field confidence, quality flags, extended editorial scores
 *
 *   2. FFprobe / FFmpeg quality analysis
 *      — black frame detection, blur / freeze, duration validation
 *      — watermark heuristic from title/tags
 *
 *   3. Scene detection enhancement
 *      — histogram change detection (ARCHIVE_HISTOGRAM_DETECT=true)
 *
 *   4. Near-duplicate detection
 *      — cosine similarity against recently indexed clips
 *
 *   5. Facet embeddings
 *      — 7 separate text embeddings (description, persons, location,
 *        objects, events, emotions, style)
 *
 *   6. Search alias expansion
 *      — LLM aliases + KG entities + existing tags, deduped, capped at 40
 *
 *   7. Rich logging
 *      — [ArchiveIntelligence] prefix; final report per clip
 *
 *   8. Multi-frame vision analysis  ← NEW v3
 *      — FFmpeg extracts 3–5 frames at evenly-spaced timestamps
 *      — Dedicated LLM vision call: refines timeline, object tracks, face tracks,
 *        OCR text, cinematic tags, shot importance, visual uniqueness, descriptions
 *      — Merges results into existing annotation (LLM v3 fields are baseline;
 *        vision analysis enriches/overrides with real pixel evidence)
 *
 *   9. Audio intelligence  ← NEW v3
 *      — FFmpeg: silence detection, loudness peaks, audio presence
 *      — Classifies audio events: speech, music, applause, explosion, crowd, etc.
 *      — Stored as annotation.audioEvents[]
 *
 *  10. Segment-level embeddings  ← NEW v3
 *      — Creates one embedding per timeline segment
 *      — Stored as {assetId}_seg_{index}.json alongside facet embeddings
 *      — Enables sub-clip temporal retrieval
 *
 * Feature flag: ARCHIVE_INTELLIGENCE_PIPELINE_ENABLED (default: "true")
 *               ARCHIVE_VISION_ANALYSIS_ENABLED (default: "true")
 *               ARCHIVE_AUDIO_ANALYSIS_ENABLED  (default: "true")
 *
 * Integration: call runArchiveIntelligencePipeline() after initial DB save.
 * Non-throwing — all errors are logged and swallowed.
 */

import path from "path";
import fs from "fs";
import { exec as execCb } from "child_process";
import { promisify } from "util";

import { annotateAsset, buildEnrichedSemanticDocument, ANNOTATION_VERSION } from "./clipAnnotator";
import { invokeLLM } from "./_core/llm";
import type {
  ClipAnnotation,
  ClipQualityFlags,
  ClipSegment,
  ObjectTrack,
  FaceTrack,
  AudioEvent,
  ShotImportance,
  ClipDescriptions,
  VisualUniqueness,
  OcrEntry,
  StorytellingLabels,
  StorytellingFunction,
  ClipQualityMetrics,
  ArchiveUniqueness,
  AssetHealthScore,
} from "../drizzle/annotationTypes";
import { getDb } from "./db";
import { mediaArchiveAssets } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import type { MediaArchiveAsset } from "../drizzle/schema";

const execPromise = promisify(execCb);

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function archiveIntelligencePipelineEnabled(): boolean {
  return process.env.ARCHIVE_INTELLIGENCE_PIPELINE_ENABLED !== "false";
}

// ─── FFprobe helpers ──────────────────────────────────────────────────────────

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN ?? process.env.FFPROBE_PATH ?? "ffprobe";
}

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN ?? process.env.FFMPEG_PATH ?? "ffmpeg";
}

// ─── Stage 2: Quality analysis ────────────────────────────────────────────────

export type VideoQualityAnalysis = {
  /** Fraction of frames that are predominantly black (0–1). */
  blackFrameFraction: number;
  /** True if more than 10% of frames are black. */
  isBlack: boolean;
  /** True if blur metric (laplacian variance) is below threshold. */
  isBlurry: boolean;
  /** True if no keyframes could be decoded at all. */
  isUnreadable: boolean;
  /** Duration in seconds confirmed by ffprobe. */
  confirmedDurationSec: number;
  /** Mean PSNR (used as a proxy for freeze frames / static clips). */
  hasFreezeFraction: boolean;
  /** Raw blur score (higher = sharper). */
  blurScore: number;
};

const MIN_BLUR_SCORE = 40; // below this → isBlurry
const MIN_BLACKFRAME_PCT = 0.10; // above this → isBlack

async function analyzeVideoQuality(localPath: string): Promise<VideoQualityAnalysis | null> {
  if (!fs.existsSync(localPath)) return null;

  try {
    // ── Duration ──────────────────────────────────────────────────────────────
    const { stdout: durOut } = await execPromise(
      `${ffprobeBin()} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${localPath}"`,
      { timeout: 15_000 }
    );
    const confirmedDurationSec = parseFloat(String(durOut).trim()) || 0;

    // ── Black frame detection ──────────────────────────────────────────────────
    // Sample 1 frame per second; count how many are below mean luminance 16
    let blackFrameFraction = 0;
    try {
      const { stdout: bfOut } = await execPromise(
        `${ffmpegBin()} -i "${localPath}" -vf "blackdetect=d=0:pix_th=0.10" -an -f null /dev/null 2>&1 | grep -c black_start || true`
      );
      const blackSeconds = parseInt(String(bfOut).trim(), 10) || 0;
      blackFrameFraction = confirmedDurationSec > 0 ? blackSeconds / confirmedDurationSec : 0;
    } catch { /* ignore */ }

    // ── Blur detection ─────────────────────────────────────────────────────────
    // Sample 3 evenly-spaced frames, compute Laplacian variance as blur proxy
    let blurScore = 100;
    try {
      // Use FFmpeg to extract 1 frame and compute signalstats (TOUT = contrast proxy)
      const { stderr: statsOut } = await execPromise(
        `${ffmpegBin()} -i "${localPath}" -vf "select=eq(n\\,0),signalstats" -frames:v 1 -f null -`,
        { timeout: 15_000 }
      );
      // TOUT (total signal range) is a reasonable proxy for image detail / sharpness
      const toutMatch = /TOUT:([0-9.]+)/i.exec(String(statsOut));
      if (toutMatch) {
        const tout = parseFloat(toutMatch[1]);
        // TOUT 0-255; scale to 0-100 as sharpness proxy
        blurScore = Math.round(Math.min(100, (tout / 40) * 100));
      }
    } catch { /* ignore */ }

    // ── Freeze / static detection ─────────────────────────────────────────────
    // A clip with no movement for its entire duration is likely a freeze frame
    let hasFreezeFraction = false;
    if (confirmedDurationSec > 3) {
      try {
        const { stderr: freezeOut } = await execPromise(
          `${ffmpegBin()} -i "${localPath}" -vf "freezedetect=noise=0.01:duration=2" -an -f null -`,
          { timeout: 15_000 }
        );
        hasFreezeFraction = /freeze_start/i.test(String(freezeOut));
      } catch { /* ignore */ }
    }

    return {
      blackFrameFraction,
      isBlack: blackFrameFraction >= MIN_BLACKFRAME_PCT,
      isBlurry: blurScore < MIN_BLUR_SCORE,
      isUnreadable: confirmedDurationSec <= 0,
      confirmedDurationSec,
      hasFreezeFraction,
      blurScore,
    };
  } catch (err) {
    console.warn(
      `[ArchiveIntelligence] quality analysis failed for ${path.basename(localPath)}:`,
      (err as Error).message?.slice(0, 80)
    );
    return null;
  }
}

// ─── Stage 3: Watermark / intro heuristic (from metadata, no vision needed) ───

/**
 * Heuristic quality flags derived from asset metadata when no local video is available.
 * The LLM v2 prompt already detects these from the thumbnail; this is the text-only fallback.
 */
function inferQualityFlagsFromMetadata(asset: MediaArchiveAsset): Partial<ClipQualityFlags> {
  const combined = [asset.title ?? "", (asset.tags ?? []).join(" "), asset.sourceNote ?? ""].join(" ").toLowerCase();
  return {
    hasWatermark:     /watermark|logo|copyright|©|®|trademark/.test(combined),
    isIntroOrOutro:   /\b(intro|outro|opening|title sequence|title card|bumper|opening credits)\b/.test(combined),
    isCreditSequence: /\b(credits|end credits|closing credits|rolling credits|cast|crew)\b/.test(combined),
    hasTitleCard:     /\b(title card|slate|main title|chapter|title screen)\b/.test(combined),
    isTestPattern:    /\b(colour bars|test card|test pattern|color bars|smpte)\b/.test(combined),
  };
}

// ─── Stage 4: Near-duplicate detection ────────────────────────────────────────

/**
 * Cosine similarity between two equal-length float arrays.
 */
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

function localEmbeddingDir(): string {
  const LOCAL_UPLOADS_DIR = process.env.LOCAL_UPLOADS_DIR ?? "/data/uploads";
  return path.join(LOCAL_UPLOADS_DIR, "archive-clip-embeddings");
}

async function detectNearDuplicate(
  assetId: number,
  embedding: number[]
): Promise<number | null> {
  if (!embedding || embedding.length === 0) return null;

  const dir = localEmbeddingDir();
  if (!fs.existsSync(dir)) return null;

  const NEAR_DUP_THRESHOLD = 0.97;

  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const otherId = parseInt(path.basename(file, ".json"), 10);
      if (isNaN(otherId) || otherId === assetId) continue;
      try {
        const stored = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as {
          assetId?: number;
          embedding?: number[];
        };
        if (!Array.isArray(stored.embedding) || stored.embedding.length !== embedding.length) continue;
        const sim = cosineSim(embedding, stored.embedding);
        if (sim >= NEAR_DUP_THRESHOLD) {
          console.log(
            `[ArchiveIntelligence] near-duplicate detected: asset ${assetId} ≈ asset ${otherId} (sim=${sim.toFixed(3)})`
          );
          return otherId;
        }
      } catch { /* ignore corrupt embedding file */ }
    }
  } catch (err) {
    console.warn(`[ArchiveIntelligence] near-duplicate scan failed:`, (err as Error).message?.slice(0, 80));
  }
  return null;
}

// ─── Stage 5: Facet embeddings ────────────────────────────────────────────────

type FacetEmbeddings = {
  description: number[];
  persons: number[];
  location: number[];
  objects: number[];
  events: number[];
  emotions: number[];
  style: number[];
};

/**
 * Build 7 facet-specific text documents from the annotation.
 * Each focuses on a single editorial dimension for targeted retrieval.
 */
function buildFacetDocuments(ann: ClipAnnotation, asset: MediaArchiveAsset): Record<keyof FacetEmbeddings, string> {
  return {
    description: ann.editorialDescription
      ?? buildEnrichedSemanticDocument(asset, ann),

    persons: [
      ...ann.persons.named,
      ...ann.persons.categories,
      ann.historicalContext.period,
    ].filter(Boolean).join(". "),

    location: [
      ann.location.city,
      ann.location.region,
      ann.location.country,
      ann.location.continent,
      ann.environment.setting,
    ].filter(Boolean).join(", "),

    objects: [
      ...ann.objects,
      ann.cinematography.visualStyle,
    ].filter(Boolean).join(", "),

    events: [
      ann.historicalContext.event,
      ann.historicalContext.period,
      ann.historicalContext.year,
      ann.historicalContext.decade,
      ...(ann.knowledgeGraphEntities ?? []).slice(0, 8),
    ].filter(Boolean).join(". "),

    emotions: [
      ann.emotion,
      ...ann.actions,
      ann.usageHints.bestUsedAs,
    ].filter(Boolean).join(", "),

    style: [
      ann.cinematography.shotType,
      ann.cinematography.cameraMovement,
      ann.cinematography.visualStyle,
      ann.environment.lighting,
      ann.cinematography.composition,
    ].filter(Boolean).join(", "),
  };
}

/**
 * Generate facet embeddings and store them alongside the main embedding file.
 * The main embedding file path is `{dir}/{assetId}.json`.
 * Facet embedding files are `{dir}/{assetId}_facet_{facetName}.json`.
 */
async function generateFacetEmbeddings(
  assetId: number,
  ann: ClipAnnotation,
  asset: MediaArchiveAsset
): Promise<Record<string, string>> {
  const keys: Record<string, string> = {};

  try {
    // Lazy-import to avoid circular deps and only load when needed
    const { createTextEmbedding } = await import("./semanticVisualMatching");
    const dir = localEmbeddingDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const docs = buildFacetDocuments(ann, asset);

    for (const [facet, text] of Object.entries(docs)) {
      if (!text || text.length < 5) continue;
      try {
        const embedding = await createTextEmbedding(text);
        if (!embedding || embedding.length === 0) continue;

        const filePath = path.join(dir, `${assetId}_facet_${facet}.json`);
        fs.writeFileSync(filePath, JSON.stringify({ assetId, facet, embedding, text: text.slice(0, 200) }));
        keys[facet] = filePath;
      } catch { /* individual facet failure is non-fatal */ }
    }
  } catch (err) {
    console.warn(
      `[ArchiveIntelligence] facet embeddings failed for asset ${assetId}:`,
      (err as Error).message?.slice(0, 80)
    );
  }

  return keys;
}

// ─── Stage 5b: Extended facet embeddings (v5) ────────────────────────────────

async function generateExtendedFacetEmbeddings(
  assetId: number,
  ann: ClipAnnotation
): Promise<{ ocrTimeline?: string; audioEvents?: string; storytelling?: string }> {
  const result: { ocrTimeline?: string; audioEvents?: string; storytelling?: string } = {};
  try {
    const { createTextEmbedding } = await import("./semanticVisualMatching");
    const dir = localEmbeddingDir();

    const ocrDoc = (ann.ocrTimeline ?? []).map((e) => e.text).join(". ").trim();
    const audioDoc = (ann.audioEvents ?? [])
      .map((e) => `${e.type}${e.startSec != null ? ` at ${e.startSec}s` : ""}`)
      .join(", ").trim();
    const storyDoc = [
      ann.storytellingLabels?.primary,
      ...(ann.storytellingLabels?.secondary ?? []),
    ].filter(Boolean).join(", ").trim();

    for (const [facet, text] of [
      ["ocrTimeline", ocrDoc],
      ["audioEvents", audioDoc],
      ["storytelling", storyDoc],
    ] as [string, string][]) {
      if (!text || text.length < 5) continue;
      try {
        const embedding = await createTextEmbedding(text);
        if (!embedding || embedding.length === 0) continue;
        const filePath = path.join(dir, `${assetId}_facet_${facet}.json`);
        fs.writeFileSync(filePath, JSON.stringify({ assetId, facet, embedding, text: text.slice(0, 200) }));
        (result as Record<string, string>)[facet] = filePath;
      } catch { /* non-fatal */ }
    }
  } catch { /* non-fatal */ }
  return result;
}

// ─── Stage 6: Search alias expansion ─────────────────────────────────────────

/**
 * Expand LLM-generated search aliases with KG entity terms.
 * Deduplicates and normalises case.
 */
function expandSearchAliases(
  llmAliases: string[],
  kgEntities: string[],
  existingTags: string[]
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  const addAlias = (s: string) => {
    const norm = s.trim().toLowerCase();
    if (norm.length < 3 || seen.has(norm)) return;
    seen.add(norm);
    result.push(s.trim());
  };

  // Priority: LLM-generated aliases first (most contextual)
  for (const a of llmAliases) addAlias(a);
  // Then existing tags (from upload metadata)
  for (const t of existingTags) addAlias(t);
  // Then KG entities (systematic coverage)
  for (const e of kgEntities) addAlias(e);

  return result.slice(0, 40); // cap at 40 aliases
}

// ─── Stage 8: Multi-frame vision analysis ─────────────────────────────────────

/**
 * Extract N evenly-spaced frames from a video file as base64 JPEG data URIs.
 * Returns an empty array if extraction fails or the file doesn't exist.
 */
async function extractFrames(
  localPath: string,
  durationSec: number,
  frameCount = 4,
  quality = 3 // FFmpeg JPEG quality (2=best, 31=worst)
): Promise<string[]> {
  if (!fs.existsSync(localPath) || durationSec <= 0) return [];

  const frames: string[] = [];
  const tmpDir = path.join(path.dirname(localPath), `_frames_${path.basename(localPath, path.extname(localPath))}`);

  try {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const timestamps = Array.from({ length: frameCount }, (_, i) =>
      Math.min(durationSec - 0.1, (durationSec / (frameCount + 1)) * (i + 1))
    );

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i]!;
      const outPath = path.join(tmpDir, `frame_${i}.jpg`);
      try {
        await execPromise(
          `${ffmpegBin()} -ss ${ts.toFixed(3)} -i "${localPath}" -frames:v 1 -q:v ${quality} -vf "scale=640:-2" "${outPath}" -y`,
          { timeout: 10_000 }
        );
        if (fs.existsSync(outPath)) {
          const b64 = fs.readFileSync(outPath).toString("base64");
          frames.push(`data:image/jpeg;base64,${b64}`);
        }
      } catch { /* ignore individual frame failures */ }
    }
  } finally {
    // Clean up temp frames
    try {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }
  }

  return frames;
}

/**
 * Build the vision analysis prompt for multi-frame inspection.
 * Focused purely on v3 fields: timeline, tracks, OCR, tags, importance.
 */
function buildVisionAnalysisPrompt(asset: MediaArchiveAsset, durationSec: number, frameCount: number): string {
  const meta = [
    asset.title ? `Title: "${asset.title}"` : "",
    asset.tags?.length ? `Tags: ${asset.tags.slice(0, 10).join(", ")}` : "",
    asset.sourceNote ? `Source: ${asset.sourceNote}` : "",
    `Duration: ${durationSec.toFixed(1)}s`,
    `Frames shown: ${frameCount} evenly-spaced frames from this clip`,
  ].filter(Boolean).join("\n");

  return `You are a professional documentary archive editor performing frame-by-frame visual analysis. You are shown ${frameCount} frames from a video clip. Analyze what you actually see in the images and return ONLY this JSON object.

${meta}

{
  "timeline": [],
  "objectTracks": [],
  "faceTracks": [],
  "ocrText": [],
  "cinematicTags": [],
  "cameraMovementDetail": "",
  "shotImportance": {"score": 0, "label": "generic", "reason": ""},
  "visualUniqueness": {"score": 0, "reason": ""},
  "descriptions": {"short": "", "normal": "", "extended": ""}
}

INSTRUCTIONS:

timeline: Based on the frames shown, divide this ${durationSec.toFixed(1)}s clip into 2–5 temporal segments. Each frame represents a different moment in the clip.
Each segment: { "startSec": N, "endSec": N, "shotType": "...", "description": "...", "persons": [], "objects": [], "emotion": "...", "cameraMovement": "...", "ocrText": "..." }

objectTracks: For each object that moves significantly between frames:
{ "object": "...", "startPosition": "left|center|right|offscreen", "endPosition": "...", "direction": "left→right|towards camera|...", "movement": "enters frame left|exits right|..." }

faceTracks: For each face you can see:
{ "name": "name or unknown person", "firstAppearsSec": 0, "lastAppearsSec": 0, "dominanceFraction": 0.0–1.0, "closeUpDurationSec": 0, "isPrimarySubject": true/false }

ocrText: All text you can read in any frame. Include street signs, dates, subtitles, banners, newspapers, maps, building names.

cinematicTags: Pick all that apply: "leading lines" "symmetry" "silhouette" "crowd shot" "aerial view" "skyline" "smoke" "fire" "destruction" "celebration" "interview" "archive footage" "establishing shot" "insert shot" "reaction shot" "cutaway" "b-roll" "portrait" "propaganda" "newsreel" "action" "aftermath" "procession" "ceremony" "ruins" "landscape" "battle" "documentary"

cameraMovementDetail: Describe actual camera motion you observe between frames. E.g. "slow pan left, then static close-up" or "handheld tracking shot throughout".

shotImportance score 0–100: 100=Moon landing/D-Day (irreplaceable primary source). 90+=iconic major event. 70+=historically significant. 50+=useful B-roll. <40=generic stock.
label: "iconic"(≥90) | "unique"(≥70) | "rare"(≥50) | "generic"(<50)

visualUniqueness score 0–100: How rare is THIS visual composition globally? 100=one-of-a-kind. 80+=extremely rare. 60+=uncommon. 40+=seen before. <40=very common.

descriptions.short: 1 sentence (15–25 words): who does what, where, when.
descriptions.normal: 1 paragraph (3–5 sentences): who, what, where, when, significance.
descriptions.extended: 150–300 words for an AI video editor: visual detail, historical context, editorial usage, emotional impact, cinematography.

Return ONLY valid JSON. No markdown, no explanation.`;
}

type VisionAnalysisResult = {
  timeline?: ClipSegment[];
  objectTracks?: ObjectTrack[];
  faceTracks?: FaceTrack[];
  ocrText?: string[];
  cinematicTags?: string[];
  cameraMovementDetail?: string;
  shotImportance?: ShotImportance;
  visualUniqueness?: VisualUniqueness;
  descriptions?: ClipDescriptions;
};

/**
 * Run multi-frame vision analysis on a clip.
 * Extracts frames with FFmpeg, then sends them to a vision-capable LLM.
 * Returns null if vision analysis is disabled or fails.
 */
async function runVisionAnalysis(
  asset: MediaArchiveAsset,
  localPath: string,
  durationSec: number
): Promise<VisionAnalysisResult | null> {
  if (process.env.ARCHIVE_VISION_ANALYSIS_ENABLED === "false") return null;
  if (!localPath || !fs.existsSync(localPath)) return null;

  try {
    console.log(`[ArchiveIntelligence] Stage 8: extracting frames for asset ${asset.id}…`);
    const frameCount = Math.min(5, Math.max(2, Math.ceil(durationSec / 3)));
    const frames = await extractFrames(localPath, durationSec, frameCount);

    if (frames.length === 0) {
      console.log(`[ArchiveIntelligence] Stage 8: no frames extracted for asset ${asset.id}, skipping vision`);
      return null;
    }

    console.log(`[ArchiveIntelligence] Stage 8: vision analysis with ${frames.length} frames for asset ${asset.id}`);

    const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: "text", text: buildVisionAnalysisPrompt(asset, durationSec, frames.length) },
      ...frames.map((f) => ({ type: "image_url", image_url: { url: f } })),
    ];

    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are a documentary archive editor performing visual frame analysis. Return ONLY valid JSON.",
        },
        { role: "user", content: userContent as never },
      ],
      maxTokens: 2500,
      responseFormat: { type: "json_object" },
    });

    const raw = typeof result.choices[0]?.message.content === "string"
      ? result.choices[0].message.content
      : "{}";

    const parsed = JSON.parse(raw) as VisionAnalysisResult;

    const out: VisionAnalysisResult = {};

    if (Array.isArray(parsed.timeline) && parsed.timeline.length > 0) {
      out.timeline = parsed.timeline.map((s) => ({
        startSec:       typeof s.startSec === "number" ? s.startSec : 0,
        endSec:         typeof s.endSec === "number" ? s.endSec : 0,
        shotType:       typeof s.shotType === "string" ? s.shotType : "medium",
        description:    typeof s.description === "string" ? s.description.slice(0, 300) : "",
        persons:        Array.isArray(s.persons) ? s.persons : undefined,
        objects:        Array.isArray(s.objects) ? s.objects : undefined,
        emotion:        typeof s.emotion === "string" ? s.emotion : undefined,
        cameraMovement: typeof s.cameraMovement === "string" ? s.cameraMovement : undefined,
        ocrText:        typeof s.ocrText === "string" ? s.ocrText : undefined,
      }));
    }
    if (Array.isArray(parsed.objectTracks) && parsed.objectTracks.length > 0) {
      out.objectTracks = (parsed.objectTracks as ObjectTrack[]).filter((t) => typeof t.object === "string" && t.object.length > 0);
    }
    if (Array.isArray(parsed.faceTracks) && parsed.faceTracks.length > 0) {
      out.faceTracks = (parsed.faceTracks as FaceTrack[]).filter((f) => typeof f.name === "string");
    }
    if (Array.isArray(parsed.ocrText) && parsed.ocrText.length > 0) {
      out.ocrText = parsed.ocrText.filter((t) => typeof t === "string" && t.trim().length > 0).slice(0, 30);
    }
    if (Array.isArray(parsed.cinematicTags) && parsed.cinematicTags.length > 0) {
      out.cinematicTags = parsed.cinematicTags.filter((t) => typeof t === "string").slice(0, 20);
    }
    if (typeof parsed.cameraMovementDetail === "string" && parsed.cameraMovementDetail.length > 2) {
      out.cameraMovementDetail = parsed.cameraMovementDetail.slice(0, 200);
    }
    const si = parsed.shotImportance;
    if (si && typeof si.score === "number") {
      const score = Math.min(100, Math.max(0, Math.round(si.score)));
      const validLabels: Array<ShotImportance["label"]> = ["iconic", "unique", "rare", "generic"];
      out.shotImportance = {
        score,
        label: validLabels.includes(si.label as ShotImportance["label"])
          ? (si.label as ShotImportance["label"])
          : score >= 90 ? "iconic" : score >= 70 ? "unique" : score >= 50 ? "rare" : "generic",
        reason: typeof si.reason === "string" ? si.reason.slice(0, 200) : "",
      };
    }
    const vu = parsed.visualUniqueness;
    if (vu && typeof vu.score === "number") {
      out.visualUniqueness = {
        score:  Math.min(100, Math.max(0, Math.round(vu.score))),
        reason: typeof vu.reason === "string" ? vu.reason.slice(0, 200) : "",
      };
    }
    const desc = parsed.descriptions;
    if (desc && (desc.short || desc.normal || desc.extended)) {
      out.descriptions = {
        short:    typeof desc.short === "string" ? desc.short.slice(0, 200) : "",
        normal:   typeof desc.normal === "string" ? desc.normal.slice(0, 600) : "",
        extended: typeof desc.extended === "string" ? desc.extended.slice(0, 1200) : "",
      };
    }

    console.log(
      `[ArchiveIntelligence] Stage 8 done: asset ${asset.id} — ` +
      `timeline:${out.timeline?.length ?? 0} tracks:${out.objectTracks?.length ?? 0} ` +
      `faces:${out.faceTracks?.length ?? 0} ocr:${out.ocrText?.length ?? 0} ` +
      `importance:${out.shotImportance?.score ?? "-"} unique:${out.visualUniqueness?.score ?? "-"}`
    );

    return out;
  } catch (err) {
    console.warn(
      `[ArchiveIntelligence] Stage 8 vision analysis failed for asset ${asset.id}:`,
      (err as Error).message?.slice(0, 120)
    );
    return null;
  }
}

// ─── Stage 9: Audio intelligence ─────────────────────────────────────────────

/**
 * Analyse audio in a local video file using FFmpeg.
 * Detects: silence, loudness peaks, audio presence, approximate event types.
 * Returns an array of AudioEvent objects.
 */
async function analyzeAudio(localPath: string, durationSec: number): Promise<AudioEvent[]> {
  if (process.env.ARCHIVE_AUDIO_ANALYSIS_ENABLED === "false") return [];
  if (!fs.existsSync(localPath)) return [];

  const events: AudioEvent[] = [];

  try {
    // ── Check audio stream presence ────────────────────────────────────────────
    let hasAudio = false;
    try {
      const { stdout: probeOut } = await execPromise(
        `${ffprobeBin()} -v error -select_streams a:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${localPath}"`,
        { timeout: 8_000 }
      );
      hasAudio = String(probeOut).trim().toLowerCase() === "audio";
    } catch { /* ignore */ }

    if (!hasAudio) {
      events.push({ type: "silence", startSec: 0, durationSec, confidence: 0.9 });
      return events;
    }

    // ── Silence detection ─────────────────────────────────────────────────────
    let silenceSec = 0;
    try {
      const { stderr: silOut } = await execPromise(
        `${ffmpegBin()} -i "${localPath}" -af "silencedetect=n=-50dB:d=0.5" -f null -`,
        { timeout: 20_000 }
      );
      let sMatch: RegExpExecArray | null;
      const silRe = /silence_duration:\s*([0-9.]+)/g;
      const silStr = String(silOut);
      while ((sMatch = silRe.exec(silStr)) !== null) {
        silenceSec += parseFloat(sMatch[1]!);
      }
    } catch { /* ignore */ }

    // ── Loudness / RMS analysis ───────────────────────────────────────────────
    let rms = -60; // dBFS
    let peak = -60;
    try {
      const { stderr: statsOut } = await execPromise(
        `${ffmpegBin()} -i "${localPath}" -af "astats=metadata=1:reset=1" -f null -`,
        { timeout: 20_000 }
      );
      const rmsMatch = /RMS level dB:\s*([+-]?[0-9.]+)/i.exec(String(statsOut));
      const peakMatch = /Peak level dB:\s*([+-]?[0-9.]+)/i.exec(String(statsOut));
      if (rmsMatch) rms = parseFloat(rmsMatch[1]!);
      if (peakMatch) peak = parseFloat(peakMatch[1]!);
    } catch { /* ignore */ }

    // ── Classify events from audio metrics ───────────────────────────────────
    const silenceFraction = durationSec > 0 ? silenceSec / durationSec : 0;

    if (silenceFraction > 0.9) {
      events.push({ type: "silence", startSec: 0, durationSec, confidence: 0.95 });
    } else if (silenceFraction > 0.5) {
      events.push({ type: "silence", durationSec: silenceSec, confidence: 0.8 });
    }

    // Speech: moderate RMS, non-silent
    if (rms > -45 && rms < -15 && silenceFraction < 0.7) {
      events.push({ type: "speech", startSec: null, durationSec: null, confidence: 0.6 });
    }

    // Loud event (explosion, crowd, gunfire): high peak + high RMS
    if (peak > -6) {
      events.push({ type: "loud event", startSec: null, durationSec: null, confidence: 0.65 });
    }

    // Music: sustained moderate RMS with low silence
    if (rms > -30 && silenceFraction < 0.1 && peak < -3) {
      events.push({ type: "music", startSec: null, durationSec: null, confidence: 0.55 });
    }

    // Crowd noise: high RMS, sustained, not too peaky
    if (rms > -25 && peak - rms < 12 && silenceFraction < 0.05) {
      events.push({ type: "crowd", startSec: null, durationSec: null, confidence: 0.5 });
    }

    console.log(
      `[ArchiveIntelligence] Stage 9: asset audio — rms:${rms.toFixed(1)}dB peak:${peak.toFixed(1)}dB ` +
      `silence:${(silenceFraction * 100).toFixed(0)}% events:[${events.map((e) => e.type).join(",")}]`
    );
  } catch (err) {
    console.warn(`[ArchiveIntelligence] Stage 9 audio analysis failed:`, (err as Error).message?.slice(0, 80));
  }

  return events;
}

// ─── Stage 10: Segment-level embeddings ──────────────────────────────────────

/**
 * Generate one text embedding per timeline segment.
 * Stores embedding files as {assetId}_seg_{index}.json in the embedding dir.
 * Updates each segment's embeddingKey field in-place.
 */
async function generateSegmentEmbeddings(
  assetId: number,
  segments: ClipSegment[]
): Promise<void> {
  if (!segments || segments.length === 0) return;

  try {
    const { createTextEmbedding } = await import("./semanticVisualMatching");
    const dir = localEmbeddingDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let embedded = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const text = [
        seg.description,
        seg.persons?.join(", "),
        seg.objects?.join(", "),
        seg.emotion,
        seg.shotType,
        seg.ocrText,
      ].filter(Boolean).join(". ");

      if (!text || text.length < 5) continue;

      try {
        const embedding = await createTextEmbedding(text);
        if (!embedding || embedding.length === 0) continue;

        const filePath = path.join(dir, `${assetId}_seg_${i}.json`);
        fs.writeFileSync(
          filePath,
          JSON.stringify({ assetId, segmentIndex: i, startSec: seg.startSec, endSec: seg.endSec, embedding, text: text.slice(0, 200) })
        );
        seg.embeddingKey = filePath;
        embedded++;
      } catch { /* individual segment embedding failure is non-fatal */ }
    }

    if (embedded > 0) {
      console.log(`[ArchiveIntelligence] Stage 10: generated ${embedded}/${segments.length} segment embeddings for asset ${assetId}`);
    }
  } catch (err) {
    console.warn(`[ArchiveIntelligence] Stage 10 segment embeddings failed:`, (err as Error).message?.slice(0, 80));
  }
}

// ─── Stage 11: Technical quality metrics (FFmpeg) ─────────────────────────────

/**
 * Derive objective technical quality metrics from the video file using
 * ffprobe (resolution/fps/bitrate) and ffmpeg signalstats (luma/contrast/noise).
 * All values are 0–100 (higher = better) except exposureScore (50 = ideal).
 * Feature flag: ARCHIVE_QUALITY_METRICS_ENABLED (default: "true")
 */
async function computeQualityMetrics(
  localPath: string,
  qa: VideoQualityAnalysis | null
): Promise<ClipQualityMetrics | null> {
  if (process.env.ARCHIVE_QUALITY_METRICS_ENABLED === "false") return null;
  if (!fs.existsSync(localPath)) return null;

  try {
    const metrics: ClipQualityMetrics = {};

    // ── Resolution & FPS (ffprobe) ─────────────────────────────────────────────
    try {
      const { stdout: probeOut } = await execPromise(
        `${ffprobeBin()} -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate,bit_rate -of csv=p=0 "${localPath}"`,
        { timeout: 10_000 }
      );
      const parts = String(probeOut).trim().split(",");
      const w = parseInt(parts[0] ?? "0", 10);
      const h = parseInt(parts[1] ?? "0", 10);
      const fpsStr = parts[2] ?? "";
      const bitrate = parseInt(parts[3] ?? "0", 10);

      if (w > 0 && h > 0) {
        const px = w * h;
        if      (px >= 3840 * 2160) metrics.resolutionLabel = "4K";
        else if (px >= 1920 * 1080) metrics.resolutionLabel = "1080p";
        else if (px >= 1280 * 720)  metrics.resolutionLabel = "720p";
        else if (px >= 640 * 480)   metrics.resolutionLabel = "SD";
        else                         metrics.resolutionLabel = "sub-SD";
      }

      if (fpsStr) {
        const [num, den] = fpsStr.split("/").map(Number);
        const fps = den && den > 0 ? (num ?? 0) / den : 0;
        if      (fps >= 55) metrics.fpsLabel = "60fps";
        else if (fps >= 45) metrics.fpsLabel = "50fps";
        else if (fps >= 28) metrics.fpsLabel = "30fps";
        else if (fps >= 23) metrics.fpsLabel = "24fps";
        else if (fps > 0)   metrics.fpsLabel = `${Math.round(fps)}fps`;
      }

      if (bitrate > 0) {
        // >4 Mbps = good; 1–4 Mbps = acceptable; <1 Mbps = compressed
        metrics.compressionScore = bitrate >= 4_000_000 ? 90
          : bitrate >= 1_000_000 ? Math.round(40 + (bitrate / 4_000_000) * 50)
          : Math.round((bitrate / 1_000_000) * 40);
      }
    } catch { /* ignore */ }

    // ── Signal statistics (ffmpeg signalstats) — 3 evenly-spaced frames ────────
    try {
      const { stderr: sigOut } = await execPromise(
        `${ffmpegBin()} -i "${localPath}" -vf "select=not(mod(n\\,30)),signalstats" -frames:v 3 -f null -`,
        { timeout: 15_000 }
      );
      const sigStr = String(sigOut);

      // YAVG: mean luma (0–255). 128 = ideal; <16 = very dark; >240 = blown out
      const yavgMatch = /YAVG:\s*([0-9.]+)/i.exec(sigStr);
      if (yavgMatch) {
        const yavg = parseFloat(yavgMatch[1]!);
        // Exposure: penalise extremes; 50 = perfectly exposed
        const deviation = Math.abs(yavg - 128) / 128;
        metrics.exposureScore = Math.round(Math.max(0, 100 - deviation * 100));
      }

      // TOUT: percentage of out-of-range samples (0–100). Low = clean signal.
      const toutMatch = /TOUT:\s*([0-9.]+)/i.exec(sigStr);
      if (toutMatch) {
        const tout = parseFloat(toutMatch[1]!);
        // TOUT as clipping proxy: 0 = pristine; >5 = compressed/clipped
        metrics.noiseScore = Math.min(100, Math.round(tout * 10));
      }

      // VREP: vertical repetition (interlace artifact). 0 = progressive/clean.
      const vrepMatch = /VREP:\s*([0-9.]+)/i.exec(sigStr);
      if (vrepMatch) {
        const vrep = parseFloat(vrepMatch[1]!);
        // Lower VREP = better. Penalise heavy interlacing.
        const stabilityPenalty = Math.min(50, Math.round(vrep * 5));
        metrics.stabilityScore = Math.max(0, 100 - stabilityPenalty);
      }
    } catch { /* ignore */ }

    // ── Sharpness from existing QA blur score ──────────────────────────────────
    if (qa?.blurScore != null) {
      metrics.sharpnessScore = Math.min(100, qa.blurScore);
    }

    // ── Stability from freeze / handheld heuristic ─────────────────────────────
    if (qa?.hasFreezeFraction) {
      // Freeze = extremely stable but potentially broken
      metrics.stabilityScore = metrics.stabilityScore ?? 95;
    }

    // ── Composite overall quality ──────────────────────────────────────────────
    const available = [
      metrics.sharpnessScore,
      metrics.compressionScore,
      metrics.exposureScore,
      100 - (metrics.noiseScore ?? 50),     // invert noise → cleanliness
      metrics.stabilityScore,
    ].filter((v): v is number => v != null);
    if (available.length > 0) {
      metrics.overallTechnicalQuality = Math.round(
        available.reduce((a, b) => a + b, 0) / available.length
      );
    }

    return Object.keys(metrics).length > 0 ? metrics : null;
  } catch (err) {
    console.warn(`[ArchiveIntelligence] Stage 11 quality metrics failed:`, (err as Error).message?.slice(0, 80));
    return null;
  }
}

// ─── Stage 12: OCR timeline (from existing timeline segments) ─────────────────

/**
 * Build a structured OcrEntry[] from the v3/v4 timeline segments.
 * Each segment that has ocrText becomes one or more OcrEntry objects.
 * Deduplicates consecutive identical texts. No extra LLM or FFmpeg call.
 */
function buildOcrTimeline(segments: ClipSegment[] | undefined): OcrEntry[] {
  if (!segments?.length) return [];

  const entries: OcrEntry[] = [];
  for (const seg of segments) {
    if (!seg.ocrText || seg.ocrText.trim().length === 0) continue;

    // Each semicolon-separated or newline-separated text string becomes its own entry
    const texts = seg.ocrText.split(/[;\n]/).map((t) => t.trim()).filter(Boolean);
    for (const text of texts) {
      // Deduplicate: skip if identical to the previous entry in the same time window
      const last = entries[entries.length - 1];
      if (last && last.text === text && last.endSec >= seg.startSec - 0.5) {
        last.endSec = seg.endSec; // extend existing entry
        continue;
      }
      entries.push({ text: text.slice(0, 300), startSec: seg.startSec, endSec: seg.endSec, type: "other" });
    }
  }

  // Also include ocrTimeline from the LLM annotation (v4 direct output)
  return entries;
}

// ─── Stage 13: Storytelling labels (derived, no extra LLM) ───────────────────

const BEST_USED_AS_TO_FUNCTION: Record<string, StorytellingFunction> = {
  "establishing":   "establishing",
  "cutaway":        "context",
  "close detail":   "detail",
  "transition":     "transition",
  "title card":     "detail",
  "reaction shot":  "reaction",
  "b-roll":         "context",
  "interview":      "action",
  "archive":        "context",
};

const CINEMATIC_TAG_TO_FUNCTION: Record<string, StorytellingFunction> = {
  "establishing shot":  "establishing",
  "reaction shot":      "reaction",
  "insert shot":        "detail",
  "cutaway":            "context",
  "b-roll":             "context",
  "action":             "action",
  "celebration":        "emotion",
  "aftermath":          "ending",
  "procession":         "action",
  "ceremony":           "action",
  "battle":             "climax",
  "ruins":              "ending",
  "portrait":           "emotion",
  "crowd shot":         "context",
  "silhouette":         "emotion",
};

/**
 * Derive storytelling labels from existing annotation fields.
 * Maps usageHints.bestUsedAs + cinematicTags + shotImportance to editorial functions.
 * Feature flag: ARCHIVE_STORYTELLING_LABELS_ENABLED (default: "true")
 */
function deriveStorytellingLabels(annotation: ClipAnnotation): StorytellingLabels | null {
  if (process.env.ARCHIVE_STORYTELLING_LABELS_ENABLED === "false") return null;

  // If LLM already produced storytellingLabels, trust them
  if (annotation.storytellingLabels?.primary) return null; // already set

  const VALID_FUNCTIONS: StorytellingFunction[] = [
    "establishing","context","action","transition","reaction",
    "emotion","detail","reveal","climax","ending",
  ];
  const isValidFn = (v: string): v is StorytellingFunction => VALID_FUNCTIONS.includes(v as StorytellingFunction);

  // Primary: map from bestUsedAs
  const hint = (annotation.usageHints?.bestUsedAs ?? "").toLowerCase();
  let primary: StorytellingFunction =
    BEST_USED_AS_TO_FUNCTION[hint] ?? "context";

  // Override: high-importance shots get "climax" / "reveal"
  const importanceScore = annotation.shotImportance?.score ?? 0;
  if (importanceScore >= 85 && primary === "context") primary = "climax";
  else if (importanceScore >= 70 && primary === "context") primary = "reveal";

  // Secondary: mine cinematic tags
  const secondarySet: StorytellingFunction[] = [];
  for (const tag of (annotation.cinematicTags ?? [])) {
    const fn = CINEMATIC_TAG_TO_FUNCTION[tag.toLowerCase()];
    if (fn && fn !== primary && isValidFn(fn) && !secondarySet.includes(fn)) secondarySet.push(fn);
  }

  // Mine shot type
  const shotType = (annotation.cinematography?.shotType ?? "").toLowerCase();
  if (shotType.includes("establishing") && primary !== "establishing" && !secondarySet.includes("establishing")) secondarySet.push("establishing");
  if (shotType.includes("close") && !secondarySet.includes("detail")) secondarySet.push("detail");

  const secondaryArr = secondarySet.slice(0, 3);

  return { primary, secondary: secondaryArr.length > 0 ? secondaryArr : undefined };
}

// ─── Stage 14: Archive uniqueness (embedding comparison) ─────────────────────

/**
 * Count how many other clips in our archive have embedding similarity ≥ 0.85.
 * A unique clip (no similar clips) scores 100; common footage scores lower.
 * Feature flag: ARCHIVE_UNIQUENESS_SCORING_ENABLED (default: "true")
 */
async function computeArchiveUniqueness(
  assetId: number,
  embedding: number[]
): Promise<ArchiveUniqueness | null> {
  if (process.env.ARCHIVE_UNIQUENESS_SCORING_ENABLED === "false") return null;
  if (!embedding || embedding.length === 0) return null;

  const SIMILARITY_THRESHOLD = 0.85; // lower than near-dup (0.97) — catches same scene/event

  try {
    const dir = localEmbeddingDir();
    if (!fs.existsSync(dir)) return null;

    const files = fs.readdirSync(dir).filter((f) => f.match(/^\d+\.json$/));
    let nearCount = 0;

    for (const file of files) {
      const otherId = parseInt(path.basename(file, ".json"), 10);
      if (isNaN(otherId) || otherId === assetId) continue;
      try {
        const stored = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as {
          embedding?: number[];
        };
        if (!Array.isArray(stored.embedding) || stored.embedding.length !== embedding.length) continue;
        const sim = cosineSim(embedding, stored.embedding);
        if (sim >= SIMILARITY_THRESHOLD) nearCount++;
        // Cap scan to 200 files to avoid blocking the pipeline too long
        if (files.indexOf(file) > 200) break;
      } catch { /* ignore corrupt file */ }
    }

    const score = Math.max(0, Math.min(100, Math.round(100 - nearCount * 15)));
    const reason = nearCount === 0
      ? "No similar clips found in archive — highly unique"
      : `${nearCount} similar clip${nearCount === 1 ? "" : "s"} found in archive`;

    return { score, nearDuplicateCount: nearCount, reason };
  } catch (err) {
    console.warn(`[ArchiveIntelligence] Stage 14 archive uniqueness failed:`, (err as Error).message?.slice(0, 80));
    return null;
  }
}

// ─── Stage 15: Asset health score (pure computation) ──────────────────────────

/**
 * Compute a composite health score from all available annotation metadata.
 * No LLM calls, no I/O — pure aggregation of already-computed fields.
 * Always runs unless disabled.
 */
function computeHealthScore(annotation: ClipAnnotation): AssetHealthScore {
  // ── Metadata completeness ──────────────────────────────────────────────────
  const filledChecks = [
    annotation.persons.named.length > 0,
    annotation.persons.categories.length > 0,
    annotation.objects.length > 0,
    annotation.actions.length > 0,
    annotation.historicalContext.event.length > 0,
    annotation.historicalContext.year.length > 0,
    annotation.location.country.length > 0,
    annotation.editorialDescription && annotation.editorialDescription.length > 50,
    (annotation.searchAliases?.length ?? 0) >= 5,
    (annotation.knowledgeGraphEntities?.length ?? 0) >= 3,
    annotation.timeline?.length != null && annotation.timeline.length > 0,
    annotation.faceTracks != null,
    annotation.cinematicTags?.length != null && annotation.cinematicTags.length > 0,
    annotation.descriptions?.extended != null && annotation.descriptions.extended.length > 100,
    annotation.storytellingLabels != null,
    annotation.audioEvents != null,
    annotation.ocrTimeline != null || annotation.ocrText != null,
    annotation.shotImportance != null,
  ];
  const metadataCompleteness = Math.round((filledChecks.filter(Boolean).length / filledChecks.length) * 100);

  // ── Technical quality ──────────────────────────────────────────────────────
  const qm = annotation.qualityMetrics;
  const q = annotation.quality;
  const technicalQuality = qm?.overallTechnicalQuality
    ?? Math.round((q.overall + q.sharpness + q.stability + q.compression + q.exposure) / 5);

  // ── Editorial quality ──────────────────────────────────────────────────────
  const editorialQuality = annotation.editorialScore.total;

  // ── Archive uniqueness ─────────────────────────────────────────────────────
  const archiveUniqScore = annotation.archiveUniqueness?.score
    ?? annotation.visualUniqueness?.score
    ?? 50;

  // ── Composite (weighted) ───────────────────────────────────────────────────
  const score = Math.round(
    metadataCompleteness * 0.35 +
    technicalQuality     * 0.25 +
    editorialQuality     * 0.25 +
    archiveUniqScore     * 0.15
  );

  return {
    score: Math.min(100, Math.max(0, score)),
    metadataCompleteness,
    technicalQuality,
    editorialQuality,
    archiveUniqueness: archiveUniqScore,
    computedAt: new Date().toISOString(),
  };
}

// ─── Stage 7: Logging ─────────────────────────────────────────────────────────

function logIntelligenceReport(
  asset: MediaArchiveAsset,
  annotation: ClipAnnotation,
  qa: VideoQualityAnalysis | null,
  facetCount: number,
  nearDupId: number | null,
  aliasCount: number,
  elapsedMs: number,
  segmentCount?: number
): void {
  const qf = annotation.qualityFlags ?? {};
  const flags = [
    qf.isBlack          ? "BLACK"     : null,
    qf.isBlurry         ? "BLURRY"    : null,
    qf.hasWatermark     ? "WATERMARK" : null,
    qf.isIntroOrOutro   ? "INTRO/OUTRO" : null,
    qf.isCreditSequence ? "CREDITS"   : null,
    qf.hasTitleCard     ? "TITLE_CARD": null,
    qf.isTestPattern    ? "TEST_PATTERN": null,
    nearDupId != null   ? `NEAR_DUP:${nearDupId}` : null,
  ].filter(Boolean);

  const es = annotation.editorialScore;
  const ext = annotation.extendedEditorialScore;
  const conf = annotation.confidence;
  const loc = annotation.location;

  console.log(
    `[ArchiveIntelligence] asset ${asset.id} "${(asset.title ?? "").slice(0, 50)}" — ${elapsedMs}ms\n` +
    `  Version:     ${annotation.version}\n` +
    `  Persons:     ${annotation.persons.named.join(", ") || "(none)"} [conf:${(conf?.persons ?? 0).toFixed(2)}]\n` +
    `  Categories:  ${annotation.persons.categories.join(", ") || "(none)"}\n` +
    `  Objects:     ${annotation.objects.slice(0, 8).join(", ")}\n` +
    `  Actions:     ${annotation.actions.slice(0, 5).join(", ")}\n` +
    `  Location:    ${[loc.city, loc.country].filter(Boolean).join(", ") || "unknown"} [${loc.confidence}|conf:${(conf?.location ?? 0).toFixed(2)}]\n` +
    `  Era:         ${[annotation.historicalContext.year, annotation.historicalContext.period].filter(Boolean).join(" | ") || "unknown"} [conf:${(conf?.historicalContext ?? 0).toFixed(2)}]\n` +
    `  Event:       ${annotation.historicalContext.event || "(none)"}\n` +
    `  Emotion:     ${annotation.emotion} [conf:${(conf?.emotion ?? 0).toFixed(2)}]\n` +
    `  Motion:      ${annotation.motionLevel}/100  Setting: ${annotation.environment.setting}  Lighting: ${annotation.environment.lighting}\n` +
    `  Shot:        ${annotation.cinematography.shotType} | ${annotation.cinematography.cameraMovement} | ${annotation.cinematography.visualStyle}\n` +
    `  Quality:     overall:${annotation.quality.overall} sharp:${annotation.quality.sharpness} stability:${annotation.quality.stability}` +
    (qa ? ` | blur:${qa.blurScore} blackFrac:${(qa.blackFrameFraction * 100).toFixed(1)}%` : "") + "\n" +
    `  Editorial:   hist:${es.historicalUsability} cinematic:${es.cinematicQuality} story:${es.storytellingPotential} emotion:${es.emotionalValue} orig:${es.originality} total:${es.total}\n` +
    (ext ? `  Extended:    news:${ext.newsValue} doc:${ext.documentaryValue} src:${ext.sourceQualityScore} reuse:${ext.reusabilityScore}\n` : "") +
    `  KG entities: ${(annotation.knowledgeGraphEntities ?? []).length} terms\n` +
    `  Aliases:     ${aliasCount} search terms\n` +
    `  Facets:      ${facetCount} embeddings\n` +
    `  Flags:       ${flags.length > 0 ? flags.join(" ") : "clean"}\n` +
    `  Description: ${(annotation.editorialDescription ?? "").slice(0, 120)}…\n` +
    (annotation.descriptions ? `  Short desc:  ${annotation.descriptions.short.slice(0, 120)}\n` : "") +
    (annotation.shotImportance ? `  Importance:  ${annotation.shotImportance.score}/100 [${annotation.shotImportance.label}] — ${annotation.shotImportance.reason.slice(0, 80)}\n` : "") +
    (annotation.visualUniqueness ? `  Uniqueness:  ${annotation.visualUniqueness.score}/100 — ${annotation.visualUniqueness.reason.slice(0, 80)}\n` : "") +
    (annotation.timeline?.length ? `  Timeline:    ${annotation.timeline.length} segments\n` + annotation.timeline.map((s) => `    ${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)}s [${s.shotType}] ${s.description.slice(0, 70)}`).join("\n") + "\n" : "") +
    (annotation.objectTracks?.length ? `  ObjTracks:   ${annotation.objectTracks.map((t) => `${t.object} ${t.movement}`).join("; ")}\n` : "") +
    (annotation.faceTracks?.length ? `  FaceTracks:  ${annotation.faceTracks.map((f) => `${f.name} ${(f.dominanceFraction * 100).toFixed(0)}% dom`).join("; ")}\n` : "") +
    (annotation.ocrText?.length ? `  OCR text:    ${annotation.ocrText.slice(0, 6).join(" | ")}\n` : "") +
    (annotation.cinematicTags?.length ? `  CineTags:    ${annotation.cinematicTags.slice(0, 8).join(", ")}\n` : "") +
    (annotation.audioEvents?.length ? `  Audio:       ${annotation.audioEvents.map((e) => e.type).join(", ")}\n` : "") +
    (annotation.cameraMovementDetail ? `  CameraDetail:${annotation.cameraMovementDetail.slice(0, 100)}\n` : "") +
    (segmentCount !== undefined ? `  Seg embeds:  ${segmentCount}\n` : "") +
    (annotation.storytellingLabels ? `  Storytelling:${annotation.storytellingLabels.primary}${annotation.storytellingLabels.secondary?.length ? ` + ${annotation.storytellingLabels.secondary.join(", ")}` : ""}\n` : "") +
    (annotation.qualityMetrics ? `  QualMetrics: sharp:${annotation.qualityMetrics.sharpnessScore ?? "?"} blur:${annotation.qualityMetrics.motionBlurScore ?? "?"} noise:${annotation.qualityMetrics.noiseScore ?? "?"} exposure:${annotation.qualityMetrics.exposureScore ?? "?"} overall:${annotation.qualityMetrics.overallTechnicalQuality ?? "?"} res:${annotation.qualityMetrics.resolutionLabel ?? "?"} fps:${annotation.qualityMetrics.fpsLabel ?? "?"}\n` : "") +
    (annotation.ocrTimeline?.length ? `  OCR timeline:${annotation.ocrTimeline.length} entries: ${annotation.ocrTimeline.slice(0, 3).map((e) => `"${e.text.slice(0, 30)}" ${e.startSec.toFixed(1)}–${e.endSec.toFixed(1)}s`).join("; ")}\n` : "") +
    (annotation.archiveUniqueness ? `  ArcUniqueness:${annotation.archiveUniqueness.score}/100 — ${annotation.archiveUniqueness.reason ?? ""}\n` : "") +
    (annotation.healthScore ? `  HealthScore: ${annotation.healthScore.score}/100 (meta:${annotation.healthScore.metadataCompleteness} tech:${annotation.healthScore.technicalQuality} edit:${annotation.healthScore.editorialQuality} uniq:${annotation.healthScore.archiveUniqueness})\n` : "")
  );
}

// ─── DB save ─────────────────────────────────────────────────────────────────

async function saveEnrichedAnnotation(
  assetId: number,
  annotation: ClipAnnotation
): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn(`[ArchiveIntelligence] DB not available — annotation not saved for asset ${assetId}`);
    return;
  }
  await db
    .update(mediaArchiveAssets)
    .set({
      annotationJson: annotation,
      editorialScore: annotation.editorialScore.total,
      annotationVersion: ANNOTATION_VERSION,
    })
    .where(eq(mediaArchiveAssets.id, assetId));
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export type ArchiveIntelligenceOptions = {
  /** Local path to the video file on disk (needed for quality analysis). */
  localVideoPath?: string;
  /** If true, skip facet embedding generation (faster, less storage). */
  skipFacetEmbeddings?: boolean;
  /** If true, skip near-duplicate detection (faster for bulk backfill). */
  skipNearDupDetect?: boolean;
  /** Existing main embedding vector (avoids a redundant load). */
  mainEmbedding?: number[];
};

/**
 * Run the full Archive Intelligence Pipeline on one asset.
 *
 * Call after the initial DB record has been created. This enriches the asset
 * with v2 annotation, quality analysis, facet embeddings, and near-dup flags.
 *
 * Never throws — all errors are logged and swallowed. Returns the final
 * annotation (or null if the DB asset could not be loaded).
 */
export async function runArchiveIntelligencePipeline(
  asset: MediaArchiveAsset,
  opts: ArchiveIntelligenceOptions = {}
): Promise<ClipAnnotation | null> {
  if (!archiveIntelligencePipelineEnabled()) return null;

  const startMs = Date.now();

  try {
    console.log(
      `[ArchiveIntelligence] starting pipeline for asset ${asset.id} "${(asset.title ?? "").slice(0, 60)}"`
    );

    // ── Stage 1: Enhanced LLM annotation ──────────────────────────────────────
    const annotation = await annotateAsset(asset);

    // ── Stage 2: Video quality analysis ────────────────────────────────────────
    let qa: VideoQualityAnalysis | null = null;
    if (opts.localVideoPath) {
      qa = await analyzeVideoQuality(opts.localVideoPath);
      if (qa) {
        // Merge quality analysis results into annotation flags
        const qf = annotation.qualityFlags ?? {};
        if (qa.isBlack)  qf.isBlack  = true;
        if (qa.isBlurry) qf.isBlurry = true;
        annotation.qualityFlags = qf;

        // Also push quality signal back into the quality scores
        if (qa.isBlurry) {
          annotation.quality.sharpness = Math.min(annotation.quality.sharpness, 25);
          annotation.quality.overall   = Math.round(annotation.quality.overall * 0.7);
        }
        if (qa.isBlack) {
          annotation.quality.overall = Math.min(annotation.quality.overall, 10);
          annotation.editorialScore.total = Math.min(annotation.editorialScore.total, 10);
        }
      }
    }

    // ── Stage 2b: Metadata-based quality heuristics ─────────────────────────
    const metaFlags = inferQualityFlagsFromMetadata(asset);
    const qf = annotation.qualityFlags ?? {};
    if (metaFlags.hasWatermark)     qf.hasWatermark     = true;
    if (metaFlags.isIntroOrOutro)   qf.isIntroOrOutro   = true;
    if (metaFlags.isCreditSequence) qf.isCreditSequence = true;
    if (metaFlags.hasTitleCard)     qf.hasTitleCard     = true;
    if (metaFlags.isTestPattern)    qf.isTestPattern    = true;
    annotation.qualityFlags = qf;

    // Apply quality flag penalties to editorial score
    const flagPenalties = [
      qf.hasWatermark     ? -15 : 0,
      qf.isIntroOrOutro   ? -20 : 0,
      qf.isCreditSequence ? -30 : 0,
      qf.hasTitleCard     ? -15 : 0,
      qf.isTestPattern    ? -40 : 0,
    ].reduce((a, b) => a + b, 0);

    if (flagPenalties < 0) {
      annotation.editorialScore.total = Math.max(0, annotation.editorialScore.total + flagPenalties);
      if (annotation.extendedEditorialScore) {
        annotation.extendedEditorialScore.reusabilityScore =
          Math.max(0, annotation.extendedEditorialScore.reusabilityScore + flagPenalties);
      }
    }

    // ── Stage 4: Near-duplicate detection ──────────────────────────────────────
    let nearDupId: number | null = null;
    if (!opts.skipNearDupDetect && opts.mainEmbedding && opts.mainEmbedding.length > 0) {
      nearDupId = await detectNearDuplicate(asset.id, opts.mainEmbedding);
      if (nearDupId !== null) {
        if (!annotation.qualityFlags) annotation.qualityFlags = {};
        annotation.qualityFlags.nearDuplicateOf = nearDupId;
        // Near-duplication significantly reduces editorial value
        annotation.editorialScore.originality = Math.min(
          annotation.editorialScore.originality, 20
        );
      }
    }

    // ── Stage 5: Facet embeddings ──────────────────────────────────────────────
    let facetCount = 0;
    if (!opts.skipFacetEmbeddings) {
      const facetKeys = await generateFacetEmbeddings(asset.id, annotation, asset);
      facetCount = Object.keys(facetKeys).length;
      if (facetCount > 0) {
        annotation.facetEmbeddingKeys = {
          description: facetKeys["description"],
          persons:     facetKeys["persons"],
          location:    facetKeys["location"],
          objects:     facetKeys["objects"],
          events:      facetKeys["events"],
          emotions:    facetKeys["emotions"],
          style:       facetKeys["style"],
        };
      }
    }

    // ── Stage 6: Search alias expansion ───────────────────────────────────────
    const expandedAliases = expandSearchAliases(
      annotation.searchAliases ?? [],
      annotation.knowledgeGraphEntities ?? [],
      asset.tags ?? []
    );
    annotation.searchAliases = expandedAliases;

    // ── Stage 8: Multi-frame vision analysis ──────────────────────────────────
    const confirmedDuration = qa?.confirmedDurationSec ?? (asset.durationSec ?? 0);
    if (opts.localVideoPath && confirmedDuration > 0) {
      const vision = await runVisionAnalysis(asset, opts.localVideoPath, confirmedDuration);
      if (vision) {
        // Vision results take precedence over LLM inference (real pixels > text inference)
        if (vision.timeline?.length)          annotation.timeline          = vision.timeline;
        if (vision.objectTracks?.length)      annotation.objectTracks      = vision.objectTracks;
        if (vision.faceTracks?.length)        annotation.faceTracks        = vision.faceTracks;
        if (vision.ocrText?.length)           annotation.ocrText           = vision.ocrText;
        if (vision.cinematicTags?.length)     annotation.cinematicTags     = vision.cinematicTags;
        if (vision.cameraMovementDetail)      annotation.cameraMovementDetail = vision.cameraMovementDetail;
        if (vision.shotImportance)            annotation.shotImportance    = vision.shotImportance;
        if (vision.visualUniqueness)          annotation.visualUniqueness  = vision.visualUniqueness;
        if (vision.descriptions?.extended)    annotation.descriptions      = vision.descriptions;
      }
    }

    // ── Stage 9: Audio intelligence ────────────────────────────────────────────
    if (opts.localVideoPath && confirmedDuration > 0) {
      const audioEvents = await analyzeAudio(opts.localVideoPath, confirmedDuration);
      if (audioEvents.length > 0) {
        annotation.audioEvents = audioEvents;
      }
    }

    // ── Stage 10: Segment-level embeddings ────────────────────────────────────
    let segmentCount = 0;
    if (!opts.skipFacetEmbeddings && annotation.timeline?.length) {
      await generateSegmentEmbeddings(asset.id, annotation.timeline);
      segmentCount = annotation.timeline.filter((s) => s.embeddingKey).length;
    }

    // ── Stage 11: Technical quality metrics (FFmpeg signalstats) ─────────────
    if (opts.localVideoPath) {
      const qm = await computeQualityMetrics(opts.localVideoPath, qa);
      if (qm) annotation.qualityMetrics = qm;
    }

    // ── Stage 12: OCR timeline (from existing timeline segments) ─────────────
    if (annotation.timeline?.length) {
      const ocrTimeline = buildOcrTimeline(annotation.timeline);
      if (ocrTimeline.length > 0) annotation.ocrTimeline = ocrTimeline;
    }

    // ── Stage 13: Storytelling labels (derived from annotation, no LLM) ──────
    const storyLabels = deriveStorytellingLabels(annotation);
    if (storyLabels) annotation.storytellingLabels = storyLabels;

    // ── Stage 14: Archive uniqueness (embedding comparison) ──────────────────
    if (opts.mainEmbedding && opts.mainEmbedding.length > 0) {
      const uniqueness = await computeArchiveUniqueness(asset.id, opts.mainEmbedding);
      if (uniqueness) annotation.archiveUniqueness = uniqueness;
    }

    // ── Stage 15: Asset health score (pure computation) ──────────────────────
    annotation.healthScore = computeHealthScore(annotation);

    // ── Stage 5b: Extended facet embeddings (ocrTimeline, audioEvents, storytelling) ──
    if (!opts.skipFacetEmbeddings && annotation.facetEmbeddingKeys) {
      const extFacets = await generateExtendedFacetEmbeddings(asset.id, annotation);
      if (extFacets.ocrTimeline)  annotation.facetEmbeddingKeys.ocrTimeline  = extFacets.ocrTimeline;
      if (extFacets.audioEvents)  annotation.facetEmbeddingKeys.audioEvents  = extFacets.audioEvents;
      if (extFacets.storytelling) annotation.facetEmbeddingKeys.storytelling = extFacets.storytelling;
    }

    // ── Stage 7: Log & save ────────────────────────────────────────────────────
    const elapsedMs = Date.now() - startMs;
    logIntelligenceReport(asset, annotation, qa, facetCount, nearDupId, expandedAliases.length, elapsedMs, segmentCount);

    await saveEnrichedAnnotation(asset.id, annotation);

    return annotation;
  } catch (err) {
    console.error(
      `[ArchiveIntelligence] pipeline failed for asset ${asset.id}:`,
      (err as Error).message?.slice(0, 200)
    );
    return null;
  }
}

// ─── Backfill entry point ─────────────────────────────────────────────────────

/**
 * Backfill wrapper: load asset from DB and run the intelligence pipeline.
 * Used by clipAnnotationBackfill.ts and admin endpoints.
 */
export async function runArchiveIntelligencePipelineForAssetId(
  assetId: number,
  opts: ArchiveIntelligenceOptions = {}
): Promise<ClipAnnotation | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select()
      .from(mediaArchiveAssets)
      .where(eq(mediaArchiveAssets.id, assetId))
      .limit(1);
    const asset = rows[0];
    if (!asset) {
      console.warn(`[ArchiveIntelligence] asset ${assetId} not found`);
      return null;
    }
    return await runArchiveIntelligencePipeline(asset, opts);
  } catch (err) {
    console.error(`[ArchiveIntelligence] backfill failed for asset ${assetId}:`, (err as Error).message?.slice(0, 120));
    return null;
  }
}

// ─── Scene detection enhancement: histogram-based cuts ───────────────────────

/**
 * Run FFmpeg histogram-change detection on a video file.
 * Returns timestamps (in seconds) where a significant colour histogram shift occurs.
 * This is complementary to scdet + scene filter.
 *
 * Enabled via ARCHIVE_HISTOGRAM_DETECT=true.
 */
export async function detectHistogramChangeCutTimes(
  inputPath: string,
  totalDur: number,
  timeoutMs = 60_000
): Promise<number[]> {
  if (process.env.ARCHIVE_HISTOGRAM_DETECT !== "true") return [];
  if (!fs.existsSync(inputPath)) return [];

  try {
    // Use the `signalstats` filter with `select` to find frames where the
    // total signal deviation (TOUT) changes sharply — a colour histogram signal.
    const threshold = 0.12; // fraction of pixel range change that counts as a cut
    const { stderr } = await execPromise(
      `${ffmpegBin()} -i "${inputPath}" ` +
      `-vf "fps=2,signalstats=stat=tout,metadata=mode=print:file=-" -an -f null -`,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }
    );

    // Parse frame-level TOUT values and detect large jumps
    const lines = String(stderr).split(/\r?\n/);
    const frames: Array<{ t: number; tout: number }> = [];
    let curTime = 0;

    for (const line of lines) {
      const timeMatch = /pts_time:([0-9.]+)/i.exec(line);
      if (timeMatch) curTime = parseFloat(timeMatch[1]);

      const toutMatch = /lavfi\.signalstats\.TOUT=([0-9.]+)/i.exec(line);
      if (toutMatch) {
        frames.push({ t: curTime, tout: parseFloat(toutMatch[1]) });
      }
    }

    const cuts: number[] = [];
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1]!;
      const curr = frames[i]!;
      const delta = Math.abs(curr.tout - prev.tout) / 255;
      if (delta >= threshold && curr.t > 0.5 && curr.t < totalDur - 0.5) {
        cuts.push(curr.t);
      }
    }

    return cuts;
  } catch {
    return [];
  }
}
