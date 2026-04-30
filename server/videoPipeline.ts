/**
 * Fastvid — AI Video Generation Pipeline (Speed-Optimised v3)
 *
 * Speed targets (all stages combined < 15 min):
 * 1. Parse script into 4 scenes                              (~15 sec)
 * 2. Generate 4 voiceovers in parallel (Fish Audio S2 Pro)   (~20-40 sec)
 * 3. Fetch 1 Pexels clip per scene in parallel               (~1-2 min)
 * 4. Compose 4 scenes in parallel (simple overlay, no xfade) (~3-5 min)
 * 5. Concatenate + intro/outro + background music            (~1-2 min)
 * 6. Upload to S3                                            (~30 sec)
 *
 * Key speed decisions:
 * - MAX_SCENES = 4 (was 6)
 * - CLIPS_PER_SCENE = 1 (was 2, no multi-cut xfade)
 * - No AI image generation fallback (color fallback is instant)
 * - No Ken Burns zoompan (simple scale/crop instead)
 * - TTS text capped at 250 chars (faster Fish Audio response)
 * - Pexels download timeout 15s (was 30s)
 * - All FFmpeg uses ultrafast preset + crf 28 (was crf 26)
 * - Compose timeout 60s per scene (was 120s)
 */
import { exec as execCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { storagePut } from "./storage";
import { invokeLLM } from "./_core/llm";
import pLimit from "p-limit";

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
  pexelsQuery: string;   // Single best search query
  duration: number;
}

export interface PipelineProgress {
  stage: string;
  percent: number;
}

const TMP_DIR = os.tmpdir();
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const MAX_SCENES = 4;  // 4 scenes — fast pipeline, still covers full video content

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
  parsing:    `Parsing script into ${MAX_SCENES} scenes... (~15 sec)`,
  voiceovers: `Generating ${MAX_SCENES} voiceovers in parallel... (~30 sec)`,
  visuals:    `Fetching scene visuals from Pexels... (~1-2 min)`,
  composing:  `Composing ${MAX_SCENES} scenes with subtitles... (~3-5 min)`,
  assembling: "Assembling final video with intro, outro & music... (~2 min)",
  uploading:  "Uploading final video... (~30 sec)",
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
- text: The narration text (1-2 sentences, what will be spoken). Keep it SHORT — max 200 characters.
- visualCue: A short 3-5 word description of what to show
- pexelsQuery: ONE best Pexels video search query (3-6 words, English, specific). Examples:
  "aerial city skyline night", "scientist lab experiment", "stock market trading floor"

