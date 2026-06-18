/**
 * Vision + luma checks so adopted clips match the beat and are not dark/empty.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";
import { pipelineWallClockLimitEnabled, vidrushDocumentaryQualityEnabled } from "./sourcingPolicy";

const NARRATION_MATCH_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "clip_narration_match",
    strict: true,
    schema: {
      type: "object",
      properties: {
        score: { type: "number" },
        matchesNarration: { type: "boolean" },
        showsSubject: { type: "boolean" },
        wellFramed: { type: "boolean" },
        wrongSubject: { type: "boolean" },
      },
      required: ["score", "matchesNarration", "showsSubject", "wellFramed", "wrongSubject"],
      additionalProperties: false,
    },
  },
} as const;

const VISION_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "clip_visual_quality",
    strict: true,
    schema: {
      type: "object",
      properties: {
        relevance: { type: "number" },
        showsSubject: { type: "boolean" },
        wellFramed: { type: "boolean" },
      },
      required: ["relevance", "showsSubject", "wellFramed"],
      additionalProperties: false,
    },
  },
} as const;

/** Sample positions through each clip (start → end). */
const VISION_SAMPLE_FRACTIONS = [0.12, 0.38, 0.62, 0.88];

export function clipVisionGateEnabled(): boolean {
  return process.env.ENABLE_CLIP_VISION !== "false" && Boolean(ENV.forgeApiKey);
}

/** Critical per-clip voice/visual QA (default on with Vidrush quality). */
export function sceneCriticalReviewEnabled(): boolean {
  if (process.env.ENABLE_SCENE_CRITICAL_REVIEW === "false") return false;
  return process.env.ENABLE_VIDRUSH_QUALITY !== "false";
}

/** Minimum vision score (0–10). Default 8 — strong quality without rejecting near-perfect clips. */
export function minClipQualityScore(): number {
  const raw = process.env.MIN_CLIP_QUALITY_SCORE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5 && n <= 10) return n;
  }
  return 8;
}

/** When true, inconclusive vision (timeout / extract fail) rejects the clip. */
export function strictVisionInconclusiveFails(): boolean {
  if (process.env.STRICT_CLIP_VISION === "false") return false;
  return minClipQualityScore() >= 9;
}

/** Frames scored per clip (1–6). Default 4 across the full duration. */
export function clipVisionSampleCount(): number {
  const raw = process.env.CLIP_VISION_SAMPLE_COUNT?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 6) return n;
  }
  return 4;
}

/** Runtime status for /api/health and startup logs (Railway Vision QA). */
export function getVisionQaStatus(): {
  ready: boolean;
  clipVisionGate: boolean;
  sceneCriticalReview: boolean;
  minScore: number;
  visionSamplesPerClip: number;
  strictInconclusive: boolean;
  llmKeyConfigured: boolean;
  llmProvider: "openai" | "groq" | "forge" | "none";
  hint: string;
} {
  const llmKeyConfigured = Boolean(ENV.forgeApiKey);
  const clipVisionGate = clipVisionGateEnabled();
  const sceneCriticalReview = sceneCriticalReviewEnabled();
  const minScore = minClipQualityScore();
  const visionSamplesPerClip = clipVisionSampleCount();
  const strictInconclusive = strictVisionInconclusiveFails();
  const llmProvider = ENV.llmProvider;
  const ready = clipVisionGate && sceneCriticalReview && llmKeyConfigured;

  let hint = `Vision QA active — ${visionSamplesPerClip} frames/clip, pass ≥${minScore}/10.`;
  if (!llmKeyConfigured) {
    hint = "Set LLM_API_KEY (OpenAI) on web and worker services to enable Vision QA.";
  } else if (!clipVisionGate) {
    hint = "Clip vision gate disabled — remove ENABLE_CLIP_VISION=false if set.";
  } else if (!sceneCriticalReview) {
    hint = "Scene critical review disabled — remove ENABLE_SCENE_CRITICAL_REVIEW=false if set.";
  }

  return {
    ready,
    clipVisionGate,
    sceneCriticalReview,
    minScore,
    visionSamplesPerClip,
    strictInconclusive,
    llmKeyConfigured,
    llmProvider,
    hint,
  };
}

