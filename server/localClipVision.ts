/**
 * Local CLIP-based visual QA — no external vision API.
 * Indexes archive frames on upload; scores adopt candidates via text↔image similarity + luma.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { promisify } from "util";
import { exec as execCb } from "child_process";
import { cosineSimilarityVectors, type BeatSemanticProfile } from "./semanticVisualMatching";
import { inferVideoVisualTopic } from "./visualBeatTags";
import {
  asVideoTitleString,
  coerceVisionString,
} from "./stringCoercion";
import { beatVisualDescriptionFromIntent } from "./scriptVisualKeywords";

export { coerceVisionString, asVideoTitleString } from "./stringCoercion";

const exec = promisify(execCb);

const CLIP_MODEL = "Xenova/clip-vit-base-patch32";
export const LOCAL_FRAME_FRACTIONS = [0.12, 0.38, 0.62, 0.88];
/** Index frames aligned with gate sampling so pre-rank scores predict adopt gates. */
const INDEX_FRAME_FRACTIONS = LOCAL_FRAME_FRACTIONS.slice(0, 3);

type ClipPipeline = (input: string, options?: Record<string, unknown>) => Promise<{ data: Float32Array }>;

let imagePipeline: ClipPipeline | null = null;
let textPipeline: ClipPipeline | null = null;
let pipelineLoadFailed = false;
let pipelineLoadInFlight: Promise<boolean> | null = null;
let imageLoadAttempts = 0;
let textLoadAttempts = 0;
const MAX_PIPELINE_LOAD_ATTEMPTS = 3;

/** Writable cache dir for Hugging Face / ONNX model weights (Railway volume preferred). */
export function clipModelCacheDir(): string {
  const explicit =
    process.env.TRANSFORMERS_CACHE?.trim() ||
    process.env.HF_HOME?.trim() ||
    process.env.XDG_CACHE_HOME?.trim();
  if (explicit) return explicit;
  if (process.env.UPLOADS_DIR?.startsWith("/data")) {
    return path.join(path.dirname(process.env.UPLOADS_DIR), "transformers-cache");
  }
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim()) {
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH.trim(), "transformers-cache");
  }
  return path.join(os.tmpdir(), "fastvid-transformers-cache");
}

let transformersEnvConfigured = false;

function configureTransformersEnv(): string {
  const cacheDir = clipModelCacheDir();
  if (!transformersEnvConfigured) {
    transformersEnvConfigured = true;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
    } catch {
      /* ignore — import may still succeed with in-memory cache */
    }
    process.env.TRANSFORMERS_CACHE = cacheDir;
    process.env.HF_HOME = cacheDir;
    process.env.XDG_CACHE_HOME = cacheDir;
  }
  return cacheDir;
}

async function importTransformersPipeline() {
  const cacheDir = configureTransformersEnv();
  const { env, pipeline } = await import("@xenova/transformers");
  env.cacheDir = cacheDir;
  env.allowRemoteModels = true;
  env.useBrowserCache = false;
  env.backends.onnx.wasm.numThreads = 1;
  return pipeline;
}

/** Local visual QA on by default — set ENABLE_LOCAL_VISION=false to disable. */
export function localVisionEnabled(): boolean {
  return process.env.ENABLE_LOCAL_VISION !== "false";
}

/** Background CLIP index on archive upload (default on with local vision). */
export function clipEmbeddingIndexEnabled(): boolean {
  if (process.env.ENABLE_CLIP_EMBEDDING_INDEX === "false") return false;
  return localVisionEnabled();
}

export function ffmpegBin(): string {
  return process.env.FFMPEG_BIN?.trim() || "ffmpeg";
}

export function clipSimToScore(sim: number): number {
  return Math.max(0, Math.min(10, Math.round(sim * 40)));
}

/** Minimum cosine similarity (0–1) to pass gate; derived from MIN_CLIP_QUALITY_SCORE unless overridden. */
export function minLocalClipSimilarity(minScore10 = 8): number {
  const raw = process.env.LOCAL_VISION_MIN_SIMILARITY?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.08 && n <= 0.55) return n;
  }
  return minScore10 / 40;
}

