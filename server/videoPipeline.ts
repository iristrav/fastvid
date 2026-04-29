/**
 * Fastvid — AI Video Generation Pipeline (Vidrush-level v2)
 *
 * Visual sourcing strategy (per scene, in priority order):
 * 1. Pexels HD video  — LLM generates 3 different search queries (wide, close-up, detail)
 *                       → 3 real stock footage clips per scene, each ~3s with xfade transitions
 * 2. AI-generated image — forge ImageService generates a cinematic image
 *                         → animated with Ken Burns zoom-pan effect
 * 3. Color fallback   — solid color PNG if everything else fails
 *
 * Pipeline stages (all parallel where possible):
 * 1. Parse script into max 8 scenes + generate 3 search queries + image prompts  (max 45 sec)
 * 2. Generate ALL voiceovers in parallel                                          (max 8 min)
 * 3. Fetch ALL visuals in parallel (3 Pexels clips → AI image → color fallback)  (max 12 min)
 * 4. Render branded intro title card                                              (max 30 sec)
 * 5. Compose each scene video in parallel                                         (max 20 min)
 *    → 3 clips with xfade crossfade transitions
 *    → Subtitle lower-third overlay (canvas-rendered PNG)
 *    → Scene number badge
 *    → Fade in/out transitions
 * 6. Concatenate all scenes + branded outro + mix background music               (max 10 min)
 * 7. Upload to S3                                                                 (max 5 min)
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
// Fish Audio S2 Pro TTS
const FISH_AUDIO_API_KEY = process.env.FISH_AUDIO_API_KEY || "";
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
  pexelsQueries: string[];  // 3 different search queries: [wide, close-up, detail]
  imagePrompt: string;      // AI image fallback prompt
  duration: number;
}

/** Result of fetching a visual for a scene */
interface VisualResult {
  type: "pexels_video" | "ai_image" | "fallback";
  filePaths: string[];  // Multiple clips for multi-cut scenes
  isVideo: boolean;     // true = MP4 clips, false = PNG images
}

export interface PipelineProgress {
  stage: string;
  percent: number;
}

const TMP_DIR = os.tmpdir();
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const MAX_SCENES = 8;
const CLIPS_PER_SCENE = 3; // 3 different clips per scene for dynamic cuts

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
  visuals:    `Fetching ${CLIPS_PER_SCENE} scene-matched clips per scene (Pexels / AI)... (max 12 min)`,
  intro:      "Rendering branded intro title card... (max 30 sec)",
  composing:  `Composing all ${MAX_SCENES} scenes with multi-cut transitions... (max 20 min)`,
  assembling: "Assembling final video with music + outro... (max 10 min)",
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
- pexelsQueries: An array of exactly 3 different Pexels search queries for this scene.
  Each query should show a DIFFERENT visual angle of the same topic:
  [0] Wide establishing shot: e.g. "aerial view city skyline night"
  [1] Close-up detail shot: e.g. "close up businessman hands laptop"
  [2] Action/movement shot: e.g. "people walking busy street timelapse"
  All queries must be in English, 3-6 words, specific enough to find real footage.
  Examples for "Morgan Freeman owns a Cessna 414":
    ["vintage propeller airplane cockpit", "pilot hands controls aircraft", "small plane landing runway"]
  Examples for "The stock market crashed in 2008":
    ["stock market trading floor panic", "red stock chart falling graph", "worried traders watching screens"]
- imagePrompt: A detailed 15-25 word AI image generation prompt as fallback.
  Style: cinematic 4K, dramatic lighting, ultra-detailed, photorealistic.