/** Check adopted clips; stock included when Vidrush quality or ENABLE_CLIP_VISION_STOCK=true. */
export function shouldVisionCheckClip(filePath: string): boolean {
  if (process.env.ENABLE_CLIP_VISION === "false") return false;
  const base = path.basename(filePath).toLowerCase();
  if (sceneCriticalReviewEnabled()) return true;
  const checkStock =
    vidrushDocumentaryQualityEnabled() || process.env.ENABLE_CLIP_VISION_STOCK === "true";
  if (checkStock && /pexels|pixabay|_b\d+_vid|person_stock/i.test(base)) return true;
  return (
    /_archive_|_hist|_wikivid|_wiki_|_gdelt|_septube|_ov_|_serp_|_unsplash|_euro_|_nasa/i.test(base) ||
    /_ytcc_|_ytfu_|_transformed|_curated_a/i.test(base)
  );
}

function visionSampleFractions(): number[] {
  return VISION_SAMPLE_FRACTIONS.slice(0, clipVisionSampleCount());
}

async function extractPreviewFrameAt(
  clipPath: string,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  sampleIndex: number,
  positionFraction: number
): Promise<string | null> {
  const ffmpeg = process.env.FFMPEG_BIN?.trim() || "ffmpeg";
  const pct = `${Math.round(positionFraction * 1000) / 10}%`;
  const outPath = path.join(
    workDir,
    `scene_${sceneIndex}_b${beatIndex}_vq${sampleIndex}_${path.basename(clipPath).replace(/\.[^.]+$/, "")}.jpg`
  );
  if (!fs.existsSync(clipPath)) return null;

  try {
    await new Promise<void>((resolve, reject) => {
      const args = ["-y", "-ss", pct, "-i", clipPath, "-frames:v", "1", "-q:v", "3", outPath];
      const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        reject(new Error("frame extract timeout"));
      }, 10_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 800) resolve();
        else reject(new Error(stderr.slice(-120) || `ffmpeg exit ${code}`));
      });
      child.on("error", reject);
    });
    return outPath;
  } catch {
    return null;
  }
}

async function extractPreviewFrames(
  clipPath: string,
  workDir: string,
  sceneIndex: number,
  beatIndex: number
): Promise<string[]> {
  const fractions = visionSampleFractions();
  const paths = await Promise.all(
    fractions.map((f, i) => extractPreviewFrameAt(clipPath, workDir, sceneIndex, beatIndex, i, f))
  );
  return paths.filter((p): p is string => p != null);
}

function cleanupFramePaths(framePaths: string[]): void {
  for (const fp of framePaths) {
    try { fs.unlinkSync(fp); } catch { /* ignore */ }
  }
}