const MODERN_MISMATCH_QUERIES = [
  "modern business conference presentation projector screen audience",
  "laptop computer software code documentation office meeting",
  "corporate keynote speaker slide deck technology startup",
  "smartphone tablet digital app interface screen",
  "contemporary office whiteboard team meeting",
];

export function topicNeedsHistoricalFootage(beatText: string, videoTitle?: unknown): boolean {
  const topic = inferVideoVisualTopic(videoTitle, beatText);
  if (topic === "wwii" || topic === "cold_war") return true;
  const hay = `${asVideoTitleString(videoTitle)} ${beatText}`.toLowerCase();
  return /\b(19\d{2}|20[0-1]\d|world war|wwii|ww2|war|historical|archive|ancient|century|hitler|nazi|berlin|titanic)\b/.test(
    hay
  );
}

async function getModernMismatchEmbeddings(): Promise<number[][]> {
  if (modernMismatchEmbCache) return modernMismatchEmbCache;
  const out: number[][] = [];
  for (const q of MODERN_MISMATCH_QUERIES) {
    const emb = await embedTextQuery(q);
    if (emb) out.push(emb);
  }
  modernMismatchEmbCache = out;
  return out;
}

async function modernContentMismatchAgainstEmbeddings(
  imageEmbeddings: number[][],
  beatQueryEmb: number[],
  beatText: string,
  videoTitle?: string
): Promise<boolean> {
  if (!topicNeedsHistoricalFootage(beatText, videoTitle)) return false;
  const negEmbs = await getModernMismatchEmbeddings();
  if (negEmbs.length === 0) return false;
  const samples = imageEmbeddings.slice(0, Math.min(2, imageEmbeddings.length));
  for (const imgEmb of samples) {
    const beatSim = scoreEmbeddingSimilarity(beatQueryEmb, imgEmb);
    for (const negEmb of negEmbs) {
      const negSim = scoreEmbeddingSimilarity(negEmb, imgEmb);
      if (negSim >= beatSim - 0.01) return true;
      if (negSim >= 0.18 && beatSim < 0.24) return true;
    }
  }
  return false;
}

async function modernContentMismatchAgainstBeat(
  framePaths: string[],
  beatQueryEmb: number[],
  beatText: string,
  videoTitle?: string
): Promise<boolean> {
  const imageEmbeddings: number[][] = [];
  for (const fp of framePaths.slice(0, Math.min(2, framePaths.length))) {
    const emb = await embedImageFromPath(fp);
    if (emb) imageEmbeddings.push(emb);
  }
  return modernContentMismatchAgainstEmbeddings(imageEmbeddings, beatQueryEmb, beatText, videoTitle);
}

const TEXT_EMBED_CACHE_MAX = 320;
const textEmbeddingCache = new Map<string, number[]>();
let modernMismatchEmbCache: number[][] | null = null;

export type BeatVisionQueryContext = {
  beatText: string;
  visualDescription?: string;
  videoTitle?: string;
  searchQuery?: string;
  powerWord?: string;
  semanticSummary?: string;
  semanticPersons?: string[];
  semanticLocations?: string[];
  semanticObjects?: string[];
  semanticYears?: string[];
  semanticEvents?: string[];
};