IMPORTANT: Return exactly ${MAX_SCENES} scenes. Keep text SHORT (max 200 chars each).`,
        },
        {
          role: "user",
          content: `Parse this script into exactly ${MAX_SCENES} scenes:\n\n${script.slice(0, 6000)}`,
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
                  },
                  required: ["text", "visualCue", "pexelsQuery"],
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
    pexelsQuery: s.pexelsQuery?.trim() || s.visualCue || "cinematic background",
  }));
}

// ─── 2. TTS Voiceover (Fish Audio S2 Pro) ────────────────────────────────────
export async function generateVoiceover(
  text: string,
  outputPath: string,
  voiceId?: string
): Promise<number> {
  // Cap at 250 chars — shorter text = faster Fish Audio response (~5-8s vs 15-20s for 400 chars)
  const rawText = text
    .replace(/[#*_`~>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\x00-\x7F]/g, "")
    .trim();
  const cleanText = rawText.length <= 250 ? rawText : rawText.slice(0, 250).replace(/\s\S*$/, "");

  const MAX_ATTEMPTS = 3;
  const TTS_TIMEOUT_MS = 12_000;  // 12s hard limit per scene — fail fast

  if (FISH_AUDIO_API_KEY) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const body: Record<string, unknown> = {
          text: cleanText,
          format: "mp3",
          model: "s2-pro",
          mp3_bitrate: 64,  // 64kbps — smaller = faster transfer
        };
        if (voiceId) body.reference_id = voiceId;

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

        if (response.status === 429) {
          const waitMs = 200 + attempt * 150;
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
        // Estimate duration: 64kbps mp3 = 8000 bytes/sec
        const durationSec = Math.max(3, Math.round(audioBuffer.length / 8000));
        console.log(`[Pipeline] TTS scene ${outputPath.match(/scene_(\d+)/)?.[1] ?? "?"}: ${durationSec}s (${audioBuffer.length} bytes)`);
        return durationSec;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          console.warn(`[Pipeline] Fish Audio failed after ${MAX_ATTEMPTS} attempts, using silent fallback:`, err);
          break;
        }
        console.warn(`[Pipeline] Fish Audio attempt ${attempt} failed, retrying in 300ms:`, err);
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  // Silent audio fallback
  console.warn("[Pipeline] Fish Audio failed — using silent audio fallback");
  const estimatedDuration = Math.max(3, Math.ceil(cleanText.split(" ").length / 2.5));
  try {
    await withTimeout(
      exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${estimatedDuration} -c:a libmp3lame -b:a 64k "${outputPath}" 2>/dev/null`),
      10_000,
      "Silent audio fallback"
    );
  } catch {
    const silentMp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(413).fill(0)]);
    fs.writeFileSync(outputPath, silentMp3);
  }
  return estimatedDuration;
}

// ─── 3. Fetch ONE Pexels Clip per Scene ──────────────────────────────────────
async function fetchPexelsClip(
  query: string,
  clipDuration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!PEXELS_API_KEY) return null;

  try {
    const searchUrl = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&size=small&orientation=landscape`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { Authorization: PEXELS_API_KEY } }),
      8_000,
      `Pexels search scene ${sceneIndex}`
    );

    if (!searchResp.ok) return null;

    const searchData = await searchResp.json() as {
      videos?: Array<{
        id: number;
        duration: number;
        video_files: Array<{ width: number; height: number; link: string }>;
      }>;
    };

    if (!searchData.videos?.length) {
      console.warn(`[Pipeline] No Pexels results for: "${query}"`);
      return null;
    }

    // Pick best candidate: has enough duration, prefer 720p
    const candidates = searchData.videos.filter(v => v.duration >= 2);
    if (!candidates.length) return null;
    const video = candidates[sceneIndex % candidates.length];

    // Prefer SD quality (faster download)
    const videoFile = video.video_files
      .filter(f => f.width >= 640 && f.width <= 1280)
      .sort((a, b) => a.width - b.width)[0]
      || video.video_files.sort((a, b) => a.width - b.width)[0];

    if (!videoFile?.link) return null;

    console.log(`[Pipeline] Scene ${sceneIndex}: Pexels "${query}" → video ${video.id} (${videoFile.width}px)`);

    const downloadResp = await withTimeout(
      fetch(videoFile.link),
      15_000,  // 15s download timeout (was 30s)
      `Download Pexels clip scene ${sceneIndex}`
    );
    if (!downloadResp.ok) return null;

    const rawPath = outputPath.replace(".mp4", "_raw.mp4");
    const buffer = Buffer.from(await downloadResp.arrayBuffer());
    fs.writeFileSync(rawPath, buffer);

    // Trim/scale — ultrafast preset, crf 28 (slightly lower quality but much faster)
    const loopFlag = video.duration < clipDuration ? `-stream_loop -1` : "";
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ${loopFlag} -i "${rawPath}" ` +
        `-t ${clipDuration} ` +
        `-vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}" ` +
        `-c:v libx264 -preset ultrafast -crf 28 -an -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
      ),
      30_000,  // 30s trim timeout (was 45s)
      `Trim Pexels clip scene ${sceneIndex}`
    );

    try { fs.unlinkSync(rawPath); } catch { /* ignore */ }

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      return outputPath;
    }
    return null;
  } catch (err) {
    console.warn(`[Pipeline] Pexels clip failed scene ${sceneIndex}:`, err);
    return null;
  }
}

// ─── 3b. Color Fallback (instant) ────────────────────────────────────────────
async function generateColorFallback(sceneIndex: number, duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, `scene_${sceneIndex}_fallback.mp4`);
  const colors = ["0a0a1e", "0a1a2e", "1a0a2e", "0a2a1e", "1a1a0a", "2a0a1e", "0a1a1e", "1a0a1e"];
  const color = colors[sceneIndex % colors.length];
  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -f lavfi -i "color=c=#${color}:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
        `-t ${duration} -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
      ),
      15_000,
      `Fallback video scene ${sceneIndex}`
    );
  } catch {
    // Absolute fallback: 1-frame black video
    await exec(
      `${FFMPEG_BIN} -y -f lavfi -i "color=c=black:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
      `-t ${duration} -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
    ).catch(() => {
      fs.writeFileSync(outputPath, Buffer.alloc(0));
    });
  }
  return outputPath;
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

  const OVERLAY_H = 160;
  const canvas = createCanvas(VIDEO_WIDTH, OVERLAY_H);
  const ctx = canvas.getContext("2d");

  const grad = ctx.createLinearGradient(0, 0, 0, OVERLAY_H);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.3, "rgba(0,0,0,0.82)");
  grad.addColorStop(1, "rgba(0,0,0,0.92)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, VIDEO_WIDTH, OVERLAY_H);

  // Scene badge
  const badgeText = `${sceneIndex + 1} / ${totalScenes}`;
  ctx.fillStyle = "rgba(120,60,220,0.9)";
  ctx.beginPath();
  ctx.roundRect(30, 20, 110, 40, 20);
  ctx.fill();
  ctx.font = "bold 22px NotoSans";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.fillText(badgeText, 85, 47);

  // Subtitle text
  const cleanText = text.replace(/[^\x20-\x7E]/g, "").slice(0, 100).trim();
  ctx.font = "bold 40px NotoSans";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = 6;

  const words = cleanText.split(" ");
  const lines: string[] = [];
  let currentLine = "";
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length > 55 && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
    if (lines.length >= 2) break;
  }
  if (currentLine && lines.length < 2) lines.push(currentLine);

  const lineHeight = 48;
  const startY = lines.length === 1 ? 105 : 80;
  lines.forEach((line, i) => {
    ctx.fillText(line, VIDEO_WIDTH / 2, startY + i * lineHeight);
  });

  fs.writeFileSync(outputPath, canvas.toBuffer("image/png"));
  return outputPath;
}

