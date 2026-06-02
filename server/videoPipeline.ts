/**
 * Fastvid — AI Video Generation Pipeline (v5 — Stability AI + Dynamic Scenes)
 *
 * Visual strategy (per scene):
 *   1. PRIMARY:   Stability AI SDXL image → FFmpeg zoom-loop video (~5-10s) — HIGH QUALITY
 *   2. SECONDARY: Pexels stock video clips (multiple per scene)
 *   3. FALLBACK:  Solid colour video (instant)
 *
 * Scene count scales with video length:
 *   5-8 min  → 12 scenes (~25-30s each)
 *   8-12 min → 20 scenes (~25-30s each)
 *   12-15 min → 25 scenes (~25-30s each)
 *   15-20 min → 30 scenes (~30-35s each)
 *   20+ min   → 35 scenes (~35-40s each)
 *
 * Per scene: 1 AI image (zoompan) + 3 Pexels clips joined with xfade transitions. All encoded at HIGH QUALITY (preset=slow, crf=18).
 * All scenes processed in parallel batches to stay within 60-min cap.
 *
 * Cost per video (Stability AI SDXL @ $0.003/image):
 *   12 scenes → ~$0.036
 *   20 scenes → ~$0.060
 *   30 scenes → ~$0.090
 */
import { exec as execCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { storagePut } from "./storage";
import { invokeLLM } from "./_core/llm";
import { updateVideoScenes, updateVideoStatus, type EditorScene, type EditorClip } from "./db";
import pLimit from "p-limit";
import { generateGrokVideo } from "./_core/grokVideo";
import { generateVeoVideo } from "./_core/veoVideo";
import { generateMetaMovieGen } from "./_core/metaMovieGen";
import { generateHiggsfieldTextToVideo, generateHiggsfieldImageToVideo } from "./_core/higgsfieldVideo";
import { sanitizeForDrawtext, sanitizeForDrawtextStrict } from "./ffmpegSanitize";
import { PIPELINE_ERROR, pipelineError } from "@shared/appErrors";
import fetch from "node-fetch";

// API Keys
const FISH_AUDIO_API_KEY = process.env.FISH_AUDIO_API_KEY || "";
const STABILITY_AI_API_KEY = process.env.STABILITY_AI_API_KEY || "";
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || "";
const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY || "";
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY || "";
const META_MOVIE_GEN_API_KEY = process.env.META_MOVIE_GEN_API_KEY || "";
const HIGGSFIELD_API_KEY = process.env.HIGGSFIELD_API_KEY || "";
const HIGGSFIELD_API_SECRET = process.env.HIGGSFIELD_API_SECRET || "";
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY || "";
const KLING_API_KEY = process.env.KLING_API_KEY || "";
const KLING_API_SECRET = process.env.KLING_API_SECRET || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const LUMA_API_KEY = process.env.LUMA_API_KEY || "";
const LEONARDO_API_KEY = process.env.LEONARDO_API_KEY || "";
const PIKA_API_KEY = process.env.PIKA_API_KEY || "";
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || "";
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const RAPIDAPI_YT_HOST =
  process.env.RAPIDAPI_YT_HOST || "ytstream-download-youtube-videos.p.rapidapi.com";

// @ts-ignore
import ffmpegStatic from "ffmpeg-static";
import { execSync } from "child_process";

// Prefer system FFmpeg (installed via nixpacks.toml on Railway) over ffmpeg-static.
// ffmpeg-static can fail on some Linux environments due to missing glibc/libatomic.

// Helper: test if a binary actually runs (not just exists on disk)
const testBinary = (binPath: string): boolean => {
  try {
    execSync(`"${binPath}" -version`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

const resolveFFmpegBin = (): string => {
  // Check NODE_ENV for Railway
  const envPath = process.env.FFMPEG_BIN || '';
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[Fastvid] Using FFMPEG_BIN env: ${envPath}`);
    return envPath;
  }
  // PRIORITY 1: Try system ffmpeg FIRST - it has drawtext/libfreetype support needed for text overlays
  // ffmpeg-static does NOT have drawtext support (compiled without libfreetype)
  const candidatePaths = [
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/nix/var/nix/profiles/default/bin/ffmpeg",
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p) && testBinary(p)) {
      console.log(`[Fastvid] Using system FFmpeg (drawtext-capable): ${p}`);
      return p;
    }
  }
  // PRIORITY 2: Try ffmpeg-static as fallback (no drawtext, but works for basic encoding)
  const staticPath = (ffmpegStatic as unknown as string) || "ffmpeg";
  if (staticPath && fs.existsSync(staticPath)) {
    try {
      execSync(`chmod +x "${staticPath}"`, { shell: "/bin/sh" });
    } catch { /* ignore */ }
    if (testBinary(staticPath)) {
      console.warn(`[Fastvid] Using ffmpeg-static (NO drawtext support): ${staticPath}`);
      return staticPath;
    } else {
      console.warn(`[Fastvid] ffmpeg-static exists but CANNOT RUN (missing glibc?): ${staticPath}`);
    }
  }
  // PRIORITY 3: Try which command
  try {
    const systemPath = execSync("which ffmpeg", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    if (systemPath && testBinary(systemPath)) {
      console.log(`[Fastvid] Using system FFmpeg (which): ${systemPath}`);
      return systemPath;
    }
  } catch {
    // system ffmpeg not found via which
  }
  // PRIORITY 4: Try nix store — Railway Nixpacks installs ffmpeg here (use shell:true for glob)
  try {
    const nixPath = execSync("ls /nix/store/*/bin/ffmpeg 2>/dev/null | head -1", { encoding: "utf8", shell: "/bin/sh" }).trim();
    if (nixPath && fs.existsSync(nixPath) && testBinary(nixPath)) {
      console.log(`[Fastvid] Using nix store FFmpeg: ${nixPath}`);
      return nixPath;
    }
  } catch {
    // nix store not available
  }
  // PRIORITY 5: Try find as last resort
  try {
    const found = execSync("find /nix /usr /opt -name ffmpeg -type f 2>/dev/null | head -1", { encoding: "utf8", shell: "/bin/sh" }).trim();
    if (found && fs.existsSync(found) && testBinary(found)) {
      console.log(`[Fastvid] Using found FFmpeg: ${found}`);
      return found;
    }
  } catch {
    // find failed
  }
  // PRIORITY 6: Last resort: try 'ffmpeg' from PATH
  if (testBinary('ffmpeg')) {
    console.log(`[Fastvid] Using 'ffmpeg' from PATH`);
    return 'ffmpeg';
  }
  console.error(`[Fastvid] CRITICAL: No working FFmpeg binary found! staticPath=${staticPath}`);
  return staticPath; // return anyway so error messages show the path
};
let FFMPEG_BIN: string = resolveFFmpegBin();

function resolveFFprobeBin(): string {
  const envPath = process.env.FFPROBE_BIN || "";
  if (envPath && fs.existsSync(envPath) && testBinary(envPath)) {
    return envPath;
  }
  const derivedFromFfmpeg = FFMPEG_BIN.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  const candidates = [
    derivedFromFfmpeg,
    "/usr/bin/ffprobe",
    "/usr/local/bin/ffprobe",
    "ffprobe",
  ];
  for (const p of candidates) {
    if (p && testBinary(p)) {
      console.log(`[Fastvid] Using ffprobe: ${p}`);
      return p;
    }
  }
  if (process.platform !== "win32") {
    try {
      const nixPath = execSync("ls /nix/store/*/bin/ffprobe 2>/dev/null | head -1", {
        encoding: "utf8",
        shell: "/bin/sh",
      }).trim();
      if (nixPath && testBinary(nixPath)) return nixPath;
    } catch {
      /* nix store not available */
    }
  }
  console.warn("[Fastvid] No dedicated ffprobe found — using 'ffprobe' from PATH");
  return "ffprobe";
}

let FFPROBE_BIN: string = resolveFFprobeBin();

const FFPROBE_PATHS = (): string[] => [
  FFPROBE_BIN,
  "/usr/bin/ffprobe",
  "/usr/local/bin/ffprobe",
  "ffprobe",
];

async function isValidVideoFile(filePath: string): Promise<boolean> {
  if (!fs.existsSync(filePath)) return false;
  const size = fs.statSync(filePath).size;
  if (size < 1000) return false;
  for (const probePath of FFPROBE_PATHS()) {
    try {
      const { stdout } = await exec(
        `"${probePath}" -v error -select_streams v:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
      );
      if (stdout.trim().includes("video")) return true;
    } catch {
      /* try next probe binary */
    }
  }
  // ffprobe missing or failed — accept files that look like MP4 and are non-trivial size
  try {
    const head = fs.readFileSync(filePath).subarray(0, 12);
    return head.length >= 8 && head.subarray(4, 8).toString("ascii") === "ftyp" && size > 5000;
  } catch {
    return false;
  }
}
// Use 256MB maxBuffer — FFmpeg concat of 15+ scenes can produce large stderr output
const execRaw = (cmd: string) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
  execCb(cmd, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) { (err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout = stdout; (err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stderr = stderr; reject(err); }
    else resolve({ stdout, stderr });
  });
});

// Wrapper that retries with a different ffmpeg binary if the current one fails
const exec = async (cmd: string): Promise<{ stdout: string; stderr: string }> => {
  try {
    return await execRaw(cmd);
  } catch (err: unknown) {
    // If current FFMPEG_BIN failed with a binary-not-found error, try alternatives
    const errMsg = (err as Error)?.message || '';
    // Only treat as binary-not-found if the error mentions the FFmpeg binary path itself,
    // NOT if it's an input file ENOENT (which would incorrectly trigger binary switching)
    const isBinaryNotFound = (
      errMsg.includes('not found') || errMsg.includes('Permission denied')
    ) && !errMsg.includes('ENOENT') && !errMsg.includes('No such file or directory');
    if (isBinaryNotFound) {
      console.warn(`[Fastvid] FFmpeg binary failed (${FFMPEG_BIN}), trying alternatives...`);
      const alternatives = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'];
      for (const alt of alternatives) {
        if (alt === FFMPEG_BIN) continue;
        if (testBinary(alt)) {
          console.log(`[Fastvid] Switching to alternative FFmpeg: ${alt}`);
          const oldBin = FFMPEG_BIN;
          FFMPEG_BIN = alt;
          // Replace the old binary path at the start of the command with the new one
          // Commands are built as: `${FFMPEG_BIN} -y ...` so the first token is the binary
          const retryCmd = cmd.startsWith(oldBin)
            ? alt + cmd.slice(oldBin.length)
            : cmd.replace(/^\S+/, alt);
          return await execRaw(retryCmd);
        }
      }
    }
    throw err;
  }
};

// Font paths
// Resolve font paths dynamically — Ubuntu vs Debian have different Noto font locations
const resolveFontPath = (name: string): string => {
  const candidates = [
    `/usr/share/fonts/truetype/noto/${name}`,           // Ubuntu
    `/usr/share/fonts/noto/${name}`,                    // Debian (fonts-noto)
    `/usr/share/fonts/truetype/noto-fonts/${name}`,     // some distros
    `/usr/share/fonts/${name}`,                         // generic fallback
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Last resort: try fc-match to find any available font
  try {
    const result = execSync(`fc-match --format='%{file}' 'NotoSans:bold'`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch { /* ignore */ }
  console.warn(`[Fastvid] Font not found: ${name}, canvas will use default font`);
  return '';
};
const FONT_BOLD = resolveFontPath('NotoSans-Bold.ttf');
const FONT_REGULAR = resolveFontPath('NotoSans-Regular.ttf');

// Canvas is not used — all rendering is done via FFmpeg (no native dependencies required)
const CANVAS_AVAILABLE = false; // kept for reference, all functions use FFmpeg-only paths

// Linux/Railway: prefer /var/tmp (survives long runs). Windows/dev: use OS temp dir.
const TMP_DIR =
  process.env.FASTVID_TMP_DIR ??
  (process.platform === "win32" ? path.join(os.tmpdir(), "fastvid") : "/var/tmp");
// Use lower resolution on Railway (no Forge key = Railway environment) to avoid OOM
// Railway free tier has ~512MB RAM; 1280x720 FFmpeg compositing OOM-kills the process
const IS_RAILWAY = !process.env.BUILT_IN_FORGE_API_KEY;
// 1080p resolution for professional YouTube quality
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
/** Standard scale chain — pad ensures exact even dimensions for libx264 */
const STANDARD_VF = `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease,pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps=25,format=yuv420p`;
/** Vidrush pacing: 2–3s hard-cut clips (reference documentary style) */
const VIDRUSH_CLIP_MIN_SEC = 2.0;
const VIDRUSH_CLIP_MAX_SEC = 3.0;
const VIDRUSH_BEAT_SEC = 2.8;
const CHAPTER_CARD_DURATION = 1.5;

/** Stable stock trim — no animated Ken Burns pan (avoids jitter on real footage). */
async function trimDownloadedStockClip(
  rawPath: string,
  outPath: string,
  clipDuration: number,
  sourceDuration: number,
  label: string,
  startOffsetSec = 0
): Promise<boolean> {
  const loopFlag = sourceDuration < clipDuration ? "-stream_loop -1" : "";
  const ss = Math.max(0, startOffsetSec).toFixed(2);
  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ${loopFlag} -ss ${ss} -i "${rawPath}" ` +
        `-t ${clipDuration} ` +
        `-vf "${STANDARD_VF}" ` +
        `-c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p "${outPath}"`
      ),
      45_000,
      label
    );
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 1_000;
  } catch {
    return false;
  }
}

// ─── Dynamic scene count based on video length ────────────────────────────────
// Each scene is ~25-35s of narration. To hit target duration:
//   5-8 min  = 300-480s → 12-18 scenes @ ~30s each → use 15
//   8-12 min = 480-720s → 18-24 scenes @ ~30s each → use 22
//   12-15 min= 720-900s → 24-30 scenes @ ~30s each → use 28
//   15-20 min= 900-1200s→ 30-40 scenes @ ~30s each → use 35
//   20+ min  = 1200s+   → 40+ scenes @ ~30s each   → use 42
function getScenesForLength(videoLength: string): number {
  switch (videoLength) {
    case "1":     return 3;   // ~1 min preview / test
    case "2":     return 5;   // ~2 min preview / test
    case "5-8":   return 15;
    case "8-12":  return 22;
    case "12-15": return 28;
    case "15-20": return 35;
    case "20+":   return 42;
    default:      return 22;
  }
}
// ─── Types ─────────────────────────────────────────────────────────────────────────────────
interface Scene {
  index: number;
  text: string;
  visualCue: string;
  pexelsQuery: string;
  pexelsQueries?: string[]; // Multiple search queries for better visual matching
  personNames?: string[];    // Names of all people mentioned in this scene's narration
  aiImagePrompt: string;
  duration: number;
  // Chapter card fields (optional)
  isChapterCard?: boolean;   // true = this scene is a chapter title card (no voiceover, 1.5s)
  chapterTitle?: string;     // ALL CAPS title text for the chapter card
  // Vidrush-quality fields
  highlightWords?: string[]; // 2-3 power words for kinetic typography overlay (LLM-generated)
  brollQueries?: string[];   // 2 specific B-roll search queries for cutaway footage
  statCallout?: string;      // 1 key statistic/number for yellow corner callout box (e.g. "45°C", "2%", "$4B")
  literalVisualCue?: string; // Hyper-specific 3-5 word B-roll search (Vidrush literal matching)
  sectionTitle?: string;     // ALL CAPS chapter title → yellow card before this scene
}

export interface PipelineProgress {
  stage: string;
  percent: number;
}

// ─── Timeout helper ───────────────────────────────────────────────────────────
// fetchWithTimeout: truly cancels the download using AbortController (unlike withTimeout which only races)
async function fetchWithTimeout(url: string, timeoutMs: number, label: string, options: Record<string, unknown> = {}): Promise<ReturnType<typeof fetch>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') {
      throw pipelineError(PIPELINE_ERROR.TIMEOUT, `Timeout: ${label} exceeded ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(pipelineError(PIPELINE_ERROR.TIMEOUT, `Timeout: ${label} exceeded ${Math.round(ms / 1000)}s`)),
        ms
      )
    ),
  ]);
}

// ─── Stage labels ─────────────────────────────────────────────────────────────
export const STAGE_LABELS = {
  parsing:    "Parsing script into scenes...",
  voiceovers: "Generating voiceovers...",
  visuals:    "Generating AI visuals + fetching stock clips...",
  composing:  "Composing scenes with AI visuals, subtitles & effects...",
  assembling: "Assembling final video with intro, outro & music...",
  uploading:  "Uploading final video...",
  complete:   "Complete!",
};

// ─── 1. Parse Script into Scenes ─────────────────────────────────────────────

const SCENE_PARSE_BATCH_SIZE = 16;

function parseLLMJson<T>(content: unknown, label: string): T {
  try {
    if (content && typeof content === "object") return content as T;
    const raw = typeof content === "string" ? content : JSON.stringify(content);
    return JSON.parse(raw) as T;
  } catch (err) {
    throw pipelineError(
      PIPELINE_ERROR.SCRIPT_PARSE,
      `${label}: ${(err as Error).message}`
    );
  }
}

function splitScriptForSceneParsing(script: string, parts: number): string[] {
  if (parts <= 1) return [script];
  const sections = script.split(/(?=^## )/m).filter((s) => s.trim().length > 0);
  if (sections.length >= parts) {
    const chunks: string[] = Array.from({ length: parts }, () => "");
    sections.forEach((sec, i) => {
      chunks[i % parts] += (chunks[i % parts] ? "\n" : "") + sec;
    });
    return chunks.filter((c) => c.trim().length > 0);
  }
  const size = Math.ceil(script.length / parts);
  return Array.from({ length: parts }, (_, i) => script.slice(i * size, (i + 1) * size)).filter(Boolean);
}

const SCENE_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "scenes",
    strict: true,
    schema: {
      type: "object",
      properties: {
        scenes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              visualCue: { type: "string" },
              pexelsQuery: { type: "string" },
              pexelsQueries: { type: "array", items: { type: "string" } },
              personNames: { type: "array", items: { type: "string" } },
              brollQueries: { type: "array", items: { type: "string" } },
              literalVisualCue: { type: "string" },
              sectionTitle: { type: "string" },
            },
            required: ["text", "visualCue", "pexelsQuery", "pexelsQueries", "personNames", "brollQueries", "literalVisualCue", "sectionTitle"],
            additionalProperties: false,
          },
        },
      },
      required: ["scenes"],
      additionalProperties: false,
    },
  },
};

async function parseScriptIntoScenesBatch(
  script: string,
  sceneCount: number,
  startIndex: number
): Promise<Scene[]> {
  const response = await withTimeout(
    invokeLLM({
      messages: [
        {
          role: "system",
          content: `Parse the script into exactly ${sceneCount} scenes for Vidrush-quality documentary video.

For each scene return:
- text: narration (max 500 chars, full sentences)
- visualCue: EXACT footage shown while narrating (e.g. "SpaceX Falcon 9 launch pad", "Tesla Gigafactory assembly line")
- literalVisualCue: hyper-specific 3-5 word stock search for the key visual moment (e.g. "rocket launch pad night", "electric car assembly robot")
- pexelsQuery: primary English stock video search — MUST match visualCue and narration topic
- pexelsQueries: 3 queries from most specific to slightly broader — ALL must stay on the same topic
- brollQueries: exactly 2 cutaway B-roll queries (close-ups, hands, screens, crowds) different from pexelsQuery
- personNames: full names of real people mentioned in text, or []
- sectionTitle: ALL CAPS chapter heading shown on yellow card BEFORE this scene when starting a new topic; "" if not a chapter start. NEVER use HOOK, OPENING, CTA, INTRO, or OUTRO as sectionTitle — always "" for those meta sections.

Every query must literally describe what the viewer should see. Scenes are ~2-4s of footage with hard cuts.`,
        },
        {
          role: "user",
          content: `Parse into exactly ${sceneCount} scenes:\n\n${script.slice(0, 14000)}`,
        },
      ],
      response_format: SCENE_JSON_SCHEMA,
      maxTokens: 16384,
    }),
    120_000,
    `Parse scenes batch from ${startIndex}`
  );

  const content = response.choices[0]?.message?.content;
  if (!content) throw pipelineError(PIPELINE_ERROR.SCRIPT_PARSE, "Failed to parse script into scenes");
  const parsed = parseLLMJson<{ scenes: Array<Omit<Scene, "index" | "duration"> & { sectionTitle?: string }> }>(
    content,
    "Scene parse JSON"
  );
  const rawScenes = (parsed.scenes ?? []).slice(0, sceneCount);
  return rawScenes.map((s, i) => mapRawScene(s, startIndex + i));
}

function mapRawScene(
  s: Omit<Scene, "index" | "duration"> & { sectionTitle?: string },
  index: number
): Scene {
  const rawS = s as Record<string, unknown>;
  const literalVisualCue =
    typeof rawS.literalVisualCue === "string" ? rawS.literalVisualCue.trim() : "";
  const primaryQuery =
    literalVisualCue || (s.pexelsQuery?.trim() || s.visualCue || "cinematic background");
  const extraQueries = (rawS.pexelsQueries as string[] | undefined) || [];
  const allQueries = [primaryQuery, ...extraQueries.filter((q) => q && q !== primaryQuery)].slice(0, 4);
  const personNames = ((rawS.personNames as string[] | undefined) || [])
    .filter((n) => typeof n === "string" && n.trim().length > 0)
    .map((n) => n.trim());
  const brollQueries = ((rawS.brollQueries as string[] | undefined) || [])
    .filter((q) => typeof q === "string" && q.trim().length > 0)
    .slice(0, 2);
  const sectionTitle =
    typeof rawS.sectionTitle === "string" ? rawS.sectionTitle.trim().slice(0, 60) : "";
  return {
    ...s,
    index,
    duration: 0,
    pexelsQuery: primaryQuery,
    pexelsQueries: allQueries,
    personNames,
    literalVisualCue: literalVisualCue || undefined,
    highlightWords: [],
    brollQueries,
    statCallout: "",
    aiImagePrompt: `Cinematic ${s.visualCue || "documentary scene"}, dramatic lighting, photorealistic`,
    isChapterCard: false,
    chapterTitle: isPublishableChapterTitle(sectionTitle) ? sectionTitle : undefined,
    sectionTitle: isPublishableChapterTitle(sectionTitle) ? sectionTitle : undefined,
  };
}

async function parseScriptIntoScenes(script: string, maxScenes: number): Promise<Scene[]> {
  if (maxScenes <= SCENE_PARSE_BATCH_SIZE) {
    return parseScriptIntoScenesBatch(script, maxScenes, 0);
  }

  const batchCount = Math.ceil(maxScenes / SCENE_PARSE_BATCH_SIZE);
  const chunks = splitScriptForSceneParsing(script, batchCount);
  const scenesPerBatch = Math.ceil(maxScenes / chunks.length);
  const allScenes: Scene[] = [];

  for (let b = 0; b < chunks.length; b++) {
    const remaining = maxScenes - allScenes.length;
    if (remaining <= 0) break;
    const count = Math.min(scenesPerBatch, remaining, SCENE_PARSE_BATCH_SIZE);
    const batchScenes = await parseScriptIntoScenesBatch(chunks[b], count, allScenes.length);
    allScenes.push(...batchScenes);
  }

  if (allScenes.length === 0) {
    throw pipelineError(PIPELINE_ERROR.SCRIPT_PARSE, "No scenes parsed from script");
  }
  return allScenes.slice(0, maxScenes);
}

