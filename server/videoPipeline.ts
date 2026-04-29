/**
 * Fastvid — AI Video Generation Pipeline (Vidrush-level)
 *
 * Visual sourcing strategy (per scene, in priority order):
 * 1. Pexels HD video  — LLM generates a precise search query from the narration text
 *                       → real stock footage that matches the scene topic
 * 2. AI-generated image — forge ImageService generates a cinematic image
 *                         → animated with Ken Burns zoom-pan effect
 * 3. Color fallback   — solid color PNG if everything else fails
 *
 * Pipeline stages (all parallel where possible):
 * 1. Parse script into max 8 scenes + generate search queries + image prompts  (max 45 sec)
 * 2. Generate ALL voiceovers in parallel                                        (max 8 min)
 * 3. Fetch ALL visuals in parallel (Pexels video → AI image → color fallback)  (max 10 min)
 * 4. Compose each scene video in parallel                                       (max 20 min)
 *    → Subtitle lower-third overlay (canvas-rendered PNG)
 *    → Scene number badge
 *    → Fade in/out transitions
 * 5. Concatenate all scenes + mix background music                              (max 10 min)
 * 6. Upload to S3                                                               (max 5 min)
 *
 * Total hard cap: 1 hour (enforced via global timeout in routers.ts)
 */
import { exec as execCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { generateImage } from "./_core/imageGeneration";
import { storagePut } from "./storage";
import { invokeLLM } from "./_core/llm";
// @ts-ignore
import gTTS from "node-gtts";
// @ts-ignore
import ffmpegStatic from "ffmpeg-static";

const FFMPEG_BIN: string = (ffmpegStatic as unknown as string) || "ffmpeg";
const execRaw = promisify(execCb);
const exec = (cmd: string) => execRaw(cmd.replace(/^ffmpeg\b/, FFMPEG_BIN));

// Font paths (NotoSans — always available on Ubuntu)
const FONT_BOLD = "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf";
const FONT_REGULAR = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf";

// Pexels API key (injected from env)
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || "";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Scene {
  index: number;
  text: string;
  visualCue: string;
  pexelsQuery: string;   // Precise search query for Pexels video
  imagePrompt: string;   // AI image fallback prompt
  duration: number;
}

/** Result of fetching a visual for a scene */
interface VisualResult {
  type: "pexels_video" | "ai_image" | "fallback";
  filePath: string;
  isVideo: boolean;      // true = MP4 clip, false = PNG image
}

export interface PipelineProgress {
  stage: string;
  percent: number;
}

const TMP_DIR = os.tmpdir();
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const MAX_SCENES = 8;

// ─── Timeout helper ───────────────────────────────────────────────────────────
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
  parsing:    `Parsing script into ${MAX_SCENES} scenes... (max 45 sec)`,
  voiceovers: `Generating voiceovers for all ${MAX_SCENES} scenes... (max 8 min)`,
  visuals:    `Fetching scene-matched visuals (Pexels video / AI image)... (max 10 min)`,
  composing:  `Composing all ${MAX_SCENES} scenes with overlays... (max 20 min)`,
  assembling: "Assembling final video with background music... (max 10 min)",
  uploading:  "Uploading video... (max 5 min)",
  complete:   "Complete!",
};