function uniqueQueryParts(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const v = item.trim();
    if (!v || v.length < 2 || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

/** Rich CLIP query — concrete visual intent and entities before raw narration. */
export function buildBeatVisionQueryText(ctx: BeatVisionQueryContext): string {
  const parts: string[] = [];
  const visual = coerceVisionString(ctx.visualDescription)?.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  if (visual && visual.length >= 8) parts.push(visual.slice(0, 180));

  const summary = coerceVisionString(ctx.semanticSummary)?.trim();
  if (summary && summary !== visual) parts.push(summary.slice(0, 160));

  const entityBits = uniqueQueryParts([
    ...(ctx.semanticPersons ?? []).slice(0, 2),
    ...(ctx.semanticLocations ?? []).slice(0, 2),
    ...(ctx.semanticObjects ?? []).slice(0, 2),
    ...(ctx.semanticYears ?? []).slice(0, 2),
    ...(ctx.semanticEvents ?? []).slice(0, 1),
  ]);
  if (entityBits.length) parts.push(`Subject: ${entityBits.join(", ")}`);

  const shot = coerceVisionString(ctx.searchQuery)?.trim();
  if (shot && shot.length >= 4 && !parts.some((p) => p.includes(shot.slice(0, 20)))) {
    parts.push(shot.slice(0, 100));
  }
  const powerWord = coerceVisionString(ctx.powerWord);
  if (powerWord?.trim() && powerWord.length >= 3) {
    parts.push(powerWord.trim().slice(0, 40));
  }

  const hasRichVisualIntent = parts.length > 0;
  const narration = coerceVisionString(ctx.beatText)?.replace(/\[visual:[^\]]+\]/gi, " ").trim() ?? "";
  if (narration) {
    parts.push(hasRichVisualIntent ? narration.slice(0, 80) : narration.slice(0, 180));
  }
  const videoTitle = coerceVisionString(ctx.videoTitle);
  if (videoTitle?.trim() && !hasRichVisualIntent) parts.push(videoTitle.trim().slice(0, 60));

  return parts.filter(Boolean).join(". ");
}

export function beatVisionContextFromProfile(
  beat: {
    text: string;
    searchQuery?: string;
    powerWord?: string;
    visualDescription?: string;
  },
  videoTitle?: string,
  semanticProfile?: BeatSemanticProfile
): BeatVisionQueryContext {
  const visualDescription =
    beat.visualDescription?.trim() || semanticProfile?.summary?.trim() || undefined;
  return {
    beatText: coerceVisionString(beat.text) ?? "",
    visualDescription,
    videoTitle: coerceVisionString(videoTitle),
    searchQuery: coerceVisionString(beat.searchQuery),
    powerWord: coerceVisionString(beat.powerWord),
    semanticSummary: semanticProfile?.summary,
    semanticPersons: semanticProfile?.entities.persons,
    semanticLocations: semanticProfile?.entities.locations,
    semanticObjects: semanticProfile?.entities.objects,
    semanticYears: semanticProfile?.entities.years,
    semanticEvents: semanticProfile?.entities.events,
  };
}

export async function resolveBeatVisionQueryEmbedding(
  ctx: BeatVisionQueryContext
): Promise<number[] | null> {
  return embedTextQuery(buildBeatVisionQueryText(ctx));
}

export async function resolveBeatQueryEmbedding(
  beatText: string,
  visualDescription?: string,
  videoTitle?: string
): Promise<number[] | null> {
  return resolveBeatVisionQueryEmbedding({ beatText, visualDescription, videoTitle });
}

/** Rich CLIP gate context — script [visual:] cues, beat description, semantic summary. */
export function beatGateVisualDescription(
  beat: { text: string; visualDescription?: string; searchQuery?: string; powerWord?: string },
  semanticProfile?: { summary?: string }
): string | undefined {
  const parts: string[] = [];
  const cue = beat.text.match(/\[visual:\s*([^\]]+)\]/i)?.[1];
  if (cue?.trim()) parts.push(cue.trim());
  for (const raw of [
    beat.visualDescription,
    beatVisualDescriptionFromIntent(beat.text),
    semanticProfile?.summary,
    beat.searchQuery,
    beat.powerWord,
  ]) {
    const v = coerceVisionString(raw)?.trim();
    if (v && !parts.some((p) => p.toLowerCase() === v.toLowerCase())) parts.push(v);
  }
  return parts.length ? parts.join(". ").slice(0, 320) : undefined;
}

function significantBeatTokens(beatText: string, videoTitle?: string): Set<string> {
  const text = `${asVideoTitleString(videoTitle)} ${beatText}`.toLowerCase();
  const tokens = text.match(/[a-zà-ÿ]{4,}/g) ?? [];
  const stop = new Set([
    "that", "this", "with", "from", "they", "were", "have", "been", "their", "which",
    "would", "about", "there", "these", "those", "after", "before", "during", "while",
    "also", "into", "over", "under", "more", "most", "some", "such", "than", "then",
    "when", "what", "where", "word", "words", "video", "scene", "clip",
  ]);
  return new Set(tokens.filter((t) => !stop.has(t)));
}