// ─── 2. TTS Voiceover ───────────────────────────────────────────────────────────────────────────
// Priority: Fish Audio S2 Pro (primary, high quality) → ElevenLabs (fallback if quota available) → Google TTS (free) → silent
export async function generateVoiceover(
  text: string,
  outputPath: string,
  voiceId?: string
): Promise<number> {
  const rawText = text
    .replace(/[#*_`~>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\x00-\x7F]/g, "")
    .trim();
  const cleanText = rawText.length <= 800 ? rawText : rawText.slice(0, 800).replace(/\s\S*$/, "");

  const MAX_ATTEMPTS = 3;
  const TTS_TIMEOUT_MS = 90_000;

  // ── Fish Audio S2 Pro TTS (PRIMARY — highest quality, no quota issues) ───────
  // Maps ElevenLabs voice IDs (stored in DB) to Fish Audio reference IDs
  const FISH_VOICE_MAP: Record<string, string> = {
    "pNInz6obpgDQGcFmaJgB": "0327fdb5da9e4fd782899a8058c8ae2b", // Michael → Narrator
    "ErXwobaYiN019PkySvjV": "0327fdb5da9e4fd782899a8058c8ae2b", // Adam → Narrator
    "21m00Tcm4TlvDq8ikWAM": "0327fdb5da9e4fd782899a8058c8ae2b", // Heart → Narrator
    "EXAVITQu4vr4xnSDxMaL": "0327fdb5da9e4fd782899a8058c8ae2b", // Bella → Narrator
    "JBFqnCBsd6RMkjVDRZzb": "0327fdb5da9e4fd782899a8058c8ae2b", // George → Narrator
    "TX3LPaxmHKxFdv7VOQHJ": "0327fdb5da9e4fd782899a8058c8ae2b", // Lewis → Narrator
  };
  const fishReferenceId = (voiceId && FISH_VOICE_MAP[voiceId]) || "0327fdb5da9e4fd782899a8058c8ae2b";

  if (FISH_AUDIO_API_KEY) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await withTimeout(
          fetch("https://api.fish.audio/v1/tts", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${FISH_AUDIO_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text: cleanText,
              reference_id: fishReferenceId,
              format: "mp3",
              mp3_bitrate: 192,
              normalize: true,
              latency: "normal",
            }),
          }),
          TTS_TIMEOUT_MS,
          `Fish Audio TTS attempt ${attempt}`
        );

        if (response.status === 429) {
          const waitMs = 1000 + attempt * 1000;
          console.warn(`[Pipeline] Fish Audio 429 (attempt ${attempt}), retrying in ${waitMs}ms`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }

        if (!response.ok) {
          const errText = await response.text();
          throw pipelineError(PIPELINE_ERROR.VOICEOVER, `Fish Audio HTTP ${response.status}: ${errText.slice(0, 200)}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        if (audioBuffer.length < 100) throw pipelineError(PIPELINE_ERROR.VOICEOVER_EMPTY, "Fish Audio returned empty audio");

        fs.writeFileSync(outputPath, audioBuffer);
        console.log(`[Pipeline] Fish Audio TTS written: ${audioBuffer.length} bytes to ${outputPath}`);

        let durationSec = Math.max(3, Math.round(audioBuffer.length / 40000));
        try {
          const { execSync: es } = await import('child_process');
          for (const probePath of FFPROBE_PATHS()) {
            try {
              const probeOut = es(`"${probePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`, { encoding: 'utf8', timeout: 8000 });
              const parsed = parseFloat(probeOut.trim());
              if (!isNaN(parsed) && parsed > 0) { durationSec = Math.ceil(parsed); break; }
            } catch { /* try next */ }
          }
        } catch { /* use estimate */ }
        console.log(`[Pipeline] Fish Audio TTS scene ${outputPath.match(/scene_(\d+)/)?.[1] ?? '?'}: ${durationSec}s`);
        return durationSec;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          console.warn(`[Pipeline] Fish Audio failed after ${MAX_ATTEMPTS} attempts:`, err);
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // ── ElevenLabs TTS (FALLBACK — try if Fish Audio fails and key available) ───────────
  if (ELEVENLABS_API_KEY) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Map voiceId to ElevenLabs voice ID, or use a high-quality default
        // Default: "Adam" = pNInz6obpgDQGcFmaJgB (deep documentary voice)
        const elevenVoiceId = voiceId || "pNInz6obpgDQGcFmaJgB";
        const response = await withTimeout(
          fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elevenVoiceId}`, {
            method: "POST",
            headers: {
              "xi-api-key": ELEVENLABS_API_KEY,
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            body: JSON.stringify({
              text: cleanText,
              model_id: "eleven_multilingual_v2",
              voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
            }),
          }),
          TTS_TIMEOUT_MS,
          `ElevenLabs TTS attempt ${attempt}`
        );

        if (response.status === 429) {
          const waitMs = 500 + attempt * 500;
          console.warn(`[Pipeline] ElevenLabs 429 (attempt ${attempt}), retrying in ${waitMs}ms`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }

        if (!response.ok) {
          const errText = await response.text();
          throw pipelineError(PIPELINE_ERROR.VOICEOVER, `ElevenLabs HTTP ${response.status}: ${errText.slice(0, 200)}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        if (audioBuffer.length < 100) throw pipelineError(PIPELINE_ERROR.VOICEOVER_EMPTY, "ElevenLabs returned empty audio");

        fs.writeFileSync(outputPath, audioBuffer);
        console.log(`[Pipeline] ElevenLabs TTS written: ${audioBuffer.length} bytes to ${outputPath}`);

        let durationSec = 5;
        try {
          const { execSync: es } = await import('child_process');
          for (const probePath of FFPROBE_PATHS()) {
            try {
              const probeOut = es(`"${probePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`, { encoding: 'utf8', timeout: 8000 });
              const parsed = parseFloat(probeOut.trim());
              if (!isNaN(parsed) && parsed > 0) { durationSec = Math.ceil(parsed); break; }
            } catch { /* try next */ }
          }
        } catch { /* use default */ }
        if (durationSec === 5 && audioBuffer.length > 1000) {
          durationSec = Math.max(3, Math.round(audioBuffer.length / 40000));
        }
        console.log(`[Pipeline] ElevenLabs TTS scene ${outputPath.match(/scene_(\d+)/)?.[1] ?? "?"}: ${durationSec}s`);
        return durationSec;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          console.warn(`[Pipeline] ElevenLabs failed after ${MAX_ATTEMPTS} attempts:`, err);
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // Fallback 2: Google TTS (free, no API key, works in any environment)
  // Uses the unofficial Google Translate TTS endpoint — reliable for short texts
  try {
    const chunks: string[] = [];
    const words = cleanText.split(' ');
    let chunk = '';
    for (const word of words) {
      if ((chunk + ' ' + word).trim().length > 180) {
        chunks.push(chunk.trim());
        chunk = word;
      } else {
        chunk = (chunk + ' ' + word).trim();
      }
    }
    if (chunk) chunks.push(chunk);

    const chunkFiles: string[] = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunkPath = outputPath.replace('.mp3', `_gtts_chunk${ci}.mp3`);
      const encoded = encodeURIComponent(chunks[ci]);
      const gttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=en&client=tw-ob`;
      const gResp = await withTimeout(
        fetch(gttsUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } }),
        15_000, `gTTS chunk ${ci}`
      );
      if (!gResp.ok) throw pipelineError(PIPELINE_ERROR.VOICEOVER, `gTTS HTTP ${gResp.status}`);
      const buf = Buffer.from(await gResp.arrayBuffer());
      if (buf.length < 100) throw pipelineError(PIPELINE_ERROR.VOICEOVER_EMPTY, "gTTS empty response");
      fs.writeFileSync(chunkPath, buf);
      chunkFiles.push(chunkPath);
    }

    if (chunkFiles.length === 1) {
      fs.renameSync(chunkFiles[0], outputPath);
    } else {
      // Concatenate chunks with FFmpeg
      const listFile = outputPath.replace('.mp3', '_gtts_list.txt');
      fs.writeFileSync(listFile, chunkFiles.map(f => `file '${f}'`).join('\n'));
      await withTimeout(
        exec(`${FFMPEG_BIN} -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`),
        20_000, 'gTTS concat'
      );
      chunkFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
      try { fs.unlinkSync(listFile); } catch {}
    }

    const { execSync: es } = await import('child_process');
    let durationSec = Math.max(3, Math.ceil(cleanText.split(' ').length / 2.5));
    try {
      const probeOut = es(`"${FFPROBE_BIN}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`, { encoding: 'utf8', timeout: 8000 });
      const parsed = parseFloat(probeOut.trim());
      if (!isNaN(parsed) && parsed > 0) durationSec = Math.ceil(parsed);
    } catch { /* use estimate */ }

    console.log(`[Pipeline] gTTS fallback scene ${outputPath.match(/scene_(\d+)/)?.[1] ?? '?'}: ${durationSec}s`);
    return durationSec;
  } catch (gErr) {
    console.warn('[Pipeline] gTTS fallback failed:', gErr);
  }

  // Silent fallback
  const estimatedDuration = Math.max(3, Math.ceil(cleanText.split(" ").length / 2.5));
  try {
    await withTimeout(
      exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${estimatedDuration} -c:a libmp3lame -b:a 64k "${outputPath}"`),
      10_000, "Silent audio fallback"
    );
  } catch {
    fs.writeFileSync(outputPath, Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(413).fill(0)]));
  }
  return estimatedDuration;
}

// ─── 3a. Stability AI Image → Video Loop (PRIMARY visual) ────────────────────
async function generateStabilityAIClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!STABILITY_AI_API_KEY) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: No Stability AI key, skipping AI image`);
    return null;
  }

  try {
    console.log(`[Pipeline] Scene ${sceneIndex}: Generating Stability AI image...`);
    const t = Date.now();

    // Use Stability AI Core API (v2beta) — JSON body, no FormData
    const stabilityPayload = {
      text_prompts: [
        { text: prompt, weight: 1 },
        { text: "blurry, low quality, watermark, text, logo, ugly, deformed", weight: -1 },
      ],
      cfg_scale: 8,
      height: 768,   // SDXL valid resolution (multiple of 64, landscape)
      width: 1344,   // SDXL valid resolution (multiple of 64, ~16:9 landscape)
      samples: 1,
      steps: 50,
    };

    const response = await withTimeout(
      fetch("https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${STABILITY_AI_API_KEY}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(stabilityPayload),
      }),
      45_000,
      `Stability AI image scene ${sceneIndex}`
    );

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Pipeline] Scene ${sceneIndex}: Stability AI error ${response.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const result = await response.json() as { artifacts?: Array<{ base64: string; finishReason: string }> };
    const artifact = result.artifacts?.[0];
    if (!artifact?.base64) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Stability AI returned no image`);
      return null;
    }

    const imgBuffer = Buffer.from(artifact.base64, "base64");
    const pngPath = outputPath.replace(".mp4", "_ai.png");
    fs.writeFileSync(pngPath, imgBuffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Stability AI image in ${((Date.now()-t)/1000).toFixed(1)}s (${(imgBuffer.length/1024).toFixed(0)}KB)`);

    // Convert to video — Ken Burns 5-10% zoom (like reference video), NO fade-in/out
    const fps = 25;
    const totalFrames = Math.ceil(duration * fps);
    const zoomStep = 0.0003; // slow 7% zoom over full duration
    const direction = sceneIndex % 2 === 0 ? 1 : -1;
    const panX = direction > 0 ? `iw/2-(iw/zoom/2)` : `iw/2-(iw/zoom/2)+2`;
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -loop 1 -i "${pngPath}" ` +
        `-vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},` +
        `zoompan=z='min(zoom+${zoomStep},1.07)':x='${panX}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${fps}" ` +
        `-t ${duration} -r ${fps} -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p "${outputPath}"`
      ),
      90_000,
      `AI image to video scene ${sceneIndex}`
    );

    try { fs.unlinkSync(pngPath); } catch { /* ignore */ }

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      return outputPath;
    }
    return null;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Stability AI clip failed:`, err);
    return null;
  }
}

// ─── 3b. Pexels Stock Clips (SECONDARY — multiple per scene) ─────────────────
async function fetchPexelsClips(
  query: string,
  clipDuration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 3,
  extraQueries?: string[],
  strictQueries = false,
  fileTag = "pexels",
  excludeVideoIds?: Set<number>,
  candidateOffset = 0
): Promise<string[]> {
  if (!PEXELS_API_KEY) return [];

  const results: string[] = [];

  // Never fall back to generic nature/city b-roll — that produces irrelevant footage (wind turbines, cyclists, etc.)
  const queryList = Array.from(
    new Set([query, ...(extraQueries ?? [])].filter((q) => q && q.trim().length > 2 && !isBlockedStockQuery(q)))
  );
  if (queryList.length === 0) return [];
  // Deduplicate
  const seen = new Set<string>();
  const uniqueQueries = queryList.filter(q => { if (seen.has(q)) return false; seen.add(q); return true; });

  for (const currentQuery of uniqueQueries) {
    if (results.length >= count) break; // Stop if we have enough clips

    try {
      // HD quality: large size (min 1280px), landscape orientation, fetch 15 candidates
      const searchUrl = `https://api.pexels.com/videos/search?query=${encodeURIComponent(currentQuery)}&per_page=15&size=large&orientation=landscape&min_duration=4`;
      const searchResp = await withTimeout(
        fetch(searchUrl, { headers: { Authorization: PEXELS_API_KEY } }),
        10_000,
        `Pexels search scene ${sceneIndex} query "${currentQuery}"`
      );

      if (!searchResp.ok) continue;

    const searchData = await searchResp.json() as {
      videos?: Array<{
        id: number;
        duration: number;
        video_files: Array<{ width: number; height: number; link: string }>;
      }>;
    };

    if (!searchData.videos?.length) continue;

    // Filter: min 3s duration, skip already-used Pexels IDs, sort by resolution descending
    const filtered = searchData.videos
      .filter(v => v.duration >= 3 && !excludeVideoIds?.has(v.id))
      .sort((a, b) => {
        const aMax = Math.max(...a.video_files.map(f => f.width));
        const bMax = Math.max(...b.video_files.map(f => f.width));
        return bMax - aMax;
      });
    const offset = filtered.length > 0 ? candidateOffset % filtered.length : 0;
    const candidates = [...filtered.slice(offset), ...filtered.slice(0, offset)].slice(0, count * 3);

    const needed = count - results.length;
    // Download up to `needed` clips in parallel
    const downloadLimit = pLimit(needed);
    const downloadResults = await Promise.allSettled(
      candidates.slice(0, needed).map((video, idx) => downloadLimit(async () => {
        // Prefer 720p (1280px wide) — cap at 1280 to avoid large file download timeouts
        // 4K files (3840px+) and 1080p (1920px) are too large and cause FetchError: aborted
        const videoFile = video.video_files
          .filter(f => f.width >= 1280 && f.width <= 1280)  // exact 720p/1280p
          .sort((a, b) => b.width - a.width)[0]
          || video.video_files
          .filter(f => f.width >= 960 && f.width <= 1280)   // 960-1280px range
          .sort((a, b) => b.width - a.width)[0]
          || video.video_files
          .filter(f => f.width >= 640 && f.width <= 1920)   // any HD
          .sort((a, b) => b.width - a.width)[0]
          || video.video_files
          .filter(f => f.width <= 1920)
          .sort((a, b) => b.width - a.width)[0]
          || video.video_files.sort((a, b) => a.width - b.width)[0]; // fallback: smallest available

        if (!videoFile?.link) return null;

        const rawPath = path.join(workDir, `scene_${sceneIndex}_${fileTag}_vid${video.id}_raw.mp4`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${fileTag}_vid${video.id}.mp4`);

        // Download with retry logic
        let downloadResp;
        let buffer: Buffer | null = null;
        let retries = 3;
        
        while (retries > 0 && !buffer) {
          try {
            downloadResp = await withTimeout(
              fetch(videoFile.link),
              45_000,
              `Download Pexels clip ${idx} scene ${sceneIndex} (attempt ${4 - retries}/3)`
            );
            if (!downloadResp.ok) {
              retries--;
              if (retries > 0) await new Promise(r => setTimeout(r, 1000)); // Wait before retry
              continue;
            }

            buffer = Buffer.from(await downloadResp.arrayBuffer());
            
            // Validate buffer size (minimum 50KB for valid video)
            if (buffer.length < 50_000) {
              console.warn(`[Pipeline] Pexels clip ${idx} too small (${buffer.length} bytes), retrying...`);
              buffer = null;
              retries--;
              if (retries > 0) await new Promise(r => setTimeout(r, 1000));
              continue;
            }
            
            break; // Success
          } catch (err) {
            console.warn(`[Pipeline] Download attempt failed for Pexels clip ${idx}:`, err);
            retries--;
            if (retries > 0) await new Promise(r => setTimeout(r, 1000));
          }
        }
        
        if (!buffer) {
          console.warn(`[Pipeline] Failed to download Pexels clip ${idx} after 3 attempts`);
          return null;
        }

        fs.writeFileSync(rawPath, buffer);

        // Validate downloaded file with ffprobe before processing
        // Use system ffprobe which supports -show_entries (ffmpeg-static does not have drawtext/libfreetype)
        try {
          const probeCmd = `"${FFPROBE_BIN}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${rawPath}"`;
          const probeResult = await withTimeout(
            exec(probeCmd),
            10_000,
            `Probe Pexels clip ${idx}`
          );
          const probeDuration = typeof probeResult === 'string' ? probeResult : (probeResult as any).stdout || '';
          const duration = parseFloat(probeDuration);
          if (isNaN(duration) || duration < 1) {
            console.warn(`[Pipeline] Pexels clip ${idx} has invalid duration: ${duration}`);
            try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
            return null;
          }
          // Second check: verify video stream is readable (catches 'moov atom not found' and other corrupt MP4 errors)
          const streamCheckCmd = `"${FFPROBE_BIN}" -v error -select_streams v:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${rawPath}"`;
          const streamResult = await withTimeout(
            exec(streamCheckCmd),
            10_000,
            `Stream check Pexels clip ${idx}`
          );
          const streamOutput = typeof streamResult === 'string' ? streamResult : (streamResult as any).stdout || '';
          if (!streamOutput.includes('video')) {
            console.warn(`[Pipeline] Pexels clip ${idx} has no readable video stream (corrupt/incomplete MP4), skipping`);
            try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
            return null;
          }
        } catch (err) {
          console.warn(`[Pipeline] Failed to validate Pexels clip ${idx}:`, err);
          try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
          return null;
        }

        const startSec = ((sceneIndex + idx) * 0.37) % 1.2;
        const trimmed = await trimDownloadedStockClip(
          rawPath,
          outPath,
          clipDuration,
          video.duration,
          `Trim Pexels clip ${idx} scene ${sceneIndex}`,
          startSec
        );

        try { fs.unlinkSync(rawPath); } catch { /* ignore */ }

        if (trimmed) {
          excludeVideoIds?.add(video.id);
          return outPath;
        }
        return null;
      }))
    );

    for (const r of downloadResults) {
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    }
    } catch (err) {
      console.warn(`[Pipeline] Pexels search failed for query "${currentQuery}" scene ${sceneIndex}:`, err);
    }
  }

  return results;
}

// ─── 3b2. Fetch B-roll Clips from Pexels (cutaway footage for visual variety) ─────────────
// Fetches 1-2 B-roll clips using scene.brollQueries (LLM-generated cutaway queries).
// These are inserted between main clips to add visual variety (Vidrush style).
async function fetchBrollClips(
  brollQueries: string[],
  clipDuration: number,
  workDir: string,
  sceneIndex: number,
  excludeVideoIds?: Set<number>
): Promise<string[]> {
  if ((!PEXELS_API_KEY && !PIXABAY_API_KEY) || !brollQueries || brollQueries.length === 0) return [];
  const results: string[] = [];
  for (let qi = 0; qi < brollQueries.length && results.length < 3; qi++) {
    const query = brollQueries[qi];
    if (!query || !query.trim()) continue;
    try {
      const searchUrl = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&size=large&orientation=landscape&min_duration=4`;
      const searchResp = await withTimeout(
        fetch(searchUrl, { headers: { Authorization: PEXELS_API_KEY } }),
        10_000,
        `B-roll Pexels search scene ${sceneIndex} query "${query}"`
      );
      if (!searchResp.ok) continue;
      const searchData = await searchResp.json() as {
        videos?: Array<{ id: number; duration: number; video_files: Array<{ width: number; height: number; link: string }> }>;
      };
      if (!searchData.videos?.length) continue;
      const candidates = searchData.videos
        .filter(v => v.duration >= 3 && !excludeVideoIds?.has(v.id))
        .slice(0, 3);
      for (const video of candidates) {
        if (results.length >= 3) break;
        const videoFile = video.video_files
          .filter(f => f.width >= 1280 && f.width <= 1920)
          .sort((a, b) => b.width - a.width)[0]
          || video.video_files.filter(f => f.width <= 1920).sort((a, b) => b.width - a.width)[0];
        if (!videoFile?.link) continue;
        const rawPath = path.join(workDir, `scene_${sceneIndex}_broll_vid${video.id}_raw.mp4`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_broll_vid${video.id}.mp4`);
        try {
          const dlResp = await fetchWithTimeout(videoFile.link, 8_000, `B-roll download scene ${sceneIndex}`);
          if (!dlResp.ok) continue;
          const buffer = Buffer.from(await dlResp.arrayBuffer());
          if (buffer.length < 50_000) continue;
          fs.writeFileSync(rawPath, buffer);
          const startSec = (sceneIndex + qi) * 0.29 % 1.0;
          const trimmed = await trimDownloadedStockClip(
            rawPath,
            outPath,
            clipDuration,
            video.duration,
            `B-roll trim scene ${sceneIndex}`,
            startSec
          );
          try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
          if (trimmed) {
            excludeVideoIds?.add(video.id);
            results.push(outPath);
            console.log(`[Pipeline] Scene ${sceneIndex}: B-roll clip added: "${query}"`);
          }
        } catch (err) {
          console.warn(`[Pipeline] B-roll clip failed for scene ${sceneIndex} query "${query}":`, (err as Error).message);
          try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
        }
        break; // one clip per query
      }
    } catch (err) {
      console.warn(`[Pipeline] B-roll search failed for scene ${sceneIndex} query "${query}":`, (err as Error).message);
    }
  }
  return results;
}


