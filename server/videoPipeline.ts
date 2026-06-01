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
import { updateVideoScenes, type EditorScene, type EditorClip } from "./db";
import pLimit from "p-limit";
import { generateGrokVideo } from "./_core/grokVideo";
import { generateVeoVideo } from "./_core/veoVideo";
import { generateMetaMovieGen } from "./_core/metaMovieGen";
import { generateHiggsfieldTextToVideo, generateHiggsfieldImageToVideo } from "./_core/higgsfieldVideo";
import { sanitizeForDrawtext, sanitizeForDrawtextStrict } from "./ffmpegSanitize";
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

// Use /var/tmp instead of os.tmpdir() (/tmp) — /var/tmp is persistent and not cleaned
// by systemd-tmpfiles or sandbox cleanup. /tmp can be wiped during long pipeline runs.
const TMP_DIR = '/var/tmp';
// Use lower resolution on Railway (no Forge key = Railway environment) to avoid OOM
// Railway free tier has ~512MB RAM; 1280x720 FFmpeg compositing OOM-kills the process
const IS_RAILWAY = !process.env.BUILT_IN_FORGE_API_KEY;
// 1080p resolution for professional YouTube quality
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;

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
    if ((err as Error).name === 'AbortError') throw new Error(`Timeout: ${label} exceeded ${Math.round(timeoutMs / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${Math.round(ms / 1000)}s`)), ms)
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
async function parseScriptIntoScenes(script: string, maxScenes: number): Promise<Scene[]> {
  const response = await withTimeout(
    invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a video editor at a professional YouTube documentary channel (Vox/Wendover Productions style). Parse the given script into exactly ${maxScenes} scenes for video production.

For each scene, extract:
- text: The narration text for this scene (2-5 sentences, what will be spoken). Max 700 characters. Keep it natural and conversational. Do NOT truncate — include the full narration for this scene.
- visualCue: A VERY SPECIFIC, LITERAL 4-8 word description of exactly what footage to show. Extract this from [VISUAL: ...] tags in the script if present. Examples:
  "aerial drone shot Brussels city center", "black white 1950s highway construction", "close-up tram narrow medieval street", "cyclist riding through Amsterdam intersection"
- pexelsQuery: The PRIMARY Pexels/stock video search query (3-6 words, English). Must match the visual cue literally.
- pexelsQueries: Array of 5 search queries in DECREASING specificity order. Start very specific, end more general. All in English.
  Example for "aerial drone shot Brussels city center":
  ["Brussels aerial drone city", "Belgium capital city aerial", "European city aerial drone", "historic city center aerial", "city skyline aerial drone"]
  Example for "close-up tram narrow medieval street":
  ["tram medieval street city", "historic tram cobblestone street", "European tram old city", "tram urban street", "city tram transportation"]
- aiImagePrompt: A detailed, vivid image generation prompt (25-40 words) for a cinematic, photorealistic scene matching the visual cue. Include: subject, setting, lighting, mood, camera angle, style. Examples:
  "Cinematic aerial drone view of Brussels historic city center at golden hour, warm light on medieval rooftops, slight haze, photorealistic, 8K, wide angle lens"
  "Black and white archival photograph of 1950s American highway construction, workers and bulldozers, dramatic shadows, documentary style"
- sectionTitle: The ## section heading this scene belongs to (from the script). Use the EXACT heading text (without ## prefix). If this is the FIRST scene of a new section, set sectionTitle to the section name. For subsequent scenes in the same section, set sectionTitle to empty string "".
  Example: script has "## ROOTS OF DIVERGENCE" → first scene of that section has sectionTitle="ROOTS OF DIVERGENCE", subsequent scenes have sectionTitle=""
- personNames: Array of FULL NAMES of all real people (celebrities, politicians, athletes, public figures, historical figures) explicitly mentioned by name in this scene's narration text. Include ONLY names that appear in the text field. If no person is mentioned, return an empty array [].
  Examples: ["Kylie Jenner"], ["Elon Musk", "Jeff Bezos"], ["Napoleon Bonaparte"], []
- highlightWords: Array of 2-3 POWER WORDS from this scene's narration — the most impactful, emotionally resonant, or statistically significant words. These will be displayed as bold kinetic text overlays on screen. Choose words that create visual impact: numbers ("$47 BILLION"), strong verbs ("COLLAPSED"), key nouns ("MONOPOLY"), or dramatic adjectives ("UNPRECEDENTED"). Always UPPERCASE. Examples: ["$47 BILLION", "COLLAPSED"], ["MONOPOLY", "EXPOSED"], ["UNPRECEDENTED", "CRISIS"]
- brollQueries: Array of exactly 2 specific B-roll search queries for cutaway footage that would visually complement this scene. These should be different from pexelsQuery — think of supporting footage that adds visual variety. Examples: ["stock market trading floor", "money bills close up"], ["factory workers assembly line", "industrial machinery"], ["city traffic aerial view", "commuters subway station"]
- statCallout: ONE key statistic, number, percentage, year, or measurement from this scene that would make a powerful on-screen callout box. Format as a short string: "45°C", "2%", "$4B", "1950s", "97%". If no strong stat exists, return empty string "".
- literalVisualCue: A hyper-specific 3-5 word description of the EXACT physical object or action being spoken at the most important moment in this scene. Used for ultra-precise B-roll search. Examples: "horse cart cobblestone bruges", "earthmover highway construction 1950s", "tram arriving pedestrian street", "aerial drone brussels rooftops". Must be more literal and specific than visualCue.
IMPORTANT:
- Return exactly ${maxScenes} scenes covering the entire script evenly
- Extract [VISUAL: ...] tags from the script to use as visualCue when available
- Keep text natural (max 700 chars each) — this is spoken narration. Include full sentences, do NOT truncate mid-sentence
- Make pexelsQuery LITERAL and SPECIFIC — it will be used to search for real footage
- Make aiImagePrompt vivid, cinematic and highly detailed
- Scenes should flow naturally — each scene is ~2-4 seconds of footage (reference: 1-4s hard cuts)
- sectionTitle is ONLY non-empty for the FIRST scene of each new ## section
- personNames MUST be extracted from the text field only — do not invent names not present in the text
- highlightWords MUST be 2-3 words max, always UPPERCASE, chosen for maximum visual impact
- brollQueries MUST be exactly 2 queries, different from pexelsQuery, for visual variety`,
        },
        {
          role: "user",
          content: `Parse this script into exactly ${maxScenes} scenes:\n\n${script.slice(0, 12000)}`,
        },
      ],
      response_format: {
        type: "json_schema",
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
                    aiImagePrompt: { type: "string" },
                    sectionTitle: { type: "string" },
                    highlightWords: { type: "array", items: { type: "string" } },
                    brollQueries: { type: "array", items: { type: "string" } },
                    statCallout: { type: "string" },
                    literalVisualCue: { type: "string" },
                  },
                  required: ["text", "visualCue", "pexelsQuery", "pexelsQueries", "personNames", "aiImagePrompt", "sectionTitle", "highlightWords", "brollQueries", "statCallout", "literalVisualCue"],
                  additionalProperties: false,
                },
              },
            },
            required: ["scenes"],
            additionalProperties: false,
          },
        },
      },
    }),
    90_000,  // 90s for large scene count parsing
    "Parse scenes"
  );

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Failed to parse script into scenes");
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  const rawScenes = (parsed.scenes as (Omit<Scene, "index" | "duration"> & { sectionTitle?: string })[]).slice(0, maxScenes);
  return rawScenes.map((s, i) => {
    const rawS = s as Record<string, unknown>;
    const primaryQuery = (s.pexelsQuery?.trim() || s.visualCue || "cinematic background");
    const extraQueries = (rawS.pexelsQueries as string[] | undefined) || [];
    // Build a deduped list: primary first, then LLM-generated variants
    const allQueries = [primaryQuery, ...extraQueries.filter(q => q && q !== primaryQuery)];
    // Extract person names from the LLM response
    const personNames = ((rawS.personNames as string[] | undefined) || [])
      .filter(n => typeof n === 'string' && n.trim().length > 0)
      .map(n => n.trim());
    // Extract highlight words (LLM-generated power words for kinetic typography)
    const highlightWords = ((rawS.highlightWords as string[] | undefined) || [])
      .filter(w => typeof w === 'string' && w.trim().length > 0)
      .map(w => w.trim().toUpperCase())
      .slice(0, 3); // max 3 words
    // Extract B-roll queries (2 specific queries for cutaway footage)
    const brollQueries = ((rawS.brollQueries as string[] | undefined) || [])
      .filter(q => typeof q === 'string' && q.trim().length > 0)
      .slice(0, 2); // max 2 queries
    // Extract stat callout (1 key number/stat for yellow corner box overlay)
    const statCallout = typeof rawS.statCallout === 'string' ? rawS.statCallout.trim().slice(0, 20) : '';
    // Extract literal visual cue (hyper-specific B-roll search query)
    const literalVisualCue = typeof rawS.literalVisualCue === 'string' ? rawS.literalVisualCue.trim() : '';
    return {
      ...s,
      index: i,
      duration: 0,
      pexelsQuery: literalVisualCue || primaryQuery, // use literalVisualCue as primary if available
      pexelsQueries: literalVisualCue ? [literalVisualCue, ...allQueries] : allQueries,
      personNames,
      highlightWords,
      brollQueries,
      statCallout,
      aiImagePrompt: s.aiImagePrompt?.trim() || `Cinematic ${s.visualCue || "landscape"}, dramatic lighting, photorealistic, 8K`,
      // Store sectionTitle as chapterTitle if it's the first scene of a section
      isChapterCard: false,
      chapterTitle: rawS.sectionTitle as string | undefined,
    };
  });
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
          throw new Error(`Fish Audio HTTP ${response.status}: ${errText.slice(0, 200)}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        if (audioBuffer.length < 100) throw new Error("Fish Audio returned empty audio");

        fs.writeFileSync(outputPath, audioBuffer);
        console.log(`[Pipeline] Fish Audio TTS written: ${audioBuffer.length} bytes to ${outputPath}`);

        let durationSec = Math.max(3, Math.round(audioBuffer.length / 40000));
        try {
          const { execSync: es } = await import('child_process');
          const ffprobePaths = ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', 'ffprobe'];
          for (const probePath of ffprobePaths) {
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
          throw new Error(`ElevenLabs HTTP ${response.status}: ${errText.slice(0, 200)}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        if (audioBuffer.length < 100) throw new Error("ElevenLabs returned empty audio");

        fs.writeFileSync(outputPath, audioBuffer);
        console.log(`[Pipeline] ElevenLabs TTS written: ${audioBuffer.length} bytes to ${outputPath}`);

        let durationSec = 5;
        try {
          const { execSync: es } = await import('child_process');
          const ffprobePaths = ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', 'ffprobe'];
          for (const probePath of ffprobePaths) {
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
      if (!gResp.ok) throw new Error(`gTTS HTTP ${gResp.status}`);
      const buf = Buffer.from(await gResp.arrayBuffer());
      if (buf.length < 100) throw new Error('gTTS empty response');
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
      const probeOut = es(`"/usr/bin/ffprobe" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`, { encoding: 'utf8', timeout: 8000 });
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
  extraQueries?: string[]
): Promise<string[]> {
  if (!PEXELS_API_KEY) return [];

  const results: string[] = [];

  // Build query list: LLM-generated queries first (most specific → least specific),
  // then generic cinematic fallbacks as last resort
  const queryList = [
    ...(extraQueries && extraQueries.length > 0 ? extraQueries : [query]),
    'cinematic nature landscape', 'aerial city drone', 'documentary footage',
  ];
  // Deduplicate
  const seen = new Set<string>();
  const uniqueQueries = queryList.filter(q => { if (seen.has(q)) return false; seen.add(q); return true; });

  for (const currentQuery of uniqueQueries) {
    if (results.length >= count) break; // Stop if we have enough clips

    try {
      // HD quality: large size (min 1280px), landscape orientation, fetch 15 candidates
      const searchUrl = `https://api.pexels.com/videos/search?query=${encodeURIComponent(currentQuery)}&per_page=15&size=large&orientation=landscape`;
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

    // Filter: min 3s duration, sort by resolution descending (best quality first)
    const candidates = searchData.videos
      .filter(v => v.duration >= 3)
      .sort((a, b) => {
        // Prefer videos with higher-resolution files
        const aMax = Math.max(...a.video_files.map(f => f.width));
        const bMax = Math.max(...b.video_files.map(f => f.width));
        return bMax - aMax;
      })
      .slice(0, count * 3); // Take top candidates by quality

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

        const rawPath = path.join(workDir, `scene_${sceneIndex}_pexels_${idx}_raw.mp4`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_pexels_${idx}.mp4`);

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
        const FFPROBE_BIN = '/usr/bin/ffprobe';
        try {
          const probeCmd = `${FFPROBE_BIN} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${rawPath}" 2>&1`;
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
          const streamCheckCmd = `${FFPROBE_BIN} -v error -select_streams v:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${rawPath}" 2>&1`;
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

        const loopFlag = video.duration < clipDuration ? `-stream_loop -1` : "";
        // Ken Burns effect: 5-10% zoom (like reference video) with slow pan
        // NO fade-in/out on individual clips (hard cuts between scenes)
        const panX = (sceneIndex + idx) % 3 === 0 ? `(iw-${VIDEO_WIDTH})/2*t/${clipDuration}` :
                     (sceneIndex + idx) % 3 === 1 ? `(iw-${VIDEO_WIDTH})/2*(1-t/${clipDuration})` :
                     `(iw-${VIDEO_WIDTH})/2`;
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y ${loopFlag} -i "${rawPath}" ` +
            `-t ${clipDuration} ` +
            `-vf "scale=${Math.round(VIDEO_WIDTH * 1.08)}:${Math.round(VIDEO_HEIGHT * 1.08)}:force_original_aspect_ratio=increase,` +
            `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:${panX}:(ih-${VIDEO_HEIGHT})/2" ` +
            `-c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p "${outPath}"`
          ),
          45_000,
          `Trim Pexels clip ${idx} scene ${sceneIndex}`
        );

        try { fs.unlinkSync(rawPath); } catch { /* ignore */ }

        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1_000) return outPath;
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
  sceneIndex: number
): Promise<string[]> {
  if ((!PEXELS_API_KEY && !PIXABAY_API_KEY) || !brollQueries || brollQueries.length === 0) return [];
  const results: string[] = [];
  for (let qi = 0; qi < brollQueries.length && results.length < 1; qi++) {
    const query = brollQueries[qi];
    if (!query || !query.trim()) continue;
    try {
      const searchUrl = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&size=large&orientation=landscape`;
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
      const candidates = searchData.videos.filter(v => v.duration >= 3).slice(0, 3);
      for (const video of candidates) {
        if (results.length >= 2) break;
        const videoFile = video.video_files
          .filter(f => f.width >= 1280 && f.width <= 1920)
          .sort((a, b) => b.width - a.width)[0]
          || video.video_files.filter(f => f.width <= 1920).sort((a, b) => b.width - a.width)[0];
        if (!videoFile?.link) continue;
        const rawPath = path.join(workDir, `scene_${sceneIndex}_broll_${qi}_raw.mp4`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_broll_${qi}.mp4`);
        try {
          const dlResp = await fetchWithTimeout(videoFile.link, 8_000, `B-roll download scene ${sceneIndex}`);
          if (!dlResp.ok) continue;
          const buffer = Buffer.from(await dlResp.arrayBuffer());
          if (buffer.length < 50_000) continue;
          fs.writeFileSync(rawPath, buffer);
          // Apply Ken Burns + fair-use color grade to B-roll
          const panX = qi % 2 === 0 ? `(iw-${VIDEO_WIDTH})/2*t/${clipDuration}` : `(iw-${VIDEO_WIDTH})/2*(1-t/${clipDuration})`;
          await withTimeout(
            exec(
              `${FFMPEG_BIN} -y -i "${rawPath}" ` +
              `-t ${clipDuration} ` +
              `-vf "scale=${Math.round(VIDEO_WIDTH * 1.08)}:${Math.round(VIDEO_HEIGHT * 1.08)}:force_original_aspect_ratio=increase,` +
              `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:${panX}:(ih-${VIDEO_HEIGHT})/2,` +
              `eq=contrast=1.08:saturation=0.95:brightness=-0.02,vignette=angle=0.5:mode=forward" ` +
              `-c:v libx264 -preset veryfast -crf 20 -an -pix_fmt yuv420p "${outPath}"`
            ),
            45_000,
            `B-roll trim scene ${sceneIndex}`
          );
          try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
          if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1_000) {
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
  suffix: string = "pixabay"
): Promise<string[]> {
  if (!PIXABAY_API_KEY) return [];
  const results: string[] = [];

  // Build query list: primary query + cinematic fallbacks
  const queryList = [query, 'cinematic nature landscape', 'aerial city drone'];
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
          videos: {
            large?: { url: string; width: number; height: number; size: number };
            medium?: { url: string; width: number; height: number; size: number };
            small?: { url: string; width: number; height: number; size: number };
          };
        }>;
      };

      if (!searchData.hits?.length) continue;

      // Filter: min 3s duration, sort by resolution descending
      const candidates = searchData.hits
        .filter(v => v.duration >= 3)
        .sort((a, b) => {
          const aW = a.videos.large?.width ?? a.videos.medium?.width ?? 0;
          const bW = b.videos.large?.width ?? b.videos.medium?.width ?? 0;
          return bW - aW;
        })
        .slice(0, count * 2);

      for (let idx = 0; idx < candidates.length && results.length < count; idx++) {
        const video = candidates[idx];
        // Prefer large (1080p) → medium (720p) → small
        const videoFile =
          video.videos.large?.url ? video.videos.large :
          video.videos.medium?.url ? video.videos.medium :
          video.videos.small?.url ? video.videos.small : null;

        if (!videoFile?.url) continue;

        const rawPath = path.join(workDir, `scene_${sceneIndex}_${suffix}_${idx}_raw.mp4`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${suffix}_${idx}.mp4`);

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
              if (buf.length < 50_000) { await new Promise(r => setTimeout(r, 1000)); continue; }
              buffer = buf;
            } catch (dlErr) {
              console.warn(`[Pipeline] Pixabay download attempt ${attempt + 1} failed:`, dlErr);
              await new Promise(r => setTimeout(r, 1000));
            }
          }
          if (!buffer) continue;

          fs.writeFileSync(rawPath, buffer);

          // Validate with ffprobe
          const FFPROBE_BIN = '/usr/bin/ffprobe';
          try {
            const probeResult = await withTimeout(
              exec(`${FFPROBE_BIN} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${rawPath}" 2>&1`),
              10_000, `Probe Pixabay clip ${idx}`
            );
            const dur = parseFloat(typeof probeResult === 'string' ? probeResult : (probeResult as any).stdout || '');
            if (isNaN(dur) || dur < 1) { try { fs.unlinkSync(rawPath); } catch { /**/ } continue; }
          } catch { try { fs.unlinkSync(rawPath); } catch { /**/ } continue; }

          // Ken Burns + trim
          const loopFlag = video.duration < clipDuration ? '-stream_loop -1' : '';
          const panX = (sceneIndex + idx) % 3 === 0
            ? `(iw-${VIDEO_WIDTH})/2*t/${clipDuration}`
            : (sceneIndex + idx) % 3 === 1
              ? `(iw-${VIDEO_WIDTH})/2*(1-t/${clipDuration})`
              : `(iw-${VIDEO_WIDTH})/2`;

          await withTimeout(
            exec(
              `${FFMPEG_BIN} -y ${loopFlag} -i "${rawPath}" ` +
              `-t ${clipDuration} ` +
              `-vf "scale=${Math.round(VIDEO_WIDTH * 1.08)}:${Math.round(VIDEO_HEIGHT * 1.08)}:force_original_aspect_ratio=increase,` +
              `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:${panX}:(ih-${VIDEO_HEIGHT})/2" ` +
              `-c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p "${outPath}"`
            ),
            45_000,
            `Trim Pixabay clip ${idx} scene ${sceneIndex}`
          );

          try { fs.unlinkSync(rawPath); } catch { /**/ }

          if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1_000) {
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

// ─── 3c2. Wikimedia Commons Image Search ────────────────────────────────────
// Searches Wikimedia Commons for freely licensed images (good for celebrities, news, etc.)
async function fetchWikimediaImages(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2
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
        const imgPath = path.join(workDir, `scene_${sceneIndex}_wiki_${i}.jpg`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_wiki_${i}.mp4`);
        const imgResp = await withTimeout(
          fetch(imageInfo.url, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }),
          15_000,
          `Wikimedia download scene ${sceneIndex}`
        );
        if (!imgResp.ok) continue;
        const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
        if (imgBuffer.length < 10_000) continue;
        fs.writeFileSync(imgPath, imgBuffer);

        // Convert image to video with Ken Burns effect: 5-10% zoom (like reference video)
        // NO fade-in/out on individual clips (hard cuts between scenes)
        const zoomDir = (sceneIndex + i) % 2 === 0 ? 'in' : 'out';
        const startScale = zoomDir === 'in' ? 1.0 : 1.07;
        const endScale = zoomDir === 'in' ? 1.07 : 1.0;
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y -loop 1 -i "${imgPath}" ` +
            `-t ${duration} ` +
            `-vf "scale=${Math.round(VIDEO_WIDTH * 1.10)}:${Math.round(VIDEO_HEIGHT * 1.10)}:force_original_aspect_ratio=increase,` +
            `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(iw-${VIDEO_WIDTH})/2:(ih-${VIDEO_HEIGHT})/2,` +
            `zoompan=z='if(lte(zoom,1.0),${startScale},min(zoom+${((endScale - startScale) / (duration * 25)).toFixed(5)},${endScale}))':d=${duration * 25}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=25" ` +
            `-c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p "${outPath}"`
          ),
          45_000,
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
  maxResults: number = 2
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

        const imgPath = path.join(workDir, `scene_${sceneIndex}_openverse_${i}.jpg`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_openverse_${i}.mp4`);

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
  count: number = 3
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

        const imgPath = path.join(workDir, `scene_${sceneIndex}_yt_${i}.jpg`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_yt_${i}.mp4`);

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
  count: number = 2
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
        const imgPath = path.join(workDir, `scene_${sceneIndex}_serp_${i}.jpg`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_serp_${i}.mp4`);

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

        // Convert image to video with fast Ken Burns effect (scale+crop, no zoompan)
        // zoompan is O(n²) in frames and extremely slow at 1920×1080 — use scale trick instead
        const scaledW = Math.round(VIDEO_WIDTH * 1.07);
        const scaledH = Math.round(VIDEO_HEIGHT * 1.07);
        const cropX = (sceneIndex + i) % 2 === 0 ? '0' : `${scaledW - VIDEO_WIDTH}`;
        const cropY = (sceneIndex + i) % 4 < 2 ? '0' : `${scaledH - VIDEO_HEIGHT}`;
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y -loop 1 -i "${imgPath}" ` +
            `-t ${duration} -r 25 ` +
            `-vf "scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,` +
            `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:${cropX}:${cropY}" ` +
            `-c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p "${outPath}"`
          ),
          60_000,
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
  // Ensure workDir exists (may have been cleaned up between pipeline stages)
  fs.mkdirSync(workDir, { recursive: true });
  const outputPath = path.join(workDir, `scene_${sceneIndex}_fallback.mp4`);
  const colors = ["0a0a1e", "0a1a2e", "1a0a2e", "0a2a1e", "1a1a0a", "2a0a1e", "0a1a1e", "1a0a1e"];
  const color = colors[sceneIndex % colors.length];

  // Verify FFmpeg binary exists before attempting
  if (!fs.existsSync(FFMPEG_BIN) && FFMPEG_BIN !== 'ffmpeg') {
    console.error(`[Pipeline] CRITICAL: FFmpeg binary not found at: ${FFMPEG_BIN}`);
  } else {
    console.log(`[Pipeline] Scene ${sceneIndex}: generating fallback video with FFmpeg: ${FFMPEG_BIN}`);
  }

  try {
    // Ensure workDir still exists (may have been cleaned between pipeline stages)
    fs.mkdirSync(workDir, { recursive: true });
    // Include silent audio stream so FFmpeg audio map works in composeSceneVideo
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "color=c=#${color}:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
        `-f lavfi -i anullsrc=r=44100:cl=stereo ` +
        `-t ${duration} -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "${outputPath}"`
      ),
      20_000, `Fallback video scene ${sceneIndex}`
    );
    console.log(`[Pipeline] Scene ${sceneIndex}: fallback video created (${(fs.statSync(outputPath).size / 1024).toFixed(0)}KB)`);
  } catch (err1) {
    console.error(`[Pipeline] Scene ${sceneIndex}: color fallback failed, trying black screen:`, err1);
    try {
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y ` +
          `-f lavfi -i "color=c=black:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
          `-f lavfi -i anullsrc=r=44100:cl=stereo ` +
          `-t ${duration} -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "${outputPath}"`
        ),
        15_000, `Black screen fallback scene ${sceneIndex}`
      );
      console.log(`[Pipeline] Scene ${sceneIndex}: black screen fallback created`);
    } catch (err2) {
      console.error(`[Pipeline] CRITICAL: Black screen fallback also failed for scene ${sceneIndex}:`, err2);
      // Write a minimal valid MP4 placeholder so the pipeline can continue
      fs.writeFileSync(outputPath, Buffer.alloc(0));
    }
  }
  return outputPath;
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