/** Small boost when beat keywords appear in clip filename (stock paths). */
export function filenameLexicalBoost(clipPath: string, beatText: string, videoTitle?: string): number {
  const base = path.basename(clipPath).toLowerCase().replace(/[_\-.]+/g, " ");
  const tokens = significantBeatTokens(beatText, videoTitle);
  if (tokens.size === 0) return 0;
  let hits = 0;
  for (const t of tokens) {
    if (base.includes(t)) hits++;
  }
  return Math.min(0.06, hits * 0.02);
}

const PIPELINE_LOAD_TIMEOUT_MS = 90_000;

function withPipelineTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[LocalVision] TIMEOUT after ${PIPELINE_LOAD_TIMEOUT_MS / 1000}s: ${label}`)), PIPELINE_LOAD_TIMEOUT_MS)
    ),
  ]);
}

async function loadImagePipeline(): Promise<ClipPipeline | null> {
  if (!localVisionEnabled()) return null;
  if (imagePipeline) return imagePipeline;
  if (pipelineLoadFailed && imageLoadAttempts >= MAX_PIPELINE_LOAD_ATTEMPTS) return null;
  console.log(`[LocalVision] BEFORE load image pipeline (attempt ${imageLoadAttempts + 1})`);
  try {
    const pipeline = await withPipelineTimeout(importTransformersPipeline(), "import @xenova/transformers");
    console.log(`[LocalVision] BEFORE pipeline("image-feature-extraction")`);
    imagePipeline = (await withPipelineTimeout(
      pipeline("image-feature-extraction", CLIP_MODEL, { quantized: true }),
      `pipeline(image-feature-extraction, ${CLIP_MODEL})`
    )) as ClipPipeline;
    console.log(`[LocalVision] AFTER pipeline("image-feature-extraction") — OK`);
    pipelineLoadFailed = false;
    return imagePipeline;
  } catch (err) {
    imageLoadAttempts++;
    console.warn(
      `[LocalVision] CLIP image pipeline failed (attempt ${imageLoadAttempts}/${MAX_PIPELINE_LOAD_ATTEMPTS}):`,
      (err as Error).message?.slice(0, 200)
    );
    if (imageLoadAttempts >= MAX_PIPELINE_LOAD_ATTEMPTS) {
      pipelineLoadFailed = true;
    }
    return null;
  }
}

async function loadTextPipeline(): Promise<ClipPipeline | null> {
  if (!localVisionEnabled()) return null;
  if (textPipeline) return textPipeline;
  if (pipelineLoadFailed && textLoadAttempts >= MAX_PIPELINE_LOAD_ATTEMPTS) return null;
  console.log(`[LocalVision] BEFORE load text pipeline (attempt ${textLoadAttempts + 1})`);
  try {
    const pipeline = await withPipelineTimeout(importTransformersPipeline(), "import @xenova/transformers (text)");
    console.log(`[LocalVision] BEFORE pipeline("feature-extraction")`);
    textPipeline = (await withPipelineTimeout(
      pipeline("feature-extraction", CLIP_MODEL, { quantized: true }),
      `pipeline(feature-extraction, ${CLIP_MODEL})`
    )) as ClipPipeline;
    console.log(`[LocalVision] AFTER pipeline("feature-extraction") — OK`);
    pipelineLoadFailed = false;
    return textPipeline;
  } catch (err) {
    textLoadAttempts++;
    console.warn(
      `[LocalVision] CLIP text pipeline failed (attempt ${textLoadAttempts}/${MAX_PIPELINE_LOAD_ATTEMPTS}):`,
      (err as Error).message?.slice(0, 200)
    );
    if (textLoadAttempts >= MAX_PIPELINE_LOAD_ATTEMPTS) {
      pipelineLoadFailed = true;
    }
    return null;
  }
}

/** Load image + text pipelines once (sequential to reduce peak RAM on Railway). */
export async function ensureClipPipelinesLoaded(): Promise<boolean> {
  if (!localVisionEnabled()) return false;
  if (imagePipeline && textPipeline) return true;
  if (pipelineLoadInFlight) {
    console.log(`[LocalVision] BEFORE ensureClipPipelinesLoaded (in-flight, waiting)`);
    const r = await pipelineLoadInFlight;
    console.log(`[LocalVision] AFTER ensureClipPipelinesLoaded (was in-flight) => ${r}`);
    return r;
  }
  console.log(`[LocalVision] BEFORE ensureClipPipelinesLoaded (starting load)`);
  pipelineLoadInFlight = (async () => {
    const image = await loadImagePipeline();
    const text = image ? await loadTextPipeline() : null;
    pipelineLoadInFlight = null;
    const ok = !!(image && text);
    console.log(`[LocalVision] AFTER ensureClipPipelinesLoaded => image=${!!image} text=${!!text} ok=${ok}`);
    return ok;
  })();
  return pipelineLoadInFlight;
}

export async function embedImageFromPath(imagePath: string): Promise<number[] | null> {
  if (!localVisionEnabled() || !fs.existsSync(imagePath)) return null;
  const pipe = await loadImagePipeline();
  if (!pipe) return null;
  try {
    const result = await pipe(imagePath);
    const embedding = Array.from(result.data);
    return embedding.length >= 8 ? embedding : null;
  } catch {
    return null;
  }
}

export type ClipBatchEmbedMode = "batch" | "sequential";

/**
 * Embed multiple images in one pipeline call when the underlying transformers.js pipeline
 * accepts array input (most image-feature-extraction pipelines do). Falls back to
 * sequential embedImageFromPath calls if batched output can't be cleanly split per image
 * (e.g. older/incompatible pipeline build) or the batched call throws. Order of the
 * returned array always matches imagePaths; missing/failed files are null.
 */
export async function embedImagesFromPaths(imagePaths: string[]): Promise<{ embeddings: (number[] | null)[]; mode: ClipBatchEmbedMode }> {
  if (!localVisionEnabled() || imagePaths.length === 0) {
    return { embeddings: imagePaths.map(() => null), mode: "sequential" };
  }
  const exists = imagePaths.map((p) => fs.existsSync(p));
  const pipe = await loadImagePipeline();
  if (!pipe) return { embeddings: imagePaths.map(() => null), mode: "sequential" };

  if (imagePaths.length > 1 && exists.every(Boolean)) {
    try {
      const result = await (pipe as unknown as (input: string[]) => Promise<{ data: Float32Array }>)(imagePaths);
      const data = Array.from(result.data);
      const dim = data.length / imagePaths.length;
      if (Number.isInteger(dim) && dim >= 8) {
        const embeddings: number[][] = [];
        for (let i = 0; i < imagePaths.length; i++) {
          embeddings.push(data.slice(i * dim, (i + 1) * dim));
        }
        return { embeddings, mode: "batch" };
      }
    } catch {
      // Fall through to sequential — batched array input isn't supported by this pipeline build.
    }
  }

  const embeddings = await Promise.all(
    imagePaths.map((p, i) => (exists[i] ? embedImageFromPath(p) : Promise.resolve(null)))
  );
  return { embeddings, mode: "sequential" };
}

export async function embedTextQuery(query: string): Promise<number[] | null> {
  const key = query.trim();
  if (!localVisionEnabled() || !key) return null;
  const cached = textEmbeddingCache.get(key);
  if (cached) return cached;
  const pipe = await loadTextPipeline();
  if (!pipe) return null;
  try {
    const result = await pipe(key, { pooling: "mean", normalize: true });
    const embedding = Array.from(result.data);
    if (embedding.length < 8) return null;
    if (textEmbeddingCache.size >= TEXT_EMBED_CACHE_MAX) {
      const oldest = textEmbeddingCache.keys().next().value;
      if (oldest) textEmbeddingCache.delete(oldest);
    }
    textEmbeddingCache.set(key, embedding);
    return embedding;
  } catch {
    return null;
  }
}

export function scoreEmbeddingSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  return Math.max(0, cosineSimilarityVectors(a, b));
}

export async function probeImageMeanLuma(jpegPath: string): Promise<number | null> {
  if (!fs.existsSync(jpegPath)) return null;
  try {
    const { stdout } = await exec(
      `"${ffmpegBin()}" -y -i "${jpegPath}" -vf "scale=1:1,format=gray" -frames:v 1 -f rawvideo -`,
      { encoding: "buffer", maxBuffer: 4096, timeout: 8_000 }
    );
    const buf = stdout as Buffer;
    if (!buf?.length) return null;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i]!;
    return sum / buf.length;
  } catch {
    return null;
  }
}

function isForkPressureSpawnError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EAGAIN") return true;
  const msg = (err as Error)?.message || "";
  return /resource temporarily unavailable/i.test(msg) || /cannot fork/i.test(msg);
}

async function extractFrameAtFractionOnce(
  videoPath: string,
  outPath: string,
  fraction: number,
  timeoutMs: number
): Promise<void> {
  const pct = `${Math.round(fraction * 1000) / 10}%`;
  await new Promise<void>((resolve, reject) => {
    const args = ["-y", "-ss", pct, "-i", videoPath, "-frames:v", "1", "-q:v", "3", outPath];
    const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error("frame extract timeout"));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 800) resolve();
      else reject(new Error(stderr.slice(-120) || `ffmpeg exit ${code}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Under heavy concurrent ffmpeg load, spawn can transiently fail with EAGAIN/"Cannot