// ─── 3b3. Fetch Clips from Pixabay (B-roll + main visual source) ─────────────────────────────
// Pixabay Video API: free, no attribution required for commercial use.
// Returns up to `count` trimmed HD clips matching the query.
async function fetchPixabayClips(
  query: string,
  clipDuration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2,
  suffix: string = "pixabay",
  strictQueries = false,
  excludeVideoIds?: Set<number>,
  candidateOffset = 0
): Promise<string[]> {
  if (!PIXABAY_API_KEY) return [];
  const results: string[] = [];

  const queryList = Array.from(
    new Set([query].filter((q) => q && q.trim().length > 2 && !isBlockedStockQuery(q)))
  );
  if (queryList.length === 0) return [];
  const seen = new Set<string>();
  const uniqueQueries = queryList.filter(q => { if (seen.has(q)) return false; seen.add(q); return true; });

  for (const currentQuery of uniqueQueries) {
    if (results.length >= count) break;
    try {
      // Pixabay Video API: https://pixabay.com/api/docs/#api_videos
      // video_type=film gives real footage (not animation); min_width=1280 for HD
      const searchUrl =
        `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}` +
        `&q=${encodeURIComponent(currentQuery)}` +
        `&per_page=10&video_type=film&min_width=1280&safesearch=true`;

      const searchResp = await withTimeout(
        fetch(searchUrl),
        10_000,
        `Pixabay search scene ${sceneIndex} query "${currentQuery}"`
      );
      if (!searchResp.ok) {
        console.warn(`[Pipeline] Pixabay search HTTP ${searchResp.status} for "${currentQuery}"`);
        continue;
      }

      const searchData = await searchResp.json() as {
        totalHits?: number;
        hits?: Array<{
          id: number;
          duration: number;
          tags?: string;
          videos: {
            large?: { url: string; width: number; height: number; size: number };
            medium?: { url: string; width: number; height: number; size: number };
            small?: { url: string; width: number; height: number; size: number };
          };
        }>;
      };

      if (!searchData.hits?.length) continue;

      // Filter: min 3s duration, skip used IDs, sort by resolution descending
      const filtered = searchData.hits
        .filter(v => v.duration >= 3 && !excludeVideoIds?.has(v.id) && !hasBlockedStockTags(v.tags))
        .sort((a, b) => {
          const aW = a.videos.large?.width ?? a.videos.medium?.width ?? 0;
          const bW = b.videos.large?.width ?? b.videos.medium?.width ?? 0;
          return bW - aW;
        });
      const offset = filtered.length > 0 ? candidateOffset % filtered.length : 0;
      const candidates = [...filtered.slice(offset), ...filtered.slice(0, offset)].slice(0, count * 2);

      for (let idx = 0; idx < candidates.length && results.length < count; idx++) {
        const video = candidates[idx];
        // Prefer large (1080p) → medium (720p) → small
        const videoFile =
          video.videos.large?.url ? video.videos.large :
          video.videos.medium?.url ? video.videos.medium :
          video.videos.small?.url ? video.videos.small : null;

        if (!videoFile?.url) continue;

        const rawPath = path.join(workDir, `scene_${sceneIndex}_${suffix}_vid${video.id}_raw.mp4`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${suffix}_vid${video.id}.mp4`);

        try {
          // Download with retry
          let buffer: Buffer | null = null;
          for (let attempt = 0; attempt < 3 && !buffer; attempt++) {
            try {
              const dlResp = await withTimeout(
                fetch(videoFile.url),
                20_000,
                `Pixabay download scene ${sceneIndex} clip ${idx} attempt ${attempt + 1}`
              );
              if (!dlResp.ok) { await new Promise(r => setTimeout(r, 1000)); continue; }
              const buf = Buffer.from(await dlResp.arrayBuffer());
              if (buf.length < 200_000) { await new Promise(r => setTimeout(r, 1000)); continue; }
              buffer = buf;
            } catch (dlErr) {
              console.warn(`[Pipeline] Pixabay download attempt ${attempt + 1} failed:`, dlErr);
              await new Promise(r => setTimeout(r, 1000));
            }
          }
          if (!buffer) continue;

          fs.writeFileSync(rawPath, buffer);

          // Validate with ffprobe
          try {
            const probeResult = await withTimeout(
              exec(`"${FFPROBE_BIN}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${rawPath}"`),
              10_000, `Probe Pixabay clip ${idx}`
            );
            const dur = parseFloat(typeof probeResult === 'string' ? probeResult : (probeResult as any).stdout || '');
            if (isNaN(dur) || dur < 1) { try { fs.unlinkSync(rawPath); } catch { /**/ } continue; }
          } catch { try { fs.unlinkSync(rawPath); } catch { /**/ } continue; }

          // Stable trim — color grade applied later in composeSceneVideo
          const startSec = (sceneIndex + idx) * 0.33 % 1.1;
          const trimmed = await trimDownloadedStockClip(
            rawPath,
            outPath,
            clipDuration,
            video.duration,
            `Trim Pixabay clip ${idx} scene ${sceneIndex}`,
            startSec
          );

          try { fs.unlinkSync(rawPath); } catch { /**/ }

          if (trimmed) {
            excludeVideoIds?.add(video.id);
            results.push(outPath);
            console.log(`[Pipeline] Scene ${sceneIndex}: Pixabay clip added: "${currentQuery}"`);
          }
        } catch (err) {
          console.warn(`[Pipeline] Pixabay clip ${idx} failed for scene ${sceneIndex}:`, (err as Error).message);
          try { fs.unlinkSync(rawPath); } catch { /**/ }
        }
      }
    } catch (err) {
      console.warn(`[Pipeline] Pixabay search failed for query "${currentQuery}" scene ${sceneIndex}:`, err);
    }
  }

  return results;
}

/** Gentle Ken Burns for portrait stills: ~3% center zoom, no pan — avoids jitter. */
async function convertImageToVideoGentle(
  imgPath: string,
  outPath: string,
  duration: number,
  label: string
): Promise<void> {
  const fps = 25;
  const totalFrames = Math.max(25, Math.round(duration * fps));
  const zoomEnd = 1.03;
  const zoomStep = (zoomEnd - 1.0) / totalFrames;
  const padW = Math.round(VIDEO_WIDTH * 1.05);
  const padH = Math.round(VIDEO_HEIGHT * 1.05);
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -loop 1 -i "${imgPath}" -t ${duration} ` +
      `-vf "scale=${padW}:${padH}:force_original_aspect_ratio=increase,` +
      `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(iw-${VIDEO_WIDTH})/2:(ih-${VIDEO_HEIGHT})/2,` +
      `zoompan=z='min(zoom+${zoomStep.toFixed(7)},${zoomEnd})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${fps}" ` +
      `-c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p "${outPath}"`
    ),
    45_000,
    label
  );
}

// ─── 3c2. Wikimedia Commons Image Search ────────────────────────────────────
// Searches Wikimedia Commons for freely licensed images (good for celebrities, news, etc.)
async function fetchWikimediaImages(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2,
  fileTag = ""
): Promise<string[]> {
  const results: string[] = [];
  try {
    // Search Wikimedia Commons for images
    const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=6&srlimit=10&format=json&origin=*`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }),
      8_000,
      `Wikimedia search scene ${sceneIndex}`
    );
    if (!searchResp.ok) return [];
    const searchData = await searchResp.json() as { query?: { search?: Array<{ title: string }> } };
    const titles = searchData.query?.search?.map(r => r.title).slice(0, count * 2) || [];
    if (!titles.length) return [];

    // Get image info for each result
    for (let i = 0; i < Math.min(titles.length, count); i++) {
      try {
        const title = titles[i];
        const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url|mime|size&format=json&origin=*`;
        const infoResp = await withTimeout(
          fetch(infoUrl, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }),
          8_000,
          `Wikimedia info scene ${sceneIndex}`
        );
        if (!infoResp.ok) continue;
        const infoData = await infoResp.json() as { query?: { pages?: Record<string, { imageinfo?: Array<{ url: string; mime: string; size: number }> }> } };
        const pages = infoData.query?.pages || {};
        const page = Object.values(pages)[0];
        const imageInfo = page?.imageinfo?.[0];
        if (!imageInfo?.url) continue;
        // Only use JPEG/PNG images, skip SVG/PDF/audio/video
        if (!imageInfo.mime.startsWith('image/jpeg') && !imageInfo.mime.startsWith('image/png')) continue;
        // Skip very small images
        if (imageInfo.size < 10_000) continue;

        // Download the image
        const tag = fileTag ? `${fileTag}_` : "";
        const imgPath = path.join(workDir, `scene_${sceneIndex}_${tag}wiki_${i}.jpg`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}wiki_${i}.mp4`);
        const imgResp = await withTimeout(
          fetch(imageInfo.url, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }),
          15_000,
          `Wikimedia download scene ${sceneIndex}`
        );
        if (!imgResp.ok) continue;
        const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
        if (imgBuffer.length < 10_000) continue;
        fs.writeFileSync(imgPath, imgBuffer);

        await convertImageToVideoGentle(
          imgPath,
          outPath,
          duration,
          `Wikimedia image to video scene ${sceneIndex}`
        );
        try { fs.unlinkSync(imgPath); } catch { /* ignore */ }
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1_000) {
          results.push(outPath);
          console.log(`[Pipeline] Scene ${sceneIndex}: Wikimedia image added: ${title}`);
        }
      } catch (err) {
        console.warn(`[Pipeline] Wikimedia image ${i} failed for scene ${sceneIndex}:`, err);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] Wikimedia search failed for scene ${sceneIndex}:`, err);
  }
  return results;
}

// ─── 3c2b. Openverse API Image Search ─────────────────────────────────────
// Searches Openverse (WordPress/Automattic) for CC-licensed photos of public figures.
// No API key required. Returns CC-BY licensed images — safe for commercial use.
// Great source for celebrities, politicians, athletes, and public events.
async function fetchOpenverseImages(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  maxResults: number = 2,
  fileTag = ""
): Promise<string[]> {
  const results: string[] = [];
  try {
    // Search Openverse for CC-licensed images (commercial use + modification allowed)
    const searchUrl = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license_type=commercial,modification&page_size=${maxResults * 3}&format=json`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation; contact@fastvid.ai)' } }),
      8000,
      `Openverse search scene ${sceneIndex}`
    );
    if (!searchResp.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Openverse error ${searchResp.status}`);
      return [];
    }
    const payload = await searchResp.json() as { results?: Array<{ id: string; url: string; title?: string; license?: string; attribution?: string }> };
    const images = payload.results || [];
    if (images.length === 0) return [];

    for (let i = 0; i < Math.min(images.length, maxResults * 2) && results.length < maxResults; i++) {
      try {
        const imgUrl = images[i].url;
        if (!imgUrl || !/\.(jpg|jpeg|png|webp)/i.test(imgUrl)) continue;

        const tag = fileTag ? `${fileTag}_` : "";
        const imgPath = path.join(workDir, `scene_${sceneIndex}_${tag}openverse_${i}.jpg`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}openverse_${i}.mp4`);

        // Download image
        const imgResp = await withTimeout(
          fetch(imgUrl),
          10000,
          `Openverse image download scene ${sceneIndex}`
        );
        if (!imgResp.ok) continue;
        const imgBuf = Buffer.from(await imgResp.arrayBuffer());
        if (imgBuf.length < 5000) continue; // skip tiny/broken images
        fs.writeFileSync(imgPath, imgBuf);

        // Convert image to video clip with Ken Burns pan effect
        await withTimeout(
          new Promise<void>(async (resolve, reject) => {
            const { spawn } = await import('child_process');
            const args = [
              '-y', '-loop', '1', '-i', imgPath,
              '-vf', `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,zoompan=z='min(zoom+0.0008,1.04)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(duration * 25)}:s=1920x1080:fps=25,setsar=1`,
              '-t', String(duration),
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
              '-pix_fmt', 'yuv420p', '-an', outPath
            ];
            const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
            const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /**/ } reject(new Error('timeout')); }, 20000);
            child.on('close', (code: number | null) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`exit ${code}`)); });
            child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
          }),
          25000,
          `Openverse image to video scene ${sceneIndex}`
        );
        try { fs.unlinkSync(imgPath); } catch { /**/ }

        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
          results.push(outPath);
          console.log(`[Pipeline] Scene ${sceneIndex}: Openverse image added: ${images[i].title?.slice(0, 60) || imgUrl.slice(0, 60)}`);
        }
      } catch (err) {
        console.warn(`[Pipeline] Openverse image ${i} failed for scene ${sceneIndex}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] Openverse search failed for scene ${sceneIndex}:`, (err as Error).message);
  }
  return results;
}

// ─── 3c2b-yt. YouTube Data API Thumbnails ────────────────────────────────────
// Uses YouTube Data API v3 to search for relevant videos and downloads their
// high-quality thumbnails as image clips. This gives highly relevant visuals
// that match the scene topic without requiring video downloads.
async function fetchYouTubeThumbnails(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 3,
  fileTag = ""
): Promise<string[]> {
  const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
  if (!YOUTUBE_API_KEY) return [];
  fs.mkdirSync(workDir, { recursive: true });
  const results: string[] = [];
  try {
    // Search YouTube for relevant videos (Creative Commons preferred, but also standard)
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${count * 3}&key=${YOUTUBE_API_KEY}`;
    const searchResp = await withTimeout(
      fetch(searchUrl),
      10000,
      `YouTube search scene ${sceneIndex}`
    );
    if (!searchResp.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: YouTube API error ${searchResp.status}`);
      return [];
    }
    const payload = await searchResp.json() as { items?: Array<{ id: { videoId: string }; snippet: { title: string; thumbnails: { maxres?: { url: string }; high?: { url: string }; medium?: { url: string } } } }> };
    const items = payload.items || [];
    if (items.length === 0) return [];

    for (let i = 0; i < Math.min(items.length, count * 2) && results.length < count; i++) {
      try {
        const item = items[i];
        // Use highest quality thumbnail available
        const thumbUrl = item.snippet.thumbnails?.maxres?.url ||
                         item.snippet.thumbnails?.high?.url ||
                         item.snippet.thumbnails?.medium?.url;
        if (!thumbUrl) continue;

        const tag = fileTag ? `${fileTag}_` : "";
        const imgPath = path.join(workDir, `scene_${sceneIndex}_${tag}yt_${i}.jpg`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}yt_${i}.mp4`);

        // Download thumbnail
        const imgResp = await withTimeout(
          fetch(thumbUrl),
          10000,
          `YouTube thumbnail download scene ${sceneIndex}`
        );
        if (!imgResp.ok) continue;
        const imgBuf = Buffer.from(await imgResp.arrayBuffer());
        if (imgBuf.length < 5000) continue; // skip tiny/broken thumbnails
        fs.writeFileSync(imgPath, imgBuf);

        // Convert thumbnail to video clip with slow Ken Burns zoom effect
        await withTimeout(
          new Promise<void>(async (resolve, reject) => {
            const { spawn } = await import('child_process');
            const args = [
              '-y', '-loop', '1', '-i', imgPath,
              '-vf', `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,zoompan=z='min(zoom+0.0006,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(duration * 25)}:s=1920x1080:fps=25,setsar=1`,
              '-t', String(duration),
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
              '-pix_fmt', 'yuv420p', '-an', outPath
            ];
            const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
            const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /**/ } reject(new Error('timeout')); }, 25000);
            child.on('close', (code: number | null) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`exit ${code}`)); });
            child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
          }),
          30000,
          `YouTube thumbnail to video scene ${sceneIndex}`
        );
        try { fs.unlinkSync(imgPath); } catch { /**/ }

        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
          results.push(outPath);
          console.log(`[Pipeline] Scene ${sceneIndex}: YouTube thumbnail added: "${item.snippet.title?.slice(0, 60)}"`);
        }
      } catch (err) {
        console.warn(`[Pipeline] YouTube thumbnail ${i} failed for scene ${sceneIndex}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] YouTube search failed for scene ${sceneIndex}:`, (err as Error).message);
  }
  return results;
}

// ─── 3c2b. SerpAPI Google Images Search ────────────────────────────────────
// Searches Google Images via SerpAPI for celebrity/person-specific photos.
// Ideal for finding real photos of people mentioned in the narration.
async function fetchSerpAPIImages(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2,
  fileTag = ""
): Promise<string[]> {
  if (!SERPAPI_KEY) return [];
  // Ensure workDir exists — it may have been cleaned up between pipeline stages
  fs.mkdirSync(workDir, { recursive: true });
  const results: string[] = [];
  try {
    const searchUrl = new URL('https://serpapi.com/search.json');
    searchUrl.searchParams.set('engine', 'google_images');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('safe', 'active');
    searchUrl.searchParams.set('num', '10');
    searchUrl.searchParams.set('ijn', '0');
    searchUrl.searchParams.set('api_key', SERPAPI_KEY);

    const searchResp = await withTimeout(
      fetch(searchUrl.toString()),
      15_000,
      `SerpAPI search scene ${sceneIndex}`
    );
    if (!searchResp.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: SerpAPI error ${searchResp.status}`);
      return [];
    }
    const searchData = await searchResp.json() as {
      images_results?: Array<{
        original?: string;
        thumbnail?: string;
        title?: string;
      }>;
    };

    const images = (searchData.images_results || []).slice(0, count * 3);
    if (!images.length) return [];

    let downloaded = 0;
    for (let i = 0; i < images.length && downloaded < count; i++) {
      const imgUrl = images[i].original || images[i].thumbnail;
      if (!imgUrl) continue;
      // Skip SVG, GIF, and non-image URLs
      const lowerUrl = imgUrl.toLowerCase();
      if (lowerUrl.endsWith('.svg') || lowerUrl.endsWith('.gif') || lowerUrl.endsWith('.webp')) continue;
      if (!lowerUrl.includes('jpg') && !lowerUrl.includes('jpeg') && !lowerUrl.includes('png') &&
          !lowerUrl.match(/\.(jpg|jpeg|png)(\?|$)/i) && !lowerUrl.match(/image\/(jpeg|png)/i)) {
        // Allow if URL doesn't have a bad extension (many CDN URLs have no extension)
        if (lowerUrl.endsWith('.svg') || lowerUrl.endsWith('.gif')) continue;
      }

      try {
        const tag = fileTag ? `${fileTag}_` : "";
        const imgPath = path.join(workDir, `scene_${sceneIndex}_${tag}serp_${i}.jpg`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}serp_${i}.mp4`);

        const imgResp = await withTimeout(
          fetch(imgUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; Fastvid/1.0)',
              'Accept': 'image/jpeg,image/png,image/*',
            },
          }),
          12_000,
          `SerpAPI image download scene ${sceneIndex}`
        );
        if (!imgResp.ok) continue;
        // Validate content-type: must be an image, not HTML/text
        const contentType = imgResp.headers.get('content-type') || '';
        if (contentType.includes('text/') || contentType.includes('application/') || contentType.includes('html')) continue;
        const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
        // Skip tiny images (likely placeholders)
        if (imgBuffer.length < 15_000) continue;
        // Validate magic bytes: JPEG (FFD8FF) or PNG (89504E47)
        const magic = imgBuffer.slice(0, 4);
        const isJpeg = magic[0] === 0xFF && magic[1] === 0xD8 && magic[2] === 0xFF;
        const isPng = magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4E && magic[3] === 0x47;
        if (!isJpeg && !isPng) continue;
        fs.writeFileSync(imgPath, imgBuffer);

        await convertImageToVideoGentle(
          imgPath,
          outPath,
          duration,
          `SerpAPI image to video scene ${sceneIndex}`
        );
        try { fs.unlinkSync(imgPath); } catch { /* ignore */ }
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1_000) {
          results.push(outPath);
          downloaded++;
          console.log(`[Pipeline] Scene ${sceneIndex}: SerpAPI image added: ${images[i].title || imgUrl.slice(0, 60)}`);
        }
      } catch (err) {
        console.warn(`[Pipeline] SerpAPI image ${i} failed for scene ${sceneIndex}:`, err);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] SerpAPI search failed for scene ${sceneIndex}:`, err);
  }
  return results;
}

// ─── 3c. Color Fallback (LAST RESORT) ────────────────────────────────────────
async function generateColorFallback(sceneIndex: number, duration: number, workDir: string): Promise<string> {
  fs.mkdirSync(workDir, { recursive: true });
  const outputPath = path.join(workDir, `scene_${sceneIndex}_fallback.mp4`);
  const colors = ["0a0a1e", "0a0a1e", "0a1a2e", "1a0a2e", "0a2a1e", "1a1a0a", "2a0a1e", "0a1a1e"];
  const color = colors[sceneIndex % colors.length];
  const safeDuration = Math.min(Math.max(duration, 3), 90);

  if (fs.existsSync(outputPath)) {
    try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
  }

  const commands = [
    `${FFMPEG_BIN} -y -f lavfi -i "color=c=#${color}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:r=25" -t ${safeDuration} -c:v libx264 -preset ultrafast -pix_fmt yuv420p -an "${outputPath}"`,
    `${FFMPEG_BIN} -y -f lavfi -i "color=c=black:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:r=25" -t ${safeDuration} -c:v libx264 -preset ultrafast -pix_fmt yuv420p -an "${outputPath}"`,
    `${FFMPEG_BIN} -y -f lavfi -i "color=c=black:s=1280x720:r=25" -t ${safeDuration} -c:v mpeg4 -q:v 5 -an "${outputPath}"`,
  ];

  for (let i = 0; i < commands.length; i++) {
    try {
      if (fs.existsSync(outputPath)) {
        try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
      }
      await withTimeout(exec(commands[i]), 30_000, `Fallback video scene ${sceneIndex} attempt ${i + 1}`);
      if (await isValidVideoFile(outputPath)) {
        console.log(`[Pipeline] Scene ${sceneIndex}: fallback video OK (${(fs.statSync(outputPath).size / 1024).toFixed(0)}KB, attempt ${i + 1})`);
        return outputPath;
      }
      console.warn(`[Pipeline] Scene ${sceneIndex}: fallback attempt ${i + 1} produced unreadable file`);
    } catch (err) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: fallback attempt ${i + 1} failed:`, (err as Error).message);
    }
  }

  throw pipelineError(
    PIPELINE_ERROR.FFMPEG,
    `Could not create valid fallback video for scene ${sceneIndex}`
  );
}

/** Return clipPath if ffprobe confirms a video stream; otherwise throw or substitute fallback. */
async function requireValidClip(
  clipPath: string,
  sceneIndex: number,
  duration: number,
  workDir: string
): Promise<string> {
  if (await isValidVideoFile(clipPath)) return clipPath;
  console.warn(`[Pipeline] Scene ${sceneIndex}: invalid clip ${path.basename(clipPath)}, regenerating fallback`);
  return generateColorFallback(sceneIndex, duration, workDir);
}

// ─── 3c1. Generate Grok Video Clip ──────────────────────────────────────────
async function generateGrokVideoClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!REPLICATE_API_KEY) {
    return null; // Fallback to other sources
  }

  try {
    const result = await generateGrokVideo(prompt, Math.min(duration, 8));
    if (!result) return null;

    // Download the video from the URL and save to local file
    const grokOutputPath = outputPath.replace(/\.mp4$/, "_grok.mp4");
    const response = await fetch(result.url);
    if (!response.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Grok download failed (${response.status})`);
      return null;
    }

    const buffer = await response.buffer();
    fs.writeFileSync(grokOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Grok video saved (${buffer.length} bytes)`);
    return grokOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Grok generation error:`, err);
    return null;
  }
}

// ─── 3c2. Generate Veo Video Clip ───────────────────────────────────────────
async function generateVeoVideoClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!GOOGLE_GEMINI_API_KEY) {
    return null; // Fallback to other sources
  }

  try {
    const result = await generateVeoVideo(prompt, Math.min(duration, 8));
    if (!result) return null;

    // Download the video from the URL and save to local file
    const veoOutputPath = outputPath.replace(/\.mp4$/, "_veo.mp4");
    const response = await fetch(result.url);
    if (!response.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Veo download failed (${response.status})`);
      return null;
    }

    const buffer = await response.buffer();
    fs.writeFileSync(veoOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Veo video saved (${buffer.length} bytes)`);
    return veoOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Veo generation error:`, err);
    return null;
  }
}

// ─── 3c3. Generate Meta Movie Gen Clip ──────────────────────────────────────
async function generateMetaMovieGenClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!META_MOVIE_GEN_API_KEY) {
    return null; // Fallback to other sources
  }

  try {
    const result = await generateMetaMovieGen(prompt, Math.min(duration, 8));
    if (!result) return null;

    // Download the video from the URL and save to local file
    const metaOutputPath = outputPath.replace(/\.mp4$/, "_meta.mp4");
    const response = await fetch(result.url);
    if (!response.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Meta Movie Gen download failed (${response.status})`);
      return null;
    }

    const buffer = await response.buffer();
    fs.writeFileSync(metaOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Meta Movie Gen video saved (${buffer.length} bytes)`);
    return metaOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Meta Movie Gen generation error:`, err);
    return null;
  }
}

// ─── 3c4. Generate Higgsfield Text-to-Video Clip ───────────────────────────────
async function generateHiggsfieldTextToVideoClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!HIGGSFIELD_API_KEY || !HIGGSFIELD_API_SECRET) {
    return null; // Fallback to other sources
  }

  try {
    const result = await generateHiggsfieldTextToVideo(prompt, Math.min(duration, 8));
    if (!result) return null;

    // Download the video from the URL and save to local file
    const higgsfieldOutputPath = outputPath.replace(/\.mp4$/, "_higgsfield.mp4");
    const response = await fetch(result.url);
    if (!response.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Higgsfield text-to-video download failed (${response.status})`);
      return null;
    }

    const buffer = await response.buffer();
    fs.writeFileSync(higgsfieldOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Higgsfield text-to-video saved (${buffer.length} bytes)`);
    return higgsfieldOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Higgsfield text-to-video error:`, err);
    return null;
  }
}