// ─── 1. Parse Script into Scenes ─────────────────────────────────────────────
async function parseScriptIntoScenes(script: string): Promise<Scene[]> {
  const response = await withTimeout(
    invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a video production assistant. Parse the given YouTube video script into exactly ${MAX_SCENES} scenes.
For each scene, extract:
- text: The narration text (2-3 sentences max, what will be spoken)
- visualCue: A short 3-5 word description of what to show
- pexelsQuery: A precise 3-6 word search query for Pexels stock video that would find a REAL video clip matching this scene.
  Think about what visual would best illustrate the narration. Be specific but not too narrow.
  Examples:
    "Morgan Freeman owns a Cessna 414" → "vintage propeller airplane cockpit"
    "Gisele Bündchen models on runway" → "fashion model runway catwalk"
    "Scientists discovered a new planet" → "telescope observatory night sky stars"
    "The stock market crashed in 2008" → "stock market trading floor panic"
    "Electric cars are taking over" → "electric car charging station"
- imagePrompt: A detailed 15-25 word AI image generation prompt as fallback if no Pexels video found.
  Style: cinematic 4K, dramatic lighting, ultra-detailed, photorealistic.

IMPORTANT: Return exactly ${MAX_SCENES} scenes. The pexelsQuery must be in English and specific enough to find relevant footage.`,
        },
        {
          role: "user",
          content: `Parse this script into exactly ${MAX_SCENES} scenes:\n\n${script.slice(0, 8000)}`,
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
                    imagePrompt: { type: "string" },
                  },
                  required: ["text", "visualCue", "pexelsQuery", "imagePrompt"],
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
    45_000,
    "Parse scenes"
  );

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Failed to parse script into scenes");
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  const rawScenes = (parsed.scenes as Omit<Scene, "index" | "duration">[]).slice(0, MAX_SCENES);
  return rawScenes.map((s, i) => ({ ...s, index: i, duration: 0 }));
}

// ─── 2. TTS Voiceover ─────────────────────────────────────────────────────────
export async function generateVoiceover(text: string, outputPath: string): Promise<number> {
  const cleanText = text
    .replace(/[#*_`~>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\x00-\x7F]/g, "")
    .trim()
    .slice(0, 500);

  const MAX_ATTEMPTS = 3;
  const TTS_TIMEOUT_MS = 60_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const tts = gTTS("en");
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          tts.save(outputPath, cleanText, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        }),
        TTS_TIMEOUT_MS,
        `TTS attempt ${attempt}`
      );

      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        const stats = fs.statSync(outputPath);
        return Math.max(3, Math.ceil(stats.size / 2000));
      }
      throw new Error("TTS output file is empty or missing");
    } catch (err) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      if (isLastAttempt) {
        console.warn(`[Pipeline] TTS failed after ${MAX_ATTEMPTS} attempts, using silent fallback:`, err);
        const estimatedDuration = Math.max(3, Math.ceil(cleanText.split(" ").length / 2.5));
        try {
          await withTimeout(
            exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${estimatedDuration} -c:a libmp3lame -b:a 128k "${outputPath}" 2>/dev/null`),
            15_000,
            "Silent audio fallback"
          );
        } catch {
          const silentMp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(413).fill(0)]);
          fs.writeFileSync(outputPath, silentMp3);
        }
        return estimatedDuration;
      }
      const backoffMs = Math.pow(2, attempt) * 1000;
      console.warn(`[Pipeline] TTS attempt ${attempt} failed, retrying in ${backoffMs}ms:`, err);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  return 5;
}

// ─── 3a. Pexels Video Fetching ────────────────────────────────────────────────
/**
 * Searches Pexels for a video matching the scene's pexelsQuery.
 * Downloads the best available HD clip (720p or 1080p) and trims it to the scene duration.
 * Returns the local MP4 file path, or null if no suitable video found.
 */
async function fetchPexelsVideoForScene(
  scene: Scene,
  duration: number,
  workDir: string
): Promise<string | null> {
  if (!PEXELS_API_KEY) {
    console.warn("[Pipeline] No PEXELS_API_KEY, skipping Pexels video search");
    return null;
  }

  const outputPath = path.join(workDir, `scene_${scene.index}_pexels.mp4`);

  try {
    // Search Pexels for videos matching the scene query
    const searchUrl = `https://api.pexels.com/videos/search?query=${encodeURIComponent(scene.pexelsQuery)}&per_page=5&size=medium&orientation=landscape`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { Authorization: PEXELS_API_KEY } }),
      10_000,
      `Pexels search for scene ${scene.index}`
    );

    if (!searchResp.ok) {
      console.warn(`[Pipeline] Pexels search failed for scene ${scene.index}: HTTP ${searchResp.status}`);
      return null;
    }

    const searchData = await searchResp.json() as {
      videos?: Array<{
        id: number;
        duration: number;
        video_files: Array<{ width: number; height: number; link: string; quality?: string }>;
      }>;
    };

    if (!searchData.videos || searchData.videos.length === 0) {
      console.warn(`[Pipeline] No Pexels videos found for query: "${scene.pexelsQuery}"`);
      return null;
    }

    // Pick the best video: prefer clips >= scene duration, prefer 720p or 1080p
    const candidates = searchData.videos
      .filter(v => v.duration >= 3) // at least 3 seconds
      .sort((a, b) => {
        // Prefer videos that are at least as long as the scene
        const aFits = a.duration >= duration ? 1 : 0;
        const bFits = b.duration >= duration ? 1 : 0;
        return bFits - aFits;
      });

    if (candidates.length === 0) return null;

    const video = candidates[0];

    // Pick best quality file: prefer 1080p, then 720p, then best available
    const videoFile = video.video_files
      .filter(f => f.width >= 1280 && f.height >= 720)
      .sort((a, b) => b.width - a.width)[0]
      || video.video_files.sort((a, b) => b.width - a.width)[0];

    if (!videoFile?.link) {
      console.warn(`[Pipeline] No suitable video file for Pexels video ${video.id}`);
      return null;
    }

    console.log(`[Pipeline] Scene ${scene.index}: Downloading Pexels video ${video.id} (${video.duration}s, ${videoFile.width}x${videoFile.height}) for query "${scene.pexelsQuery}"`);

    // Download the video file
    const downloadResp = await withTimeout(
      fetch(videoFile.link),
      30_000,
      `Download Pexels video for scene ${scene.index}`
    );

    if (!downloadResp.ok) throw new Error(`Download failed: HTTP ${downloadResp.status}`);

    const rawPath = path.join(workDir, `scene_${scene.index}_pexels_raw.mp4`);
    const buffer = Buffer.from(await downloadResp.arrayBuffer());
    fs.writeFileSync(rawPath, buffer);

    // Trim/scale to scene duration and target resolution
    // If video is shorter than duration, loop it
    const loopFlag = video.duration < duration ? `-stream_loop -1` : "";
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ${loopFlag} -i "${rawPath}" ` +
        `-t ${duration} ` +
        `-vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}" ` +
        `-c:v libx264 -preset fast -crf 23 -an -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
      ),
      120_000,
      `Trim Pexels video for scene ${scene.index}`
    );

    // Cleanup raw download
    try { fs.unlinkSync(rawPath); } catch { /* ignore */ }

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      console.log(`[Pipeline] Scene ${scene.index}: Pexels video ready (${fs.statSync(outputPath).size} bytes)`);
      return outputPath;
    }
    return null;
  } catch (err) {
    console.warn(`[Pipeline] Pexels video failed for scene ${scene.index}:`, err);
    return null;
  }
}

// ─── 3b. AI Image Fallback ────────────────────────────────────────────────────
async function generateAIImageForScene(scene: Scene, workDir: string): Promise<string | null> {
  const outputPath = path.join(workDir, `scene_${scene.index}_ai.png`);
  const prompt = scene.imagePrompt ||
    `${scene.visualCue}, cinematic 4K YouTube video background, professional lighting, ultra-detailed, photorealistic`;

  try {
    console.log(`[Pipeline] Scene ${scene.index}: Generating AI image: "${prompt.slice(0, 60)}..."`);
    const { url: imageUrl } = await withTimeout(
      generateImage({ prompt }),
      45_000,
      `AI image for scene ${scene.index}`
    );

    if (!imageUrl) return null;

    const response = await withTimeout(fetch(imageUrl), 15_000, `Download AI image for scene ${scene.index}`);
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);
    console.log(`[Pipeline] Scene ${scene.index}: AI image saved (${buffer.length} bytes)`);
    return outputPath;
  } catch (err) {
    console.warn(`[Pipeline] AI image failed for scene ${scene.index}:`, err);
    return null;
  }
}

// ─── 3c. Color Fallback ───────────────────────────────────────────────────────
async function generateColorFallback(scene: Scene, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, `scene_${scene.index}_fallback.png`);
  const colors = ["0a0a1e", "0a1a2e", "1a0a2e", "0a2a1e", "1a1a0a", "2a0a1e", "0a1a1e", "1a0a1e"];
  const color = colors[scene.index % colors.length];
  try {
    await withTimeout(
      exec(`${FFMPEG_BIN} -y -f lavfi -i "color=c=#${color}:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=1" -frames:v 1 "${outputPath}" 2>/dev/null`),
      15_000,
      `Fallback PNG for scene ${scene.index}`
    );
  } catch {
    const blackPng = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108020000009001" + "2e00000000c4944415408d76360000000020001e221bc330000000049454e44ae426082", "hex");
    fs.writeFileSync(outputPath, blackPng);
  }
  return outputPath;
}

// ─── 3. Fetch Visual for Scene (Priority: Pexels → AI → Fallback) ────────────
async function fetchVisualForScene(
  scene: Scene,
  duration: number,
  workDir: string
): Promise<VisualResult> {
  // Priority 1: Pexels HD video (real footage matching the scene topic)
  const pexelsPath = await fetchPexelsVideoForScene(scene, duration, workDir);
  if (pexelsPath) {
    return { type: "pexels_video", filePath: pexelsPath, isVideo: true };
  }

  // Priority 2: AI-generated image (cinematic, scene-specific)
  const aiPath = await generateAIImageForScene(scene, workDir);
  if (aiPath) {
    return { type: "ai_image", filePath: aiPath, isVideo: false };
  }

  // Priority 3: Color fallback (never fails)
  const fallbackPath = await generateColorFallback(scene, workDir);
  return { type: "fallback", filePath: fallbackPath, isVideo: false };
}

// ─── 4a. Canvas Subtitle Overlay ─────────────────────────────────────────────
async function renderSubtitleOverlay(
  text: string,
  sceneIndex: number,
  totalScenes: number,
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${sceneIndex}_subtitle.png`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createCanvas, registerFont } = require("canvas") as typeof import("canvas");

  try {
    registerFont(FONT_BOLD, { family: "NotoSans", weight: "bold" });
    registerFont(FONT_REGULAR, { family: "NotoSans", weight: "normal" });
  } catch { /* already registered */ }

  const OVERLAY_H = 180;
  const canvas = createCanvas(VIDEO_WIDTH, OVERLAY_H);
  const ctx = canvas.getContext("2d");

  // Semi-transparent gradient background
  const grad = ctx.createLinearGradient(0, 0, 0, OVERLAY_H);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.3, "rgba(0,0,0,0.82)");
  grad.addColorStop(1, "rgba(0,0,0,0.92)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, VIDEO_WIDTH, OVERLAY_H);

  // Scene badge (purple pill on left)
  const badgeText = `${sceneIndex + 1} / ${totalScenes}`;
  ctx.fillStyle = "rgba(120,60,220,0.9)";
  ctx.beginPath();
  ctx.roundRect(40, 30, 130, 50, 25);
  ctx.fill();
  ctx.font = "bold 28px NotoSans";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.fillText(badgeText, 105, 63);

  // Subtitle text (centered, white, bold, word-wrapped)
  const cleanText = text.replace(/[^\x20-\x7E]/g, "").slice(0, 120).trim();
  ctx.font = "bold 46px NotoSans";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = 8;

  const words = cleanText.split(" ");
  const lines: string[] = [];
  let currentLine = "";
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length > 60 && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
    if (lines.length >= 2) break;
  }
  if (currentLine && lines.length < 2) lines.push(currentLine);

  const lineHeight = 54;
  const startY = lines.length === 1 ? 115 : 90;
  lines.forEach((line, i) => {
    ctx.fillText(line, VIDEO_WIDTH / 2, startY + i * lineHeight);
  });

  fs.writeFileSync(outputPath, canvas.toBuffer("image/png"));
  return outputPath;
}