// fork" — retry with backoff instead of dropping the CLIP candidate entirely.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function extractFrameAtFraction(
  videoPath: string,
  outPath: string,
  fraction: number,
  timeoutMs = 12_000
): Promise<boolean> {
  if (!fs.existsSync(videoPath)) return false;
  let retriesLeft = 2;
  while (true) {
    try {
      await extractFrameAtFractionOnce(videoPath, outPath, fraction, timeoutMs);
      return true;
    } catch (err) {
      if (retriesLeft > 0 && isForkPressureSpawnError(err)) {
        retriesLeft--;
        await sleep(1500 * (3 - retriesLeft));
        continue;
      }
      return false;
    }
  }
}

export type LocalFrameScore = {
  similarity: number;
  score: number;
  luma: number | null;
  wellFramed: boolean;
};

export async function scoreImagePathAgainstQuery(
  imagePath: string,
  queryEmbedding: number[],
  lexicalBoost = 0
): Promise<LocalFrameScore | null> {
  const emb = await embedImageFromPath(imagePath);
  if (!emb) return null;
  const luma = await probeImageMeanLuma(imagePath);
  const sim = scoreEmbeddingSimilarity(queryEmbedding, emb) + lexicalBoost;
  const wellFramed = luma === null || luma >= 18;
  return {
    similarity: sim,
    score: clipSimToScore(sim),
    luma,
    wellFramed,
  };
}