// ─── 3c5. Generate Higgsfield Image-to-Video Clip ───────────────────────────────
async function generateHiggsfieldImageToVideoClip(
  imageUrl: string,
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!HIGGSFIELD_API_KEY || !HIGGSFIELD_API_SECRET) {
    return null; // Fallback to other sources
  }

  try {
    const result = await generateHiggsfieldImageToVideo(imageUrl, prompt, Math.min(duration, 8));
    if (!result) return null;

    // Download the video from the URL and save to local file
    const higgsfieldOutputPath = outputPath.replace(/\.mp4$/, "_higgsfield_img.mp4");
    const response = await fetch(result.url);
    if (!response.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Higgsfield image-to-video download failed (${response.status})`);
      return null;
    }

    const buffer = await response.buffer();
    fs.writeFileSync(higgsfieldOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Higgsfield image-to-video saved (${buffer.length} bytes)`);
    return higgsfieldOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Higgsfield image-to-video error:`, err);
    return null;
  }
}

// ─── 3c6. Leonardo AI Image → Video (HIGH QUALITY image gen, replaces Stability AI) ─────
async function generateLeonardoAIClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!LEONARDO_API_KEY) return null;
  try {
    console.log(`[Pipeline] Scene ${sceneIndex}: Generating Leonardo AI image...`);
    const t = Date.now();
    // Step 1: Create generation job
    const genResp = await withTimeout(
      fetch("https://cloud.leonardo.ai/api/rest/v1/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${LEONARDO_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt + ", cinematic, 4K, high quality, professional photography",
          negative_prompt: "blurry, low quality, watermark, text, logo, ugly, deformed",
          modelId: "b24e16ff-06e3-43eb-8d33-4416c2d75876", // Leonardo Kino XL (cinematic)
          width: 1344, height: 768, num_images: 1,
          guidance_scale: 7, num_inference_steps: 30,
          public: false, photoReal: false, alchemy: true,
        }),
      }),
      30_000, `Leonardo AI generate scene ${sceneIndex}`
    );
    if (!genResp.ok) {
      const errText = await genResp.text();
      console.warn(`[Pipeline] Scene ${sceneIndex}: Leonardo AI error ${genResp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const genData = await genResp.json() as { sdGenerationJob?: { generationId: string } };
    const generationId = genData.sdGenerationJob?.generationId;
    if (!generationId) return null;

    // Step 2: Poll for completion (max 60s)
    let imageUrl: string | null = null;
    for (let poll = 0; poll < 12; poll++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await withTimeout(
        fetch(`https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`, {
          headers: { Authorization: `Bearer ${LEONARDO_API_KEY}` },
        }),
        10_000, `Leonardo AI poll scene ${sceneIndex}`
      );
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json() as { generations_by_pk?: { status: string; generated_images?: Array<{ url: string }> } };
      const gen = pollData.generations_by_pk;
      if (gen?.status === "COMPLETE" && gen.generated_images?.[0]?.url) {
        imageUrl = gen.generated_images[0].url;
        break;
      }
      if (gen?.status === "FAILED") break;
    }
    if (!imageUrl) return null;

    // Step 3: Download image and convert to video
    const imgResp = await withTimeout(fetch(imageUrl), 20_000, `Leonardo AI download scene ${sceneIndex}`);
    if (!imgResp.ok) return null;
    const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
    const pngPath = outputPath.replace(".mp4", "_leonardo.jpg");
    fs.writeFileSync(pngPath, imgBuffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Leonardo AI image in ${((Date.now()-t)/1000).toFixed(1)}s (${(imgBuffer.length/1024).toFixed(0)}KB)`);

    // Convert to video with fast Ken Burns
    const fps = 25; const totalFrames = Math.ceil(duration * fps);
    const zoomEnd = 1.05; const zoomStart = 1.0;
    const zoomStep = (zoomEnd - zoomStart) / totalFrames;
    const leonardoOutputPath = outputPath.replace(".mp4", "_leonardo.mp4");
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -loop 1 -i "${pngPath}" ` +
        `-vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},` +
        `zoompan=z='min(zoom+${zoomStep.toFixed(6)},${zoomEnd})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${fps}" ` +
        `-t ${duration} -r ${fps} -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p "${leonardoOutputPath}"`
      ),
      90_000, `Leonardo AI image to video scene ${sceneIndex}`
    );
    try { fs.unlinkSync(pngPath); } catch { /* ignore */ }
    if (fs.existsSync(leonardoOutputPath) && fs.statSync(leonardoOutputPath).size > 1000) {
      return leonardoOutputPath;
    }
    return null;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Leonardo AI clip failed:`, err);
    return null;
  }
}

// ─── 3c7. Runway Gen-4 Image-to-Video ─────────────────────────────────────────
async function generateRunwayClip(
  prompt: string,
  imageUrl: string | null,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!RUNWAY_API_KEY) return null;
  try {
    console.log(`[Pipeline] Scene ${sceneIndex}: Generating Runway Gen-4 video...`);
    const t = Date.now();
    const durationSec = Math.min(duration, 10) as 5 | 10;
    const body: Record<string, unknown> = {
      model: "gen4_turbo",
      promptText: prompt,
      duration: durationSec <= 5 ? 5 : 10,
      ratio: "1280:768",
    };
    if (imageUrl) body.promptImage = imageUrl;

    const createResp = await withTimeout(
      fetch("https://api.dev.runwayml.com/v1/image_to_video", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RUNWAY_API_KEY}`,
          "Content-Type": "application/json",
          "X-Runway-Version": "2024-11-06",
        },
        body: JSON.stringify(body),
      }),
      30_000, `Runway create scene ${sceneIndex}`
    );
    if (!createResp.ok) {
      const errText = await createResp.text();
      console.warn(`[Pipeline] Scene ${sceneIndex}: Runway error ${createResp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const createData = await createResp.json() as { id: string };
    const taskId = createData.id;
    if (!taskId) return null;

    // Poll for completion (max 3 minutes)
    let videoUrl: string | null = null;
    for (let poll = 0; poll < 36; poll++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await withTimeout(
        fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${RUNWAY_API_KEY}`, "X-Runway-Version": "2024-11-06" },
        }),
        10_000, `Runway poll scene ${sceneIndex}`
      );
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json() as { status: string; output?: string[] };
      if (pollData.status === "SUCCEEDED" && pollData.output?.[0]) {
        videoUrl = pollData.output[0];
        break;
      }
      if (pollData.status === "FAILED") break;
    }
    if (!videoUrl) return null;

    // Download video
    const dlResp = await withTimeout(fetch(videoUrl), 60_000, `Runway download scene ${sceneIndex}`);
    if (!dlResp.ok) return null;
    const buffer = Buffer.from(await dlResp.arrayBuffer());
    const runwayOutputPath = outputPath.replace(".mp4", "_runway.mp4");
    fs.writeFileSync(runwayOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Runway video in ${((Date.now()-t)/1000).toFixed(1)}s (${(buffer.length/1024/1024).toFixed(1)}MB)`);
    return runwayOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Runway clip failed:`, err);
    return null;
  }
}

// ─── 3c8. Kling AI Image-to-Video ─────────────────────────────────────────────
async function generateKlingClip(
  prompt: string,
  imageUrl: string | null,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!KLING_API_KEY || !KLING_API_SECRET) return null;
  try {
    console.log(`[Pipeline] Scene ${sceneIndex}: Generating Kling AI video...`);
    const t = Date.now();

    // Generate JWT token for Kling
    const { createHmac } = await import('crypto');
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: KLING_API_KEY, exp: Math.floor(Date.now()/1000) + 1800, nbf: Math.floor(Date.now()/1000) - 5 })).toString('base64url');
    const sig = createHmac('sha256', KLING_API_SECRET).update(`${header}.${payload}`).digest('base64url');
    const klingJWT = `${header}.${payload}.${sig}`;

    const body: Record<string, unknown> = {
      model_name: "kling-v1-5",
      prompt: prompt,
      duration: Math.min(duration, 10) <= 5 ? "5" : "10",
      mode: "std",
      cfg_scale: 0.5,
    };
    if (imageUrl) body.image_url = imageUrl;

    const endpoint = imageUrl
      ? "https://api.klingai.com/v1/videos/image2video"
      : "https://api.klingai.com/v1/videos/text2video";

    const createResp = await withTimeout(
      fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${klingJWT}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      30_000, `Kling create scene ${sceneIndex}`
    );
    if (!createResp.ok) {
      const errText = await createResp.text();
      console.warn(`[Pipeline] Scene ${sceneIndex}: Kling error ${createResp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const createData = await createResp.json() as { data?: { task_id: string } };
    const taskId = createData.data?.task_id;
    if (!taskId) return null;

    // Poll for completion (max 3 minutes)
    let videoUrl: string | null = null;
    const pollEndpoint = imageUrl
      ? `https://api.klingai.com/v1/videos/image2video/${taskId}`
      : `https://api.klingai.com/v1/videos/text2video/${taskId}`;
    for (let poll = 0; poll < 36; poll++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await withTimeout(
        fetch(pollEndpoint, { headers: { Authorization: `Bearer ${klingJWT}` } }),
        10_000, `Kling poll scene ${sceneIndex}`
      );
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json() as { data?: { task_status: string; task_result?: { videos?: Array<{ url: string }> } } };
      if (pollData.data?.task_status === "succeed" && pollData.data.task_result?.videos?.[0]?.url) {
        videoUrl = pollData.data.task_result.videos[0].url;
        break;
      }
      if (pollData.data?.task_status === "failed") break;
    }
    if (!videoUrl) return null;

    const dlResp = await withTimeout(fetch(videoUrl), 60_000, `Kling download scene ${sceneIndex}`);
    if (!dlResp.ok) return null;
    const buffer = Buffer.from(await dlResp.arrayBuffer());
    const klingOutputPath = outputPath.replace(".mp4", "_kling.mp4");
    fs.writeFileSync(klingOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Kling video in ${((Date.now()-t)/1000).toFixed(1)}s (${(buffer.length/1024/1024).toFixed(1)}MB)`);
    return klingOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Kling clip failed:`, err);
    return null;
  }
}

// ─── 3c9. Luma Dream Machine Image-to-Video ────────────────────────────────────
async function generateLumaClip(
  prompt: string,
  imageUrl: string | null,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!LUMA_API_KEY) return null;
  try {
    console.log(`[Pipeline] Scene ${sceneIndex}: Generating Luma Dream Machine video...`);
    const t = Date.now();
    const body: Record<string, unknown> = {
      prompt: prompt,
      model: "ray-2",
      resolution: "720p",
      duration: "5s",
      loop: false,
    };
    if (imageUrl) body.keyframes = { frame0: { type: "image", url: imageUrl } };

    const createResp = await withTimeout(
      fetch("https://api.lumalabs.ai/dream-machine/v1/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${LUMA_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      30_000, `Luma create scene ${sceneIndex}`
    );
    if (!createResp.ok) {
      const errText = await createResp.text();
      console.warn(`[Pipeline] Scene ${sceneIndex}: Luma error ${createResp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const createData = await createResp.json() as { id: string };
    const genId = createData.id;
    if (!genId) return null;

    // Poll for completion (max 3 minutes)
    let videoUrl: string | null = null;
    for (let poll = 0; poll < 36; poll++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await withTimeout(
        fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${genId}`, {
          headers: { Authorization: `Bearer ${LUMA_API_KEY}` },
        }),
        10_000, `Luma poll scene ${sceneIndex}`
      );
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json() as { state: string; assets?: { video?: string } };
      if (pollData.state === "completed" && pollData.assets?.video) {
        videoUrl = pollData.assets.video;
        break;
      }
      if (pollData.state === "failed") break;
    }
    if (!videoUrl) return null;

    const dlResp = await withTimeout(fetch(videoUrl), 60_000, `Luma download scene ${sceneIndex}`);
    if (!dlResp.ok) return null;
    const buffer = Buffer.from(await dlResp.arrayBuffer());
    const lumaOutputPath = outputPath.replace(".mp4", "_luma.mp4");
    fs.writeFileSync(lumaOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Luma video in ${((Date.now()-t)/1000).toFixed(1)}s (${(buffer.length/1024/1024).toFixed(1)}MB)`);
    return lumaOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Luma clip failed:`, err);
    return null;
  }
}

// ─── 3c10. Pika Labs Image-to-Video ────────────────────────────────────────────
async function generatePikaClip(
  prompt: string,
  imageUrl: string | null,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!PIKA_API_KEY) return null;
  try {
    console.log(`[Pipeline] Scene ${sceneIndex}: Generating Pika Labs video...`);
    const t = Date.now();
    const body: Record<string, unknown> = {
      promptText: prompt,
      model: "pike-2.2",
      options: { frameRate: 24, resolution: "1080p", duration: Math.min(duration, 5) },
    };
    if (imageUrl) body.image = imageUrl;

    const createResp = await withTimeout(
      fetch("https://api.pika.art/v2/generate", {
        method: "POST",
        headers: { Authorization: `Bearer ${PIKA_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      30_000, `Pika create scene ${sceneIndex}`
    );
    if (!createResp.ok) {
      const errText = await createResp.text();
      console.warn(`[Pipeline] Scene ${sceneIndex}: Pika error ${createResp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const createData = await createResp.json() as { id?: string; requestId?: string };
    const taskId = createData.id || createData.requestId;
    if (!taskId) return null;

    // Poll for completion (max 3 minutes)
    let videoUrl: string | null = null;
    for (let poll = 0; poll < 36; poll++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await withTimeout(
        fetch(`https://api.pika.art/v2/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${PIKA_API_KEY}` },
        }),
        10_000, `Pika poll scene ${sceneIndex}`
      );
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json() as { status?: string; videos?: Array<{ url: string }>; resultUrl?: string };
      if ((pollData.status === "finished" || pollData.status === "succeeded") && (pollData.videos?.[0]?.url || pollData.resultUrl)) {
        videoUrl = pollData.videos?.[0]?.url || pollData.resultUrl || null;
        break;
      }
      if (pollData.status === "failed") break;
    }
    if (!videoUrl) return null;

    const dlResp = await withTimeout(fetch(videoUrl), 60_000, `Pika download scene ${sceneIndex}`);
    if (!dlResp.ok) return null;
    const buffer = Buffer.from(await dlResp.arrayBuffer());
    const pikaOutputPath = outputPath.replace(".mp4", "_pika.mp4");
    fs.writeFileSync(pikaOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Pika video in ${((Date.now()-t)/1000).toFixed(1)}s (${(buffer.length/1024/1024).toFixed(1)}MB)`);
    return pikaOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Pika clip failed:`, err);
    return null;
  }
}

// ─── 3c11. Manus Forge Built-in Video Generation ──────────────────────────────
async function generateManusForgeClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL || "";
  const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY || "";
  if (!FORGE_API_URL || !FORGE_API_KEY) return null;
  try {
    console.log(`[Pipeline] Scene ${sceneIndex}: Generating Manus Forge video...`);
    const t = Date.now();
    const forgeBase = FORGE_API_URL.replace(/\/+$/, "");

    // Try Manus Forge video generation endpoint
    const createResp = await withTimeout(
      fetch(`${forgeBase}/v1/video/generate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${FORGE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt,
          duration: Math.min(duration, 8),
          resolution: "1280x720",
          fps: 24,
        }),
      }),
      30_000, `Manus Forge create scene ${sceneIndex}`
    );
    if (!createResp.ok) {
      const errText = await createResp.text();
      console.warn(`[Pipeline] Scene ${sceneIndex}: Manus Forge error ${createResp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const createData = await createResp.json() as { task_id?: string; id?: string; url?: string };

    // If direct URL returned, download immediately
    if (createData.url) {
      const dlResp = await withTimeout(fetch(createData.url), 60_000, `Manus Forge download scene ${sceneIndex}`);
      if (!dlResp.ok) return null;
      const buffer = Buffer.from(await dlResp.arrayBuffer());
      const forgeOutputPath = outputPath.replace(".mp4", "_forge.mp4");
      fs.writeFileSync(forgeOutputPath, buffer);
      console.log(`[Pipeline] Scene ${sceneIndex}: Manus Forge video in ${((Date.now()-t)/1000).toFixed(1)}s`);
      return forgeOutputPath;
    }

    // Otherwise poll for task completion
    const taskId = createData.task_id || createData.id;
    if (!taskId) return null;
    let videoUrl: string | null = null;
    for (let poll = 0; poll < 36; poll++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await withTimeout(
        fetch(`${forgeBase}/v1/video/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${FORGE_API_KEY}` },
        }),
        10_000, `Manus Forge poll scene ${sceneIndex}`
      );
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json() as { status?: string; url?: string; output_url?: string };
      if ((pollData.status === "completed" || pollData.status === "succeeded") && (pollData.url || pollData.output_url)) {
        videoUrl = pollData.url || pollData.output_url || null;
        break;
      }
      if (pollData.status === "failed") break;
    }
    if (!videoUrl) return null;

    const dlResp = await withTimeout(fetch(videoUrl), 60_000, `Manus Forge download scene ${sceneIndex}`);
    if (!dlResp.ok) return null;
    const buffer = Buffer.from(await dlResp.arrayBuffer());
    const forgeOutputPath = outputPath.replace(".mp4", "_forge.mp4");
    fs.writeFileSync(forgeOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Manus Forge video in ${((Date.now()-t)/1000).toFixed(1)}s (${(buffer.length/1024/1024).toFixed(1)}MB)`);
    return forgeOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Manus Forge clip failed:`, err);
    return null;
  }
}

/** Trim a downloaded file to a short scene clip (shared by Archive, NASA, Wikimedia video). */
async function trimRemoteVideoToClip(
  sourcePath: string,
  outputPath: string,
  duration: number,
  clipStart = 5,
  label = "clip"
): Promise<boolean> {
  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -ss ${clipStart} -i "${sourcePath}" -t ${duration} ` +
        `-vf "${STANDARD_VF}" ` +
        `-c:v libx264 -preset veryfast -crf 22 -an -pix_fmt yuv420p "${outputPath}"`
      ),
      90_000,
      `Trim ${label}`
    );
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10_000;
  } catch (err) {
    console.warn(`[Pipeline] trimRemoteVideoToClip failed (${label}):`, (err as Error).message);
    return false;
  }
}

// ─── 3c2v. Wikimedia Commons Video Search ───────────────────────────────────
async function fetchWikimediaVideos(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2,
  fileTag = ""
): Promise<string[]> {
  if (!query?.trim()) return [];
  const results: string[] = [];
  const UA = { "User-Agent": "Fastvid/1.0 (video generation; CC-licensed clips only)" };
  try {
    const searchUrl =
      `https://commons.wikimedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(`${query} filetype:video`)}&srnamespace=6&srlimit=12&format=json&origin=*`;
    const searchResp = await withTimeout(fetch(searchUrl, { headers: UA }), 10_000, `Wikimedia video search scene ${sceneIndex}`);
    if (!searchResp.ok) return [];
    const searchData = await searchResp.json() as { query?: { search?: Array<{ title: string }> } };
    const titles = searchData.query?.search?.map((r) => r.title).slice(0, count * 3) || [];
    if (!titles.length) return [];

    let downloaded = 0;
    for (let i = 0; i < titles.length && downloaded < count; i++) {
      try {
        const title = titles[i];
        const infoUrl =
          `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}` +
          `&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*`;
        const infoResp = await withTimeout(fetch(infoUrl, { headers: UA }), 10_000, `Wikimedia video info scene ${sceneIndex}`);
        if (!infoResp.ok) continue;
        const infoData = await infoResp.json() as {
          query?: { pages?: Record<string, { imageinfo?: Array<{ url: string; size?: number; mime?: string }> }> };
        };
        const page = Object.values(infoData.query?.pages || {})[0];
        const imageInfo = page?.imageinfo?.[0];
        if (!imageInfo?.url || !imageInfo.mime?.startsWith("video/")) continue;
        if ((imageInfo.size ?? 0) > 80 * 1024 * 1024) continue;

        const tag = fileTag ? `${fileTag}_` : "";
        const tmpPath = path.join(workDir, `scene_${sceneIndex}_${tag}wikivid_${i}_tmp`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}wikivid_${i}.mp4`);
        const dlResp = await fetchWithTimeout(imageInfo.url, 45_000, `Wikimedia video download scene ${sceneIndex}`, { headers: UA });
        if (!dlResp.ok) continue;
        const buf = await dlResp.arrayBuffer();
        if (buf.byteLength < 50_000 || buf.byteLength > 80 * 1024 * 1024) continue;
        fs.writeFileSync(tmpPath, Buffer.from(buf));

        if (await trimRemoteVideoToClip(tmpPath, outPath, duration, 3, `Wikimedia video scene ${sceneIndex}`)) {
          results.push(outPath);
          downloaded++;
          console.log(`[Pipeline] Scene ${sceneIndex}: Wikimedia video added: ${title}`);
        }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      } catch (err) {
        console.warn(`[Pipeline] Wikimedia video ${i} failed for scene ${sceneIndex}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] Wikimedia video search failed for scene ${sceneIndex}:`, (err as Error).message);
  }
  return results;
}

// ─── 3c2n. NASA Images & Video Library (public domain US gov footage) ─────────
async function fetchNasaVideoClips(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2
): Promise<string[]> {
  if (!query?.trim()) return [];
  const results: string[] = [];
  try {
    const searchUrl = `https://images-api.nasa.gov/search?q=${encodeURIComponent(query)}&media_type=video`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { "User-Agent": "Fastvid/1.0 (NASA public domain footage)" } }),
      12_000,
      `NASA video search scene ${sceneIndex}`
    );
    if (!searchResp.ok) return [];
    const data = await searchResp.json() as {
      collection?: { items?: Array<{ data?: Array<{ nasa_id?: string; title?: string }> }> };
    };
    const items = data.collection?.items ?? [];
    let fetched = 0;
    for (const item of items) {
      if (fetched >= count) break;
      const nasaId = item.data?.[0]?.nasa_id;
      const title = item.data?.[0]?.title ?? nasaId;
      if (!nasaId) continue;
      try {
        const assetResp = await withTimeout(
          fetch(`https://images-api.nasa.gov/asset/${nasaId}`, { headers: { "User-Agent": "Fastvid/1.0" } }),
          12_000,
          `NASA asset ${nasaId}`
        );
        if (!assetResp.ok) continue;
        const assets = await assetResp.json() as string[];
        const mp4Path = assets.find((u) => /\.mp4$/i.test(u) && !/~mobile|~thumb|~preview|~small/i.test(u))
          ?? assets.find((u) => /\.mp4$/i.test(u));
        if (!mp4Path) continue;
        const mp4Url = mp4Path.startsWith("http")
          ? mp4Path
          : `https://images-assets.nasa.gov${mp4Path.startsWith("/") ? mp4Path : `/${mp4Path}`}`;

        const tmpPath = path.join(workDir, `scene_${sceneIndex}_nasa_${fetched}_tmp.mp4`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_nasa_${fetched}.mp4`);
        const dlResp = await fetchWithTimeout(mp4Url, 60_000, `NASA download scene ${sceneIndex}`, {
          headers: { "User-Agent": "Fastvid/1.0" },
        });
        if (!dlResp.ok) continue;
        const buf = await dlResp.arrayBuffer();
        if (buf.byteLength < 50_000 || buf.byteLength > 80 * 1024 * 1024) continue;
        fs.writeFileSync(tmpPath, Buffer.from(buf));

        if (await trimRemoteVideoToClip(tmpPath, outPath, duration, 8, `NASA scene ${sceneIndex}`)) {
          results.push(outPath);
          fetched++;
          console.log(`[Pipeline] Scene ${sceneIndex}: NASA video added: ${title}`);
        }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      } catch (err) {
        console.warn(`[Pipeline] NASA video ${nasaId} failed for scene ${sceneIndex}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] NASA video search failed for scene ${sceneIndex}:`, (err as Error).message);
  }
  return results;
}

function buildEventVideoQueries(scene: Scene, primarySubject: string, hasPerson: boolean): string[] {
  const q = [
    scene.visualCue,
    scene.pexelsQuery,
    ...(scene.pexelsQueries ?? []),
    ...(scene.brollQueries ?? []),
    hasPerson && primarySubject ? `${primarySubject} speech` : "",
    hasPerson && primarySubject ? `${primarySubject} interview` : "",
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 2);
  return Array.from(new Set(q));
}

function isSpaceRelatedTopic(...parts: string[]): boolean {
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  return /space|rocket|nasa|esa|spacex|mars|moon|satellite|launch|orbit|astronaut|shuttle|station|tesla|electric vehicle|factory/i.test(text);
}

// ─── 3c2. Fetch Internet Archive Video Clips ────────────────────────────────
async function fetchInternetArchiveClips(
  queries: string | string[],
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2,
  fileTag = ""
): Promise<string[]> {
  const results: string[] = [];
  const queryList = Array.isArray(queries) ? queries : [queries];
  const uniqueQueries = Array.from(new Set(queryList.filter((q) => q && q.trim().length > 0)));
  let fetched = 0;

  for (const query of uniqueQueries) {
    if (fetched >= count) break;
    try {
    const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:movies&fl[]=identifier,title&rows=10&output=json`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }),
      10_000,
      `Internet Archive search scene ${sceneIndex}`
    );
    if (!searchResp.ok) continue;
    const searchData = await searchResp.json() as { response?: { docs?: Array<{ identifier: string; title: string }> } };
    const docs = searchData.response?.docs?.slice(0, (count - fetched) * 3) || [];
    if (!docs.length) continue;

    for (const doc of docs) {
      if (fetched >= count) break;
      try {
        const metaUrl = `https://archive.org/metadata/${doc.identifier}/files`;
        const metaResp = await withTimeout(
          fetch(metaUrl, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }),
          8_000,
          `Internet Archive metadata scene ${sceneIndex}`
        );
        if (!metaResp.ok) continue;
        const metaData = await metaResp.json() as { result?: Array<{ name: string; format: string; size?: string }> };
        const videoFiles = (metaData.result || []).filter(f =>
          ['h.264', 'MPEG4', 'MP4', 'Ogg Video', 'WebM'].includes(f.format)
        );
        if (!videoFiles.length) continue;

        const videoFile = videoFiles.sort((a, b) =>
          parseInt(a.size || '999999999') - parseInt(b.size || '999999999')
        )[0];

        const videoUrl = `https://archive.org/download/${doc.identifier}/${encodeURIComponent(videoFile.name)}`;
        const tag = fileTag ? `${fileTag}_` : "";
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}archive_${fetched}.mp4`);
        const tmpPath = path.join(workDir, `scene_${sceneIndex}_${tag}archive_${fetched}_tmp`);

        const dlResp = await fetchWithTimeout(
          videoUrl,
          45_000,
          `Internet Archive download scene ${sceneIndex}`,
          { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }
        );
        if (!dlResp.ok) continue;

        const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024;
        const arrayBuf = await dlResp.arrayBuffer();
        if (arrayBuf.byteLength > MAX_ARCHIVE_SIZE) {
          console.warn(`[Pipeline] Scene ${sceneIndex}: Archive clip too large (${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)}MB), skipping`);
          continue;
        }
        fs.writeFileSync(tmpPath, Buffer.from(arrayBuf));

        if (await trimRemoteVideoToClip(tmpPath, outPath, duration, 10, `Internet Archive scene ${sceneIndex}`)) {
          results.push(outPath);
          fetched++;
          console.log(`[Pipeline] Scene ${sceneIndex}: Internet Archive clip added: ${doc.title}`);
        }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      } catch (err) {
        console.warn(`[Pipeline] Scene ${sceneIndex}: Archive item ${doc.identifier} failed:`, (err as Error).message);
      }
    }
    } catch (err) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Internet Archive search failed for "${query}":`, (err as Error).message);
    }
  }
  return results;
}