// ─── 4b. Compose Scene Video ──────────────────────────────────────────────────
/**
 * Composes a scene video from either:
 * - A Pexels video clip (already the right duration) + subtitle overlay + audio
 * - An AI image → Ken Burns animation + subtitle overlay + audio
 */
async function composeSceneVideo(
  scene: Scene,
  visual: VisualResult,
  audioPath: string,
  duration: number,
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${scene.index}_composed.mp4`);

  // Render subtitle overlay PNG
  const subtitlePath = await renderSubtitleOverlay(scene.text, scene.index, MAX_SCENES, workDir);

  const OVERLAY_H = 180;
  const overlayY = VIDEO_HEIGHT - OVERLAY_H;
  const fadeFilter = `fade=t=in:st=0:d=0.4,fade=t=out:st=${Math.max(0, duration - 0.4)}:d=0.4`;

  if (visual.isVideo) {
    // Pexels video: overlay subtitle + audio + fade
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -i "${visual.filePath}" -i "${audioPath}" -loop 1 -i "${subtitlePath}" ` +
        `-filter_complex "[0:v][2:v]overlay=x=0:y=${overlayY}:shortest=1,${fadeFilter}[vout]" ` +
        `-map "[vout]" -map "1:a" ` +
        `-t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
      ),
      180_000,
      `Compose Pexels scene ${scene.index}`
    );
  } else {
    // AI image / fallback: Ken Burns animation + subtitle overlay + audio
    const frames = Math.ceil(duration * 30);
    const zoomDir = scene.index % 2 === 0 ? "+" : "-";
    const panX = scene.index % 4 < 2
      ? `iw/2-(iw/zoom/2)`
      : `iw/2-(iw/zoom/2)+${scene.index * 5}`;
    const kenBurns = `scale=${VIDEO_WIDTH * 2}:${VIDEO_HEIGHT * 2},zoompan=z='min(zoom${zoomDir}0.0006,1.3)':x='${panX}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=30`;

    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -loop 1 -i "${visual.filePath}" -i "${audioPath}" -loop 1 -i "${subtitlePath}" ` +
        `-filter_complex "[0:v]${kenBurns}[kb];[kb][2:v]overlay=x=0:y=${overlayY}:shortest=1,${fadeFilter}[vout]" ` +
        `-map "[vout]" -map "1:a" ` +
        `-t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
      ),
      180_000,
      `Compose AI scene ${scene.index}`
    );
  }

  // Cleanup subtitle file
  try { fs.unlinkSync(subtitlePath); } catch { /* ignore */ }

  return outputPath;
}