// ─── 3c2. Fetch Internet Archive Video Clips ────────────────────────────────
async function fetchInternetArchiveClips(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2
): Promise<string[]> {
  const results: string[] = [];
  try {
    // Search Internet Archive for video content matching the query
    const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+mediatype:movies&fl[]=identifier,title&rows=10&output=json`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }),
      10_000,
      `Internet Archive search scene ${sceneIndex}`
    );
    if (!searchResp.ok) return [];
    const searchData = await searchResp.json() as { response?: { docs?: Array<{ identifier: string; title: string }> } };
    const docs = searchData.response?.docs?.slice(0, count * 3) || [];
    if (!docs.length) return [];

    let fetched = 0;
    for (const doc of docs) {
      if (fetched >= count) break;
      try {
        // Get metadata for this item to find video files
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

        // Pick smallest video file to avoid large downloads
        const videoFile = videoFiles.sort((a, b) =>
          parseInt(a.size || '999999999') - parseInt(b.size || '999999999')
        )[0];

        const videoUrl = `https://archive.org/download/${doc.identifier}/${encodeURIComponent(videoFile.name)}`;
        const outPath = path.join(workDir, `scene_${sceneIndex}_archive_${fetched}.mp4`);
        const tmpPath = path.join(workDir, `scene_${sceneIndex}_archive_${fetched}_tmp.mp4`);

        // Download with size limit (max 50MB, 30s timeout)
        const dlResp = await fetchWithTimeout(
          videoUrl,
          30_000,
          `Internet Archive download scene ${sceneIndex}`,
          { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }
        );
        if (!dlResp.ok) continue;

        // Use arrayBuffer with size check (max 50MB)
        const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024; // 50MB
        const arrayBuf = await dlResp.arrayBuffer();
        if (arrayBuf.byteLength > MAX_ARCHIVE_SIZE) {
          console.warn(`[Pipeline] Scene ${sceneIndex}: Archive clip too large (${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)}MB), skipping`);
          continue;
        }
        fs.writeFileSync(tmpPath, Buffer.from(arrayBuf));

        // Extract a clip from the middle of the video (skip first 10s to avoid intros)
        const clipStart = 10;
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y -ss ${clipStart} -i "${tmpPath}" -t ${duration} ` +
            `-vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}" ` +
            `-c:v libx264 -preset veryfast -crf 22 -an -pix_fmt yuv420p "${outPath}"`
          ),
          45_000,
          `Internet Archive clip extract scene ${sceneIndex}`
        );
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
          results.push(outPath);
          fetched++;
          console.log(`[Pipeline] Scene ${sceneIndex}: Internet Archive clip added: ${doc.title}`);
        }
      } catch (err) {
        console.warn(`[Pipeline] Scene ${sceneIndex}: Archive item ${doc.identifier} failed:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Internet Archive search failed:`, (err as Error).message);
  }
  return results;
}