// ─── 3c3a. Download a YouTube CC clip (RapidAPI first, cloud service fallback) ─
async function downloadYouTubeCCClip(
  videoId: string,
  duration: number,
  clipStart: number,
  outPath: string,
  sceneIndex: number,
  title?: string
): Promise<boolean> {
  const cloudDlService = process.env.YOUTUBE_CC_DL_SERVICE?.replace(/\/$/, "") || "";

  if (RAPIDAPI_KEY) {
    const tmpPath = outPath.replace(/\.mp4$/, "_rapid_tmp.mp4");
    try {
      const metaUrl = `https://${RAPIDAPI_YT_HOST}/dl?id=${videoId}`;
      const metaResp = await withTimeout(
        fetch(metaUrl, {
          headers: {
            "x-rapidapi-host": RAPIDAPI_YT_HOST,
            "x-rapidapi-key": RAPIDAPI_KEY,
          },
        }),
        20_000,
        `RapidAPI YouTube meta scene ${sceneIndex}`
      );
      if (metaResp.ok) {
        const data = await metaResp.json() as {
          formats?: Array<{ url?: string; mimeType?: string; contentLength?: string; height?: number }>;
          adaptiveFormats?: Array<{ url?: string; mimeType?: string; contentLength?: string; height?: number }>;
        };
        const pickFormat = (
          formats: Array<{ url?: string; mimeType?: string; contentLength?: string; height?: number }> | undefined
        ) => {
          const mp4 = (formats ?? []).filter((f) => f.url && f.mimeType?.includes("mp4"));
          if (!mp4.length) return undefined;
          return mp4.sort((a, b) => {
            const heightA = a.height ?? 720;
            const heightB = b.height ?? 720;
            const distA = Math.abs(heightA - 720);
            const distB = Math.abs(heightB - 720);
            if (distA !== distB) return distA - distB;
            return parseInt(a.contentLength || "999999999", 10) - parseInt(b.contentLength || "999999999", 10);
          })[0];
        };

        const format = pickFormat(data.formats) ?? pickFormat(data.adaptiveFormats);
        if (format?.url) {
          const dlResp = await fetchWithTimeout(
            format.url,
            90_000,
            `RapidAPI YouTube download scene ${sceneIndex}`,
            {
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: "https://www.youtube.com/",
              },
            }
          );
          if (dlResp.ok) {
            const buf = await dlResp.arrayBuffer();
            if (buf.byteLength >= 50_000 && buf.byteLength <= 80 * 1024 * 1024) {
              fs.writeFileSync(tmpPath, Buffer.from(buf));
              if (
                await trimRemoteVideoToClip(
                  tmpPath,
                  outPath,
                  duration,
                  clipStart,
                  `YouTube CC RapidAPI scene ${sceneIndex}`
                )
              ) {
                console.log(
                  `[Pipeline] Scene ${sceneIndex}: ✅ YouTube CC via RapidAPI: "${title?.slice(0, 60) ?? videoId}" (${videoId})`
                );
                return true;
              }
            }
          }
        }
      } else {
        console.warn(
          `[Pipeline] Scene ${sceneIndex}: RapidAPI error ${metaResp.status} for ${videoId}`
        );
      }
    } catch (err) {
      console.warn(
        `[Pipeline] Scene ${sceneIndex}: RapidAPI download failed for ${videoId}:`,
        (err as Error).message
      );
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }

  if (cloudDlService) {
    try {
      const dlUrl = `${cloudDlService}/download?id=${videoId}&duration=${duration}&start=${clipStart}`;
      const dlResp = await fetchWithTimeout(
        dlUrl,
        90_000,
        `YouTube CC cloud download scene ${sceneIndex}`
      );
      if (!dlResp.ok) {
        const errText = await dlResp.text().catch(() => "");
        console.warn(
          `[Pipeline] Scene ${sceneIndex}: Cloud DL service error ${dlResp.status} for ${videoId}: ${errText.slice(0, 100)}`
        );
        return false;
      }
      const arrayBuf = await dlResp.arrayBuffer();
      if (arrayBuf.byteLength > 80 * 1024 * 1024) {
        console.warn(
          `[Pipeline] Scene ${sceneIndex}: YouTube CC clip too large (${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)}MB), skipping`
        );
        return false;
      }
      fs.writeFileSync(outPath, Buffer.from(arrayBuf));
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
        console.log(
          `[Pipeline] Scene ${sceneIndex}: ✅ YouTube CC via cloud service: "${title?.slice(0, 60) ?? videoId}" (${videoId})`
        );
        return true;
      }
    } catch (err) {
      console.warn(
        `[Pipeline] Scene ${sceneIndex}: Cloud DL failed for ${videoId}:`,
        (err as Error).message
      );
    }
  }

  return false;
}

// ─── 3c3. Fetch YouTube CC Video Clips ───────────────────────────────────────
// Uses YouTube Data API v3 to search for Creative Commons videos, then downloads
// via RapidAPI (RAPIDAPI_KEY) or the legacy cloud download service URL.
// Accepts multiple query variants (specific→broad) and tries each until enough clips found.
async function fetchYouTubeCCClips(
  queries: string | string[],
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2,
  relevanceKeywords: string[] = [],
  minRelevanceScore = 2
): Promise<string[]> {
  const results: string[] = [];

  const youtubeApiKey = process.env.YOUTUBE_API_KEY;
  const hasDownloader = !!RAPIDAPI_KEY || !!process.env.YOUTUBE_CC_DL_SERVICE;

  if (!youtubeApiKey) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: YouTube CC skipped — missing YOUTUBE_API_KEY`);
    return [];
  }
  if (!hasDownloader) {
    console.warn(
      `[Pipeline] Scene ${sceneIndex}: YouTube CC skipped — set RAPIDAPI_KEY or YOUTUBE_CC_DL_SERVICE in Railway`
    );
    return [];
  }

  // Normalise: accept single string or array of query variants (specific→broad)
  const queryList = Array.isArray(queries) ? queries : [queries];
  // Deduplicate and filter empty strings
  const uniqueQueries = Array.from(new Set(queryList.filter(q => q && q.trim().length > 0)));

  // Track video IDs already downloaded to avoid duplicates across query variants
  const downloadedIds = new Set<string>();
  let fetched = 0;

  for (const query of uniqueQueries) {
    if (fetched >= count) break;

    try {
      // Step 1: Search YouTube Data API v3 for Creative Commons videos
      const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
      searchUrl.searchParams.set('key', youtubeApiKey);
      searchUrl.searchParams.set('q', query);
      searchUrl.searchParams.set('type', 'video');
      searchUrl.searchParams.set('videoLicense', 'creativeCommon'); // CC only
      searchUrl.searchParams.set('maxResults', String(Math.max(5, (count - fetched) * 4)));
      searchUrl.searchParams.set('part', 'snippet');
      searchUrl.searchParams.set('videoDuration', 'medium'); // 4-20 min videos
      searchUrl.searchParams.set('order', 'relevance');
      searchUrl.searchParams.set('videoEmbeddable', 'true');

      const searchResp = await withTimeout(
        fetch(searchUrl.toString()),
        15_000,
        `YouTube CC search scene ${sceneIndex}`
      );
      if (!searchResp.ok) {
        console.warn(`[Pipeline] Scene ${sceneIndex}: YouTube API error ${searchResp.status} for query: "${query}"`);
        continue;
      }
      const searchData = await searchResp.json() as { items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string } }> };
      const items = searchData.items || [];
      if (!items.length) {
        console.warn(`[Pipeline] Scene ${sceneIndex}: YouTube CC 0 results for: "${query}" — trying next variant`);
        continue;
      }
      console.log(`[Pipeline] Scene ${sceneIndex}: YouTube CC found ${items.length} videos for "${query}"`);

      for (const item of items) {
        if (fetched >= count) break;
        const videoId = item.id?.videoId;
        if (!videoId || downloadedIds.has(videoId)) continue;

        const title = item.snippet?.title ?? "";
        if (relevanceKeywords.length > 0) {
          const rel = scoreVisualRelevance(title, relevanceKeywords);
          if (rel < minRelevanceScore) {
            console.warn(
              `[Pipeline] Scene ${sceneIndex}: YT CC skip irrelevant title "${title.slice(0, 60)}" (score ${rel}/${minRelevanceScore})`
            );
            continue;
          }
        }

        try {
          const clipStart = 15; // Skip first 15s to avoid intros
          const outPath = path.join(workDir, `scene_${sceneIndex}_ytcc_${fetched}.mp4`);

          const ok = await downloadYouTubeCCClip(
            videoId,
            duration,
            clipStart,
            outPath,
            sceneIndex,
            item.snippet?.title
          );
          if (ok) {
            results.push(outPath);
            downloadedIds.add(videoId);
            fetched++;
          }
        } catch (err) {
          console.warn(`[Pipeline] Scene ${sceneIndex}: YouTube CC video ${videoId} failed:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: YouTube CC search failed for "${query}":`, (err as Error).message);
    }
  }
  return results;
}

// ─── 3d. Transform Clip for Fair Use ───────────────────────────────────────
// Applies mandatory visual transformations to any stock/archive/YouTube clip:
//   1. Cinematic color grading (contrast + saturation + color curves)
//   2. Scene narration text as subtitle overlay (bottom of frame)
//   3. Vignette effect (darkened edges for cinematic look)
//   4. Slight zoom-in crop (changes framing/composition)
// This makes every clip a transformative derivative work.
async function transformClipForFairUse(
  inputPath: string,
  sceneText: string,
  sceneIndex: number,
  clipIndex: number,
  workDir: string
): Promise<string> {
  const outputPath = inputPath.replace(/\.mp4$/, '_transformed.mp4');

  // Use different color grade per scene for visual variety
  const grades = [
    { contrast: 1.08, saturation: 1.12, brightness: -0.02 }, // cinematic warm
    { contrast: 1.10, saturation: 0.95, brightness: -0.03 }, // desaturated cool
    { contrast: 1.05, saturation: 1.20, brightness: 0.00  }, // vivid
    { contrast: 1.12, saturation: 0.90, brightness: -0.04 }, // moody dark
    { contrast: 1.06, saturation: 1.08, brightness: 0.01  }, // natural warm
  ];
  const grade = grades[(sceneIndex + clipIndex) % grades.length];
  const vignetteAngle = (0.5 + ((sceneIndex * 3 + clipIndex) % 5) * 0.1).toFixed(2);
  const filterChain =
    `eq=contrast=${grade.contrast}:saturation=${grade.saturation}:brightness=${grade.brightness},` +
    `vignette=angle=${vignetteAngle}:mode=forward`;

  // Use spawn() with explicit SIGKILL on timeout to prevent Node.js event loop deadlock.
  // Promise.race() with exec() does NOT kill the child process, causing silent hangs.
  const TRANSFORM_TIMEOUT_MS = 120_000; // 2 min — large Pexels clips can be 100MB+
  console.log(`[Pipeline] Scene ${sceneIndex}: starting fair-use transform clip ${clipIndex} (${path.basename(inputPath)})`);
  try {
    // Import spawn at the top of the async function scope (ES module — require() is not available)
    const { spawn: spawnChild } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-y', '-i', inputPath,
        '-vf', filterChain,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', '-pix_fmt', 'yuv420p',
        outputPath
      ];
      const child = spawnChild(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString().slice(-500); }); // keep last 500 chars
      const timer = setTimeout(() => {
        console.warn(`[Pipeline] Scene ${sceneIndex}: transform clip ${clipIndex} TIMEOUT after ${TRANSFORM_TIMEOUT_MS/1000}s — killing FFmpeg`);
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        reject(
          pipelineError(
            PIPELINE_ERROR.TIMEOUT,
            `Transform timeout scene ${sceneIndex} clip ${clipIndex}`
          )
        );
      }, TRANSFORM_TIMEOUT_MS);
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(pipelineError(PIPELINE_ERROR.FFMPEG, `FFmpeg exit ${code}: ${stderr.slice(-200)}`));
      });
      child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
    });
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5_000) {
      if (await isValidVideoFile(outputPath)) {
        try { fs.unlinkSync(inputPath); } catch { /* ignore */ }
        console.log(`[Pipeline] Scene ${sceneIndex}: clip ${clipIndex} transformed for fair use`);
        return outputPath;
      }
      console.warn(`[Pipeline] Scene ${sceneIndex}: transformed clip ${clipIndex} unreadable, keeping original`);
    }
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: fair-use transform failed for clip ${clipIndex}:`, (err as Error).message);
  }
  // If transform failed or timed out, return original
  return inputPath;
}

/** Extract a person name from video titles like "Rumors about Elon Musk: A Deep Dive". */
function extractPrimaryPersonFromTitle(title?: string): string {
  if (!title?.trim()) return "";
  const cleaned = title.replace(/[^\w\s:'-]/g, " ").replace(/\s+/g, " ").trim();
  const aboutMatch = cleaned.match(/\babout\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+){0,2})/i);
  if (aboutMatch?.[1]) return aboutMatch[1].trim();
  const nameMatches = cleaned.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g) ?? [];
  const skip = new Set(["deep dive", "the story", "a deep", "full story"]);
  for (const candidate of nameMatches) {
    if (!skip.has(candidate.toLowerCase())) return candidate.trim();
  }
  return "";
}

function buildPersonMediaQueries(person: string, visualCue?: string): string[] {
  const cue = visualCue?.split(/\s+/).slice(0, 3).join(" ") ?? "";
  return [
    person,
    `${person} interview`,
    `${person} speech`,
    `${person} news conference`,
    cue ? `${person} ${cue}` : `${person} documentary`,
  ].filter((q, i, arr) => q.trim().length > 0 && arr.indexOf(q) === i);
}

/** Still-photo clips (Ken Burns from images) — cap these per scene; prefer real stock video. */
function isStillPhotoClip(filePath: string): boolean {
  if (isStockVideoClip(filePath)) return false;
  const base = path.basename(filePath);
  // AI / generated motion clips count as video, not stills
  if (/_ai\.mp4$|_runway_|_kling_|_luma_|_pika_|_veo_|_grok_|_forge_/i.test(base)) return false;
  return /_serp_|_wiki_|_openverse_|_p0_|_p2_|_yt_\d/i.test(base);
}

function isStockVideoClip(filePath: string): boolean {
  return /_pexels_|_pex_|_pixabay_|_pix_|_broll_|_ytcc_|_archive_|_wikivid_|_nasa_|_esa_|_b\d+_(pex|pix)/i.test(
    path.basename(filePath)
  );
}

function maxStillPhotosForScene(sceneIndex: number, hasPerson: boolean): number {
  if (hasPerson && sceneIndex === 0) return 2; // named person on screen at open
  return 1;
}

function resolveScenePersons(scene: Scene, videoTitle?: string): string[] {
  const persons = new Set((scene.personNames ?? []).map((n) => n.trim()).filter(Boolean));
  const titlePerson = extractPrimaryPersonFromTitle(videoTitle);
  if (titlePerson) {
    const firstName = titlePerson.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (scene.index === 0 || (firstName && scene.text.toLowerCase().includes(firstName))) {
      persons.add(titlePerson);
    }
  }
  return Array.from(persons);
}

// ─── Beat-level visual matching (narration ↔ footage alignment) ───────────────
const RELEVANCE_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "will", "would", "could",
  "should", "may", "might", "this", "that", "these", "those", "it", "its", "we", "they", "he", "she",
  "you", "i", "my", "our", "their", "his", "her", "your", "as", "so", "if", "not", "no", "up", "out",
  "about", "into", "than", "then", "when", "where", "who", "which", "what", "how", "all", "each", "more",
  "most", "also", "just", "very", "over", "after", "before", "through", "during", "between", "while",
  "because", "since", "even", "only", "still", "now", "here", "there", "some", "any", "every", "one",
  "two", "three", "first", "second", "third", "new", "like", "said", "says", "fact", "facts", "minute",
]);

interface SceneBeat {
  index: number;
  text: string;
  searchQuery: string;
  keywords: string[];
}

interface VisualDedupState {
  usedPaths: Set<string>;
  usedPexelsIds: Set<number>;
  usedPixabayIds: Set<number>;
  usedContentKeys: Set<string>;
  usedCategories: Map<string, number>;
  globalBeatIndex: number;
  lock: Promise<void>;
}

const STOCK_CATEGORY_LIMITS: Record<string, number> = {
  solar: 1,
  rocket: 3,
  tesla: 3,
  factory: 3,
  robot: 2,
  space: 2,
  generic: 5,
};

/** High-quality rotating queries for Musk/Tesla/SpaceX videos — real-world B-roll only. */
const GOLDEN_MUSK_QUERIES = [
  "SpaceX Falcon 9 rocket launch pad",
  "rocket launch exhaust flame night sky",
  "Falcon 9 landing drone ship ocean",
  "Starship launch pad Texas coastline",
  "Tesla Gigafactory production line workers",
  "Tesla electric car assembly line robots",
  "Tesla Model 3 driving cinematic road",
  "electric vehicle battery manufacturing plant",
  "rocket engine ignition launch pad close up",
  "mission control room NASA monitors",
  "Tesla supercharger station cars charging",
  "industrial robot arm welding automotive factory",
  "SpaceX rocket hangar horizontal transport",
  "lithium ion battery factory production",
  "electric car factory quality inspection",
];

function createVisualDedupState(): VisualDedupState {
  return {
    usedPaths: new Set(),
    usedPexelsIds: new Set(),
    usedPixabayIds: new Set(),
    usedContentKeys: new Set(),
    usedCategories: new Map(),
    globalBeatIndex: 0,
    lock: Promise.resolve(),
  };
}

async function withVisualDedupLock<T>(dedup: VisualDedupState, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = dedup.lock;
  dedup.lock = prev.then(() => gate);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

const BLOCKED_STOCK_TAGS_RE =
  /emoji|cartoon|animation|icon|illustration|graphic|pattern|sticker|clipart|motion graphics|3d render|abstract background|wallpaper|seamless loop|looping|campfire|bonfire|fireplace|bbq|barbecue|driving|dashcam|highway|bridge|miniature|scale model|toy|diorama|tabletop|model rocket/i;

const BLOCKED_STOCK_QUERY_RE =
  /\b(subscribe|like button|thumbs up|thumbs down|social media ui|notification bell|emoji|icon animation|button animation|wallpaper|seamless loop|motion graphics|scale model|miniature|toy rocket|model rocket|space shuttle model|shuttle model|diorama|replica rocket)\b/i;

function stockVisualCategory(query: string, filePath?: string): string {
  const combined = `${query} ${path.basename(filePath ?? "")}`.toLowerCase();
  if (/solar|photovoltaic|panel array|sun panel/.test(combined)) return "solar";
  if (/tesla|supercharger|model [3syx]|cybertruck/.test(combined)) return "tesla";
  if (/falcon|spacex|starship|rocket launch|launch pad|booster|ignition/.test(combined)) return "rocket";
  if (/robot arm|humanoid|cybernetic|prosthetic arm/.test(combined)) return "robot";
  if (/assembly line|manufacturing|factory|gigafactory|welding plant/.test(combined)) return "factory";
  if (/astronaut|mission control|orbit|satellite deploy|space station/.test(combined)) return "space";
  return "generic";
}

function categoryAtLimit(dedup: VisualDedupState, category: string): boolean {
  const limit = STOCK_CATEGORY_LIMITS[category] ?? 2;
  return (dedup.usedCategories.get(category) ?? 0) >= limit;
}

function isMuskTeslaTopic(videoTitle?: string, sceneText?: string): boolean {
  const text = `${videoTitle ?? ""} ${sceneText ?? ""}`.toLowerCase();
  return /musk|tesla|spacex|electric vehicle|falcon|starship/.test(text);
}

function hasBlockedStockTags(tags?: string): boolean {
  return BLOCKED_STOCK_TAGS_RE.test(tags ?? "");
}

function isBlockedStockQuery(q: string): boolean {
  return BLOCKED_STOCK_QUERY_RE.test(q);
}

function isPublishableChapterTitle(title: string | undefined): boolean {
  if (!title?.trim()) return false;
  const lower = title.trim().toLowerCase();
  const blocked = new Set([
    "hook", "call to action", "cta", "intro", "introduction", "outro", "conclusion", "opening", "closing",
  ]);
  if (blocked.has(lower)) return false;
  if (/^(section|part|chapter|scene)\s*\d*$/i.test(lower)) return false;
  return title.trim().length >= 4;
}

function clipContentKey(filePath: string): string {
  const base = path.basename(filePath).replace(/_transformed(?=\.mp4)/, "");
  const vidMatch = base.match(/_vid(\d+)/);
  if (vidMatch) return `stock:vid:${vidMatch[1]}`;
  try {
    const stat = fs.statSync(filePath);
    return `file:${stat.size}:${base}`;
  } catch {
    return base;
  }
}

/** Beat clip length in compose — fill scene duration, cap per clip for pacing. */
function computeMontageClipDuration(sceneDuration: number, clipCount: number): number {
  if (clipCount <= 0) return VIDRUSH_CLIP_MAX_SEC;
  const evenSplit = sceneDuration / clipCount;
  let clipDur = Math.max(VIDRUSH_CLIP_MIN_SEC, Math.min(4.5, evenSplit));
  if (clipDur * clipCount < sceneDuration - 0.05) {
    clipDur = sceneDuration / clipCount;
  }
  return clipDur;
}

function extractTopicStockQueries(promptOrTitle: string): string[] {
  const text = promptOrTitle.toLowerCase();
  const queries: string[] = [];
  if (/musk|tesla|spacex|electric vehicle|ev\b/.test(text)) {
    queries.push(
      "SpaceX Falcon 9 rocket launch",
      "SpaceX rocket launch pad night",
      "Falcon 9 landing drone ship",
      "Tesla Gigafactory production line",
      "Tesla electric car factory workers",
      "Tesla Model 3 assembly line",
      "electric vehicle manufacturing plant",
      "rocket engine ignition launch pad",
    );
  }
  if (/tesla/.test(text)) {
    queries.push("Tesla car showroom", "Tesla charging station supercharger", "Tesla autopilot camera");
  }
  if (/spacex|rocket|space|mars|starship/.test(text)) {
    queries.push("Starship launch pad", "astronaut space suit", "mission control room screens");
  }
  if (/ai|artificial intelligence|neural/.test(text)) {
    queries.push("data center server room", "computer chip manufacturing", "robot arm factory");
  }
  return queries;
}

function buildTopicAnchoredQueries(scene: Scene, videoTitle?: string, personName?: string, prompt?: string): string[] {
  const person = personName || scene.personNames?.[0] || extractPrimaryPersonFromTitle(videoTitle) || "";
  const titleLower = (videoTitle ?? "").toLowerCase();
  const textLower = scene.text.toLowerCase();
  const queries: string[] = [];

  queries.push(
    enrichStockQuery(scene.literalVisualCue ?? "", scene, videoTitle, person),
    enrichStockQuery(scene.pexelsQuery, scene, videoTitle, person),
    enrichStockQuery(scene.visualCue, scene, videoTitle, person),
    ...(scene.pexelsQueries ?? []).map((q) => enrichStockQuery(q, scene, videoTitle, person)),
    ...(scene.brollQueries ?? []).map((q) => enrichStockQuery(q, scene, videoTitle, person)),
  );
  queries.push(...extractTopicStockQueries(`${prompt ?? ""} ${videoTitle ?? ""} ${scene.text}`));

  if (titleLower.includes("tesla") || textLower.includes("tesla")) {
    queries.push("Tesla factory workers assembly", "Tesla electric vehicle production");
  }
  if (titleLower.includes("spacex") || textLower.includes("spacex") || textLower.includes("rocket")) {
    queries.push("SpaceX rocket launch", "rocket launch exhaust flame", "Falcon 9 landing");
  }
  // Person-name queries last — Pexels rarely has celebrity footage; object queries work better
  if (person) {
    queries.push(...buildPersonMediaQueries(person, scene.visualCue));
  }

  const allowSolar = /solar|photovoltaic|sun energy|panel/.test(textLower);
  return [...new Set(queries.filter((q) => {
    if (!q.trim() || q.trim().length <= 2 || isBlockedStockQuery(q)) return false;
    if (!allowSolar && stockVisualCategory(q) === "solar") return false;
    return true;
  }))];
}

function enrichStockQuery(
  query: string,
  scene: Scene,
  videoTitle?: string,
  personName?: string
): string {
  if (isBlockedStockQuery(query)) return query;
  const person = personName || scene.personNames?.[0] || extractPrimaryPersonFromTitle(videoTitle) || "";
  const topicTokens = [
    ...tokenizeForRelevance(person),
    ...tokenizeForRelevance(videoTitle ?? ""),
  ].filter((t) => t.length >= 3).slice(0, 2);
  const qLower = query.toLowerCase();
  if (topicTokens.some((t) => qLower.includes(t))) return query.slice(0, 100);
  if (person) {
    const first = person.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (first && !qLower.includes(first)) {
      return `${person} ${query}`.trim().slice(0, 100);
    }
  }
  if (topicTokens.length > 0) {
    return `${topicTokens.join(" ")} ${query}`.trim().slice(0, 100);
  }
  return query.slice(0, 100);
}

function tokenizeForRelevance(text: string): string[] {
  return text
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !RELEVANCE_STOP_WORDS.has(w));
}