// ─── 5. Generate Ambient Background Music ────────────────────────────────────
async function generateAmbientMusic(duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "ambient_music.mp3");
  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "sine=frequency=220:duration=${duration}" ` +
        `-f lavfi -i "sine=frequency=330:duration=${duration}" ` +
        `-f lavfi -i "sine=frequency=440:duration=${duration}" ` +
        `-f lavfi -i "sine=frequency=110:duration=${duration}" ` +
        `-filter_complex "[0]volume=0.3[a0];[1]volume=0.2[a1];[2]volume=0.15[a2];[3]volume=0.25[a3];` +
        `[a0][a1][a2][a3]amix=inputs=4:duration=first,aecho=0.8:0.88:60:0.4,lowpass=f=800,volume=0.4[music]" ` +
        `-map "[music]" -c:a libmp3lame -b:a 128k "${outputPath}" 2>/dev/null`
      ),
      30_000,
      "Ambient music generation"
    );
    return outputPath;
  } catch (err) {
    console.warn("[Pipeline] Ambient music generation failed, using silence:", err);
    await exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${duration} -c:a libmp3lame -b:a 128k "${outputPath}" 2>/dev/null`);
    return outputPath;
  }
}

// ─── 6. Final Concatenation + Music Mix ───────────────────────────────────────
async function concatenateScenesWithMusic(
  scenePaths: string[],
  workDir: string,
  videoId: number,
  totalDuration: number
): Promise<string> {
  const listFile = path.join(workDir, "concat_list.txt");
  const concatPath = path.join(workDir, `fastvid_${videoId}_concat.mp4`);
  const outputPath = path.join(workDir, `fastvid_${videoId}_final.mp4`);

  // Step 1: Concatenate all scenes
  const listContent = scenePaths.map(p => `file '${p}'`).join("\n");
  fs.writeFileSync(listFile, listContent, "utf-8");
  await withTimeout(
    exec(`${FFMPEG_BIN} -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -movflags +faststart "${concatPath}" 2>/dev/null`),
    600_000,
    "Scene concatenation"
  );

  // Step 2: Generate ambient background music
  const musicPath = await generateAmbientMusic(totalDuration + 5, workDir);

  // Step 3: Mix background music at 15% volume under voiceovers
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
      `-filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.15[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=3[aout]" ` +
      `-map "0:v" -map "[aout]" ` +
      `-c:v copy -c:a aac -b:a 192k -movflags +faststart "${outputPath}" 2>/dev/null`
    ),
    300_000,
    "Background music mixing"
  );

  // Cleanup intermediate files
  try { fs.unlinkSync(concatPath); fs.unlinkSync(musicPath); } catch { /* ignore */ }

  return outputPath;
}

