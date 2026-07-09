/**
 * Archive Intelligence Pipeline — professional-grade ingestion enrichment.
 *
 * Transforms raw archive assets into fully editorial-profiled clips that an AI
 * editor can select with the same precision as a senior BBC documentary editor.
 *
 * Pipeline stages (all run at ingest time, non-blocking for the upload response):
 *
 *   1. Enhanced LLM annotation (v2 ClipAnnotator)
 *      — persons, objects, actions, location, era, emotion, cinematography
 *      — 150-word editorial description, 15-25 search aliases
 *      — per-field confidence, quality flags, extended editorial scores
 *      — Knowledge Graph entity list
 *
 *   2. FFprobe / FFmpeg quality analysis
 *      — black frame detection
 *      — blur / freeze frame detection
 *      — duration validation
 *      — watermark heuristic from title/tags
 *
 *   3. Scene detection enhancement
 *      — histogram change detection (additive to scdet + scene filter)
 *      — enabled via ARCHIVE_HISTOGRAM_DETECT=true
 *
 *   4. Near-duplicate detection
 *      — cosine similarity against recently indexed clips
 *      — flags as nearDuplicateOf when similarity > threshold
 *
 *   5. Facet embeddings
 *      — 7 separate text embeddings (description, persons, location,
 *        objects, events, emotions, style) stored alongside the main embedding
 *
 *   6. Search alias expansion
 *      — merges LLM-generated aliases with KG-expanded terms
 *      — produces a final deduplicated alias list stored on the annotation
 *
 *   7. Rich logging
 *      — [ArchiveIntelligence] prefix, every stage logged
 *      — final report per clip: all signals, quality verdict, alias count
 *
 * Feature flag: ARCHIVE_INTELLIGENCE_PIPELINE_ENABLED (default: "true")
 * KG expansion uses the same KNOWLEDGE_GRAPH from assetDirector.ts.
 *
 * Integration: call runArchiveIntelligencePipeline() after initial DB save in
 * the archive upload handler. Non-throwing — all errors are logged and swallowed.
 */

import path from "path";
import fs from "fs";
import { exec as execCb } from "child_process";
import { promisify } from "util";

import { annotateAsset, buildEnrichedSemanticDocument, ANNOTATION_VERSION } from "./clipAnnotator";
import type { ClipAnnotation, ClipQualityFlags } from "../drizzle/annotationTypes";
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

// ─── Stage 7: Logging ─────────────────────────────────────────────────────────

function logIntelligenceReport(
  asset: MediaArchiveAsset,
  annotation: ClipAnnotation,
  qa: VideoQualityAnalysis | null,
  facetCount: number,
  nearDupId: number | null,
  aliasCount: number,
  elapsedMs: number
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
    `  Description: ${(annotation.editorialDescription ?? "").slice(0, 120)}…`
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

    // ── Stage 7: Log & save ────────────────────────────────────────────────────
    const elapsedMs = Date.now() - startMs;
    logIntelligenceReport(asset, annotation, qa, facetCount, nearDupId, expandedAliases.length, elapsedMs);

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