async function scoreClipNarrationMatch(
  imagePath: string,
  beatText: string,
  visualDescription: string | undefined,
  videoTitle: string | undefined,
  timeoutMs: number
): Promise<{
  score: number;
  matchesNarration: boolean;
  showsSubject: boolean;
  wellFramed: boolean;
  wrongSubject: boolean;
} | null> {
  if (!fs.existsSync(imagePath)) return null;
  const buf = fs.readFileSync(imagePath);
  const b64 = buf.toString("base64");
  const dataUrl = `data:image/jpeg;base64,${b64}`;

  try {
    const response = await Promise.race([
      invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "You are a strict documentary editor. Judge if B-roll matches spoken narration. Return JSON only. Score 10 = perfect match; below target = reject.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Spoken narration: "${beatText.slice(0, 220)}"
${visualDescription ? `Intended visual: ${visualDescription.slice(0, 180)}` : ""}
${videoTitle ? `Documentary topic: ${videoTitle}` : ""}
Does this frame show what the voiceover describes? Score 0-10, matchesNarration, wrongSubject if clearly unrelated geography/subject (e.g. Toronto/USA map when narration says Netherlands).`,
              },
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
            ],
          },
        ],
        response_format: NARRATION_MATCH_SCHEMA,
        maxTokens: 256,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("vision timeout")), timeoutMs)
      ),
    ]);

    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string") return null;
    const parsed = JSON.parse(content) as {
      score?: number;
      matchesNarration?: boolean;
      showsSubject?: boolean;
      wellFramed?: boolean;
      wrongSubject?: boolean;
    };
    return {
      score: Math.max(0, Math.min(10, parsed.score ?? 0)),
      matchesNarration: Boolean(parsed.matchesNarration),
      showsSubject: Boolean(parsed.showsSubject),
      wellFramed: Boolean(parsed.wellFramed),
      wrongSubject: Boolean(parsed.wrongSubject),
    };
  } catch {
    return null;
  }
}

async function scoreFrameRelevance(
  imagePath: string,
  beatText: string,
  videoTitle: string | undefined,
  timeoutMs: number
): Promise<{ relevance: number; showsSubject: boolean; wellFramed: boolean } | null> {
  if (!fs.existsSync(imagePath)) return null;
  const buf = fs.readFileSync(imagePath);
  const b64 = buf.toString("base64");
  const dataUrl = `data:image/jpeg;base64,${b64}`;

  try {
    const response = await Promise.race([
      invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "You judge documentary B-roll. Return JSON only. Reject generic unrelated stock, black frames, extreme blur, or subjects cut off at edges.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Narration beat: "${beatText.slice(0, 220)}"
${videoTitle ? `Documentary topic: ${videoTitle}` : ""}
Rate relevance 0-10, whether the real subject is visible, and if the shot is well-framed for 16:9 (not tiny in corner, not mostly black bars).`,
              },
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
            ],
          },
        ],
        response_format: VISION_JSON_SCHEMA,
        maxTokens: 256,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("vision timeout")), timeoutMs)
      ),
    ]);

    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string") return null;
    const parsed = JSON.parse(content) as {
      relevance?: number;
      showsSubject?: boolean;
      wellFramed?: boolean;
    };
    return {
      relevance: Math.max(0, Math.min(10, parsed.relevance ?? 0)),
      showsSubject: Boolean(parsed.showsSubject),
      wellFramed: Boolean(parsed.wellFramed),
    };
  } catch {
    return null;
  }
}

type CriticalVisionScore = {
  score: number;
  matchesNarration: boolean;
  showsSubject: boolean;
  wellFramed: boolean;
  wrongSubject: boolean;
};

function passesCriticalVision(score: CriticalVisionScore, minScore: number): boolean {
  return (
    score.score >= minScore &&
    score.matchesNarration &&
    score.showsSubject &&
    !score.wrongSubject &&
    (score.wellFramed || score.score >= minScore)
  );
}

function passesRelevanceVision(
  score: { relevance: number; showsSubject: boolean; wellFramed: boolean },
  minScore: number
): boolean {
  return (
    score.relevance >= minScore &&
    score.showsSubject &&
    (score.wellFramed || score.relevance >= minScore)
  );
}

