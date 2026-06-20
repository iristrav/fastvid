/**
 * Local CLIP-based visual QA — no external vision API.
 * Indexes archive frames on upload; scores adopt candidates via text↔image similarity + luma.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { promisify } from "util";
import { exec as execCb } from "child_process";
import { cosineSimilarityVectors } from "./semanticVisualMatching";
import { inferVideoVisualTopic } from "./visualBeatTags";

const exec = promisify(execCb);

const CLIP_MODEL = "Xenova/clip-vit-base-patch32";
export const LOCAL_FRAME_FRACTIONS = [0.12, 0.38, 0.62, 0.88];
const INDEX_FRAME_FRACTIONS = [0.15, 0.5, 0.85];

type ClipPipeline = (input: string, options?: Record<string, unknown>) => Promise<{ data: Float32Array }>;

let imagePipeline: ClipPipeline | null = null;
let textPipeline: ClipPipeline | null = null;
let pipelineLoadFailed = false;

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

function clipSimToScore(sim: number): number {
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

export function topicNeedsHistoricalFootage(beatText: string, videoTitle?: string): boolean {
  const topic = inferVideoVisualTopic(videoTitle, beatText);
  if (topic === "wwii" || topic === "cold_war") return true;
  const hay = `${videoTitle ?? ""} ${beatText}`.toLowerCase();
  return /\b(19\d{2}|20[0-1]\d|world war|wwii|ww2|war|historical|archive|ancient|century|hitler|nazi|berlin|titanic)\b/.test(
    hay
  );
}

async function modernContentMismatchAgainstBeat(
  framePaths: string[],
  beatQueryEmb: number[],
  beatText: string,
  videoTitle?: string
): Promise<boolean> {
  if (!topicNeedsHistoricalFootage(beatText, videoTitle)) return false;
  const samples = framePaths.slice(0, Math.min(2, framePaths.length));
  for (const fp of samples) {
    const imgEmb = await embedImageFromPath(fp);
    if (!imgEmb) continue;
    const beatSim = scoreEmbeddingSimilarity(beatQueryEmb, imgEmb);
    for (const q of MODERN_MISMATCH_QUERIES) {
      const negEmb = await embedTextQuery(q);
      if (!negEmb) continue;
      const negSim = scoreEmbeddingSimilarity(negEmb, imgEmb);
      if (negSim >= beatSim - 0.01) return true;
      if (negSim >= 0.18 && beatSim < 0.24) return true;
    }
  }
  return false;
}

function beatQueryText(
  beatText: string,
  visualDescription?: string,
  videoTitle?: string
): string {
  const parts = [beatText.slice(0, 220)];
  if (visualDescription?.trim()) parts.push(visualDescription.slice(0, 180));
  if (videoTitle?.trim()) parts.push(videoTitle.slice(0, 80));
  return parts.join(". ");
}

function significantBeatTokens(beatText: string, videoTitle?: string): Set<string> {
  const text = `${beatText} ${videoTitle ?? ""}`.toLowerCase();
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

async function loadImagePipeline(): Promise<ClipPipeline | null> {
  if (pipelineLoadFailed) return null;
  if (imagePipeline) return imagePipeline;
  try {
    const { pipeline } = await import("@xenova/transformers");
    imagePipeline = (await pipeline("image-feature-extraction", CLIP_MODEL)) as ClipPipeline;
    return imagePipeline;
  } catch (err) {
    pipelineLoadFailed = true;
    console.warn("[LocalVision] CLIP image pipeline failed:", (err as Error).message?.slice(0, 80));
    return null;
  }
}

async function loadTextPipeline(): Promise<ClipPipeline | null> {
  if (pipelineLoadFailed) return null;
  if (textPipeline) return textPipeline;
  try {
    const { pipeline } = await import("@xenova/transformers");
    textPipeline = (await pipeline("feature-extraction", CLIP_MODEL)) as ClipPipeline;
    return textPipeline;
  } catch (err) {
    pipelineLoadFailed = true;
    console.warn("[LocalVision] CLIP text pipeline failed:", (err as Error).message?.slice(0, 80));
    return null;
  }
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

export async function embedTextQuery(query: string): Promise<number[] | null> {
  if (!localVisionEnabled() || !query.trim()) return null;
  const pipe = await loadTextPipeline();
  if (!pipe) return null;
  try {
    const result = await pipe(query, { pooling: "mean", normalize: true });
    return Array.from(result.data);
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

export async function extractFrameAtFraction(
  videoPath: string,
  outPath: string,
  fraction: number
): Promise<boolean> {
  if (!fs.existsSync(videoPath)) return false;
  const pct = `${Math.round(fraction * 1000) / 10}%`;
  try {
    await new Promise<void>((resolve, reject) => {
      const args = ["-y", "-ss", pct, "-i", videoPath, "-frames:v", "1", "-q:v", "3", outPath];
      const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        reject(new Error("frame extract timeout"));
      }, 12_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 800) resolve();
        else reject(new Error(stderr.slice(-120) || `ffmpeg exit ${code}`));
      });
      child.on("error", reject);
    });
    return true;
  } catch {
    return false;
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

export async function scoreFramePathsAgainstBeat(
  framePaths: string[],
  beatText: string,
  visualDescription: string | undefined,
  videoTitle: string | undefined,
  clipPath: string,
  minScore10: number,
  storedEmbeddings?: number[][]
): Promise<LocalClipScoreResult | null> {
  const query = beatQueryText(beatText, visualDescription, videoTitle);
  const queryEmb = await embedTextQuery(query);
  if (!queryEmb) return null;

  const lexBoost = filenameLexicalBoost(clipPath, beatText, videoTitle);
  const minSim = minLocalClipSimilarity(minScore10);

  const frameScores: LocalFrameScore[] = [];
  for (const fp of framePaths) {
    const s = await scoreImagePathAgainstQuery(fp, queryEmb, lexBoost);
    if (s) frameScores.push(s);
  }

  if (storedEmbeddings?.length) {
    for (const stored of storedEmbeddings) {
      const sim = scoreEmbeddingSimilarity(queryEmb, stored) + lexBoost;
      frameScores.push({
        similarity: sim,
        score: clipSimToScore(sim),
        luma: null,
        wellFramed: true,
      });
    }
  }

  if (frameScores.length === 0) return null;

  let worst = frameScores[0]!;
  for (const s of frameScores) {
    if (s.similarity < worst.similarity) worst = s;
  }

  const avgSim =
    frameScores.reduce((sum, s) => sum + s.similarity, 0) / frameScores.length;
  const score = clipSimToScore(avgSim);
  const allWellFramed = frameScores.every((s) => s.wellFramed);
  const darkReject = frameScores.some((s) => s.luma !== null && s.luma < 12);

  const modernMismatch = await modernContentMismatchAgainstBeat(
    framePaths,
    queryEmb,
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
    framesScored: frameScores.length,
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

  const query = beatQueryText(beatText, undefined, videoTitle);
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
  hint: string;
} {
  const enabled = localVisionEnabled();
  const clipIndexEnabled = clipEmbeddingIndexEnabled();
  const pipelineReady = !pipelineLoadFailed && enabled;
  let hint = "Local CLIP vision QA active — no external vision API.";
  if (!enabled) {
    hint = "Local vision disabled — set ENABLE_LOCAL_VISION=true (default on).";
  } else if (pipelineLoadFailed) {
    hint = "CLIP model failed to load — check @xenova/transformers on worker.";
  }
  return {
    enabled,
    clipIndexEnabled,
    model: CLIP_MODEL,
    pipelineReady,
    hint,
  };
}

/** Pre-load CLIP pipelines on worker start so first clip adopt is not blocked on model download. */
export async function warmUpLocalClipVision(): Promise<void> {
  if (!localVisionEnabled()) return;
  const [image, text] = await Promise.all([loadImagePipeline(), loadTextPipeline()]);
  if (image && text) {
    console.log("[LocalVision] CLIP model warm-up complete");
  } else {
    console.warn("[LocalVision] CLIP warm-up incomplete — vision gate may skip or reject clips");
  }
}