IMPORTANT: Return exactly ${MAX_SCENES} scenes. Each pexelsQueries array must have exactly 3 items.`,
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
                    pexelsQueries: { type: "array", items: { type: "string" } },
                    imagePrompt: { type: "string" },
                  },
                  required: ["text", "visualCue", "pexelsQueries", "imagePrompt"],
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
  return rawScenes.map((s, i) => ({
    ...s,
    index: i,
    duration: 0,
    // Ensure exactly 3 unique queries
    pexelsQueries: (() => {
      const base = s.visualCue || "cinematic background";
      const raw = Array.isArray(s.pexelsQueries) ? s.pexelsQueries : [];
      const q0 = raw[0]?.trim() || `${base} wide shot`;
      const q1 = raw[1]?.trim() || `${base} close up`;
      const q2 = raw[2]?.trim() || `${base} action`;
      // Deduplicate: if any two are identical, add a modifier
      const queries = [q0, q1, q2];
      if (queries[1] === queries[0]) queries[1] = `${base} detail`;
      if (queries[2] === queries[0] || queries[2] === queries[1]) queries[2] = `${base} movement`;
      return queries;
    })(),
  }));
}

// ─── 2. TTS Voiceover (Fish Audio S2 Pro) ────────────────────────────────────
export async function generateVoiceover(
  text: string,
  outputPath: string,
  voiceId?: string
): Promise<number> {
  const cleanText = text
    .replace(/[#*_`~>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\x00-\x7F]/g, "")
    .trim()
    .slice(0, 1000);

  const MAX_ATTEMPTS = 3;
  const TTS_TIMEOUT_MS = 90_000;

  // ── Fish Audio S2 Pro ──
  if (FISH_AUDIO_API_KEY) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const body: Record<string, unknown> = {
          text: cleanText,
          format: "mp3",
          model: "s2-pro",
          mp3_bitrate: 192,
        };
        if (voiceId) {
          body.reference_id = voiceId;
        }

        const response = await withTimeout(
          fetch("https://api.fish.audio/v1/tts", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${FISH_AUDIO_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          }),
          TTS_TIMEOUT_MS,
          `Fish Audio TTS attempt ${attempt}`
        );

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Fish Audio HTTP ${response.status}: ${errText.slice(0, 200)}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        if (audioBuffer.length < 100) throw new Error("Fish Audio returned empty audio");

        fs.writeFileSync(outputPath, audioBuffer);
        const durationSec = Math.max(3, Math.round(audioBuffer.length / 24000));
        console.log(`[Pipeline] Fish Audio S2 Pro: scene audio ${durationSec}s (${audioBuffer.length} bytes)`);
        return durationSec;
      } catch (err) {
        const isLastAttempt = attempt === MAX_ATTEMPTS;
        if (isLastAttempt) {
          console.warn(`[Pipeline] Fish Audio failed after ${MAX_ATTEMPTS} attempts, falling back to Google TTS:`, err);
          break;
        }
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(`[Pipeline] Fish Audio attempt ${attempt} failed, retrying in ${backoffMs}ms:`, err);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }

  // ── Silent audio fallback (Fish Audio failed all retries) ──
  console.warn("[Pipeline] Fish Audio failed all attempts — using silent audio fallback");
  const estimatedDuration = Math.max(3, Math.ceil(cleanText.split(" ").length / 2.5));
  try {
    await withTimeout(
      exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${estimatedDuration} -c:a libmp3lame -b:a 128k "${outputPath}" 2>/dev/null`),
      15_000,
      "Silent audio fallback"
    );
  } catch {
    // Last resort: write a minimal valid MP3 header
    const silentMp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(413).fill(0)]);
    fs.writeFileSync(outputPath, silentMp3);
  }
  return estimatedDuration;
}

// ─── 3a. Pexels Video Clip Fetching ──────────────────────────────────────────
async function fetchPexelsClip(
  query: string,
  clipDuration: number,
  outputPath: string,
  sceneIndex: number,
  clipIndex: number
): Promise<string | null> {
  if (!PEXELS_API_KEY) return null;

  try {
    const searchUrl = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&size=medium&orientation=landscape`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { Authorization: PEXELS_API_KEY } }),
      10_000,
      `Pexels search scene ${sceneIndex} clip ${clipIndex}`
    );

    if (!searchResp.ok) return null;

    const searchData = await searchResp.json() as {
      videos?: Array<{
        id: number;
        duration: number;
        video_files: Array<{ width: number; height: number; link: string }>;
      }>;
    };

    if (!searchData.videos || searchData.videos.length === 0) {
      console.warn(`[Pipeline] No Pexels results for: "${query}"`);
      return null;
    }

    // Pick a different video for each clip index to avoid repetition
    const candidates = searchData.videos.filter(v => v.duration >= 2);
    if (candidates.length === 0) return null;
    const video = candidates[Math.min(clipIndex, candidates.length - 1)];

    const videoFile = video.video_files
      .filter(f => f.width >= 1280 && f.height >= 720)
      .sort((a, b) => b.width - a.width)[0]
      || video.video_files.sort((a, b) => b.width - a.width)[0];

    if (!videoFile?.link) return null;

    console.log(`[Pipeline] Scene ${sceneIndex} clip ${clipIndex}: Pexels "${query}" → video ${video.id}`);

    const downloadResp = await withTimeout(
      fetch(videoFile.link),
      30_000,
      `Download Pexels clip scene ${sceneIndex} clip ${clipIndex}`
    );
    if (!downloadResp.ok) return null;

    const rawPath = outputPath.replace(".mp4", "_raw.mp4");
    const buffer = Buffer.from(await downloadResp.arrayBuffer());
    fs.writeFileSync(rawPath, buffer);

    // Trim/scale to clip duration
    const loopFlag = video.duration < clipDuration ? `-stream_loop -1` : "";
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ${loopFlag} -i "${rawPath}" ` +
        `-t ${clipDuration} ` +
        `-vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}" ` +
        `-c:v libx264 -preset fast -crf 23 -an -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
      ),
      90_000,
      `Trim Pexels clip scene ${sceneIndex} clip ${clipIndex}`
    );

    try { fs.unlinkSync(rawPath); } catch { /* ignore */ }

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      return outputPath;
    }
    return null;
  } catch (err) {
    console.warn(`[Pipeline] Pexels clip failed scene ${sceneIndex} clip ${clipIndex}:`, err);
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

// ─── 3. Fetch Visuals for Scene (3 clips with B-roll variety) ─────────────────
async function fetchVisualsForScene(
  scene: Scene,
  duration: number,
  workDir: string
): Promise<VisualResult> {
  const clipDuration = Math.ceil(duration / CLIPS_PER_SCENE) + 1; // +1s buffer for xfade

  // Try to fetch 3 different Pexels clips using the 3 different queries
  const clipPaths = await Promise.all(
    scene.pexelsQueries.map(async (query, clipIdx) => {
      const outputPath = path.join(workDir, `scene_${scene.index}_clip${clipIdx}.mp4`);
      return fetchPexelsClip(query, clipDuration, outputPath, scene.index, clipIdx);
    })
  );

  const validClips = clipPaths.filter((p): p is string => p !== null);

  if (validClips.length >= 2) {
    // Got at least 2 clips — use multi-cut approach
    console.log(`[Pipeline] Scene ${scene.index}: ${validClips.length}/${CLIPS_PER_SCENE} Pexels clips fetched`);
    return { type: "pexels_video", filePaths: validClips, isVideo: true };
  }

  if (validClips.length === 1) {
    // Only 1 clip — still use it
    return { type: "pexels_video", filePaths: validClips, isVideo: true };
  }

  // No Pexels clips — try AI image
  const aiPath = await generateAIImageForScene(scene, workDir);
  if (aiPath) {
    return { type: "ai_image", filePaths: [aiPath], isVideo: false };
  }

  // Final fallback
  const fallbackPath = await generateColorFallback(scene, workDir);
  return { type: "fallback", filePaths: [fallbackPath], isVideo: false };
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

// ─── 4b. Branded Intro Title Card ────────────────────────────────────────────
async function renderIntroCard(
  videoTitle: string,
  duration: number,
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, "intro_card.mp4");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createCanvas, registerFont } = require("canvas") as typeof import("canvas");

  try {
    registerFont(FONT_BOLD, { family: "NotoSans", weight: "bold" });
    registerFont(FONT_REGULAR, { family: "NotoSans", weight: "normal" });
  } catch { /* already registered */ }

  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext("2d");

  // Dark gradient background
  const bgGrad = ctx.createLinearGradient(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
  bgGrad.addColorStop(0, "#0a0a1e");
  bgGrad.addColorStop(0.5, "#1a0a2e");
  bgGrad.addColorStop(1, "#0a1a2e");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

  // Subtle grid lines
  ctx.strokeStyle = "rgba(120,60,220,0.08)";
  ctx.lineWidth = 1;
  for (let x = 0; x < VIDEO_WIDTH; x += 80) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, VIDEO_HEIGHT); ctx.stroke();
  }
  for (let y = 0; y < VIDEO_HEIGHT; y += 80) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(VIDEO_WIDTH, y); ctx.stroke();
  }

  // Glow circle behind title
  const glow = ctx.createRadialGradient(VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2, 0, VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2, 400);
  glow.addColorStop(0, "rgba(120,60,220,0.25)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

  // Channel/brand name at top
  ctx.font = "bold 36px NotoSans";
  ctx.fillStyle = "rgba(160,100,255,0.9)";
  ctx.textAlign = "center";
  ctx.fillText("FASTVID", VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2 - 160);

  // Divider line
  ctx.strokeStyle = "rgba(120,60,220,0.6)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(VIDEO_WIDTH / 2 - 200, VIDEO_HEIGHT / 2 - 130);
  ctx.lineTo(VIDEO_WIDTH / 2 + 200, VIDEO_HEIGHT / 2 - 130);
  ctx.stroke();

  // Main title (word-wrapped)
  const title = videoTitle.replace(/[^\x20-\x7E]/g, "").slice(0, 100).toUpperCase();
  ctx.font = "bold 72px NotoSans";
  ctx.fillStyle = "white";
  ctx.shadowColor = "rgba(120,60,220,0.8)";
  ctx.shadowBlur = 20;

  const words = title.split(" ");
  const lines: string[] = [];
  let currentLine = "";
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length > 30 && currentLine) {
      lines.push(currentLine);
      currentLine = word;
      if (lines.length >= 3) break;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine && lines.length < 3) lines.push(currentLine);

  const lineHeight = 85;
  const totalH = lines.length * lineHeight;
  const startY = VIDEO_HEIGHT / 2 - totalH / 2 + 40;
  lines.forEach((line, i) => {
    ctx.fillText(line, VIDEO_WIDTH / 2, startY + i * lineHeight);
  });

  // Bottom tagline
  ctx.font = "28px NotoSans";
  ctx.fillStyle = "rgba(160,200,255,0.7)";
  ctx.shadowBlur = 0;
  ctx.fillText("AI-Generated Video", VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2 + 220);

  const pngPath = path.join(workDir, "intro_card.png");
  fs.writeFileSync(pngPath, canvas.toBuffer("image/png"));

  // Convert to video with fade in/out
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -loop 1 -i "${pngPath}" ` +
      `-t ${duration} ` +
      `-vf "fade=t=in:st=0:d=0.5,fade=t=out:st=${duration - 0.5}:d=0.5" ` +
      `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -r 30 "${outputPath}" 2>/dev/null`
    ),
    30_000,
    "Intro card render"
  );

  try { fs.unlinkSync(pngPath); } catch { /* ignore */ }
  return outputPath;
}