// ─── 3c3. Fetch YouTube CC Video Clips via Cloud Computer Download Service ──────
// Uses YouTube Data API v3 to search for Creative Commons videos, then downloads
// them via the cloud computer service (yt-dlp ANDROID_VR client — no cookies needed).
// Accepts multiple query variants (specific→broad) and tries each until enough clips found.
async function fetchYouTubeCCClips(
  queries: string | string[],
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2
): Promise<string[]> {
  const results: string[] = [];

  const youtubeApiKey = process.env.YOUTUBE_API_KEY;

  // Need YouTube Data API for search; download handled by cloud computer service
  if (!youtubeApiKey) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: YouTube CC skipped — missing YOUTUBE_API_KEY`);
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

        try {
          // Use cloud computer download service (yt-dlp with ANDROID_VR client — no cookies needed)
          // The cloud computer (34.24.188.157:8765) runs yt-dlp + ffmpeg and returns ready clip bytes
          // This bypasses YouTube's IP-locked CDN URLs which only work from the requesting server's IP
          const CLOUD_DL_SERVICE = 'http://34.24.188.157:8765';
          const clipStart = 15; // Skip first 15s to avoid intros
          const outPath = path.join(workDir, `scene_${sceneIndex}_ytcc_${fetched}.mp4`);

          const dlUrl = `${CLOUD_DL_SERVICE}/download?id=${videoId}&duration=${duration}&start=${clipStart}`;
          const dlResp = await fetchWithTimeout(
            dlUrl,
            90_000, // 90s timeout for download + ffmpeg
            `YouTube CC cloud download scene ${sceneIndex}`
          );
          if (!dlResp.ok) {
            const errText = await dlResp.text().catch(() => '');
            console.warn(`[Pipeline] Scene ${sceneIndex}: Cloud DL service error ${dlResp.status} for ${videoId}: ${errText.slice(0, 100)}`);
            continue;
          }
          const MAX_YT_SIZE = 80 * 1024 * 1024; // 80MB
          const arrayBuf = await dlResp.arrayBuffer();
          if (arrayBuf.byteLength > MAX_YT_SIZE) {
            console.warn(`[Pipeline] Scene ${sceneIndex}: YouTube CC clip too large (${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)}MB), skipping`);
            continue;
          }
          fs.writeFileSync(outPath, Buffer.from(arrayBuf));

          if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
            results.push(outPath);
            downloadedIds.add(videoId);
            fetched++;
            console.log(`[Pipeline] Scene ${sceneIndex}: ✅ YouTube CC clip downloaded: "${item.snippet?.title}" (${videoId})`);
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
        reject(new Error(`Transform timeout scene ${sceneIndex} clip ${clipIndex}`));
      }, TRANSFORM_TIMEOUT_MS);
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-200)}`));
      });
      child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
    });
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5_000) {
      try { fs.unlinkSync(inputPath); } catch { /* ignore */ }
      console.log(`[Pipeline] Scene ${sceneIndex}: clip ${clipIndex} transformed for fair use`);
      return outputPath;
    }
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: fair-use transform failed for clip ${clipIndex}:`, (err as Error).message);
  }
  // If transform failed or timed out, return original
  return inputPath;
}

// ─── 3e. Fetch All Visuals for a Scene ───────────────────────────────────────
// Returns array of valid clip paths (AI image first, then Pexels clips)
async function fetchSceneVisuals(
  scene: Scene,
  workDir: string,
  videoTitle?: string
): Promise<string[]> {
   const halfDur = Math.max(3, Math.ceil(scene.duration / 3));
  const aiClipPath = path.join(workDir, `scene_${scene.index}_ai.mp4`);

  // Build subject-aware queries using per-scene person names (most specific) or global videoTitle (fallback)
  // Priority: scene.personNames[0] > videoTitle > no prefix
  // This ensures every person mentioned in the narration appears in the corresponding scene's footage
  const scenePersons = (scene.personNames || []).filter(n => n.trim().length > 0);
  const primarySubject = scenePersons.length > 0
    ? scenePersons[0]  // Use first person name mentioned in this scene
    : videoTitle ? videoTitle.replace(/[^a-zA-Z0-9 ]/g, '').trim().split(' ').slice(0, 3).join(' ') : '';
  // For scenes with multiple people, also search for the second person
  const secondarySubject = scenePersons.length > 1 ? scenePersons[1] : '';
  // Build queries: "Kylie Jenner luxury lifestyle" or "Elon Musk Tesla factory"
  const buildSubjectQuery = (subject: string, cue: string) =>
    subject ? `${subject} ${cue}`.slice(0, 100) : cue;
  const wikimediaQuery = buildSubjectQuery(primarySubject, scene.visualCue);
  // If there's a secondary person, also search for them in Wikimedia
  const wikimediaQuery2 = secondarySubject ? buildSubjectQuery(secondarySubject, scene.visualCue) : null;

  // Build SerpAPI + Openverse query: person name + visual cue for best celebrity image results
  const serpQuery = buildSubjectQuery(primarySubject, scene.visualCue);
  const serpQuery2 = secondarySubject ? buildSubjectQuery(secondarySubject, scene.visualCue) : null;
  // Openverse: search by person name alone for best portrait results, fall back to full query
  const openverseQuery = primarySubject || buildSubjectQuery(primarySubject, scene.visualCue);
  const openverseQuery2 = secondarySubject || null;

  // Build YouTube CC query variants: use pexelsQueries (specific→broad) prefixed with subject name.
  // Strategy: try specific query first (e.g. "Elon Musk Pretoria"), then broader fallbacks
  // (e.g. "Elon Musk South Africa", "Elon Musk childhood", "Elon Musk").
  // This maximises CC video hits while keeping results relevant.
  const buildYouTubeCCQueryVariants = (subject: string, pexelsQueries: string[]): string[] => {
    const variants: string[] = [];
    // OPTIMIZED: Only 2 query variants to reduce YouTube API rate limiting
    // 1. PERSON-SPECIFIC QUERY FIRST (if subject looks like a person name)
    if (subject && subject.split(' ').length >= 1) {
      const personQuery = `${subject} interview`;
      if (personQuery.length <= 50) variants.push(personQuery);
    }
    // 2. Subject + topic (combined query for better results)
    if (subject && pexelsQueries[0]) {
      const shortCue = pexelsQueries[0].split(' ').slice(0, 2).join(' ');
      const combined = `${subject} ${shortCue}`.slice(0, 50);
      if (combined.trim() && !variants.includes(combined)) variants.push(combined);
    }
    // Fallback: just subject if no variants
    if (variants.length === 0 && subject) variants.push(subject);
    return variants;
  };
  const allPexelsQueries = scene.pexelsQueries || [scene.pexelsQuery || scene.visualCue];
  const youtubeQueryVariants = buildYouTubeCCQueryVariants(primarySubject, allPexelsQueries);
  const youtubeQuery2Variants = secondarySubject ? buildYouTubeCCQueryVariants(secondarySubject, allPexelsQueries) : null;
  // For thumbnail search: use first variant (most specific)
  const youtubeQuery = youtubeQueryVariants[0] || primarySubject;
  const youtubeQuery2 = youtubeQuery2Variants?.[0] || null;

  // Build Internet Archive query: use literalVisualCue or pexelsQuery for best results
  const archiveQuery = buildSubjectQuery(primarySubject, scene.pexelsQuery || scene.visualCue);

  // ── PHASE 1: Free sources — YouTube CC FIRST (real video clips via cloud computer service)
  // YouTube Creative Commons videos are the PRIMARY source — always searched first.
  // Internet Archive is the SECONDARY source for real video clips.
  // YouTube thumbnails, Pexels, Pixabay, Wikimedia, Openverse, SerpAPI are fallbacks.
  // Run all FREE sources in parallel. Only invoke paid AI generators (Runway etc.) if free sources
  // return fewer than 2 clips — keeping costs minimal.
  // Session 44 (2026-06-01): YouTube CC + Internet Archive DISABLED.
  // Reason: YouTube anti-bot detection now blocks all yt-dlp clients on the cloud DL service,
  // and Internet Archive sometimes serves 400MB+ files that stall the pipeline.
  // Free sources used: YouTube thumbnails (high-res jpg via Data API) + Pexels + Pixabay
  // + Wikimedia + Openverse + SerpAPI images. Pexels/Pixabay return real HD video clips.
  const ytCCResults = { status: "fulfilled" as const, value: [] as string[] };
  const ytCC2Results = { status: "fulfilled" as const, value: [] as string[] };
  const archiveResults = { status: "fulfilled" as const, value: [] as string[] };
  const [youtubeResults, youtube2Results, pexelsResults, pixabayResults, brollResults, wikimediaResults, wikimedia2Results, openverseResults, openverse2Results, serpResults, serp2Results] = await Promise.allSettled([
    fetchYouTubeThumbnails(youtubeQuery, halfDur, workDir, scene.index, 4),  // YouTube thumbnails (jpg from Data API — always works)
    youtubeQuery2 ? fetchYouTubeThumbnails(youtubeQuery2, halfDur, workDir, scene.index, 3) : Promise.resolve([]),
    fetchPexelsClips(scene.pexelsQuery, halfDur, workDir, scene.index, 3, scene.pexelsQueries),  // Pexels HD video — PRIMARY real-video source now
    fetchPixabayClips(scene.pexelsQuery, halfDur, workDir, scene.index, 2),
    Promise.resolve([]),
    fetchWikimediaImages(wikimediaQuery, halfDur, workDir, scene.index, 1),
    wikimediaQuery2 ? fetchWikimediaImages(wikimediaQuery2, halfDur, workDir, scene.index, 1) : Promise.resolve([]),
    fetchOpenverseImages(openverseQuery, halfDur, workDir, scene.index, 1),
    openverseQuery2 ? fetchOpenverseImages(openverseQuery2, halfDur, workDir, scene.index, 1) : Promise.resolve([]),
    fetchSerpAPIImages(serpQuery, halfDur, workDir, scene.index, 2),
    serpQuery2 ? fetchSerpAPIImages(serpQuery2, halfDur, workDir, scene.index, 1) : Promise.resolve([]),
  ]);

  const clips: string[] = [];

  // Collect free clips — YouTube CC FIRST, then Internet Archive, then Pexels + Pixabay + B-roll
  const ytCCClipsRaw = ytCCResults.status === "fulfilled" ? ytCCResults.value : [];
  const ytCC2ClipsRaw = ytCC2Results.status === "fulfilled" ? ytCC2Results.value : [];
  const archiveClipsRaw = archiveResults.status === "fulfilled" ? archiveResults.value : [];
  const pexelsClipsRaw = pexelsResults.status === "fulfilled" ? pexelsResults.value : [];
  const pixabayClipsRaw = pixabayResults.status === "fulfilled" ? pixabayResults.value : [];
  const brollClipsRaw = brollResults.status === "fulfilled" ? brollResults.value : [];
  const ytClipsRaw = youtubeResults.status === "fulfilled" ? youtubeResults.value : [];
  const yt2ClipsRaw = youtube2Results.status === "fulfilled" ? youtube2Results.value : [];
  // Include YouTube CC + Internet Archive + YouTube thumbnails in free stock count
  const freeStockCount = ytCCClipsRaw.length + ytCC2ClipsRaw.length + archiveClipsRaw.length + pexelsClipsRaw.length + pixabayClipsRaw.length + brollClipsRaw.length + ytClipsRaw.length + yt2ClipsRaw.length;

  // ── PHASE 2: Paid AI generators — ONLY if free sources are insufficient (< 2 clips)
  // Runway is the preferred AI generator (highest quality). Other generators run only if key is set.
  // This ensures Runway credits are spent only when stock footage is unavailable.
  const RUNWAY_CLIP_THRESHOLD = 2; // trigger Runway if Pexels+Pixabay+B-roll return fewer than this
  let runwayClip: string | null = null;
  let aiClip: string | null = null;
  let leonardoClip: string | null = null;
  let klingClip: string | null = null;
  let lumaClip: string | null = null;
  let pikaClip: string | null = null;
  let forgeClip: string | null = null;
  let grokClip: string | null = null;
  let veoClip: string | null = null;
  let metaClip: string | null = null;
  let higgsfieldTextClip: string | null = null;
  let higgsfieldImageClip: string | null = null;

  if (freeStockCount < RUNWAY_CLIP_THRESHOLD) {
    console.log(`[Pipeline] Scene ${scene.index}: only ${freeStockCount} free clip(s) found — activating AI generators (Runway + others)`);
    // Run Runway first (highest quality, preferred paid generator)
    // Then run other AI generators in parallel as additional fallbacks
    // Note: Stability AI removed from fallback chain (out of credits — causes 429 errors and long waits)
    const [runwayResult, aiResult, leonardoResult, klingResult, lumaResult, pikaResult, forgeResult, grokResult, veoResult, metaResult, higgsfieldTextResult, higgsfieldImageResult] = await Promise.allSettled([
      generateRunwayClip(scene.aiImagePrompt, null, halfDur, aiClipPath, scene.index),
      Promise.resolve(null), // Stability AI slot (disabled — no credits)
      generateLeonardoAIClip(scene.aiImagePrompt, halfDur, aiClipPath, scene.index),
      generateKlingClip(scene.aiImagePrompt, null, halfDur, aiClipPath, scene.index),
      generateLumaClip(scene.aiImagePrompt, null, halfDur, aiClipPath, scene.index),
      generatePikaClip(scene.aiImagePrompt, null, halfDur, aiClipPath, scene.index),
      generateManusForgeClip(scene.aiImagePrompt, halfDur, aiClipPath, scene.index),
      generateGrokVideoClip(scene.aiImagePrompt, halfDur, aiClipPath, scene.index),
      generateVeoVideoClip(scene.aiImagePrompt, halfDur, aiClipPath, scene.index),
      generateMetaMovieGenClip(scene.aiImagePrompt, halfDur, aiClipPath, scene.index),
      generateHiggsfieldTextToVideoClip(scene.aiImagePrompt, halfDur, aiClipPath, scene.index),
      generateHiggsfieldImageToVideoClip("", scene.aiImagePrompt, halfDur, aiClipPath, scene.index),
    ]);
    runwayClip = runwayResult.status === "fulfilled" ? runwayResult.value : null;
    aiClip = aiResult.status === "fulfilled" ? aiResult.value : null;
    leonardoClip = leonardoResult.status === "fulfilled" ? leonardoResult.value : null;
    klingClip = klingResult.status === "fulfilled" ? klingResult.value : null;
    lumaClip = lumaResult.status === "fulfilled" ? lumaResult.value : null;
    pikaClip = pikaResult.status === "fulfilled" ? pikaResult.value : null;
    forgeClip = forgeResult.status === "fulfilled" ? forgeResult.value : null;
    grokClip = grokResult.status === "fulfilled" ? grokResult.value : null;
    veoClip = veoResult.status === "fulfilled" ? veoResult.value : null;
    metaClip = metaResult.status === "fulfilled" ? metaResult.value : null;
    higgsfieldTextClip = higgsfieldTextResult.status === "fulfilled" ? higgsfieldTextResult.value : null;
    higgsfieldImageClip = higgsfieldImageResult.status === "fulfilled" ? higgsfieldImageResult.value : null;
  } else {
    console.log(`[Pipeline] Scene ${scene.index}: ${freeStockCount} free clip(s) found — skipping paid AI generators (cost saving)`);
  }

  // Add AI clips in priority order (Runway first — highest quality)
  if (runwayClip) clips.push(runwayClip);
  if (aiClip) clips.push(aiClip);
  if (leonardoClip) clips.push(leonardoClip);
  if (klingClip) clips.push(klingClip);
  if (lumaClip) clips.push(lumaClip);
  if (pikaClip) clips.push(pikaClip);
  if (forgeClip) clips.push(forgeClip);
  if (grokClip) clips.push(grokClip);
  if (veoClip) clips.push(veoClip);
  if (metaClip) clips.push(metaClip);
  if (higgsfieldTextClip) clips.push(higgsfieldTextClip);
  if (higgsfieldImageClip) clips.push(higgsfieldImageClip);

  // Collect all clips that need fair-use transformation
  // YouTube CC clips go FIRST (real video, highest relevance), then Internet Archive, then thumbnails/images
  const ytCCClips = [...ytCCClipsRaw, ...ytCC2ClipsRaw]; // Combined YouTube CC results
  const archiveClips = archiveResults.status === "fulfilled" ? archiveResults.value : [];
  const ytClips = youtubeResults.status === "fulfilled" ? youtubeResults.value : [];
  const yt2Clips = youtube2Results.status === "fulfilled" ? youtube2Results.value : [];
  const pexelsClips = pexelsResults.status === "fulfilled" ? pexelsResults.value : [];
  const pixabayClips = pixabayResults.status === "fulfilled" ? pixabayResults.value : [];
  const brollClips = brollResults.status === "fulfilled" ? brollResults.value : [];
  const wikimediaClips = wikimediaResults.status === "fulfilled" ? wikimediaResults.value : [];
  const wikimedia2Clips = wikimedia2Results.status === "fulfilled" ? wikimedia2Results.value : [];
  const openverseClips = openverseResults.status === "fulfilled" ? openverseResults.value : [];
  const openverse2Clips = openverse2Results.status === "fulfilled" ? openverse2Results.value : [];
  const serpClips = serpResults.status === "fulfilled" ? serpResults.value : [];
  const serp2Clips = serp2Results.status === "fulfilled" ? serp2Results.value : [];
  const youtubeThumbClips = [...ytClips, ...yt2Clips]; // Combined YouTube thumbnail results

  // Build list of clips needing transformation (with their clip index for color grade variety)
  // YouTube CC clips go FIRST (real CC video clips), then Internet Archive, then thumbnails/images
  type TransformJob = { path: string; clipIndex: number; needsTransform: boolean };
  const transformJobs: TransformJob[] = [
    ...ytCCClips.map((p, i) => ({ path: p, clipIndex: i, needsTransform: true })), // YouTube CC — real video, needs color grade
    ...archiveClips.map((p, i) => ({ path: p, clipIndex: ytCCClips.length + i, needsTransform: true })), // Internet Archive — real video, needs color grade
    ...ytClips.map((p, i) => ({ path: p, clipIndex: ytCCClips.length + archiveClips.length + i, needsTransform: false })), // YouTube thumbnails — already processed (zoompan)
    ...yt2Clips.map((p, i) => ({ path: p, clipIndex: ytCCClips.length + archiveClips.length + ytClips.length + i, needsTransform: false })),
    ...pexelsClips.map((p, i) => ({ path: p, clipIndex: ytCCClips.length + archiveClips.length + ytClips.length + yt2Clips.length + i, needsTransform: true })),
    ...pixabayClips.map((p, i) => ({ path: p, clipIndex: ytCCClips.length + archiveClips.length + ytClips.length + yt2Clips.length + pexelsClips.length + i, needsTransform: true })),
    ...brollClips.map((p, i) => ({ path: p, clipIndex: ytCCClips.length + archiveClips.length + ytClips.length + yt2Clips.length + pexelsClips.length + pixabayClips.length + i, needsTransform: false })),
    ...wikimediaClips.map((p, i) => ({ path: p, clipIndex: ytCCClips.length + archiveClips.length + ytClips.length + yt2Clips.length + pexelsClips.length + pixabayClips.length + brollClips.length + i, needsTransform: true })),
    ...wikimedia2Clips.map((p, i) => ({ path: p, clipIndex: ytCCClips.length + archiveClips.length + ytClips.length + yt2Clips.length + pexelsClips.length + pixabayClips.length + brollClips.length + wikimediaClips.length + i, needsTransform: true })),
    ...openverseClips.map((p, i) => ({ path: p, clipIndex: i, needsTransform: false })), // already processed
    ...openverse2Clips.map((p, i) => ({ path: p, clipIndex: i, needsTransform: false })),
    ...serpClips.map((p, i) => ({ path: p, clipIndex: ytCCClips.length + archiveClips.length + ytClips.length + yt2Clips.length + pexelsClips.length + wikimediaClips.length + wikimedia2Clips.length + openverseClips.length + i, needsTransform: true })),
    ...serp2Clips.map((p, i) => ({ path: p, clipIndex: ytCCClips.length + archiveClips.length + ytClips.length + yt2Clips.length + pexelsClips.length + wikimediaClips.length + wikimedia2Clips.length + serpClips.length + i, needsTransform: true })),
  ];

  // Run fair-use transforms in parallel (max 3 concurrent FFmpeg processes per scene)
  const transformLimit = pLimit(3);
  const transformedPaths = await Promise.all(
    transformJobs.filter(job => fs.existsSync(job.path)).map(job => transformLimit(async () => {
      if (!job.needsTransform) return job.path;
      return transformClipForFairUse(job.path, scene.text, scene.index, job.clipIndex, workDir);
    }))
  );
  clips.push(...transformedPaths.filter((p): p is string => p !== null));
  // If nothing worked, use color fallback
  if (clips.length === 0) {
    console.warn(`[Pipeline] Scene ${scene.index}: All visuals failed, using color fallback`);
    clips.push(await generateColorFallback(scene.index, scene.duration + 1, workDir));
  }
  const personLabel = scenePersons.length > 0 ? ` [persons: ${scenePersons.join(', ')}]` : '';
  const runwayLabel = runwayClip ? " ⚡Runway" : "";
  const aiLabel = freeStockCount < RUNWAY_CLIP_THRESHOLD ? " [AI fallback triggered]" : " [free stock sufficient]";
  console.log(`[Pipeline] Scene ${scene.index}${personLabel}${runwayLabel}${aiLabel}: ${clips.length} clip(s) ready (YT-CC: ${ytCCClips.length}, Archive: ${archiveClips.length}, YT-Thumbs: ${youtubeThumbClips.length}, Pexels: ${pexelsClips.length}, Pixabay: ${pixabayClips.length}, Wikimedia: ${wikimediaClips.length + wikimedia2Clips.length}, Openverse: ${openverseClips.length + openverse2Clips.length}, SerpAPI: ${serpClips.length + serp2Clips.length}, Runway: ${runwayClip ? "✓" : "✗"}, Stability: ${aiClip ? "✓" : "✗"})`);
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

// ─── 5. Compose Scene Video (multi-clip with xfade transitions) ───────────────
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

  // Ensure we have at least one valid clip
  const validClips = clips.filter(p => fs.existsSync(p) && fs.statSync(p).size > 100);

  // ── Reorder clips for better pacing ──────────────────────────────────────
  // 1) Real video footage (Pexels/Pixabay/YT-CC/Archive) FIRST — these are bewegende beelden
  // 2) Then image-based clips (YT-thumb / Openverse / Wikimedia / SerpAPI) with Ken Burns
  // 3) Cap image clips at ~30% of total to keep the video feeling like a video, not a slideshow
  // 4) Interleave so we don't get a long block of stills at the end
  const isRealVideo = (p: string) =>
    /_pexels_|_pixabay_|_ytcc_|_archive_/i.test(path.basename(p));
  const realVids = validClips.filter(isRealVideo);
  const imgClips = validClips.filter(p => !isRealVideo(p));
  const maxImgs = Math.max(1, Math.ceil(realVids.length * 0.5)); // ~30% of total once interleaved
  const limitedImgs = imgClips.slice(0, maxImgs);
  // Interleave: V V I V V I V V I ...
  const interleaved: string[] = [];
  let vi = 0, ii = 0;
  while (vi < realVids.length || ii < limitedImgs.length) {
    if (vi < realVids.length) interleaved.push(realVids[vi++]);
    if (vi < realVids.length) interleaved.push(realVids[vi++]);
    if (ii < limitedImgs.length) interleaved.push(limitedImgs[ii++]);
  }
  const orderedClips = interleaved.length > 0 ? interleaved : validClips;

  const safeClips = orderedClips.length > 0
    ? orderedClips
    : [await generateColorFallback(scene.index, duration + 1, workDir)];

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
  // Film grain: subtle noise overlay for cinematic texture (Vidrush-style)
  // noise=alls=12:allf=t adds temporal noise (changes each frame) for organic film grain look
  const filmGrain = `,noise=alls=12:allf=t`;
  // Final filter: color grade + film grain + vignette. NO fade-in/out on individual scenes
  // (hard cuts between scenes, like the reference video)
  const fadeFilter = `${colorGrade}${filmGrain}${subtitleDrawtext}${vignetteFilter}`;
  // Reference video style: HARD CUTS only between clips (no xfade/crossfade/slide)
  // Hard cuts are faster, more energetic, and match the reference video exactly.
  // Each clip is trimmed to clipDur seconds, then concatenated with a hard cut.

  // Helper: build the full overlay chain — kinetic words (top-center) + stat callout (bottom-right).
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
    if (safeClips.length >= 2) {
      // Multi-clip with hard cuts — target 2.5-3.5s per shot for kinetic pacing
      // If we have FEW clips for a long scene, we'll loop the clip list to keep cuts frequent
      const TARGET_SHOT_SEC = 3.0;
      const idealShotCount = Math.min(30, Math.max(safeClips.length, Math.ceil(duration / TARGET_SHOT_SEC)));
      // If we need more shots than we have unique clips, loop the original clip list
      const baseLen = safeClips.length;
      let extraIdx = 0;
      while (safeClips.length < idealShotCount) {
        safeClips.push(safeClips[extraIdx % baseLen]);
        extraIdx++;
      }
      const clipDur = Math.min(3.5, Math.max(2.0, duration / safeClips.length));
      const inputs = safeClips.map(c => `-i "${c}"`).join(" ");
      // fps=25 normalizes timebase for concat filter
      // Ken Burns: simple scale+crop+fps, no animated zoom punch (reference uses static Ken Burns)
      const scaleFilters = safeClips.map((_, i) => {
        return `[${i}:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},fps=25[v${i}]`;
      }).join(";");

      // Hard-cut concat: use filter_complex concat to join clips with zero-duration cuts
      // This matches the reference video exactly — no crossfades, no slides, pure hard cuts
      const concatInputLabels = safeClips.map((_, i) => `[v${i}]`).join("");
      const hardCutConcat = `;${concatInputLabels}concat=n=${safeClips.length}:v=1:a=0[concatenated]`;

      // Build overlay chain on top of concatenated (kinetic words + stat callout)
      // Input indices: 0..N-1 = clips, N = audio, N+1.. = overlay PNGs
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
          `-filter_complex "${scaleFilters}${hardCutConcat}${kineticChainStr};[${finalVideoLabel}]${fadeFilter}[vout]" ` +
          `-map "[vout]" -map "${audioIdx}:a" ` +
          `-t ${duration} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
        ),
        120_000, `Compose multi-clip scene ${scene.index}`
      );
    } else {
      // Single clip — drawtext subtitle is embedded in fadeFilter
      const clip = safeClips[0];
      const audioIdx = 1;
      const kineticBaseIdx = audioIdx + 1;
      const { extraInputs: kExtraInputs, filterChain: kChain, finalLabel: kFinalLabel } =
        buildKineticChain("scaled", kineticBaseIdx);

      const kineticInput = kExtraInputs ? ` ${kExtraInputs}` : "";
      const kineticChainStr = kChain ? kChain : "";
      const hasOverlaysSingle = kineticFrames.length > 0 || statCalloutFrame !== null;
      const finalVideoLabel = hasOverlaysSingle ? kFinalLabel : "scaled";
      // Single clip: simple scale+crop (reference uses static Ken Burns, no animated zoom)
      const singleZoomFilter = `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},fps=25`;
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y -i "${clip}" -i "${safeAudioPath}"${kineticInput} ` +
          `-filter_complex "[0:v]${singleZoomFilter}[scaled]${kineticChainStr};[${finalVideoLabel}]${fadeFilter}[vout]" ` +
          `-map "[vout]" -map "${audioIdx}:a" ` +
          `-t ${duration} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
        ),
        75_000, `Compose 1-clip scene ${scene.index}`
      );
    }
  } catch (composeErr) {
    // Last resort: simple mux (no overlays)
    console.warn(`[Pipeline] Scene ${scene.index}: compose failed, trying simple mux:`, composeErr);
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -i "${safeClips[0]}" -i "${safeAudioPath}" ` +
        `-t ${duration} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
      ),
      45_000, `Simple mux scene ${scene.index}`
    );
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
  if (validScenePaths.length === 0) throw new Error("No valid composed scene files to concatenate");

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
    throw new Error(`Concat failed: output file missing or empty at ${concatPath}`);
  }
  console.log(`[Pipeline] Concat output: ${(fs.statSync(concatPath).size / 1024 / 1024).toFixed(1)}MB`);

  // Check if concat video has an audio stream
  // Try multiple probe methods; if all fail, assume audio IS present to avoid silent videos
  let concatHasAudio = true; // default: assume audio present
  try {
    const { execSync: es } = await import("child_process");
    const ffprobePaths = ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', 'ffprobe'];
    let probed = false;
    for (const probePath of ffprobePaths) {
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
  const workDir = path.join(TMP_DIR, `fastvid_${videoId}_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const videoTitle = script.split("\n").find(l => l.trim().length > 5)?.trim().slice(0, 80) || "AI Generated Video";

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
      if (!resp.ok) throw new Error(`Failed to download custom voiceover: ${resp.status}`);
      fs.writeFileSync(customAudioPath, Buffer.from(await resp.arrayBuffer()));
      const { execFile } = await import("child_process");
      const totalDuration = await new Promise<number>((resolve) => {
        execFile('/usr/bin/ffprobe', ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", customAudioPath], (_err: unknown, stdout: string) => {
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
    // Scene duration must be at least 6 seconds longer than voiceover to allow for fade-in/out and clip transitions
    // This prevents audio cutoff when FFmpeg truncates to scene.duration
    scenes.forEach((scene, i) => { scene.duration = Math.max(durations[i] + 6, 10); });
    console.log(`[Pipeline] Stage 2 (voiceovers): ${scenes.length} in ${((Date.now()-t1)/1000).toFixed(1)}s`);

    // ── Stage 3: Fetch AI images + Pexels clips in parallel batches ───────────
    onProgress?.({ stage: STAGE_LABELS.visuals, percent: 20 });
    const t2 = Date.now();

    // Process visuals in batches — limit to 2 to balance speed and OOM prevention
    const visualLimit = pLimit(2);
    let completedVisuals = 0;
    const sceneVisuals: string[][] = await withTimeout(
      Promise.all(scenes.map(scene => visualLimit(async () => {
        const clips = await fetchSceneVisuals(scene, workDir, videoTitle);
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

        // ── Stage 4b: Chapter cards DISABLED — user requested no on-screen text ────────────
    // Chapter cards are disabled. All composed scenes are used directly.
    const CHAPTER_CARD_DURATION = 0;
    const orderedClips: string[] = [...composedScenes];

    // ── Stage 5: Concatenate + intro/outro + music ────────────────────────
    onProgress?.({ stage: STAGE_LABELS.assembling, percent: 77 });
    const t4 = Date.now();
    const totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0); // No chapter cards
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

// ─── Stability AI image for thumbnail generation ─────────────────────────────
export async function generateStabilityAIThumbnail(prompt: string): Promise<string | null> {
  if (!STABILITY_AI_API_KEY) return null;
  try {
    const formData = new FormData();
    formData.append("text_prompts[0][text]", prompt);
    formData.append("text_prompts[0][weight]", "1");
    formData.append("text_prompts[1][text]", "blurry, low quality, watermark, ugly");
    formData.append("text_prompts[1][weight]", "-1");
    formData.append("cfg_scale", "7");
    formData.append("height", "720");
    formData.append("width", "1280");
    formData.append("samples", "1");
    formData.append("steps", "25");

    const response = await withTimeout(
      fetch("https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${STABILITY_AI_API_KEY}`,
          Accept: "application/json",
        },
        body: formData,
      }),
      40_000, "Stability AI thumbnail"
    );

    if (!response.ok) return null;
    const result = await response.json() as { artifacts?: Array<{ base64: string }> };
    const b64 = result.artifacts?.[0]?.base64;
    if (!b64) return null;
    return b64; // return base64 string
  } catch {
    return null;
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