// ─── Main Pipeline ────────────────────────────────────────────────────────────
export async function runVideoPipeline(
  videoId: number,
  script: string,
  onProgress?: (p: PipelineProgress) => void
): Promise<string> {
  const workDir = path.join(TMP_DIR, `fastvid_${videoId}_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // Stage 1: Parse script into scenes (max 45s)
    onProgress?.({ stage: STAGE_LABELS.parsing, percent: 5 });
    const scenes = await parseScriptIntoScenes(script);
    console.log(`[Pipeline] ${scenes.length} scenes parsed for video ${videoId}`);
    scenes.forEach((s, i) => console.log(`  Scene ${i}: pexelsQuery="${s.pexelsQuery}"`));

    // Stage 2: Generate ALL voiceovers in parallel (max 8 min)
    onProgress?.({ stage: STAGE_LABELS.voiceovers, percent: 12 });
    const audioPaths = scenes.map((_, i) => path.join(workDir, `scene_${i}_audio.mp3`));
    const durations = await withTimeout(
      Promise.all(scenes.map((scene, i) => generateVoiceover(scene.text, audioPaths[i]))),
      480_000,
      "Voiceover generation stage"
    );
    scenes.forEach((scene, i) => { scene.duration = Math.max(durations[i], 5); });
    console.log(`[Pipeline] All ${scenes.length} voiceovers generated`);

    // Stage 3: Fetch ALL visuals in parallel (max 10 min)
    // Priority: Pexels HD video → AI image → color fallback
    onProgress?.({ stage: STAGE_LABELS.visuals, percent: 28 });
    const visuals = await withTimeout(
      Promise.all(
        scenes.map(scene => fetchVisualForScene(scene, scene.duration, workDir))
      ),
      600_000, // 10 min
      "Visual fetching stage"
    );

    // Log visual source summary
    const summary = visuals.reduce((acc, v) => {
      acc[v.type] = (acc[v.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log(`[Pipeline] Visual sources: ${JSON.stringify(summary)}`);

    // Stage 4: Compose all scenes in parallel (max 20 min)
    onProgress?.({ stage: STAGE_LABELS.composing, percent: 52 });
    const composedScenes = await withTimeout(
      Promise.all(
        scenes.map((scene, i) =>
          composeSceneVideo(scene, visuals[i], audioPaths[i], scene.duration, workDir)
        )
      ),
      1_200_000,
      "Scene composition stage"
    );
    console.log(`[Pipeline] All ${scenes.length} scenes composed`);

    // Cleanup intermediate files
    for (let i = 0; i < scenes.length; i++) {
      try {
        fs.unlinkSync(audioPaths[i]);
        if (visuals[i].filePath !== composedScenes[i]) fs.unlinkSync(visuals[i].filePath);
      } catch { /* ignore */ }
    }

    // Stage 5: Concatenate + mix background music (max 10 min)
    onProgress?.({ stage: STAGE_LABELS.assembling, percent: 82 });
    const totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);
    const finalVideoPath = await concatenateScenesWithMusic(composedScenes, workDir, videoId, totalDuration);

    // Stage 6: Upload to S3 (max 5 min)
    onProgress?.({ stage: STAGE_LABELS.uploading, percent: 95 });
    const videoBuffer = fs.readFileSync(finalVideoPath);
    const { url } = await withTimeout(
      storagePut(`videos/${videoId}/final.mp4`, videoBuffer, "video/mp4"),
      300_000,
      "S3 upload"
    );

    onProgress?.({ stage: STAGE_LABELS.complete, percent: 100 });
    console.log(`[Pipeline] Video ${videoId} complete: ${url}`);
    return url;
  } finally {
    try {
      const { exec: execSync } = require("child_process");
      execSync(`rm -rf "${workDir}"`);
    } catch { /* ignore */ }
  }
}