// ─── 4c. Branded Outro Card ───────────────────────────────────────────────────
async function renderOutroCard(duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "outro_card.mp4");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createCanvas, registerFont } = require("canvas") as typeof import("canvas");

  try {
    registerFont(FONT_BOLD, { family: "NotoSans", weight: "bold" });
  } catch { /* already registered */ }

  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext("2d");

  // Dark gradient background
  const bgGrad = ctx.createLinearGradient(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
  bgGrad.addColorStop(0, "#0a0a1e");
  bgGrad.addColorStop(1, "#1a0a2e");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

  // Glow
  const glow = ctx.createRadialGradient(VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2, 0, VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2, 500);
  glow.addColorStop(0, "rgba(0,200,180,0.2)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

  // Subscribe button
  const btnW = 500, btnH = 100, btnX = VIDEO_WIDTH / 2 - btnW / 2, btnY = VIDEO_HEIGHT / 2 - 80;
  ctx.fillStyle = "#ff0000";
  ctx.beginPath();
  ctx.roundRect(btnX, btnY, btnW, btnH, 50);
  ctx.fill();
  ctx.font = "bold 52px NotoSans";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.fillText("SUBSCRIBE", VIDEO_WIDTH / 2, btnY + 68);

  // Call to action text
  ctx.font = "bold 48px NotoSans";
  ctx.fillStyle = "white";
  ctx.fillText("Thanks for watching!", VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2 - 160);

  ctx.font = "32px NotoSans";
  ctx.fillStyle = "rgba(160,200,255,0.8)";
  ctx.fillText("Like & Subscribe for more AI-generated videos", VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2 + 80);

  ctx.font = "bold 36px NotoSans";
  ctx.fillStyle = "rgba(160,100,255,0.9)";
  ctx.fillText("FASTVID", VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2 + 160);

  const pngPath = path.join(workDir, "outro_card.png");
  fs.writeFileSync(pngPath, canvas.toBuffer("image/png"));

  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -loop 1 -i "${pngPath}" ` +
      `-t ${duration} ` +
      `-vf "fade=t=in:st=0:d=0.5,fade=t=out:st=${duration - 0.5}:d=0.5" ` +
      `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -r 30 "${outputPath}" 2>/dev/null`
    ),
    30_000,
    "Outro card render"
  );

  try { fs.unlinkSync(pngPath); } catch { /* ignore */ }
  return outputPath;
}

// ─── 5. Compose Scene Video (multi-cut with xfade) ───────────────────────────
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
  const fadeFilter = `fade=t=in:st=0:d=0.3,fade=t=out:st=${Math.max(0, duration - 0.3)}:d=0.3`;

  if (visual.isVideo && visual.filePaths.length >= 2) {
    // Multi-cut: join clips with xfade crossfade transitions
    const clips = visual.filePaths;
    const clipDur = Math.ceil(duration / clips.length) + 1;
    const xfadeDur = 0.3;

    // Build xfade filter chain
    let filterComplex = "";
    let lastLabel = "[0:v]";

    for (let i = 1; i < clips.length; i++) {
      const offset = Math.max(0.1, clipDur * i - xfadeDur * i);
      const outLabel = i === clips.length - 1 ? "[vjoined]" : `[v${i}]`;
      filterComplex += `${lastLabel}[${i}:v]xfade=transition=fade:duration=${xfadeDur}:offset=${offset}${outLabel};`;
      lastLabel = outLabel;
    }

    // Build input list
    const inputs = clips.map(p => `-i "${p}"`).join(" ");

    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ${inputs} -i "${audioPath}" -loop 1 -i "${subtitlePath}" ` +
        `-filter_complex "${filterComplex}[vjoined][${clips.length + 1}:v]overlay=x=0:y=${overlayY}:shortest=1,${fadeFilter}[vout]" ` +
        `-map "[vout]" -map "${clips.length}:a" ` +
        `-t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
      ),
      240_000,
      `Compose multi-cut scene ${scene.index}`
    );
  } else if (visual.isVideo && visual.filePaths.length === 1) {
    // Single Pexels clip: overlay subtitle + audio + fade
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -i "${visual.filePaths[0]}" -i "${audioPath}" -loop 1 -i "${subtitlePath}" ` +
        `-filter_complex "[0:v][2:v]overlay=x=0:y=${overlayY}:shortest=1,${fadeFilter}[vout]" ` +
        `-map "[vout]" -map "1:a" ` +
        `-t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
      ),
      180_000,
      `Compose single-clip scene ${scene.index}`
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
        `${FFMPEG_BIN} -y -loop 1 -i "${visual.filePaths[0]}" -i "${audioPath}" -loop 1 -i "${subtitlePath}" ` +
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

// ─── 6. Generate Cinematic Background Music ───────────────────────────────────
async function generateCinematicMusic(duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "bg_music.mp3");
  try {
    // Build a richer ambient soundtrack using multiple harmonic layers
    // Am pentatonic scale: A(220) C(261) D(294) E(330) G(392) A(440)
    // Plus sub-bass and pad layers
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ` +
        // Bass layer
        `-f lavfi -i "sine=frequency=110:duration=${duration}" ` +
        // Root note
        `-f lavfi -i "sine=frequency=220:duration=${duration}" ` +
        // Third
        `-f lavfi -i "sine=frequency=261:duration=${duration}" ` +
        // Fifth
        `-f lavfi -i "sine=frequency=330:duration=${duration}" ` +
        // Octave
        `-f lavfi -i "sine=frequency=440:duration=${duration}" ` +
        // High shimmer
        `-f lavfi -i "sine=frequency=660:duration=${duration}" ` +
        `-filter_complex "
          [0]volume=0.35,aecho=0.9:0.9:80:0.6[bass];
          [1]volume=0.25,aecho=0.85:0.88:60:0.5[root];
          [2]volume=0.18,aecho=0.8:0.85:100:0.4[third];
          [3]volume=0.15,aecho=0.8:0.82:120:0.35[fifth];
          [4]volume=0.12,aecho=0.75:0.8:140:0.3[oct];
          [5]volume=0.06,aecho=0.7:0.75:160:0.2[shimmer];
          [bass][root][third][fifth][oct][shimmer]amix=inputs=6:duration=first,
          lowpass=f=1800,highpass=f=40,
          aecho=0.6:0.7:200:0.2,
          volume=0.45[music]
        " ` +
        `-map "[music]" -c:a libmp3lame -b:a 128k "${outputPath}" 2>/dev/null`
      ),
      45_000,
      "Cinematic music generation"
    );
    return outputPath;
  } catch (err) {
    console.warn("[Pipeline] Cinematic music failed, using silence:", err);
    await exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${duration} -c:a libmp3lame -b:a 128k "${outputPath}" 2>/dev/null`);
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

  // Render intro (3s) and outro (5s)
  const [introPath, outroPath] = await Promise.all([
    renderIntroCard(videoTitle, 3, workDir),
    renderOutroCard(5, workDir),
  ]);

  // Build concat list: intro + all scenes + outro
  const allClips = [introPath, ...scenePaths, outroPath];
  const listContent = allClips.map(p => `file '${p}'`).join("\n");
  fs.writeFileSync(listFile, listContent, "utf-8");

  // Step 1: Concatenate all clips
  await withTimeout(
    exec(`${FFMPEG_BIN} -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -movflags +faststart "${concatPath}" 2>/dev/null`),
    600_000,
    "Scene concatenation"
  );

  // Step 2: Generate cinematic background music
  const totalWithCards = totalDuration + 3 + 5; // intro + scenes + outro
  const musicPath = await generateCinematicMusic(totalWithCards + 5, workDir);

  // Step 3: Mix background music at 12% volume under voiceovers
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
      `-filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.12[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=3[aout]" ` +
      `-map "0:v" -map "[aout]" ` +
      `-c:v copy -c:a aac -b:a 192k -movflags +faststart "${outputPath}" 2>/dev/null`
    ),
    300_000,
    "Background music mixing"
  );

  // Cleanup
  try {
    fs.unlinkSync(concatPath);
    fs.unlinkSync(musicPath);
    fs.unlinkSync(introPath);
    fs.unlinkSync(outroPath);
  } catch { /* ignore */ }

  return outputPath;
}