/** Score multiple frames; all must pass for clip acceptance. */
async function scoreClipAcrossFrames(
  clipPath: string,
  beatText: string,
  visualDescription: string | undefined,
  videoTitle: string | undefined,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  minScore: number,
  fastMode: boolean
): Promise<{ pass: boolean; worstScore: number | null; framesScored: number }> {
  const framePaths = await extractPreviewFrames(clipPath, workDir, sceneIndex, beatIndex);
  if (framePaths.length === 0) {
    return { pass: !strictVisionInconclusiveFails(), worstScore: null, framesScored: 0 };
  }

  const baseTimeout = pipelineWallClockLimitEnabled()
    ? fastMode ? 5_000 : 8_000
    : fastMode ? 7_000 : 11_000;
  const perFrameTimeout = Math.max(4_500, Math.floor(baseTimeout * 0.85));
  const useCritical = sceneCriticalReviewEnabled() && minScore >= minClipQualityScore();

  const scores = await Promise.all(
    framePaths.map((fp) =>
      useCritical
        ? scoreClipNarrationMatch(fp, beatText, visualDescription, videoTitle, perFrameTimeout)
        : scoreFrameRelevance(fp, beatText, videoTitle, perFrameTimeout)
    )
  );
  cleanupFramePaths(framePaths);

  const valid = scores.filter((s): s is NonNullable<typeof s> => s != null);
  if (valid.length === 0) {
    return { pass: !strictVisionInconclusiveFails(), worstScore: null, framesScored: 0 };
  }

  let worstScore = 10;
  for (const score of valid) {
    const pass = useCritical && "matchesNarration" in score
      ? passesCriticalVision(score as CriticalVisionScore, minScore)
      : passesRelevanceVision(score as { relevance: number; showsSubject: boolean; wellFramed: boolean }, minScore);
    if (!pass) {
      const s = useCritical && "matchesNarration" in score
        ? (score as CriticalVisionScore).score
        : (score as { relevance: number }).relevance;
      worstScore = Math.min(worstScore, s);
      return { pass: false, worstScore: s, framesScored: valid.length };
    }
    const s = useCritical && "matchesNarration" in score
      ? (score as CriticalVisionScore).score
      : (score as { relevance: number }).relevance;
    worstScore = Math.min(worstScore, s);
  }

  return { pass: true, worstScore, framesScored: valid.length };
}

/** Returns true when clip passes vision gate (or gate skipped / inconclusive per policy). */
export async function clipPassesVisionGate(
  clipPath: string,
  beatText: string,
  videoTitle: string | undefined,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  fastMode: boolean,
  minScore = minClipQualityScore(),
  visualDescription?: string
): Promise<boolean> {
  if (fastMode || !clipVisionGateEnabled() || !shouldVisionCheckClip(clipPath)) return true;

  const result = await scoreClipAcrossFrames(
    clipPath,
    beatText,
    visualDescription,
    videoTitle,
    workDir,
    sceneIndex,
    beatIndex,
    minScore,
    fastMode
  );

  if (!result.pass) {
    console.warn(
      `[VisionGate] Scene ${sceneIndex} beat ${beatIndex}: reject "${path.basename(clipPath)}" ` +
        `(${result.framesScored} frames, worst=${result.worstScore ?? "?"}/10, need ≥${minScore})`
    );
  }
  return result.pass;
}

/** Score clip against narration for post-adoption QA (returns null when vision unavailable). */
export async function scoreAdoptedClipQuality(
  clipPath: string,
  beatText: string,
  visualDescription: string | undefined,
  videoTitle: string | undefined,
  workDir: string,
  sceneIndex: number,
  beatIndex: number
): Promise<{
  score: number;
  matchesNarration: boolean;
  showsSubject: boolean;
  wellFramed: boolean;
  wrongSubject: boolean;
} | null> {
  if (!clipVisionGateEnabled() || !shouldVisionCheckClip(clipPath)) return null;

  const framePaths = await extractPreviewFrames(clipPath, workDir, sceneIndex, beatIndex);
  if (framePaths.length === 0) return null;

  const scores = await Promise.all(
    framePaths.map((fp) =>
      scoreClipNarrationMatch(fp, beatText, visualDescription, videoTitle, 10_000)
    )
  );
  cleanupFramePaths(framePaths);

  const valid = scores.filter((s): s is NonNullable<typeof s> => s != null);
  if (valid.length === 0) return null;

  const minScore = minClipQualityScore();
  let worst = valid[0]!;
  for (const s of valid) {
    if (s.score < worst.score) worst = s;
    if (!passesCriticalVision(s, minScore)) {
      return { ...s, score: s.score };
    }
  }
  return worst;
}