function buildRelevanceKeywords(scene: Scene, beatText: string, videoTitle?: string): string[] {
  const parts = [
    ...tokenizeForRelevance(beatText),
    ...tokenizeForRelevance(scene.visualCue),
    ...tokenizeForRelevance(scene.pexelsQuery),
    ...(scene.pexelsQueries ?? []).flatMap((q) => tokenizeForRelevance(q)),
    ...(scene.personNames ?? []).flatMap((n) => tokenizeForRelevance(n)),
    ...tokenizeForRelevance(videoTitle ?? ""),
  ];
  return Array.from(new Set(parts)).slice(0, 20);
}

function scoreVisualRelevance(text: string, keywords: string[]): number {
  const t = text.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (kw.length < 3) continue;
    if (t.includes(kw)) score++;
  }
  return score;
}

function buildSceneBeats(scene: Scene, duration: number): SceneBeat[] {
  const minBeatsForDuration = Math.ceil(duration / VIDRUSH_CLIP_MAX_SEC);
  const beatCount = Math.max(minBeatsForDuration, Math.ceil(duration / VIDRUSH_BEAT_SEC));
  const sentences =
    scene.text.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()).filter((s) => s.length > 5) ??
    [scene.text.trim()];
  const brollPool = (scene.brollQueries ?? []).filter((q) => q.trim().length > 2);
  const queryPool = [
    scene.literalVisualCue,
    scene.pexelsQuery,
    scene.visualCue,
    ...(scene.pexelsQueries ?? []),
    ...brollPool,
  ].filter((q): q is string => typeof q === "string" && q.trim().length > 2);

  const beats: SceneBeat[] = [];
  for (let i = 0; i < beatCount; i++) {
    const text = sentences[Math.min(i, sentences.length - 1)] ?? scene.text;
    const textKeywords = tokenizeForRelevance(text).slice(0, 2).join(" ");
    const useBroll = i % 2 === 1 && brollPool.length > 0;
    const baseQuery = useBroll
      ? brollPool[i % brollPool.length]
      : queryPool[(i * 2 + scene.index) % Math.max(1, queryPool.length)] ??
        scene.visualCue ??
        scene.pexelsQuery ??
        extractTopicStockQueries(scene.text)[0] ??
        "factory production line";
    const searchQuery = textKeywords
      ? `${baseQuery} ${textKeywords}`.trim().slice(0, 100)
      : baseQuery;
    beats.push({
      index: i,
      text,
      searchQuery,
      keywords: buildRelevanceKeywords(scene, text),
    });
  }
  return beats;
}

async function adoptClip(
  paths: string[],
  dedup: VisualDedupState,
  sceneIndex: number,
  beatIndex: number,
  beatText: string,
  workDir: string,
  sourceQuery = ""
): Promise<string | null> {
  return withVisualDedupLock(dedup, async () => {
    for (const p of paths) {
      if (!p || dedup.usedPaths.has(p) || !fs.existsSync(p)) continue;
      if (!(await isValidVideoFile(p))) continue;
      if (isStillPhotoClip(p)) continue;
      const category = stockVisualCategory(sourceQuery, p);
      if (categoryAtLimit(dedup, category)) continue;
      let fileSize = 0;
      try { fileSize = fs.statSync(p).size; } catch { continue; }
      if (fileSize < 180_000) continue;
      const contentKey = clipContentKey(p);
      if (dedup.usedContentKeys.has(contentKey)) continue;
      dedup.usedPaths.add(p);
      dedup.usedContentKeys.add(contentKey);
      dedup.usedCategories.set(category, (dedup.usedCategories.get(category) ?? 0) + 1);
      const transformed = await transformClipForFairUse(p, beatText, sceneIndex, beatIndex, workDir);
      if (await isValidVideoFile(transformed)) return transformed;
      dedup.usedCategories.set(category, Math.max(0, (dedup.usedCategories.get(category) ?? 1) - 1));
    }
    return null;
  });
}

async function tryStockSources(
  fetchers: Array<{ query: string; fetch: () => Promise<string[]> }>,
  dedup: VisualDedupState,
  sceneIndex: number,
  beatIndex: number,
  beatText: string,
  workDir: string,
  logLabel: string
): Promise<string | null> {
  for (const { query, fetch } of fetchers) {
    if (isBlockedStockQuery(query)) continue;
    const category = stockVisualCategory(query);
    if (categoryAtLimit(dedup, category)) continue;
    const paths = await fetch();
    const clip = await adoptClip(paths, dedup, sceneIndex, beatIndex, beatText, workDir, query);
    if (clip) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beatIndex}: ${logLabel} "${query}"`);
      return clip;
    }
  }
  return null;
}

/** Last-resort real stock video — broad queries, non-strict mode. No still photos. */
async function fetchLastResortRealClip(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle?: string
): Promise<string | null> {
  const tag = `b${beat.index}_lr`;
  const candidateOffset = beat.index * 5 + sceneIndex + 11;
  const queries = [
    ...(personName
      ? [
          `${personName} Tesla factory`,
          `${personName} SpaceX rocket launch`,
          `${personName} press conference`,
          `${personName} interview`,
        ]
      : []),
    enrichStockQuery(scene.visualCue, scene, videoTitle, personName),
    enrichStockQuery(scene.pexelsQuery, scene, videoTitle, personName),
    ...(scene.pexelsQueries ?? []).map((q) => enrichStockQuery(q, scene, videoTitle, personName)),
    ...(scene.brollQueries ?? []).map((q) => enrichStockQuery(q, scene, videoTitle, personName)),
    enrichStockQuery(beat.searchQuery, scene, videoTitle, personName),
  ].filter((q): q is string => typeof q === "string" && q.trim().length > 2 && !isBlockedStockQuery(q));

  const uniqueQueries = [...new Set(queries)];

  for (const q of uniqueQueries) {
    const pex = await fetchPexelsClips(
      q, clipFetchDur, workDir, sceneIndex, 2, undefined, false, `${tag}_pex`,
      dedup.usedPexelsIds, candidateOffset
    );
    let clip = await adoptClip(pex, dedup, sceneIndex, beat.index, beat.text, workDir, q);
    if (clip) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: last-resort Pexels "${q}"`);
      return clip;
    }

    const pix = await fetchPixabayClips(
      q, clipFetchDur, workDir, sceneIndex, 2, `${tag}_pix`, false,
      dedup.usedPixabayIds, candidateOffset
    );
    clip = await adoptClip(pix, dedup, sceneIndex, beat.index, beat.text, workDir, q);
    if (clip) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: last-resort Pixabay "${q}"`);
      return clip;
    }
  }

  return null;
}

async function fetchBeatClip(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  spaceTopic: boolean,
  personName: string,
  videoTitle?: string
): Promise<string | null> {
  const tag = `b${beat.index}`;
  const candidateOffset = beat.index * 3 + sceneIndex + dedup.globalBeatIndex;
  const muskTopic = isMuskTeslaTopic(videoTitle, scene.text);

  const rawQ = beat.index === 0
    ? enrichStockQuery(
        scene.literalVisualCue || scene.pexelsQuery || scene.visualCue || beat.searchQuery,
        scene,
        videoTitle,
        personName
      )
    : enrichStockQuery(beat.searchQuery, scene, videoTitle, personName);
  const q = isBlockedStockQuery(rawQ)
    ? enrichStockQuery(scene.pexelsQuery || scene.visualCue, scene, videoTitle, personName)
    : rawQ;

  const pexFetch = (query: string, t: string, off: number, count = 2) =>
    () => fetchPexelsClips(query, clipFetchDur, workDir, sceneIndex, count, [query], true, t, dedup.usedPexelsIds, off);
  const pixFetch = (query: string, t: string, off: number) =>
    () => fetchPixabayClips(query, clipFetchDur, workDir, sceneIndex, 2, t, true, dedup.usedPixabayIds, off);
  const brollFetch = (query: string) =>
    () => fetchBrollClips([query], clipFetchDur, workDir, sceneIndex, dedup.usedPexelsIds);

  // 1) Beat-specific literal query (highest narrative match)
  let clip = await tryStockSources(
    [{ query: q, fetch: pexFetch(q, `${tag}_lit`, candidateOffset) }],
    dedup, sceneIndex, beat.index, beat.text, workDir, "literal Pexels"
  );
  if (clip) { dedup.globalBeatIndex++; return clip; }

  // 2) Golden rotating query for Musk/Tesla/SpaceX — guarantees visual variety
  if (muskTopic) {
    const golden = GOLDEN_MUSK_QUERIES[dedup.globalBeatIndex % GOLDEN_MUSK_QUERIES.length];
    const goldenCat = stockVisualCategory(golden);
    const goldenFetchers: Array<{ query: string; fetch: () => Promise<string[]> }> = [];

    if (spaceTopic && (goldenCat === "rocket" || goldenCat === "space")) {
      goldenFetchers.push({
        query: golden,
        fetch: () => fetchNasaVideoClips(golden, clipFetchDur, workDir, sceneIndex, 1),
      });
      goldenFetchers.push({
        query: golden,
        fetch: () => fetchInternetArchiveClips(golden, clipFetchDur, workDir, sceneIndex, 1, `${tag}_ga`),
      });
    }
    goldenFetchers.push({ query: golden, fetch: pexFetch(golden, `${tag}_golden`, candidateOffset + 1) });
    goldenFetchers.push({ query: golden, fetch: pixFetch(golden, `${tag}_golden`, candidateOffset + 1) });

    clip = await tryStockSources(goldenFetchers, dedup, sceneIndex, beat.index, beat.text, workDir, "golden");
    if (clip) { dedup.globalBeatIndex++; return clip; }
  }

  // 3) Scene topic-anchored queries
  const topicQueries = buildTopicAnchoredQueries(scene, videoTitle, personName, videoTitle);
  clip = await tryStockSources(
    topicQueries.slice(0, 10).map((tq, ti) => ({
      query: tq,
      fetch: pexFetch(tq, `${tag}_topic`, candidateOffset + ti, 2),
    })),
    dedup, sceneIndex, beat.index, beat.text, workDir, "topic Pexels"
  );
  if (clip) { dedup.globalBeatIndex++; return clip; }

  // 4) Dedicated B-roll cutaways on odd beats
  if (beat.index % 2 === 1 && beat.index > 0 && (scene.brollQueries?.length ?? 0) > 0) {
    const brollQ = enrichStockQuery(
      scene.brollQueries![beat.index % scene.brollQueries!.length],
      scene, videoTitle, personName
    );
    clip = await tryStockSources(
      [{ query: brollQ, fetch: brollFetch(brollQ) }],
      dedup, sceneIndex, beat.index, beat.text, workDir, "B-roll"
    );
    if (clip) { dedup.globalBeatIndex++; return clip; }
  }

  // 5) Pixabay + archival sources
  clip = await tryStockSources(
    [
      { query: q, fetch: pixFetch(q, `${tag}_pix`, candidateOffset) },
      ...(spaceTopic ? [{
        query: q,
        fetch: () => fetchNasaVideoClips(q, clipFetchDur, workDir, sceneIndex, 1),
      }] : []),
      { query: q, fetch: () => fetchWikimediaVideos(q, clipFetchDur, workDir, sceneIndex, 1, tag) },
      { query: q, fetch: () => fetchInternetArchiveClips(q, clipFetchDur, workDir, sceneIndex, 1, tag) },
      { query: q, fetch: () => fetchYouTubeCCClips(q, clipFetchDur, workDir, sceneIndex, 1, beat.keywords, 2) },
    ],
    dedup, sceneIndex, beat.index, beat.text, workDir, "archival"
  );
  if (clip) { dedup.globalBeatIndex++; return clip; }

  // 6) Scene fallback queries
  const fallbackQueries = [
    scene.visualCue,
    scene.pexelsQuery,
    ...(scene.pexelsQueries ?? []),
  ].filter((fq): fq is string => typeof fq === "string" && fq.trim().length > 2 && fq !== q && !isBlockedStockQuery(fq));

  clip = await tryStockSources(
    fallbackQueries.map((fq, fi) => ({ query: fq, fetch: pexFetch(fq, `${tag}_fb`, candidateOffset + fi, 1) })),
    dedup, sceneIndex, beat.index, beat.text, workDir, "fallback Pexels"
  );
  if (clip) { dedup.globalBeatIndex++; return clip; }

  const lastResort = await fetchLastResortRealClip(
    beat, scene, workDir, sceneIndex, clipFetchDur, dedup, personName, videoTitle
  );
  dedup.globalBeatIndex++;
  return lastResort;
}

// ─── 3e. Fetch All Visuals for a Scene (beat-aligned) ───────────────────────
// One stock clip per ~3.5s narration beat, in narrative order. No clip recycling.
async function fetchSceneVisuals(
  scene: Scene,
  workDir: string,
  videoTitle?: string,
  dedup: VisualDedupState = createVisualDedupState()
): Promise<string[]> {
  const clipFetchDur = 4;
  const scenePersons = resolveScenePersons(scene, videoTitle);
  const personName = scenePersons[0] ?? extractPrimaryPersonFromTitle(videoTitle) ?? "";
  const spaceTopic = isSpaceRelatedTopic(scene.visualCue, scene.pexelsQuery, scene.text, videoTitle ?? "");
  const beats = buildSceneBeats(scene, scene.duration);
  const clips: string[] = [];

  console.log(`[Pipeline] Scene ${scene.index}: fetching ${beats.length} beat-aligned clip(s)`);

  for (const beat of beats) {
    const clip = await fetchBeatClip(
      beat,
      scene,
      workDir,
      scene.index,
      clipFetchDur,
      dedup,
      spaceTopic,
      personName,
      videoTitle
    );
    if (clip) {
      clips.push(clip);
    } else {
      console.warn(
        `[Pipeline] Scene ${scene.index} beat ${beat.index}: no real footage for "${beat.searchQuery}" — emergency stock`
      );
      const emergencyQ = enrichStockQuery(
        scene.literalVisualCue || scene.pexelsQuery || scene.visualCue
          || extractTopicStockQueries(`${videoTitle ?? ""} ${scene.text}`)[0]
          || "electric car factory assembly",
        scene,
        videoTitle,
        personName
      );
      const emergency = await fetchPexelsClips(
        emergencyQ,
        clipFetchDur,
        workDir,
        scene.index,
        3,
        undefined,
        false,
        `b${beat.index}_em`,
        dedup.usedPexelsIds,
        beat.index * 7 + scene.index
      );
      const emClip = await adoptClip(emergency, dedup, scene.index, beat.index, beat.text, workDir, emergencyQ);
      if (emClip) {
        clips.push(emClip);
      } else {
        const lastResort = await fetchLastResortRealClip(
          beat, scene, workDir, scene.index, clipFetchDur, dedup, personName, videoTitle
        );
        if (lastResort) {
          clips.push(lastResort);
        } else {
          console.error(
            `[Pipeline] Scene ${scene.index} beat ${beat.index}: no stock video available — color placeholder`
          );
          clips.push(await generateColorFallback(scene.index * 100 + beat.index, 4, workDir));
        }
      }
    }
  }

  const videoCount = clips.filter((c) => !isStillPhotoClip(c)).length;
  const photoCount = clips.filter((c) => isStillPhotoClip(c)).length;
  const personLabel = scenePersons.length > 0 ? ` [persons: ${scenePersons.join(", ")}]` : "";
  console.log(
    `[Pipeline] Scene ${scene.index}${personLabel}: ${clips.length} beat clip(s) (${videoCount} video, ${photoCount} photo)`
  );
  return clips;
}

// ─── 3e. Extract Key Words for Kinetic Typography ───────────────────────────
// Extracts 3-5 impactful keywords from narration text without an LLM call.
// Strategy: remove stopwords, pick longest/most-impactful words.
function extractKeywords(text: string, count: number = 4): string[] {
  const STOP_WORDS = new Set([
    "the","a","an","and","or","but","in","on","at","to","for","of","with",
    "by","from","is","are","was","were","be","been","being","have","has",
    "had","do","does","did","will","would","could","should","may","might",
    "shall","can","this","that","these","those","it","its","we","they","he",
    "she","you","i","my","our","their","his","her","your","as","so","if",
    "not","no","up","out","about","into","than","then","when","where","who",
    "which","what","how","all","each","more","most","also","just","very",
    "over","after","before","through","during","between","while","because",
    "since","even","only","still","now","here","there","some","any","every",
  ]);

  // Clean text: remove punctuation, lowercase, split into words
  const words = text
    .replace(/[^a-zA-Z\s]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      unique.push(w);
    }
  }

  // Score: prefer longer words (more impactful), pick first `count` unique ones
  // Sort by length descending, then take top `count`, then re-sort by original order
  const topByLength = [...unique].sort((a, b) => b.length - a.length).slice(0, count * 2);
  // Restore original order among top candidates
  const topSet = new Set(topByLength);
  const ordered = unique.filter(w => topSet.has(w)).slice(0, count);

  // Capitalize first letter of each word for display
  return ordered.map(w => w.charAt(0).toUpperCase() + w.slice(1));
}

// ─── 3f. Render Kinetic Typography Frames ────────────────────────────────────
// Renders each keyword as a PNG overlay image for FFmpeg overlay.
// Returns array of { path, startTime, endTime } for each keyword.
interface KineticFrame {
  path: string;
  startTime: number;
  endTime: number;
}

async function renderKineticFrames(
  keywords: string[],
  sceneDuration: number,
  sceneIndex: number,
  workDir: string,
  overrideStartTime?: number,
  overrideEndTime?: number
): Promise<KineticFrame[]> {
  if (keywords.length === 0) return [];

  // FFmpeg-only implementation: render yellow pill with black text as PNG
  // No canvas dependency required — works in all environments

  const frames: KineticFrame[] = [];
  // Distribute keywords evenly across the scene duration (or use override timing)
  const slotDuration = sceneDuration / keywords.length;
  const showDuration = Math.max(1.5, slotDuration - 0.3);

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i];
    const startTime = overrideStartTime !== undefined ? overrideStartTime : i * slotDuration + 0.15;
    const endTime = overrideEndTime !== undefined ? overrideEndTime : Math.min(startTime + showDuration, sceneDuration - 0.2);

    const OVERLAY_H = 160;
    const FONT_SIZE = 72;
    const pngPath = path.join(workDir, `scene_${sceneIndex}_kword_${i}.png`);
    const safeKw = sanitizeForDrawtext(keyword.toUpperCase(), 40);

    // Estimate pill width: ~0.6 * fontSize per char + padding
    const estTextW = Math.min(safeKw.length * FONT_SIZE * 0.6, VIDEO_WIDTH - 200);
    const pillW = Math.round(estTextW + 80);
    const pillH = FONT_SIZE + 40;
    const pillX = Math.round((VIDEO_WIDTH - pillW) / 2);
    const pillY = Math.round((OVERLAY_H - pillH) / 2);

    try {
      // Generate yellow pill PNG using FFmpeg lavfi + drawbox + drawtext
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y ` +
          `-f lavfi -i "color=c=black@0:size=${VIDEO_WIDTH}x${OVERLAY_H}:rate=1" ` +
          `-vf "drawbox=x=${pillX}:y=${pillY}:w=${pillW}:h=${pillH}:color=FFD200@0.97:t=fill,` +
          `drawtext=text='${safeKw}':fontcolor=black:fontsize=${FONT_SIZE}:x=(w-text_w)/2:y=(h-text_h)/2" ` +
          `-frames:v 1 -pix_fmt rgba "${pngPath}"`
        ),
        8_000, `Kinetic PNG scene ${sceneIndex} word ${i}`
      );
    } catch (err) {
      console.warn(`[Pipeline] Kinetic PNG failed for scene ${sceneIndex} word ${i}:`, err);
      continue;
    }

    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      frames.push({ path: pngPath, startTime, endTime });
    }
  }

  return frames;
}

