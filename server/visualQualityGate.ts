/**
 * Vision + luma checks so adopted clips match the beat and are not dark/empty.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";

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

/** Authentic / archival clips — skip generic Pexels unless explicitly enabled. */
export function shouldVisionCheckClip(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (process.env.ENABLE_CLIP_VISION_STOCK === "true") {
    if (/pexels|pixabay|_b\d+_vid/i.test(base)) return true;
  }
  return (
    /_archive_|_hist|_wikivid|_wiki_|_gdelt|_septube|_ov_|_serp_|_unsplash|_euro_|_nasa/i.test(base) ||
    /_ytcc_|_ytfu_|_transformed/i.test(base)
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
  fastMode: boolean
): Promise<boolean> {
  if (!clipVisionGateEnabled() || !shouldVisionCheckClip(clipPath)) return true;

  const framePath = await extractPreviewFrame(clipPath, workDir, sceneIndex, beatIndex);
  if (!framePath) return true;

  const timeoutMs = fastMode ? 7_000 : 11_000;
  const score = await scoreFrameRelevance(framePath, beatText, videoTitle, timeoutMs);
  try { fs.unlinkSync(framePath); } catch { /* ignore */ }

  if (!score) return true;

  const minRel = fastMode ? 4 : 5;
  const pass =
    score.relevance >= minRel &&
    score.showsSubject &&
    (score.wellFramed || score.relevance >= minRel + 2);

  if (!pass) {
    console.warn(
      `[VisionGate] Scene ${sceneIndex} beat ${beatIndex}: reject "${path.basename(clipPath)}" ` +
        `(rel=${score.relevance}, subject=${score.showsSubject}, framed=${score.wellFramed})`
    );
  }
  return pass;
}