// ─── 4b. Branded Intro Title Card ────────────────────────────────────────────
async function renderIntroCard(videoTitle: string, duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "intro_card.mp4");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createCanvas, registerFont } = require("canvas") as typeof import("canvas");

  try {
    registerFont(FONT_BOLD, { family: "NotoSans", weight: "bold" });
    registerFont(FONT_REGULAR, { family: "NotoSans", weight: "normal" });
  } catch { /* already registered */ }

  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext("2d");

  const bgGrad = ctx.createLinearGradient(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
  bgGrad.addColorStop(0, "#0a0a1e");
  bgGrad.addColorStop(0.5, "#1a0a2e");
  bgGrad.addColorStop(1, "#0a1a2e");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

  const glow = ctx.createRadialGradient(VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2, 0, VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2, 400);
  glow.addColorStop(0, "rgba(120,60,220,0.25)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

  ctx.font = "bold 36px NotoSans";
  ctx.fillStyle = "rgba(160,100,255,0.9)";
  ctx.textAlign = "center";
  ctx.fillText("FASTVID", VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2 - 160);

  ctx.strokeStyle = "rgba(120,60,220,0.6)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(VIDEO_WIDTH / 2 - 200, VIDEO_HEIGHT / 2 - 130);
  ctx.lineTo(VIDEO_WIDTH / 2 + 200, VIDEO_HEIGHT / 2 - 130);
  ctx.stroke();

  const title = videoTitle.replace(/[^\x20-\x7E]/g, "").slice(0, 100).toUpperCase();
  ctx.font = "bold 68px NotoSans";
  ctx.fillStyle = "white";
  ctx.shadowColor = "rgba(120,60,220,0.8)";
  ctx.shadowBlur = 20;

  const words = title.split(" ");
  const lines: string[] = [];
  let currentLine = "";
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length > 28 && currentLine) {
      lines.push(currentLine);
      currentLine = word;
      if (lines.length >= 3) break;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine && lines.length < 3) lines.push(currentLine);

  const lineHeight = 80;
  const totalH = lines.length * lineHeight;
  const startY = VIDEO_HEIGHT / 2 - totalH / 2 + 40;
  lines.forEach((line, i) => ctx.fillText(line, VIDEO_WIDTH / 2, startY + i * lineHeight));

  ctx.font = "26px NotoSans";
  ctx.fillStyle = "rgba(160,200,255,0.7)";
  ctx.shadowBlur = 0;
  ctx.fillText("AI-Generated Video", VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2 + 220);

  const pngPath = path.join(workDir, "intro_card.png");
  fs.writeFileSync(pngPath, canvas.toBuffer("image/png"));

  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -loop 1 -i "${pngPath}" ` +
      `-t ${duration} ` +
      `-vf "fade=t=in:st=0:d=0.4,fade=t=out:st=${duration - 0.4}:d=0.4" ` +
      `-c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -r 25 "${outputPath}" 2>/dev/null`
    ),
    20_000,
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

  try { registerFont(FONT_BOLD, { family: "NotoSans", weight: "bold" }); } catch { /* already registered */ }

  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext("2d");

  const bgGrad = ctx.createLinearGradient(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
  bgGrad.addColorStop(0, "#0a0a1e");
  bgGrad.addColorStop(1, "#1a0a2e");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

  const glow = ctx.createRadialGradient(VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2, 0, VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2, 500);
  glow.addColorStop(0, "rgba(0,200,180,0.2)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

  const btnW = 500, btnH = 100, btnX = VIDEO_WIDTH / 2 - btnW / 2, btnY = VIDEO_HEIGHT / 2 - 80;
  ctx.fillStyle = "#ff0000";
  ctx.beginPath();
  ctx.roundRect(btnX, btnY, btnW, btnH, 50);
  ctx.fill();
  ctx.font = "bold 52px NotoSans";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.fillText("SUBSCRIBE", VIDEO_WIDTH / 2, btnY + 68);

  ctx.font = "bold 48px NotoSans";
  ctx.fillStyle = "white";
  ctx.fillText("Thanks for watching!", VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2 - 160);

  ctx.font = "30px NotoSans";
  ctx.fillStyle = "rgba(160,200,255,0.8)";
  ctx.fillText("Like & Subscribe for more AI-generated videos", VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2 + 80);

  ctx.font = "bold 34px NotoSans";
  ctx.fillStyle = "rgba(160,100,255,0.9)";
  ctx.fillText("FASTVID", VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2 + 160);

  const pngPath = path.join(workDir, "outro_card.png");
  fs.writeFileSync(pngPath, canvas.toBuffer("image/png"));

  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -loop 1 -i "${pngPath}" ` +
      `-t ${duration} ` +
      `-vf "fade=t=in:st=0:d=0.4,fade=t=out:st=${duration - 0.4}:d=0.4" ` +
      `-c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -r 25 "${outputPath}" 2>/dev/null`
    ),
    20_000,
    "Outro card render"
  );

  try { fs.unlinkSync(pngPath); } catch { /* ignore */ }
  return outputPath;
}

