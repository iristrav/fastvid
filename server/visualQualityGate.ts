/**
 * Vision + luma checks so adopted clips match the beat and are not dark/empty.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";
import { pipelineWallClockLimitEnabled } from "./sourcingPolicy";

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

export function clipVisionGateEnabled(): boolean {
  return process.env.ENABLE_CLIP_VISION !== "false" && Boolean(ENV.forgeApiKey);
}

/** Critical per-clip voice/visual QA (default on with Vidrush quality). */
export function sceneCriticalReviewEnabled(): boolean {
  if (process.env.ENABLE_SCENE_CRITICAL_REVIEW === "false") return false;
  return process.env.ENABLE_VIDRUSH_QUALITY !== "false";
}

/** Minimum vision score (0–10) for broadcast-quality pass. Target 10/10; pass at 8+. */
export function minClipQualityScore(): number {
  const raw = process.env.MIN_CLIP_QUALITY_SCORE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5 && n <= 10) return n;
  }
  return 8;
}

/** Runtime status for /api/health and startup logs (Railway Vision QA). */
export function getVisionQaStatus(): {
  ready: boolean;
  clipVisionGate: boolean;
  sceneCriticalReview: boolean;
  minScore: number;
  llmKeyConfigured: boolean;
  llmProvider: "openai" | "groq" | "forge" | "none";
  hint: string;
} {
  const llmKeyConfigured = Boolean(ENV.forgeApiKey);
  const clipVisionGate = clipVisionGateEnabled();
  const sceneCriticalReview = sceneCriticalReviewEnabled();
  const minScore = minClipQualityScore();
  const llmProvider = ENV.llmProvider;
  const ready = clipVisionGate && sceneCriticalReview && llmKeyConfigured;

  let hint = "Vision QA active — clips are scored against narration during generation.";
  if (!llmKeyConfigured) {
    hint = "Set GROQ_API_KEY or LLM_API_KEY on Railway to enable Vision QA.";
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
    llmKeyConfigured,
    llmProvider,
    hint,
  };
}

/** Check all adopted clips when critical scene review is enabled. */
export function shouldVisionCheckClip(filePath: string): boolean {
  if (process.env.ENABLE_CLIP_VISION === "false") return false;
  const base = path.basename(filePath).toLowerCase();
  if (sceneCriticalReviewEnabled()) return true;
  if (process.env.ENABLE_CLIP_VISION_STOCK === "true") {
    if (/pexels|pixabay|_b\d+_vid/i.test(base)) return true;
  }
  return (
    /_archive_|_hist|_wikivid|_wiki_|_gdelt|_septube|_ov_|_serp_|_unsplash|_euro_|_nasa/i.test(base) ||
    /_ytcc_|_ytfu_|_transformed|_curated_a/i.test(base)
  );
}

async function extractPreviewFrame(
  clipPath: string,
  workDir: string,
  sceneIndex: number,
  beatIndex: number
): Promise<string | null> {
  const ffmpeg = process.env.FFMPEG_BIN?.trim() || "ffmpeg";
  const outPath = path.join(
    workDir,
    `scene_${sceneIndex}_b${beatIndex}_vq_${path.basename(clipPath).replace(/\.[^.]+$/, "")}.jpg`
  );
  if (!fs.existsSync(clipPath)) return null;

  try {
    await new Promise<void>((resolve, reject) => {
      const args = [
        "-y",
        "-ss",
        "50%",
        "-i",
        clipPath,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        outPath,
      ];
      const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
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
    return outPath;
  } catch {
    return null;
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
              "You are a strict documentary editor. Judge if B-roll matches spoken narration. Return JSON only. Score 10 = perfect match; below 6 = reject.",
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

/** Returns true when clip passes vision gate (or gate skipped / inconclusive). */
export async function clipPassesVisionGate(
  clipPath: string,
  beatText: string,
  videoTitle: string | undefined,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  fastMode: boolean,
  minScore = 5,
  visualDescription?: string
): Promise<boolean> {
  if (fastMode || !clipVisionGateEnabled() || !shouldVisionCheckClip(clipPath)) return true;

  const framePath = await extractPreviewFrame(clipPath, workDir, sceneIndex, beatIndex);
  if (!framePath) return true;

  const timeoutMs = pipelineWallClockLimitEnabled()
    ? fastMode
      ? 5_000
      : 8_000
    : fastMode
      ? 7_000
      : 11_000;
  const useCritical = sceneCriticalReviewEnabled() && minScore >= minClipQualityScore();
  const score = useCritical
    ? await scoreClipNarrationMatch(
        framePath,
        beatText,
        visualDescription,
        videoTitle,
        timeoutMs
      )
    : await scoreFrameRelevance(framePath, beatText, videoTitle, timeoutMs);
  try { fs.unlinkSync(framePath); } catch { /* ignore */ }

  if (!score) return true;

  if (useCritical && "matchesNarration" in score) {
    const critical = score as {
      score: number;
      matchesNarration: boolean;
      showsSubject: boolean;
      wellFramed: boolean;
      wrongSubject: boolean;
    };
    const pass =
      critical.score >= minScore &&
      critical.matchesNarration &&
      critical.showsSubject &&
      !critical.wrongSubject &&
      (critical.wellFramed || critical.score >= minScore + 1);
    if (!pass) {
      console.warn(
        `[VisionGate] Scene ${sceneIndex} beat ${beatIndex}: reject "${path.basename(clipPath)}" ` +
          `(score=${critical.score}/10, match=${critical.matchesNarration}, wrong=${critical.wrongSubject})`
      );
    }
    return pass;
  }

  const rel = score as { relevance: number; showsSubject: boolean; wellFramed: boolean };
  const minRel = fastMode ? 4 : minScore;
  const pass =
    rel.relevance >= minRel &&
    rel.showsSubject &&
    (rel.wellFramed || rel.relevance >= minRel + 2);

  if (!pass) {
    console.warn(
      `[VisionGate] Scene ${sceneIndex} beat ${beatIndex}: reject "${path.basename(clipPath)}" ` +
        `(rel=${rel.relevance}, subject=${rel.showsSubject}, framed=${rel.wellFramed})`
    );
  }
  return pass;
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
  const framePath = await extractPreviewFrame(clipPath, workDir, sceneIndex, beatIndex);
  if (!framePath) return null;
  const score = await scoreClipNarrationMatch(
    framePath,
    beatText,
    visualDescription,
    videoTitle,
    12_000
  );
  try { fs.unlinkSync(framePath); } catch { /* ignore */ }
  return score;
}