// ─── 4a. Stat Callout Box Renderer ──────────────────────────────────────────
// Renders a yellow corner callout box (bottom-right) with a key statistic in black bold text.
// Appears via hard cut, stays 2.5s, then disappears via hard cut — reference video style.
async function renderStatCallout(
  stat: string,
  sceneIndex: number,
  workDir: string
): Promise<{ path: string; startTime: number; endTime: number } | null> {
  if (!stat || stat.trim().length === 0) return null;

  const FONT_SIZE = 64;
  const PAD_X = 36;
  const PAD_Y = 24;
  const CORNER_MARGIN = 40;

  const safeStat = sanitizeForDrawtext(stat.trim().toUpperCase(), 30);
  // Estimate box dimensions: ~0.6 * fontSize per char + padding
  const estTextW = Math.min(safeStat.length * FONT_SIZE * 0.6, VIDEO_WIDTH / 2);
  const boxW = Math.round(estTextW + PAD_X * 2);
  const boxH = FONT_SIZE + PAD_Y * 2;
  const boxX = VIDEO_WIDTH - boxW - CORNER_MARGIN;
  const boxY = VIDEO_HEIGHT - boxH - CORNER_MARGIN;

  const pngPath = path.join(workDir, `scene_${sceneIndex}_stat_callout.png`);

  try {
    // Generate stat callout PNG using FFmpeg lavfi + drawbox + drawtext
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "color=c=black@0:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=1" ` +
        `-vf "drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=FFD200@0.97:t=fill,` +
        `drawtext=text='${safeStat}':fontcolor=black:fontsize=${FONT_SIZE}:x=${boxX + PAD_X}:y=${boxY + PAD_Y}" ` +
        `-frames:v 1 -pix_fmt rgba "${pngPath}"`
      ),
      8_000, `Stat callout PNG scene ${sceneIndex}`
    );

    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      console.log(`[Pipeline] Scene ${sceneIndex}: stat callout rendered: "${stat}"`);
      return { path: pngPath, startTime: 1.0, endTime: 3.5 };
    }
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: stat callout render failed (non-fatal):`, err);
  }
  return null;
}

// ─── 4b. Canvas Subtitle Overlay ─────────────────────────────────────────────
// FFmpeg-only fallback: creates a transparent PNG with drawtext (no canvas needed)
async function renderSubtitleOverlayFFmpeg(
  text: string,
  sceneIndex: number,
  totalScenes: number,
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${sceneIndex}_subtitle.png`);
  const OVERLAY_H = 220;
  // Create a semi-transparent black bar PNG using FFmpeg lavfi
  const safeText = sanitizeForDrawtext(text, 80);
  const badge = sanitizeForDrawtext(`${sceneIndex + 1}/${totalScenes}`, 20);
  // Use FFmpeg to create a PNG: black gradient bar with white text
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -f lavfi -i "color=c=black@0.85:size=${VIDEO_WIDTH}x${OVERLAY_H}:rate=1" ` +
      `-vf "drawtext=text='${badge}':fontcolor=yellow:fontsize=22:x=28:y=14,` +
      `drawtext=text='${safeText}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=100:line_spacing=10" ` +
      `-frames:v 1 "${outputPath}"`
    ),
    10_000, `Subtitle overlay FFmpeg scene ${sceneIndex}`
  );
  return outputPath;
}

async function renderSubtitleOverlay(
  text: string,
  sceneIndex: number,
  totalScenes: number,
  workDir: string
): Promise<string> {
  // Always use FFmpeg-only implementation (no canvas dependency)
  return renderSubtitleOverlayFFmpeg(text, sceneIndex, totalScenes, workDir);
}

// ─── 4a2. Chapter Card Renderer (Vox/Wendover style) ──────────────────────────────────
// Renders a 1.5s black-background title card with:
//   - Thin horizontal accent line above the title
//   - Large ALL CAPS white title text (bold, centered)
//   - Thin horizontal accent line below the title
//   - Hard cut in, hard cut out (no fade) — like reference video
async function renderChapterCard(
  chapterTitle: string,
  chapterIndex: number,
  workDir: string
): Promise<string> {
  const CARD_DURATION = 1.5; // seconds
  const outputPath = path.join(workDir, `chapter_card_${chapterIndex}.mp4`);

  // FFmpeg-only: yellow background with black bold text (no canvas dependency)
  const safeTitle = sanitizeForDrawtext(chapterTitle.toUpperCase(), 50);
  const centerY = VIDEO_HEIGHT / 2;
  const lineY1 = centerY - 80;
  const lineY2 = centerY + 70;
  const lineX1 = Math.round(VIDEO_WIDTH * 0.15);
  const lineX2 = Math.round(VIDEO_WIDTH * 0.85);

  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "color=c=FFD700:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
        `-f lavfi -i anullsrc=r=44100:cl=stereo ` +
        `-filter_complex "[0:v]` +
        `drawbox=x=${lineX1}:y=${lineY1}:w=${lineX2 - lineX1}:h=3:color=black@0.4:t=fill,` +
        `drawbox=x=${lineX1}:y=${lineY2}:w=${lineX2 - lineX1}:h=3:color=black@0.4:t=fill,` +
        `drawtext=text='${safeTitle}':fontcolor=black:fontsize=80:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=10` +
        `[vout]" ` +
        `-map "[vout]" -map "1:a" ` +
        `-t ${CARD_DURATION} -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -r 25 -c:a aac -b:a 320k -shortest "${outputPath}"`
      ),
      15_000, `Chapter card ${chapterIndex}`
    );
    console.log(`[Pipeline] Chapter card ${chapterIndex}: "${chapterTitle}" rendered (FFmpeg)`);
  } catch (err) {
    console.warn(`[Pipeline] Chapter card ${chapterIndex} failed (non-fatal):`, (err as Error).message);
  }
  return outputPath;
}

// ─── 4b. Branded Intro Title Card ────────────────────────────────────────────
async function renderIntroCardFFmpeg(videoTitle: string, duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "intro_card.mp4");
  // Sanitize title for FFmpeg drawtext filter
  const safeTitle = sanitizeForDrawtext(videoTitle, 60);
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -f lavfi -i "color=c=#0a0a1e:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
      `-f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-filter_complex "[0:v]drawtext=text='${safeTitle}':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=h/2-40:line_spacing=10,` +
      `fade=t=in:st=0:d=0.4,fade=t=out:st=${duration - 0.4}:d=0.4[vout]" ` +
      `-map "[vout]" -map "1:a" ` +
      `-t ${duration} -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -r 25 -c:a aac -b:a 320k -shortest "${outputPath}"`
    ),
    60_000, "Intro card FFmpeg render"
  );
  return outputPath;
}

async function renderIntroCard(videoTitle: string, duration: number, workDir: string): Promise<string> {
  // Always use FFmpeg-only implementation (no canvas dependency)
  return renderIntroCardFFmpeg(videoTitle, duration, workDir);
}

//// ─── 4c. Branded Outro Card ────────────────────────────────────────────
async function renderOutroCardFFmpeg(duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "outro_card.mp4");
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -f lavfi -i "color=c=#0a0a1e:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
      `-f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-filter_complex "[0:v]drawtext=text='Thanks for watching!':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=h/2-80,` +
      `fade=t=in:st=0:d=0.4,fade=t=out:st=${duration - 0.4}:d=0.4[vout]" ` +
      `-map "[vout]" -map "1:a" ` +
      `-t ${duration} -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -r 25 -c:a aac -b:a 320k -shortest "${outputPath}"`
    ),
    90_000, "Outro card FFmpeg render"
  );
  return outputPath;
}

async function renderOutroCard(duration: number, workDir: string): Promise<string> {
  // Always use FFmpeg-only implementation (no canvas dependency)
  return renderOutroCardFFmpeg(duration, workDir);
}

// ─── 5. Compose Scene Video (Vidrush-style hard-cut montage) ───────────────
async function composeSceneVideo(
  scene: Scene,
  clips: string[],
  audioPath: string,
  duration: number,
  workDir: string,
  totalScenes: number,
  enableSubtitles = false  // Subtitles disabled by default
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${scene.index}_composed.mp4`);

  // Ensure we have at least one valid clip (existence, size, readable video stream)
  const existingClips = clips.filter(p => fs.existsSync(p) && fs.statSync(p).size > 100);
  const validClips: string[] = [];
  for (const clipPath of existingClips) {
    if (await isValidVideoFile(clipPath)) {
      validClips.push(clipPath);
    } else {
      console.warn(`[Pipeline] Scene ${scene.index}: skipping unreadable clip ${path.basename(clipPath)}`);
    }
  }

  // Clips arrive in beat/narration order from fetchSceneVisuals — preserve timeline.
  let safeClips = validClips.length > 0
    ? validClips
    : [await generateColorFallback(scene.index, duration, workDir)];

  // Last-line check: never feed corrupt MP4s into filter_complex
  const verifiedClips: string[] = [];
  for (const clip of safeClips) {
    verifiedClips.push(await requireValidClip(clip, scene.index, duration, workDir));
  }
  // Drop duplicate stock within the same scene montage
  const seenKeys = new Set<string>();
  safeClips = verifiedClips.filter((clip) => {
    const key = clipContentKey(clip);
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  if (safeClips.length === 0) {
    safeClips = [await generateColorFallback(scene.index, duration, workDir)];
  }

  // Validate audio
  const audioValid = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 100;
  let safeAudioPath = audioPath;
  if (!audioValid) {
    safeAudioPath = path.join(workDir, `scene_${scene.index}_silent.mp3`);
    try {
      await withTimeout(
        exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${duration} -c:a libmp3lame -b:a 64k "${safeAudioPath}"`),
        10_000, `Silent fallback scene ${scene.index}`
      );
    } catch {
      fs.writeFileSync(safeAudioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(413).fill(0)]));
    }
  }

  // Subtitle overlay: render if user has enabled subtitles
  let subtitlePath: string | null = null;
  if (enableSubtitles) {
    try {
      subtitlePath = await renderSubtitleOverlay(scene.text, scene.index, totalScenes, workDir);
    } catch (err) {
      console.warn(`[Pipeline] Scene ${scene.index}: subtitle overlay failed (non-fatal):`, err);
      subtitlePath = null;
    }
  }

  // Kinetic typography: Vidrush-style — use LLM-generated highlightWords for every scene that has them.
  // Fallback to stopword extraction for scenes without LLM words (every 4th scene).
  // Shows 1 power word at a time, centered in the scene, for 2s each.
  let kineticFrames: KineticFrame[] = [];
  try {
    // Prefer LLM-generated highlight words; fall back to stopword extraction every 4th scene
    const llmWords = (scene.highlightWords || []).filter(w => w && w.trim().length > 0);
    const shouldShowKinetic = false; // Kinetic typography disabled — user requested no on-screen text
    if (shouldShowKinetic) {
      const keywords = llmWords.length > 0 ? llmWords.slice(0, 2) : extractKeywords(scene.text, 1);
      if (keywords.length > 0) {
        // Show each word for 2s, distributed across the scene
        const wordDuration = 2.0;
        const gap = 0.4; // gap between words
        const totalWordTime = keywords.length * (wordDuration + gap);
        const startOffset = Math.max(0.5, (duration - totalWordTime) / 2);
        const allFrames: KineticFrame[] = [];
        for (let wi = 0; wi < keywords.length; wi++) {
          const wordStart = startOffset + wi * (wordDuration + gap);
          const wordEnd = Math.min(wordStart + wordDuration, duration - 0.3);
          if (wordStart >= duration - 0.5) break;
          const frames = await renderKineticFrames(
            [keywords[wi]],
            duration,
            scene.index,
            workDir,
            wordStart,
            wordEnd
          );
          allFrames.push(...frames);
        }
        kineticFrames = allFrames;
        console.log(`[Pipeline] Scene ${scene.index}: kinetic words: [${keywords.join(', ')}] (${llmWords.length > 0 ? 'LLM' : 'fallback'})`);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] Scene ${scene.index}: kinetic typography failed (non-fatal):`, err);
    kineticFrames = [];
  }

  // Stat callout box: yellow corner box with key statistic (reference video style)
  let statCalloutFrame: { path: string; startTime: number; endTime: number } | null = null;
  // Stat callout disabled — user requested no on-screen text
  // try {
  //   if (scene.statCallout && scene.statCallout.trim().length > 0) {
  //     statCalloutFrame = await renderStatCallout(scene.statCallout, scene.index, workDir);
  //   }
  // } catch (err) { statCalloutFrame = null; }

  // On Railway, limit FFmpeg threads to reduce memory usage
  const threadFlag = IS_RAILWAY ? "-threads 2" : "";
  // Kinetic text position: upper-center area
  const kineticY = 80;
  // Cinematic color grading: desaturated cool tones (like reference video — modern European documentary look)
  // High contrast, slightly desaturated, cooler tones for professional look
  const colorGrade = `eq=contrast=1.12:saturation=0.92:brightness=-0.02:gamma=1.02,colorbalance=rs=-0.02:gs=0:bs=0.03:rm=-0.01:gm=0:bm=0.02:rh=-0.01:gh=0:bh=0.02`;
  // No subtitle overlay
  const subtitleDrawtext = '';
  // Vignette for cinematic look
  const vignetteFilter = `,vignette=angle=0.6:mode=forward`;
  // Film grain disabled — noise filter breaks some Railway FFmpeg builds (encoder init errors)
  const fadeFilter = `${colorGrade}${subtitleDrawtext}${vignetteFilter}`;

  // Helper: build the full overlay chain
  // Kinetic frames: full-width PNG at y=kineticY, timed with enable='between(t,...)'.
  // Stat callout: full-frame transparent PNG overlaid at x=0:y=0 (box is positioned inside the PNG).
  function buildKineticChain(
    baseLabel: string,
    baseInputCount: number
  ): { extraInputs: string; filterChain: string; finalLabel: string } {
    const allOverlays: Array<{ path: string; startTime: number; endTime: number; isStatCallout?: boolean }> = [
      ...kineticFrames,
      ...(statCalloutFrame ? [{ ...statCalloutFrame, isStatCallout: true }] : []),
    ];
    if (allOverlays.length === 0) {
      return { extraInputs: "", filterChain: "", finalLabel: baseLabel };
    }
    const extraInputs = allOverlays.map(f => `-loop 1 -i "${f.path}"`).join(" ");
    let chain = "";
    let prevLabel = baseLabel;
    allOverlays.forEach((frame, idx) => {
      const inputIdx = baseInputCount + idx;
      const outLabel = idx === allOverlays.length - 1 ? "kfinal" : `kf${idx}`;
      if ((frame as { isStatCallout?: boolean }).isStatCallout) {
        // Stat callout: full-frame overlay (box positioned inside PNG), bottom-right corner
        chain += `;[${prevLabel}][${inputIdx}:v]overlay=x=0:y=0:enable='between(t,${frame.startTime.toFixed(2)},${frame.endTime.toFixed(2)})'[${outLabel}]`;
      } else {
        // Kinetic word: top-center overlay
        chain += `;[${prevLabel}][${inputIdx}:v]overlay=x=0:y=${kineticY}:enable='between(t,${frame.startTime.toFixed(2)},${frame.endTime.toFixed(2)})'[${outLabel}]`;
      }
      prevLabel = outLabel;
    });
    return { extraInputs, filterChain: chain, finalLabel: "kfinal" };
  }

  // Final existence check before compose — log clearly if something is missing
  for (const clip of safeClips) {
    if (!fs.existsSync(clip)) {
      console.error(`[Pipeline] Scene ${scene.index}: clip file MISSING before compose: ${clip}`);
    }
  }
  if (!fs.existsSync(safeAudioPath)) {
    console.error(`[Pipeline] Scene ${scene.index}: audio file MISSING before compose: ${safeAudioPath}`);
  }

  try {
    // Vidrush montage: 2–3s clips, hard cuts (no crossfade)
    const clipDur = computeMontageClipDuration(duration, safeClips.length);
    const inputs = safeClips.map((c, i) => {
      const startSec = Math.min(((scene.index + i) * 0.7) % 1.2, 0.8);
      return `-ss ${startSec.toFixed(2)} -t ${clipDur.toFixed(3)} -i "${c}"`;
    }).join(" ");
    const scaleFilters = safeClips.map((_, i) =>
      `[${i}:v]${STANDARD_VF}[v${i}]`
    ).join(";");
    const concatLabels = safeClips.map((_, i) => `[v${i}]`).join("");
    const mergeFilter =
      safeClips.length === 1
        ? `;[v0]copy[concatenated]`
        : `;${concatLabels}concat=n=${safeClips.length}:v=1:a=0[concatenated]`;

    const audioIdx = safeClips.length;
    const kineticBaseIdx = audioIdx + 1;
    const { extraInputs: kExtraInputs, filterChain: kChain, finalLabel: kFinalLabel } =
      buildKineticChain("concatenated", kineticBaseIdx);

    const kineticInput = kExtraInputs ? ` ${kExtraInputs}` : "";
    const kineticChainStr = kChain ? kChain : "";
    const hasOverlays = kineticFrames.length > 0 || statCalloutFrame !== null;
    const finalVideoLabel = hasOverlays ? kFinalLabel : "concatenated";
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ${inputs} -i "${safeAudioPath}"${kineticInput} ` +
        `-filter_complex "${scaleFilters}${mergeFilter}${kineticChainStr};[${finalVideoLabel}]${fadeFilter}[vout];[${audioIdx}:a]apad=whole_dur=${duration.toFixed(3)},atrim=0:${duration.toFixed(3)}[aout]" ` +
        `-map "[vout]" -map "[aout]" ` +
        `-t ${duration} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
      ),
      120_000, `Compose multi-clip scene ${scene.index}`
    );
  } catch (composeErr) {
    console.warn(`[Pipeline] Scene ${scene.index}: compose failed, trying simplified compose:`, composeErr);
    try {
      const clipDur = computeMontageClipDuration(duration, safeClips.length);
      const n = Math.min(12, Math.max(2, safeClips.length));
      const subset = safeClips.slice(0, n);
      const inputs = subset.map((c) => `-t ${clipDur.toFixed(3)} -i "${c}"`).join(" ");
      const scaleFilters = subset.map((_, i) => `[${i}:v]${STANDARD_VF}[v${i}]`).join(";");
      const concatLabels = subset.map((_, i) => `[v${i}]`).join("");
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y ${inputs} -i "${safeAudioPath}" ` +
          `-filter_complex "${scaleFilters};${concatLabels}concat=n=${subset.length}:v=1:a=0[vout];[${subset.length}:a]apad=whole_dur=${duration.toFixed(3)},atrim=0:${duration.toFixed(3)}[aout]" ` +
          `-map "[vout]" -map "[aout]" ` +
          `-t ${duration} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
        ),
        90_000,
        `Simplified multi-clip scene ${scene.index}`
      );
    } catch (simpleErr) {
      console.warn(`[Pipeline] Scene ${scene.index}: simplified compose failed, trying simple mux:`, simpleErr);
      try {
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y -i "${safeClips[0]}" -i "${safeAudioPath}" ` +
            `-filter_complex "[1:a]apad=whole_dur=${duration.toFixed(3)},atrim=0:${duration.toFixed(3)}[aout]" ` +
            `-map "0:v" -map "[aout]" ` +
            `-t ${duration} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
          ),
          45_000,
          `Simple mux scene ${scene.index}`
        );
      } catch (muxErr) {
        console.warn(`[Pipeline] Scene ${scene.index}: simple mux failed, using color fallback:`, muxErr);
        const fallbackClip = await generateColorFallback(scene.index, duration, workDir);
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y -i "${fallbackClip}" -i "${safeAudioPath}" ` +
            `-t ${duration} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
          ),
          60_000,
          `Color fallback scene ${scene.index}`
        );
      }
    }
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
    throw pipelineError(PIPELINE_ERROR.FFMPEG, `Scene ${scene.index} produced no output video`);
  }

  if (subtitlePath) { try { fs.unlinkSync(subtitlePath); } catch { /* ignore */ } }
  // Clean up kinetic frame PNGs
  for (const frame of kineticFrames) {
    try { fs.unlinkSync(frame.path); } catch { /* ignore */ }
  }
  return outputPath;
}

// ─── 6. Ambient Documentary Background Music ─────────────────────────────────
// Generates a rich ambient documentary track inspired by Vox/Wendover/Kurzgesagt style:
// - Layered harmonic pads (root, fifth, octave, minor seventh) for emotional depth
// - Subtle rhythmic pulse via amplitude modulation for forward momentum
// - Noise-based hi-hat texture for organic feel
// - Deep sub-bass foundation
// - Long reverb tails for spacious, cinematic atmosphere
// Mixed at -20dB relative to voiceover (ducked further by sidechaincompress in final mix)
async function generateBackgroundMusic(duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "bg_music.mp3");
  try {
    // Root: A2 (110Hz) — warm, serious documentary tone
    // Fifth: E3 (165Hz) — harmonic stability
    // Octave: A3 (220Hz) — brightness
    // Minor seventh: G3 (196Hz) — slight tension, modern feel
    // Sub-bass: A1 (55Hz) — foundation
    // Pulse: 2Hz AM on root for subtle rhythmic breathing
    // Hi-hat texture: bandpass-filtered white noise at very low volume
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ` +
        // Root pad — A2, warm and central
        `-f lavfi -i "sine=frequency=110:duration=${duration}" ` +
        // Perfect fifth — E3
        `-f lavfi -i "sine=frequency=165:duration=${duration}" ` +
        // Octave — A3
        `-f lavfi -i "sine=frequency=220:duration=${duration}" ` +
        // Minor seventh — G3 (adds modern tension)
        `-f lavfi -i "sine=frequency=196:duration=${duration}" ` +
        // Sub-bass — A1
        `-f lavfi -i "sine=frequency=55:duration=${duration}" ` +
        // Second harmonic of root — A4 (330Hz, very quiet shimmer)
        `-f lavfi -i "sine=frequency=330:duration=${duration}" ` +
        // White noise for hi-hat texture
        `-f lavfi -i "anoisesrc=r=44100:color=white:duration=${duration}" ` +
        `-filter_complex "` +
          // Root pad: volume + long echo reverb + gentle 2Hz AM pulse (aeval) + lowpass
          `[0]volume=0.40,aecho=0.97:0.94:400:0.65,aeval='val(0)*(0.82+0.18*sin(2*PI*2*t))',lowpass=f=180[root];` +
          // Fifth: volume + echo + lowpass for warmth
          `[1]volume=0.28,aecho=0.95:0.92:300:0.55,lowpass=f=250[fifth];` +
          // Octave: quieter, echo, lowpass
          `[2]volume=0.18,aecho=0.92:0.88:200:0.45,lowpass=f=350[oct];` +
          // Minor seventh: very quiet, adds modern color
          `[3]volume=0.12,aecho=0.90:0.86:250:0.40,lowpass=f=300[seventh];` +
          // Sub-bass: deep, slow 1Hz AM pulse for breathing feel
          `[4]volume=0.30,aecho=0.98:0.96:600:0.70,aeval='val(0)*(0.75+0.25*sin(2*PI*1*t))',lowpass=f=100[sub];` +
          // High shimmer: very quiet
          `[5]volume=0.06,aecho=0.88:0.84:150:0.35,lowpass=f=500[shimmer];` +
          // Hi-hat: bandpass 6kHz-12kHz, very quiet, adds organic texture
          `[6]volume=0.04,highpass=f=6000,lowpass=f=12000[hihat];` +
          // Mix all layers
          `[root][fifth][oct][seventh][sub][shimmer][hihat]amix=inputs=7:duration=first:dropout_transition=3,` +
          // Global EQ: remove rumble below 30Hz, gentle high shelf cut above 1kHz
          `highpass=f=30,lowpass=f=1200,` +
          // Subtle room reverb on the full mix
          `aecho=0.75:0.72:500:0.20,` +
          // Final volume
          `volume=0.50[music]` +
        `" ` +
        `-map "[music]" -c:a libmp3lame -b:a 320k "${outputPath}"`
      ),
      45_000, "Background music generation"
    );
    console.log(`[Pipeline] Background music generated: ${(fs.statSync(outputPath).size / 1024).toFixed(0)}KB`);
    return outputPath;
  } catch (err) {
    console.warn("[Pipeline] Music generation failed, using silence:", err);
    await exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${duration} -c:a libmp3lame -b:a 64k "${outputPath}"`).catch((e) => { console.error('[Pipeline] Music silence fallback failed:', e); });
    return outputPath;
  }
}


// ─── 6b. Sound Effects (SFX) Generation ──────────────────────────────────────
// Generates camera shutter, whoosh, and impact sounds using FFmpeg lavfi synthesis.
// These are mixed into the final audio at low volume for Vidrush-style energy.
async function generateSFX(
  type: 'shutter' | 'whoosh' | 'impact',
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `sfx_${type}.mp3`);
  try {
    let cmd = '';
    if (type === 'shutter') {
      // Camera shutter: short high-freq click (2kHz, 0.05s) + mechanical thud (200Hz, 0.08s)
      cmd = `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "sine=frequency=2000:duration=0.05" ` +
        `-f lavfi -i "sine=frequency=200:duration=0.08" ` +
        `-filter_complex "[0]volume=0.6,aecho=0.8:0.3:10:0.2[click];[1]volume=0.4,lowpass=f=400[thud];[click][thud]amix=inputs=2:duration=longest[sfx]" ` +
        `-map "[sfx]" -c:a libmp3lame -b:a 128k "${outputPath}"`;
    } else if (type === 'whoosh') {
      // Whoosh: swept sine 200Hz→2000Hz over 0.2s for transition sound
      cmd = `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "sine=frequency=200:duration=0.2" ` +
        `-f lavfi -i "sine=frequency=2000:duration=0.2" ` +
        `-filter_complex "[0]volume=0.5,aecho=0.7:0.5:20:0.3[low];[1]volume=0.3,aecho=0.7:0.5:15:0.2[high];[low][high]amix=inputs=2:duration=longest,atempo=1.5[sfx]" ` +
        `-map "[sfx]" -c:a libmp3lame -b:a 128k "${outputPath}"`;
    } else {
      // Impact: low thud (80Hz, 0.15s) with decay
      cmd = `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "sine=frequency=80:duration=0.15" ` +
        `-filter_complex "[0]volume=0.7,aecho=0.9:0.6:30:0.4,lowpass=f=300[sfx]" ` +
        `-map "[sfx]" -c:a libmp3lame -b:a 128k "${outputPath}"`;
    }
    await withTimeout(exec(cmd), 10_000, `SFX generation: ${type}`);
    return outputPath;
  } catch (err) {
    console.warn(`[Pipeline] SFX generation failed for ${type}:`, err);
    // Return empty audio as fallback
    await exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 0.1 -c:a libmp3lame -b:a 64k "${outputPath}"`).catch(() => {});
    return outputPath;
  }
}