export type LocalClipScoreResult = {
  score: number;
  matchesNarration: boolean;
  showsSubject: boolean;
  wellFramed: boolean;
  wrongSubject: boolean;
  worstSimilarity: number;
  framesScored: number;
};

export type StoredEmbeddingScore = {
  definiteFail: boolean;
  similarityPass: boolean;
  modernMismatch: boolean;
  worstSimilarity: number;
  score: number;
};

export async function scoreEmbeddingsAgainstBeat(
  imageEmbeddings: number[][],
  beatText: string,
  visualDescription: string | undefined,
  videoTitle: string | undefined,
  clipPath: string,
  minScore10: number,
  queryEmb?: number[] | null
): Promise<StoredEmbeddingScore | null> {
  if (imageEmbeddings.length === 0) return null;
  const beatEmb = queryEmb ?? (await resolveBeatQueryEmbedding(beatText, visualDescription, videoTitle));
  if (!beatEmb) return null;

  const lexBoost = filenameLexicalBoost(clipPath, beatText, videoTitle);
  const minSim = minLocalClipSimilarity(minScore10);
  const frameScores: LocalFrameScore[] = imageEmbeddings.map((emb) => {
    const sim = scoreEmbeddingSimilarity(beatEmb, emb) + lexBoost;
    return {
      similarity: sim,
      score: clipSimToScore(sim),
      luma: null,
      wellFramed: true,
    };
  });

  let worst = frameScores[0]!;
  for (const s of frameScores) {
    if (s.similarity < worst.similarity) worst = s;
  }
  const avgSim =
    frameScores.reduce((sum, s) => sum + s.similarity, 0) / frameScores.length;
  const modernMismatch = await modernContentMismatchAgainstEmbeddings(
    imageEmbeddings,
    beatEmb,
    beatText,
    videoTitle
  );
  const similarityPass = worst.similarity >= minSim && !modernMismatch;
  const definiteFail =
    worst.similarity < minSim - 0.04 || modernMismatch;

  return {
    definiteFail,
    similarityPass,
    modernMismatch,
    worstSimilarity: worst.similarity,
    score: clipSimToScore(avgSim),
  };
}