// ─── Main Pipeline ────────────────────────────────────────────────────────────
export async function runVideoPipeline(
  videoId: number,
  script: string,
  onProgress?: (p: PipelineProgress) => void,
  voiceId?: string,
  customVoiceoverUrl?: string
): Promise<string> {
  const workDir = path.join(TMP_DIR, `fastvid_${videoId}_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  // Extract video title from script (first non-empty line)
  const videoTitle = script.split("\n").find(l => l.trim().length > 5)?.trim().slice(0, 80) || "AI Generated Video";

  try {
    // Stage 1: Parse script into scenes (max 45s)
    onProgress?.({ stage: STAGE_LABELS.parsing, percent: 5 });
    const scenes = await parseScriptIntoScenes(script);
    console.log(`[Pipeline] ${scenes.length} scenes parsed for video ${videoId}`);
    scenes.forEach((s, i) => console.log(`  Scene ${i}: queries=${JSON.stringify(s.pexelsQueries)}`));

    // Stage 2: Generate ALL voiceovers in parallel (max 8 min)
    // If custom voiceover URL is provided, download and split across scenes instead of TTS
    onProgress?.({ stage: STAGE_LABELS.voiceovers, percent: 12 });
    const audioPaths = scenes.map((_, i) => path.join(workDir, `scene_${i}_audio.mp3`));
    let durations: number[];
    if (customVoiceoverUrl) {
      console.log(`[Pipeline] Using custom voiceover: ${customVoiceoverUrl}`);
      const customAudioPath = path.join(workDir, "custom_voiceover.mp3");
      const resp = await fetch(customVoiceoverUrl);
      if (!resp.ok) throw new Error(`Failed to download custom voiceover: ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(customAudioPath, buf);
      // Get total duration via ffprobe
      const totalDuration = await new Promise<number>((resolve) => {
        const { execFile } = require("child_process") as typeof import("child_process");
        execFile(FFMPEG_BIN.replace("ffmpeg", "ffprobe"), ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", customAudioPath], (_err: unknown, stdout: string) => {
          resolve(parseFloat(stdout?.trim() ?? "60") || 60);
        });
      });
      // Split audio into per-scene segments
      const perScene = Math.max(totalDuration / scenes.length, 5);
      for (let i = 0; i < scenes.length; i++) {
        const start = i * perScene;
        await exec(`${FFMPEG_BIN} -y -i "${customAudioPath}" -ss ${start} -t ${perScene} -c copy "${audioPaths[i]}"`);
      }
      durations = scenes.map(() => perScene);
    } else {
      durations = await withTimeout(
        Promise.all(scenes.map((scene, i) => generateVoiceover(scene.text, audioPaths[i], voiceId))),
        480_000,
        "Voiceover generation stage"
      );
    }
    scenes.forEach((scene, i) => { scene.duration = Math.max(durations[i], 5); });
    console.log(`[Pipeline] All ${scenes.length} voiceovers generated`);

    // Stage 3: Fetch ALL visuals in parallel — 3 clips per scene (max 12 min)
    onProgress?.({ stage: STAGE_LABELS.visuals, percent: 28 });
    const visuals = await withTimeout(
      Promise.all(
        scenes.map(scene => fetchVisualsForScene(scene, scene.duration, workDir))
      ),
      720_000, // 12 min
      "Visual fetching stage"
    );

    // Log visual source summary
    const summary = visuals.reduce((acc, v) => {
      const key = `${v.type}(${v.filePaths.length}clips)`;
      acc[key] = (acc[key] || 0) + 1;
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
        for (const fp of visuals[i].filePaths) {
          if (fp !== composedScenes[i]) fs.unlinkSync(fp);
        }
      } catch { /* ignore */ }
    }

    // Stage 5: Concatenate + intro/outro + mix background music (max 10 min)
    onProgress?.({ stage: STAGE_LABELS.assembling, percent: 82 });
    const totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);
    const finalVideoPath = await concatenateScenesWithMusic(composedScenes, workDir, videoId, totalDuration, videoTitle);

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
