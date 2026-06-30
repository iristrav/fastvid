/** Visual Matching Engine V2 — LLM Vision Scorer (funnel stage 4).
 *
 *  Retrieval -> CLIP Pre-Filter -> Candidate Ranking -> [this] -> ScoredCandidate[].
 *
 *  Scope is deliberately narrow: one multi-image LLM call per beat, producing per-dimension
 *  content scores (0-100) for each candidate. No retrieval signals (no embeddingSimilarity,
 *  no clipSimilarity, no rankingScore) reach the LLM — the prompt receives only VisualIntent,
 *  VideoContext, and the images themselves. No winner selection, no confidence tier, no
 *  fallback, no AI generation — those belong to the Selector stage.
 *
 *  Provider interface (visionProvider.ts) makes it trivial to swap OpenAI for Anthropic or
 *  Gemini without touching this file. Prompt strings live exclusively in visionPromptBuilder.ts
 *  so they can evolve without touching scorer logic, and so a PROMPT_VERSION bump
 *  automatically invalidates the cache. */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { extractFrameAtFraction } from "../localClipVision";
import { buildVisionPrompt, PROMPT_VERSION } from "./visionPromptBuilder";
import { OpenAIVisionProvider } from "./visionProvider";
import { loadVisionScore, storeVisionScore } from "./visionScoreCache";
import { recordVisionCallOutcome } from "./visionMetrics";
import { logVisionScorer } from "./logging";
import type {
  RankedCandidate,
  ScoredCandidate,
  VideoContext,
  VisionScoreTrace,
  VisionScores,
  VisualIntent,
} from "./types";
import type { VisionProvider, VisionImageInput } from "./visionProvider";

const DEFAULT_PROVIDER = new OpenAIVisionProvider();

type ResolvedImage = { dataUrl: string; cleanup: boolean; tmpPath: string | null };

function imageMimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function fileToDataUrl(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  const mime = imageMimeForPath(filePath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Resolves a candidate to a data URL embeddable in a multimodal LLM prompt. Image
 *  candidates are read directly; video candidates get one extracted frame; remote-only
 *  candidates (no localPath) are downloaded from remoteUrl/thumbnail. Returns null when
 *  nothing embeddable is available — those candidates are excluded from the LLM call and
 *  get a null-scores ScoredCandidate. */
async function resolveToDataUrl(candidate: RankedCandidate["candidate"]): Promise<ResolvedImage | null> {
  if (candidate.localPath && fs.existsSync(candidate.localPath)) {
    if (candidate.assetType === "image") {
      return { dataUrl: fileToDataUrl(candidate.localPath), cleanup: false, tmpPath: null };
    }
    const tmpPath = path.join(os.tmpdir(), `fv_v2_vis_${crypto.randomBytes(6).toString("hex")}.jpg`);
    const ok = await extractFrameAtFraction(candidate.localPath, tmpPath, 0.4);
    if (ok && fs.existsSync(tmpPath)) {
      const dataUrl = fileToDataUrl(tmpPath);
      return { dataUrl, cleanup: true, tmpPath };
    }
    return null;
  }

  const remoteUrl = candidate.assetType === "image" ? candidate.remoteUrl ?? candidate.thumbnail : candidate.thumbnail;
  if (!remoteUrl?.startsWith("http")) return null;

  const tmpPath = path.join(os.tmpdir(), `fv_v2_vis_dl_${crypto.randomBytes(6).toString("hex")}.jpg`);
  try {
    const resp = await Promise.race([
      fetch(remoteUrl, { signal: AbortSignal.timeout(8_000) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8_000)),
    ]);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 500) return null;
    fs.writeFileSync(tmpPath, buf);
    return { dataUrl: fileToDataUrl(tmpPath), cleanup: true, tmpPath };
  } catch {
    return null;
  }
}

function cleanupResolved(resolved: ResolvedImage | null): void {
  if (!resolved?.cleanup || !resolved.tmpPath) return;
  try {
    if (fs.existsSync(resolved.tmpPath)) fs.unlinkSync(resolved.tmpPath);
  } catch { /* ignore */ }
}

function fallbackScores(): VisionScores {
  return {
    subjectMatch: 0, actionMatch: 0, historicalAccuracy: 0,
    contextMatch: 0, locationMatch: 0, emotionMatch: 0,
    overallScore: 0, reasoning: "No embeddable image available for this candidate.",
  };
}

/**
 * Scores `candidates` (the Ranking Layer's output) against `intent` using one
 * multi-image LLM call. Candidates without a resolvable image are scored 0 across all
 * dimensions. No retrieval, CLIP, or ranking signals reach the LLM prompt.
 */
export async function scoreCandidates(
  intent: VisualIntent,
  candidates: RankedCandidate[],
  context: VideoContext | null = null,
  provider: VisionProvider = DEFAULT_PROVIDER
): Promise<ScoredCandidate[]> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const visionModel = provider.modelId;

  // ─── 1. Check cache for every candidate ──────────────────────────────────────
  const cacheResults = candidates.map((r) => ({
    ranked: r,
    cached: loadVisionScore(intent.intentHash, r.candidate.candidateId, visionModel, PROMPT_VERSION),
  }));

  const uncached = cacheResults.filter((cr) => !cr.cached);

  let freshScores: Record<string, VisionScores> = {};
  let promptTokens = 0;
  let completionTokens = 0;
  let llmLatencyMs = 0;

  if (uncached.length > 0) {
    // ─── 2. Resolve images for uncached candidates ────────────────────────────
    const resolved = await Promise.all(uncached.map((cr) => resolveToDataUrl(cr.ranked.candidate)));

    const images: VisionImageInput[] = [];
    const indexMap: number[] = [];
    for (let i = 0; i < uncached.length; i++) {
      const res = resolved[i];
      if (res) {
        images.push({ candidateId: uncached[i].ranked.candidate.candidateId, imageUrl: res.dataUrl });
        indexMap.push(i);
      }
    }

    // ─── 3. One LLM call for all resolvable uncached candidates ──────────────
    if (images.length > 0) {
      const prompt = buildVisionPrompt(intent, context, images);
      const llmStart = Date.now();
      try {
        const response = await provider.scoreImages({
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt,
          images,
          responseSchema: prompt.responseSchema,
          maxTokens: prompt.maxTokens,
        });
        llmLatencyMs = Date.now() - llmStart;
        freshScores = response.scores;
        promptTokens = response.promptTokens;
        completionTokens = response.completionTokens;

        for (const [candidateId, scores] of Object.entries(freshScores)) {
          storeVisionScore(intent.intentHash, candidateId, visionModel, PROMPT_VERSION, scores);
        }
      } catch (err) {
        llmLatencyMs = Date.now() - llmStart;
        logVisionScorer("error", { beatId: intent.beatId, error: (err as Error).message?.slice(0, 200) });
      }

      for (const res of resolved) cleanupResolved(res);
    }
  }

  // ─── 4. Assemble final ScoredCandidate[] ─────────────────────────────────────
  const durationMs = Date.now() - start;
  const cacheHitCount = cacheResults.filter((cr) => !!cr.cached).length;
  const traceEntries: VisionScoreTrace["entries"] = [];
  const result: ScoredCandidate[] = [];

  for (const cr of cacheResults) {
    const scores: VisionScores = cr.cached ?? freshScores[cr.ranked.candidate.candidateId] ?? fallbackScores();
    const cacheHit = !!cr.cached;
    const latencyMs = cacheHit ? 0 : llmLatencyMs;

    result.push({
      candidate: cr.ranked,
      visionScores: scores,
      visionModel,
      promptVersion: PROMPT_VERSION,
      visionLatencyMs: latencyMs,
      cacheHit,
    });

    traceEntries.push({ candidateId: cr.ranked.candidate.candidateId, visionLatencyMs: latencyMs, cacheHit, scores });
  }

  const trace: VisionScoreTrace = {
    beatId: intent.beatId,
    startedAt,
    durationMs,
    candidateCount: candidates.length,
    model: visionModel,
    promptVersion: PROMPT_VERSION,
    promptTokens,
    completionTokens,
    cacheHits: cacheHitCount,
    entries: traceEntries,
  };

  recordVisionCallOutcome({
    candidatesScored: candidates.length,
    cacheHits: cacheHitCount,
    latencyMs: durationMs,
    promptTokens,
    completionTokens,
    overallScores: result.map((s) => s.visionScores.overallScore),
    dimensionScores: {
      subjectMatch: result.map((s) => s.visionScores.subjectMatch),
      actionMatch: result.map((s) => s.visionScores.actionMatch),
      historicalAccuracy: result.map((s) => s.visionScores.historicalAccuracy),
      contextMatch: result.map((s) => s.visionScores.contextMatch),
      locationMatch: result.map((s) => s.visionScores.locationMatch),
      emotionMatch: result.map((s) => s.visionScores.emotionMatch),
    },
  });
  logVisionScorer("score_complete", trace);

  return result;
}