export async function scoreFramePathsAgainstBeat(
  framePaths: string[],
  beatText: string,
  visualDescription: string | undefined,
  videoTitle: string | undefined,
  clipPath: string,
  minScore10: number,
  storedEmbeddings?: number[][],
  queryEmb?: number[] | null
): Promise<LocalClipScoreResult | null> {
  const beatEmb = queryEmb ?? (await resolveBeatQueryEmbedding(beatText, visualDescription, videoTitle));
  if (!beatEmb) return null;

  const lexBoost = filenameLexicalBoost(clipPath, beatText, videoTitle);
  const minSim = minLocalClipSimilarity(minScore10);

  const frameScores: LocalFrameScore[] = (
    await Promise.all(
      framePaths.map(async (fp) => {
        const [emb, luma] = await Promise.all([embedImageFromPath(fp), probeImageMeanLuma(fp)]);
        if (!emb) return null;
        const sim = scoreEmbeddingSimilarity(beatEmb, emb) + lexBoost;
        return {
          similarity: sim,
          score: clipSimToScore(sim),
          luma,
          wellFramed: luma === null || luma >= 18,
          _emb: emb,
        } as LocalFrameScore & { _emb: number[] };
      })
    )
  ).filter((s): s is LocalFrameScore & { _emb: number[] } => s != null);

  const imageEmbeddings = frameScores.map((s) => s._emb);
  for (const s of frameScores) {
    delete (s as { _emb?: number[] })._emb;
  }
  const scoredFrames: LocalFrameScore[] = frameScores.map(({ similarity, score, luma, wellFramed }) => ({
    similarity,
    score,
    luma,
    wellFramed,
  }));

  if (storedEmbeddings?.length) {
    for (const stored of storedEmbeddings) {
      const sim = scoreEmbeddingSimilarity(beatEmb, stored) + lexBoost;
      scoredFrames.push({
        similarity: sim,
        score: clipSimToScore(sim),
        luma: null,
        wellFramed: true,
      });
    }
  }

  if (scoredFrames.length === 0) return null;

  let worst = scoredFrames[0]!;
  for (const s of scoredFrames) {
    if (s.similarity < worst.similarity) worst = s;
  }

  const avgSim =
    scoredFrames.reduce((sum, s) => sum + s.similarity, 0) / scoredFrames.length;
  const score = clipSimToScore(avgSim);
  const allWellFramed = scoredFrames.every((s) => s.wellFramed);
  const darkReject = scoredFrames.some((s) => s.luma !== null && s.luma < 12);

  const modernMismatch = await modernContentMismatchAgainstEmbeddings(
    imageEmbeddings.length > 0 ? imageEmbeddings : storedEmbeddings?.slice(0, 2) ?? [],
    beatEmb,
    beatText,
    videoTitle
  );

  const matchesNarration = worst.similarity >= minSim && !darkReject && !modernMismatch;
  const showsSubject = worst.similarity >= minSim;
  const wrongSubject = worst.similarity < minSim || darkReject || modernMismatch;

  return {
    score,
    matchesNarration,
    showsSubject,
    wellFramed: allWellFramed,
    wrongSubject,
    worstSimilarity: worst.similarity,
    framesScored: scoredFrames.length,
  };
}