// ─── 5. Compose Scene Video (single clip, simple overlay) ────────────────────
async function composeSceneVideo(
  scene: Scene,
  videoPath: string,
  audioPath: string,
  duration: number,
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${scene.index}_composed.mp4`);
  const subtitlePath = await renderSubtitleOverlay(scene.text, scene.index, MAX_SCENES, workDir);

  const OVERLAY_H = 160;
  const overlayY = VIDEO_HEIGHT - OVERLAY_H;
  const fadeFilter = `fade=t=in:st=0:d=0.25,fade=t=out:st=${Math.max(0, duration - 0.25)}:d=0.25`;

  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -i "${videoPath}" -i "${audioPath}" -loop 1 -i "${subtitlePath}" ` +
      `-filter_complex "[0:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}[scaled];[scaled][2:v]overlay=x=0:y=${overlayY}:shortest=1,${fadeFilter}[vout]" ` +
      `-map "[vout]" -map "1:a" ` +
      `-t ${duration} -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 64k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
    ),
    60_000,  // 60s per scene (was 120s)
    `Compose scene ${scene.index}`
  );

  try { fs.unlinkSync(subtitlePath); } catch { /* ignore */ }
  return outputPath;
}

// ─── 6. Fast Background Music ─────────────────────────────────────────────────
async function generateBackgroundMusic(duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "bg_music.mp3");
  try {
    // Simple 3-layer ambient track — faster than 6-layer version
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "sine=frequency=110:duration=${duration}" ` +
        `-f lavfi -i "sine=frequency=220:duration=${duration}" ` +
        `-f lavfi -i "sine=frequency=330:duration=${duration}" ` +
        `-filter_complex "
          [0]volume=0.3,aecho=0.9:0.9:80:0.5[bass];
          [1]volume=0.2,aecho=0.85:0.85:60:0.4[root];
          [2]volume=0.12,aecho=0.8:0.8:120:0.3[fifth];
          [bass][root][fifth]amix=inputs=3:duration=first,
          lowpass=f=1600,highpass=f=40,volume=0.4[music]
        " ` +
        `-map "[music]" -c:a libmp3lame -b:a 64k "${outputPath}" 2>/dev/null`
      ),
      30_000,
      "Background music generation"
    );
    return outputPath;
  } catch (err) {
    console.warn("[Pipeline] Music generation failed, using silence:", err);
    await exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${duration} -c:a libmp3lame -b:a 64k "${outputPath}" 2>/dev/null`).catch(() => {});
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

  // Render intro (3s) and outro (4s) in parallel
  const [introPath, outroPath] = await Promise.all([
    renderIntroCard(videoTitle, 3, workDir),
    renderOutroCard(4, workDir),
  ]);

  const allClips = [introPath, ...scenePaths, outroPath];
  const listContent = allClips.map(p => `file '${p}'`).join("\n");
  fs.writeFileSync(listFile, listContent, "utf-8");

  const totalWithCards = totalDuration + 3 + 4;

  // Concatenate + generate music in parallel
  const [, musicPath] = await Promise.all([
    withTimeout(
      exec(`${FFMPEG_BIN} -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 64k -movflags +faststart "${concatPath}" 2>/dev/null`),
      180_000,  // 3 min concat timeout
      "Scene concatenation"
    ),
    generateBackgroundMusic(totalWithCards + 5, workDir),
  ]);

  // Mix background music at 10% volume
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
      `-filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.10[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
      `-map "0:v" -map "[aout]" ` +
      `-c:v copy -c:a aac -b:a 64k -movflags +faststart "${outputPath}" 2>/dev/null`
    ),
    90_000,
    "Background music mixing"
  );

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

  const videoTitle = script.split("\n").find(l => l.trim().length > 5)?.trim().slice(0, 80) || "AI Generated Video";

  try {
    // ── Stage 1: Parse script into scenes ────────────────────────────────────
    onProgress?.({ stage: STAGE_LABELS.parsing, percent: 5 });
    const t0 = Date.now();
    const scenes = await parseScriptIntoScenes(script);
    console.log(`[Pipeline] Stage 1 (parse): ${scenes.length} scenes in ${((Date.now()-t0)/1000).toFixed(1)}s`);
    scenes.forEach((s, i) => console.log(`  Scene ${i}: query="${s.pexelsQuery}" text="${s.text.slice(0,60)}..."`));

    // ── Stage 2: Generate ALL voiceovers in parallel ──────────────────────────
    onProgress?.({ stage: STAGE_LABELS.voiceovers, percent: 12 });
    const t1 = Date.now();
    const audioPaths = scenes.map((_, i) => path.join(workDir, `scene_${i}_audio.mp3`));
    let durations: number[];

    if (customVoiceoverUrl) {
      console.log(`[Pipeline] Using custom voiceover: ${customVoiceoverUrl}`);
      const customAudioPath = path.join(workDir, "custom_voiceover.mp3");
      const resp = await fetch(customVoiceoverUrl);
      if (!resp.ok) throw new Error(`Failed to download custom voiceover: ${resp.status}`);
      fs.writeFileSync(customAudioPath, Buffer.from(await resp.arrayBuffer()));
      const totalDuration = await new Promise<number>((resolve) => {
        const { execFile } = require("child_process") as typeof import("child_process");
        execFile(FFMPEG_BIN.replace("ffmpeg", "ffprobe"), ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", customAudioPath], (_err: unknown, stdout: string) => {
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
      // All scenes in parallel with p-limit(4) — no bottleneck
      const limit = pLimit(4);
      let completedScenes = 0;
      durations = await withTimeout(
        Promise.all(scenes.map((scene, i) => limit(async () => {
          const dur = await generateVoiceover(scene.text, audioPaths[i], voiceId);
          completedScenes++;
          onProgress?.({ stage: `Creating voiceovers... (${completedScenes}/${scenes.length} done)`, percent: 12 + Math.round((completedScenes / scenes.length) * 14) });
          return dur;
        }))),
        180_000, // 3 min hard limit for all voiceovers
        "Voiceover generation stage"
      );
    }
    scenes.forEach((scene, i) => { scene.duration = Math.max(durations[i], 4); });
    console.log(`[Pipeline] Stage 2 (voiceovers): ${scenes.length} scenes in ${((Date.now()-t1)/1000).toFixed(1)}s`);

    // ── Stage 3: Fetch ONE Pexels clip per scene in parallel ──────────────────
    onProgress?.({ stage: STAGE_LABELS.visuals, percent: 28 });
    const t2 = Date.now();

    // Fetch all clips in parallel, use color fallback if Pexels fails
    const videoPaths: string[] = await withTimeout(
      Promise.all(scenes.map(async (scene) => {
        const clipPath = path.join(workDir, `scene_${scene.index}_clip.mp4`);
        const result = await fetchPexelsClip(scene.pexelsQuery, scene.duration + 1, clipPath, scene.index);
        if (result) return result;
        // Instant color fallback — no AI image generation
        console.warn(`[Pipeline] Scene ${scene.index}: Pexels failed, using color fallback`);
        return generateColorFallback(scene.index, scene.duration + 1, workDir);
      })),
      240_000, // 4 min hard limit for all visuals
      "Visual fetching stage"
    );

    console.log(`[Pipeline] Stage 3 (visuals): ${((Date.now()-t2)/1000).toFixed(1)}s`);

    // ── Stage 4: Compose all scenes in parallel ───────────────────────────────
    onProgress?.({ stage: STAGE_LABELS.composing, percent: 45 });
    const t3 = Date.now();
    const composedScenes = await withTimeout(
      Promise.all(
        scenes.map((scene, i) =>
          composeSceneVideo(scene, videoPaths[i], audioPaths[i], scene.duration, workDir)
        )
      ),
      600_000, // 10 min hard limit for compositing
      "Scene composition stage"
    );
    console.log(`[Pipeline] Stage 4 (compose): ${scenes.length} scenes in ${((Date.now()-t3)/1000).toFixed(1)}s`);

    // Cleanup intermediates
    for (let i = 0; i < scenes.length; i++) {
      try { fs.unlinkSync(audioPaths[i]); } catch { /* ignore */ }
      try { if (videoPaths[i] !== composedScenes[i]) fs.unlinkSync(videoPaths[i]); } catch { /* ignore */ }
    }

    // ── Stage 5: Concatenate + intro/outro + music ────────────────────────────
    onProgress?.({ stage: STAGE_LABELS.assembling, percent: 75 });
    const t4 = Date.now();
    const totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);
    const finalVideoPath = await concatenateScenesWithMusic(composedScenes, workDir, videoId, totalDuration, videoTitle);
    console.log(`[Pipeline] Stage 5 (assemble+music): ${((Date.now()-t4)/1000).toFixed(1)}s`);

    // ── Stage 6: Upload to S3 ─────────────────────────────────────────────────
    onProgress?.({ stage: STAGE_LABELS.uploading, percent: 93 });
    const t5 = Date.now();
    const videoBuffer = fs.readFileSync(finalVideoPath);
    const { url } = await withTimeout(
      storagePut(`videos/${videoId}/final.mp4`, videoBuffer, "video/mp4"),
      180_000,
      "S3 upload"
    );
    console.log(`[Pipeline] Stage 6 (upload): ${((Date.now()-t5)/1000).toFixed(1)}s, file size: ${(videoBuffer.length/1024/1024).toFixed(1)}MB`);

    onProgress?.({ stage: STAGE_LABELS.complete, percent: 100 });
    const totalMs = Date.now() - t0;
    console.log(`[Pipeline] Video ${videoId} COMPLETE in ${(totalMs/60000).toFixed(1)} min (${(totalMs/1000).toFixed(0)}s total): ${url}`);
    return url;
  } finally {
    try {
      const { exec: execSync } = require("child_process");
      execSync(`rm -rf "${workDir}"`);
    } catch { /* ignore */ }
  }
}