// ─── 7. Final Concatenation + Music Mix ───────────────────────────────────────
async function concatenateScenesWithMusic(
  scenePaths: string[],
  workDir: string,
  videoId: number,
  totalDuration: number,
  videoTitle: string
): Promise<string> {
  const listFile = path.join(workDir, "concat_list.txt");
  const concatPath = path.join(workDir, `fastvid_${videoId}_concat.mp4`);
  const outputPath = path.join(workDir, `fastvid_${videoId}_final.mp4`);

  const validScenePaths = scenePaths.filter(p => {
    try {
      const exists = fs.existsSync(p);
      const size = exists ? fs.statSync(p).size : 0;
      if (!exists) console.error(`[Pipeline] Concat: scene file MISSING: ${p}`);
      else if (size <= 100) console.error(`[Pipeline] Concat: scene file too small (${size} bytes): ${p}`);
      return exists && size > 100;
    } catch { return false; }
  });
  if (validScenePaths.length === 0) {
    throw pipelineError(PIPELINE_ERROR.NO_SCENES, "No valid composed scene files to concatenate");
  }

  const allClips = [...validScenePaths];
  const listContent = allClips.map(p => `file '${p}'`).join("\n");
  fs.writeFileSync(listFile, listContent, "utf-8");

  const totalWithCards = totalDuration;

  const [, musicPath] = await Promise.all([
    withTimeout(
      exec(`${FFMPEG_BIN} -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -movflags +faststart "${concatPath}"`),
      900_000, // 15 min for large videos (30+ scenes)
      "Scene concatenation"
    ),
    generateBackgroundMusic(totalWithCards + 5, workDir),
  ]);

  // Verify concat output exists before music mixing
  if (!fs.existsSync(concatPath) || fs.statSync(concatPath).size < 1000) {
    throw pipelineError(PIPELINE_ERROR.CONCAT, "Concat failed: output file missing or empty");
  }
  console.log(`[Pipeline] Concat output: ${(fs.statSync(concatPath).size / 1024 / 1024).toFixed(1)}MB`);

  // Check if concat video has an audio stream
  // Try multiple probe methods; if all fail, assume audio IS present to avoid silent videos
  let concatHasAudio = true; // default: assume audio present
  try {
    const { execSync: es } = await import("child_process");
    let probed = false;
    for (const probePath of FFPROBE_PATHS()) {
      try {
        const probeOut = es(`${probePath} -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${concatPath}"`, { encoding: 'utf8', timeout: 10000 });
        concatHasAudio = probeOut.trim().includes('audio');
        probed = true;
        console.log(`[Pipeline] Audio probe (${probePath}): hasAudio=${concatHasAudio}`);
        break;
      } catch { /* try next */ }
    }
    if (!probed) {
      console.warn('[Pipeline] All ffprobe paths failed — assuming audio present to avoid silent video');
      concatHasAudio = true;
    }
  } catch {
    console.warn('[Pipeline] Audio probe completely failed — assuming audio present');
    concatHasAudio = true;
  }
  console.log(`[Pipeline] Concat has audio: ${concatHasAudio}`);

  if (concatHasAudio) {
    // Normal path: mix voiceover audio with background music
    // VO at 100%, ambient music at 18% (like reference video: -20dB to -25dB relative)
    try {
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
          // Dynamic ducking: music drops to 8% under voiceover, rises to 22% during pauses
          // sidechaincompress: music is compressed when VO is present (attack=5ms, release=200ms)
          // This matches the reference video: VO always dominant, music swells in pauses
          `-filter_complex "[0:a]volume=1.0,asplit=2[voice][voicedet];[1:a]volume=0.22,aloop=loop=-1:size=2e+09[musicloop];[musicloop][voicedet]sidechaincompress=threshold=0.02:ratio=8:attack=5:release=200:makeup=1[music_ducked];[voice][music_ducked]amix=inputs=2:duration=first:dropout_transition=3[aout]" ` +
          `-map "0:v" -map "[aout]" ` +
          `-c:v copy -c:a aac -b:a 320k -movflags +faststart "${outputPath}"`
        ),
        180_000,
        "Background music mixing"
      );
    } catch (err) {
      console.warn("[Pipeline] Audio mixing failed, trying without aloop:", err);
      try {
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
            `-filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.12[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=3[aout]" ` +
            `-map "0:v" -map "[aout]" ` +
            `-c:v copy -c:a aac -b:a 320k -movflags +faststart "${outputPath}"`
          ),
          180_000,
          "Background music mixing (no loop)"
        );
      } catch (err2) {
        console.warn("[Pipeline] Audio mixing failed completely, copying video:", err2);
        await withTimeout(
          exec(`${FFMPEG_BIN} -y -i "${concatPath}" -c copy -movflags +faststart "${outputPath}"`),
          60_000, "Copy concat as output"
        );
      }
    }
  } else {
    // Fallback: concat has no audio — use only background music at 25%
    console.warn("[Pipeline] Concat has no audio stream, using background music only");
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
        `-filter_complex "[1:a]volume=0.25,aloop=loop=-1:size=2e+09[aout]" ` +
        `-map "0:v" -map "[aout]" ` +
        `-c:v copy -c:a aac -b:a 320k -movflags +faststart "${outputPath}"`
      ),
      120_000, "Background music mixing (no voiceover)"
    );
  }

  try {
    fs.unlinkSync(concatPath);
    fs.unlinkSync(musicPath);
  } catch { /* ignore */ }

  return outputPath;
}

// ─── Main Pipeline ────────────────────────────────────────────────────────────
export async function runVideoPipeline(
  videoId: number,
  script: string,
  onProgress?: (p: PipelineProgress) => void,
  voiceId?: string,
  customVoiceoverUrl?: string,
  videoLength: string = "8-12",
  enableSubtitles = false  // Subtitles disabled by default — user can enable via UI
): Promise<string> {
  const maxScenes = getScenesForLength(videoLength);
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
  const workDir = path.join(TMP_DIR, `fastvid_${videoId}_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const titleMatch = script.match(/^#\s+(.+)/m);
  const videoTitle = titleMatch?.[1]?.trim().slice(0, 80)
    || script.split("\n").find(l => l.trim().length > 5)?.trim().slice(0, 80)
    || "AI Generated Video";

  console.log(`[Pipeline] Video ${videoId}: ${maxScenes} scenes for ${videoLength} min video`);

  try {
    // ── Stage 1: Parse script into scenes ────────────────────────────────────
    onProgress?.({ stage: STAGE_LABELS.parsing, percent: 3 });
    const t0 = Date.now();
    const scenes = await parseScriptIntoScenes(script, maxScenes);
    console.log(`[Pipeline] Stage 1 (parse): ${scenes.length} scenes in ${((Date.now()-t0)/1000).toFixed(1)}s`);

    // ── Stage 2: Generate ALL voiceovers in parallel batches ──────────────────
    onProgress?.({ stage: STAGE_LABELS.voiceovers, percent: 8 });
    const t1 = Date.now();
    const audioPaths = scenes.map((_, i) => path.join(workDir, `scene_${i}_audio.mp3`));
    let durations: number[];

    if (customVoiceoverUrl) {
      const customAudioPath = path.join(workDir, "custom_voiceover.mp3");
      const resp = await fetch(customVoiceoverUrl);
      if (!resp.ok) {
        throw pipelineError(PIPELINE_ERROR.CUSTOM_VOICEOVER, `Failed to download custom voiceover: ${resp.status}`);
      }
      fs.writeFileSync(customAudioPath, Buffer.from(await resp.arrayBuffer()));
      const { execFile } = await import("child_process");
      const totalDuration = await new Promise<number>((resolve) => {
        execFile(FFPROBE_BIN, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", customAudioPath], (_err: unknown, stdout: string) => {
          resolve(parseFloat(stdout?.trim() ?? "60") || 60);
        });
      });
      const perScene = Math.max(totalDuration / scenes.length, 5);
      for (let i = 0; i < scenes.length; i++) {
        const start = i * perScene;
        await exec(`${FFMPEG_BIN} -y -i "${customAudioPath}" -ss ${start} -t ${perScene} -c copy "${audioPaths[i]}"`);
      }
      durations = scenes.map(() => perScene);
    } else {
      // Process voiceovers sequentially (pLimit(1)) to prevent network socket disconnects from parallel TLS connections
      const voiceLimit = pLimit(1);
      let completedVoices = 0;
      durations = await withTimeout(
        Promise.all(scenes.map((scene, i) => voiceLimit(async () => {
          const dur = await generateVoiceover(scene.text, audioPaths[i], voiceId);
          completedVoices++;
          onProgress?.({
            stage: `Creating voiceovers... (${completedVoices}/${scenes.length} done)`,
            percent: 8 + Math.round((completedVoices / scenes.length) * 10)
          });
          return dur;
        }))),
        900_000, // 15 min for all voiceovers (20+ scenes at ~15s each = 300s, plus buffer)
        "Voiceover generation stage"
      );
    }
    // Scene duration must be longer than voiceover to allow for fade-in/out and clip transitions
    const shortTargetSec: Record<string, number> = { "1": 58, "2": 118 };
    const targetTotal = shortTargetSec[videoLength];
    if (targetTotal) {
      const padded = durations.map((d) => d + 2);
      const rawTotal = padded.reduce((a, b) => a + b, 0);
      const scale = targetTotal / Math.max(rawTotal, 1);
      scenes.forEach((scene, i) => {
        scene.duration = Math.max(padded[i] * scale, durations[i] + 1.5);
      });
      const finalTotal = scenes.reduce((sum, s) => sum + s.duration, 0);
      console.log(`[Pipeline] ${videoLength}-min test: total duration ${finalTotal.toFixed(1)}s (${scenes.length} scenes)`);
    } else {
      // Vidrush pacing: tight scene length — minimal padding beyond voiceover
      scenes.forEach((scene, i) => {
        scene.duration = Math.max(durations[i] + 2, 8);
      });
    }
    console.log(`[Pipeline] Stage 2 (voiceovers): ${scenes.length} in ${((Date.now()-t1)/1000).toFixed(1)}s`);

    // ── Stage 3: Fetch AI images + Pexels clips in parallel batches ───────────
    onProgress?.({ stage: STAGE_LABELS.visuals, percent: 20 });
    const t2 = Date.now();
    const visualDedup = createVisualDedupState();

    // Sequential fetch for short tests prevents Pexels ID race duplicates; parallel for long videos
    const visualLimit = pLimit(videoLength === "1" || videoLength === "2" ? 1 : 2);
    let completedVisuals = 0;
    const sceneVisuals: string[][] = await withTimeout(
      Promise.all(scenes.map(scene => visualLimit(async () => {
        const clips = await fetchSceneVisuals(scene, workDir, videoTitle, visualDedup);
        completedVisuals++;
        onProgress?.({
          stage: `Generating AI visuals... (${completedVisuals}/${scenes.length} done)`,
          percent: 20 + Math.round((completedVisuals / scenes.length) * 25)
        });
        return clips;
      }))),
      10_800_000, // 180 min hard limit for all visuals (large scene count)
      "Visual generation stage"
    );
    console.log(`[Pipeline] Stage 3 (visuals): ${((Date.now()-t2)/1000).toFixed(1)}s`);

    // ── Save scene manifest for editor ───────────────────────────────────────
    try {
      const editorScenes: EditorScene[] = scenes.map((scene, i) => {
        const clipPaths = sceneVisuals[i] || [];
        const editorClips: EditorClip[] = clipPaths.map(clipPath => {
          const basename = path.basename(clipPath);
          // Detect source from filename pattern
          let source = "unknown";
          if (basename.includes("pexels")) source = "pexels";
          else if (basename.includes("pixabay")) source = "pixabay";
          else if (basename.includes("wikimedia")) source = "wikimedia";
          else if (basename.includes("openverse")) source = "openverse";
          else if (basename.includes("serp")) source = "serpapi";
          else if (basename.includes("_ai")) source = "ai";
          const isVideo = clipPath.endsWith(".mp4") || clipPath.endsWith(".webm");
          return { url: clipPath, type: isVideo ? "video" : "image", source };
        });
        return {
          sceneIndex: scene.index,
          title: scene.visualCue,
          narration: scene.text,
          durationMs: Math.round(scene.duration * 1000),
          clips: editorClips,
          chapterTitle: scene.chapterTitle,
        };
      });
      await updateVideoScenes(videoId, editorScenes);
      console.log(`[Pipeline] Scene manifest saved: ${editorScenes.length} scenes`);
    } catch (err) {
      console.warn(`[Pipeline] Failed to save scene manifest (non-fatal):`, (err as Error).message);
    }

    // ── Stage 4: Compose all scenes in parallel batches ───────────────────────
    onProgress?.({ stage: STAGE_LABELS.composing, percent: 47 });
    const t3 = Date.now();

    // Process compose in batches — limit to 2 to balance speed and OOM prevention
    const composeLimit = pLimit(2);
    let completedCompose = 0;
    const composedScenes = await withTimeout(
      Promise.all(
        scenes.map((scene, i) => composeLimit(async () => {
          const result = await composeSceneVideo(scene, sceneVisuals[i], audioPaths[i], scene.duration, workDir, scenes.length, enableSubtitles);
          completedCompose++;
          onProgress?.({
            stage: `Composing scenes... (${completedCompose}/${scenes.length} done)`,
            percent: 47 + Math.round((completedCompose / scenes.length) * 28)
          });
          return result;
        }))
      ),
      2400_000, // 40 min hard limit for compositing
      "Scene composition stage"
    );
    console.log(`[Pipeline] Stage 4 (compose): ${scenes.length} scenes in ${((Date.now()-t3)/1000).toFixed(1)}s`);

    // Cleanup intermediates
    for (let i = 0; i < scenes.length; i++) {
      try { fs.unlinkSync(audioPaths[i]); } catch { /* ignore */ }
      for (const clip of sceneVisuals[i]) {
        try { if (clip !== composedScenes[i]) fs.unlinkSync(clip); } catch { /* ignore */ }
      }
    }

        // ── Stage 4b: Vidrush chapter cards (yellow title cards between sections) ──
    const useChapterCards = videoLength !== "1" && videoLength !== "2";
    const orderedClips: string[] = [];
    let chapterCardCount = 0;
    for (let i = 0; i < composedScenes.length; i++) {
      const scene = scenes[i];
      const cardTitle = scene.chapterTitle || scene.sectionTitle;
      // Never open on a card — real footage first; skip script meta labels (HOOK, CTA)
      if (useChapterCards && i > 0 && isPublishableChapterTitle(cardTitle)) {
        try {
          const card = await renderChapterCard(cardTitle, i, workDir);
          if (fs.existsSync(card) && fs.statSync(card).size > 1000) {
            orderedClips.push(card);
            chapterCardCount++;
          }
        } catch (err) {
          console.warn(`[Pipeline] Chapter card ${i} failed (non-fatal):`, (err as Error).message);
        }
      }
      orderedClips.push(composedScenes[i]);
    }

    // ── Stage 5: Concatenate + intro/outro + music ────────────────────────
    onProgress?.({ stage: STAGE_LABELS.assembling, percent: 77 });
    const t4 = Date.now();
    const totalDuration =
      scenes.reduce((sum, s) => sum + s.duration, 0) + chapterCardCount * CHAPTER_CARD_DURATION;
    const finalVideoPath = await concatenateScenesWithMusic(orderedClips, workDir, videoId, totalDuration, videoTitle);
    console.log(`[Pipeline] Stage 5 (assemble+music): ${((Date.now()-t4)/1000).toFixed(1)}s`);

    // ── Stage 6: Upload to S3 ─────────────────────────────────────────────────
    onProgress?.({ stage: STAGE_LABELS.uploading, percent: 93 });
    const t5 = Date.now();
    const videoBuffer = fs.readFileSync(finalVideoPath);
    const { url } = await withTimeout(
      storagePut(`videos/${videoId}/final.mp4`, videoBuffer, "video/mp4"),
      600_000, // 10 min upload timeout for large files
      "S3 upload"
    );
    console.log(`[Pipeline] Stage 6 (upload): ${((Date.now()-t5)/1000).toFixed(1)}s, size: ${(videoBuffer.length/1024/1024).toFixed(1)}MB`);

    // Persist URL immediately so a crash during finalization cannot lose the finished video
    await updateVideoStatus(videoId, "generating_effects", {
      videoUrl: url,
      progressStep: STAGE_LABELS.complete,
      progressPercent: 95,
    }).catch((err) => console.warn(`[Pipeline] Failed to persist videoUrl for ${videoId}:`, err));

    onProgress?.({ stage: STAGE_LABELS.complete, percent: 100 });
    const totalMs = Date.now() - t0;
    console.log(`[Pipeline] Video ${videoId} COMPLETE in ${(totalMs/60000).toFixed(1)} min: ${url}`);
    return url;
  } finally {
    try {
      const { exec: execCp } = await import("child_process");
      execCp(`rm -rf "${workDir}"`);
    } catch { /* ignore */ }
  }
}

// ─── Re-render from editor scene manifest ────────────────────────────────────
/**
 * Re-renders a video using the updated scene manifest from the editor.
 * Downloads clips from their stored URLs, regenerates voiceovers, composes
 * each scene, then assembles the final video and uploads to S3.
 */
export async function rerenderFromScenes(
  videoId: number,
  scenes: EditorScene[],
  onProgress?: (step: string, pct: number) => void
): Promise<string> {
  const workDir = path.join(TMP_DIR, `fastvid_rerender_${videoId}_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    onProgress?.("Preparing re-render...", 5);

    // ── Step 1: Download all clips from their URLs ──────────────────────────
    onProgress?.("Downloading clips...", 10);
    const sceneClipPaths: string[][] = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const clipPaths: string[] = [];

      for (let j = 0; j < scene.clips.length; j++) {
        const clip = scene.clips[j];
        const ext = clip.type === "video" ? "mp4" : "jpg";
        const clipPath = path.join(workDir, `rerender_scene_${i}_clip_${j}.${ext}`);

        try {
          // If the URL is a local file path (from original pipeline), check if it exists
          if (!clip.url.startsWith("http") && fs.existsSync(clip.url)) {
            clipPaths.push(clip.url);
            continue;
          }

          // Download from URL with 15s timeout
          const resp = await fetchWithTimeout(clip.url, 15_000, `clip ${i}-${j}`);
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            fs.writeFileSync(clipPath, buf);
            if (fs.statSync(clipPath).size > 100) {
              clipPaths.push(clipPath);
            }
          }
        } catch (err) {
          console.warn(`[Rerender] Scene ${i} clip ${j} download failed (skipping):`, (err as Error).message);
        }
      }

      sceneClipPaths.push(clipPaths);
      onProgress?.(`Downloading clips... (${i + 1}/${scenes.length})`, 10 + Math.round((i + 1) / scenes.length * 20));
    }

    // ── Step 2: Generate voiceovers for all scenes ──────────────────────────
    onProgress?.("Generating voiceovers...", 30);
    const audioPaths: string[] = [];
    const durations: number[] = [];

    const voiceLimit = pLimit(1);
    await Promise.all(scenes.map((scene, i) => voiceLimit(async () => {
      const audioPath = path.join(workDir, `rerender_scene_${i}_audio.mp3`);
      try {
        const dur = await generateVoiceover(scene.narration, audioPath);
        audioPaths[i] = audioPath;
        durations[i] = dur;
      } catch (err) {
        console.warn(`[Rerender] Scene ${i} voiceover failed:`, (err as Error).message);
        // Create silent audio as fallback
        const silentDur = Math.round(scene.durationMs / 1000) || 20;
        try {
          await exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${silentDur} -c:a libmp3lame -b:a 64k "${audioPath}"`);
          audioPaths[i] = audioPath;
          durations[i] = silentDur;
        } catch {
          audioPaths[i] = audioPath;
          durations[i] = silentDur;
        }
      }
      onProgress?.(`Generating voiceovers... (${i + 1}/${scenes.length})`, 30 + Math.round((i + 1) / scenes.length * 15));
    })));

    // ── Step 3: Build Scene objects for composeSceneVideo ──────────────────
    const internalScenes: Scene[] = scenes.map((edScene, i) => ({
      index: edScene.sceneIndex,
      text: edScene.narration,
      visualCue: edScene.title ?? "scene",
      pexelsQuery: edScene.title ?? "scene",
      aiImagePrompt: edScene.title ?? "scene",
      duration: Math.max((durations[i] || 20) + 6, 10),
      chapterTitle: edScene.chapterTitle,
    }));

    // ── Step 4: Compose all scenes ──────────────────────────────────────────
    onProgress?.("Composing scenes...", 45);
    const composeLimit = pLimit(2);
    let completedCompose = 0;

    const composedScenes = await Promise.all(
      internalScenes.map((scene, i) => composeLimit(async () => {
        // If no clips downloaded, generate a color fallback
        const clips = sceneClipPaths[i].length > 0
          ? sceneClipPaths[i]
          : [await generateColorFallback(i, scene.duration + 1, workDir)];

        const result = await composeSceneVideo(
          scene,
          clips,
          audioPaths[i],
          scene.duration,
          workDir,
          internalScenes.length,
          true // enable subtitles
        );
        completedCompose++;
        onProgress?.(
          `Composing scenes... (${completedCompose}/${internalScenes.length})`,
          45 + Math.round((completedCompose / internalScenes.length) * 30)
        );
        return result;
      }))
    );

    // ── Step 5: Chapter cards DISABLED — user requested no on-screen text ───────────────────────────────────────────────────────────────────────────
    const orderedClips: string[] = [...composedScenes];

    // ── Step 6: Concatenate + music ───────────────────────────────────────────────────────────────────────────
    onProgress?.("Assembling final video...", 78);
    const videoTitle = (internalScenes[0] as any)?.title ?? `Video ${videoId}`;
    const totalDuration = internalScenes.reduce((sum, s) => sum + s.duration, 0); // No chapter cards
    const finalVideoPath = await concatenateScenesWithMusic(orderedClips, workDir, videoId, totalDuration, videoTitle);

    // ── Step 7: Upload to S3 ────────────────────────────────────────────────
    onProgress?.("Uploading re-rendered video...", 93);
    const videoBuffer = fs.readFileSync(finalVideoPath);
    const { url } = await withTimeout(
      storagePut(`videos/${videoId}/edited_final.mp4`, videoBuffer, "video/mp4"),
      600_000,
      "S3 upload (re-render)"
    );

    onProgress?.("Re-render complete!", 100);
    console.log(`[Rerender] Video ${videoId} re-render COMPLETE: ${url}`);
    return url;
  } finally {
    try {
      const { exec: execCp } = await import("child_process");
      execCp(`rm -rf "${workDir}"`);
    } catch { /* ignore */ }
  }
}