/** Index frames from a local video file (background-safe). */
export async function indexVideoFrameEmbeddings(
  localVideoPath: string,
  workDir: string,
  prefix: string
): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let i = 0; i < INDEX_FRAME_FRACTIONS.length; i++) {
    const frac = INDEX_FRAME_FRACTIONS[i]!;
    const framePath = path.join(workDir, `${prefix}_idx${i}.jpg`);
    const ok = await extractFrameAtFraction(localVideoPath, framePath, frac);
    if (!ok) continue;
    const emb = await embedImageFromPath(framePath);
    try { fs.unlinkSync(framePath); } catch { /* ignore */ }
    if (emb) embeddings.push(emb);
  }
  return embeddings;
}

export function meanEmbedding(vectors: number[][]): number[] | null {
  if (!vectors.length) return null;
  const dim = vectors[0]!.length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i] += v[i]!;
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

/** Score a remote thumbnail URL against beat text (YouTube script-guided sourcing). */
export async function scoreUrlImageAgainstBeat(
  imageUrl: string,
  beatText: string,
  videoTitle: string | undefined,
  timeoutMs = 6_000
): Promise<{ relevance: number; showsSubject: boolean } | null> {
  if (!localVisionEnabled() || !imageUrl.startsWith("http")) return null;

  const query = buildBeatVisionQueryText({ beatText, videoTitle });
  const queryEmb = await embedTextQuery(query);
  if (!queryEmb) return null;

  const tmp = path.join(
    process.env.TMPDIR || process.env.TEMP || "/tmp",
    `fv_thumb_${Date.now()}.jpg`
  );

  try {
    const resp = await Promise.race([
      fetch(imageUrl, { signal: AbortSignal.timeout(timeoutMs) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 500) return null;
    fs.writeFileSync(tmp, buf);

    const emb = await embedImageFromPath(tmp);
    if (!emb) return null;
    const sim = scoreEmbeddingSimilarity(queryEmb, emb);
    const relevance = clipSimToScore(sim);
    return {
      relevance,
      showsSubject: sim >= minLocalClipSimilarity(6) - 0.04,
    };
  } catch {
    return null;
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function getLocalVisionStatus(): {
  enabled: boolean;
  clipIndexEnabled: boolean;
  model: string;
  pipelineReady: boolean;
  cacheDir: string;
  hint: string;
} {
  const enabled = localVisionEnabled();
  const clipIndexEnabled = clipEmbeddingIndexEnabled();
  const cacheDir = clipModelCacheDir();
  const loaded = !!(imagePipeline && textPipeline);
  const pipelineReady = enabled && loaded;
  let hint = loaded
    ? `Local CLIP vision QA active (cache: ${cacheDir}).`
    : pipelineLoadFailed
      ? `CLIP model failed to load after ${MAX_PIPELINE_LOAD_ATTEMPTS} attempts — check worker logs and ${cacheDir}.`
      : "CLIP not loaded in this process yet — worker preloads on startup.";
  if (!enabled) {
    hint = "Local vision disabled — set ENABLE_LOCAL_VISION=true (default on).";
  }
  return {
    enabled,
    clipIndexEnabled,
    model: CLIP_MODEL,
    pipelineReady,
    cacheDir,
    hint,
  };
}

function resetClipPipelineLoadState(): void {
  pipelineLoadFailed = false;
  imageLoadAttempts = 0;
  textLoadAttempts = 0;
  pipelineLoadInFlight = null;
}

/** Pre-load CLIP pipelines on worker start so first clip adopt is not blocked on model download. */
export function clipPreloadEnabled(): boolean {
  if (process.env.ENABLE_CLIP_PRELOAD === "false") return false;
  return localVisionEnabled();
}

export async function warmUpLocalClipVision(): Promise<boolean> {
  if (!clipPreloadEnabled()) return false;
  console.log(`[LocalVision] Loading CLIP model (cache: ${clipModelCacheDir()})...`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ok = await ensureClipPipelinesLoaded();
    if (ok) {
      console.log("[LocalVision] CLIP model warm-up complete");
      return true;
    }
    if (attempt < 2) {
      console.warn("[LocalVision] CLIP warm-up retry in 15s (background tasks may have contended for RAM)...");
      resetClipPipelineLoadState();
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  console.warn(
    "[LocalVision] CLIP warm-up incomplete — vision gate may skip or reject clips until load succeeds"
  );
  return false;
}
