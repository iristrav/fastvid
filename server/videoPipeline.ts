/**
 * Fastvid — AI Video Generation Pipeline (v5 — Stability AI + Dynamic Scenes)
 *
 * Visual strategy (per scene):
 *   1. PRIMARY:   Stability AI SDXL image → FFmpeg zoom-loop video (~5-10s)
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
 * Per scene: 1 AI image (zoompan) + 2-3 Pexels clips joined with xfade transitions.
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
import pLimit from "p-limit";

// API Keys
const FISH_AUDIO_API_KEY = process.env.FISH_AUDIO_API_KEY || "";
const STABILITY_AI_API_KEY = process.env.STABILITY_AI_API_KEY || "";
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || "";

// @ts-ignore
import ffmpegStatic from "ffmpeg-static";
const FFMPEG_BIN: string = (ffmpegStatic as unknown as string) || "ffmpeg";
const execRaw = promisify(execCb);
const exec = (cmd: string) => execRaw(cmd.replace(/^ffmpeg\b/, FFMPEG_BIN));

// Font paths
const FONT_BOLD = "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf";
const FONT_REGULAR = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf";

const TMP_DIR = os.tmpdir();
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;

// ─── Dynamic scene count based on video length ────────────────────────────────
function getScenesForLength(videoLength: string): number {
  switch (videoLength) {
    case "5-8":   return 12;
    case "8-12":  return 20;
    case "12-15": return 25;
    case "15-20": return 30;
    case "20+":   return 35;
    default:      return 20;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface Scene {
  index: number;
  text: string;
  visualCue: string;
  pexelsQuery: string;
  aiImagePrompt: string;
  duration: number;
}

export interface PipelineProgress {
  stage: string;
  percent: number;
}

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
          content: `You are a video production assistant. Parse the given YouTube video script into exactly ${maxScenes} scenes.
For each scene, extract:
- text: The narration text (1-3 sentences, what will be spoken). Max 250 characters.
- visualCue: A short 3-5 word description of what to show
- pexelsQuery: ONE best Pexels video search query (3-6 words, English, specific, descriptive). Examples:
  "aerial city skyline night", "scientist lab experiment", "stock market trading floor", "ocean waves sunset beach"
- aiImagePrompt: A detailed, vivid image generation prompt (20-35 words) describing a cinematic, photorealistic scene. Include lighting, mood, style, camera angle. Examples:
  "Cinematic aerial view of a futuristic city at night, neon lights reflecting on wet streets, dramatic fog, photorealistic, 8K, wide angle"
  "Close-up of a scientist in a modern lab examining glowing blue liquid in a flask, dramatic side lighting, photorealistic, shallow depth of field"

IMPORTANT:
- Return exactly ${maxScenes} scenes covering the entire script evenly
- Keep text SHORT (max 250 chars each)
- Make aiImagePrompt vivid, cinematic and highly detailed
- Make pexelsQuery specific and descriptive for best stock video results`,
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
                    aiImagePrompt: { type: "string" },
                  },
                  required: ["text", "visualCue", "pexelsQuery", "aiImagePrompt"],
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
  const rawScenes = (parsed.scenes as Omit<Scene, "index" | "duration">[]).slice(0, maxScenes);
  return rawScenes.map((s, i) => ({
    ...s,
    index: i,
    duration: 0,
    pexelsQuery: s.pexelsQuery?.trim() || s.visualCue || "cinematic background",
    aiImagePrompt: s.aiImagePrompt?.trim() || `Cinematic ${s.visualCue || "landscape"}, dramatic lighting, photorealistic, 8K`,
  }));
}

// ─── 2. TTS Voiceover (Fish Audio S2 Pro) ────────────────────────────────────
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
  const cleanText = rawText.length <= 250 ? rawText : rawText.slice(0, 250).replace(/\s\S*$/, "");

  const MAX_ATTEMPTS = 3;
  const TTS_TIMEOUT_MS = 15_000;

  if (FISH_AUDIO_API_KEY) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const body: Record<string, unknown> = {
          text: cleanText,
          format: "mp3",
          model: "s2-pro",
          mp3_bitrate: 64,
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
          const waitMs = 300 + attempt * 200;
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
        const durationSec = Math.max(3, Math.round(audioBuffer.length / 8000));
        console.log(`[Pipeline] TTS scene ${outputPath.match(/scene_(\d+)/)?.[1] ?? "?"}: ${durationSec}s`);
        return durationSec;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          console.warn(`[Pipeline] Fish Audio failed after ${MAX_ATTEMPTS} attempts:`, err);
          break;
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  // Silent fallback
  const estimatedDuration = Math.max(3, Math.ceil(cleanText.split(" ").length / 2.5));
  try {
    await withTimeout(
      exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${estimatedDuration} -c:a libmp3lame -b:a 64k "${outputPath}" 2>/dev/null`),
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

    // Use Stability AI SDXL v1.0 — best quality/cost ratio
    const formData = new FormData();
    formData.append("text_prompts[0][text]", prompt);
    formData.append("text_prompts[0][weight]", "1");
    formData.append("text_prompts[1][text]", "blurry, low quality, watermark, text, logo, ugly, deformed");
    formData.append("text_prompts[1][weight]", "-1");
    formData.append("cfg_scale", "7");
    formData.append("height", "720");
    formData.append("width", "1280");
    formData.append("samples", "1");
    formData.append("steps", "30");

    const response = await withTimeout(
      fetch("https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${STABILITY_AI_API_KEY}`,
          Accept: "application/json",
        },
        body: formData,
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

    // Convert to video with gentle Ken Burns zoom
    const zoomDuration = duration + 0.5;
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -loop 1 -i "${pngPath}" ` +
        `-vf "scale=${VIDEO_WIDTH * 2}:${VIDEO_HEIGHT * 2}:force_original_aspect_ratio=increase,` +
        `crop=${VIDEO_WIDTH * 2}:${VIDEO_HEIGHT * 2},` +
        `zoompan=z='min(zoom+0.0005,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(zoomDuration * 25)}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=25,` +
        `fade=t=in:st=0:d=0.3" ` +
        `-t ${zoomDuration} -c:v libx264 -preset ultrafast -crf 26 -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
      ),
      60_000,
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
  count: number = 2
): Promise<string[]> {
  if (!PEXELS_API_KEY) return [];

  const results: string[] = [];
  try {
    const searchUrl = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=10&size=small&orientation=landscape`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { Authorization: PEXELS_API_KEY } }),
      8_000,
      `Pexels search scene ${sceneIndex}`
    );

    if (!searchResp.ok) return [];

    const searchData = await searchResp.json() as {
      videos?: Array<{
        id: number;
        duration: number;
        video_files: Array<{ width: number; height: number; link: string }>;
      }>;
    };

    if (!searchData.videos?.length) return [];

    const candidates = searchData.videos.filter(v => v.duration >= 2).slice(0, count * 2);

    // Download up to `count` clips in parallel
    const downloadLimit = pLimit(count);
    const downloadResults = await Promise.allSettled(
      candidates.slice(0, count).map((video, idx) => downloadLimit(async () => {
        const videoFile = video.video_files
          .filter(f => f.width >= 640 && f.width <= 1280)
          .sort((a, b) => a.width - b.width)[0]
          || video.video_files.sort((a, b) => a.width - b.width)[0];

        if (!videoFile?.link) return null;

        const rawPath = path.join(workDir, `scene_${sceneIndex}_pexels_${idx}_raw.mp4`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_pexels_${idx}.mp4`);

        const downloadResp = await withTimeout(
          fetch(videoFile.link),
          15_000,
          `Download Pexels clip ${idx} scene ${sceneIndex}`
        );
        if (!downloadResp.ok) return null;

        const buffer = Buffer.from(await downloadResp.arrayBuffer());
        fs.writeFileSync(rawPath, buffer);

        const loopFlag = video.duration < clipDuration ? `-stream_loop -1` : "";
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y ${loopFlag} -i "${rawPath}" ` +
            `-t ${clipDuration} ` +
            `-vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}" ` +
            `-c:v libx264 -preset ultrafast -crf 28 -an -pix_fmt yuv420p "${outPath}" 2>/dev/null`
          ),
          30_000,
          `Trim Pexels clip ${idx} scene ${sceneIndex}`
        );

        try { fs.unlinkSync(rawPath); } catch { /* ignore */ }

        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return outPath;
        return null;
      }))
    );

    for (const r of downloadResults) {
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    }
  } catch (err) {
    console.warn(`[Pipeline] Pexels clips failed scene ${sceneIndex}:`, err);
  }

  return results;
}

// ─── 3c. Color Fallback (LAST RESORT) ────────────────────────────────────────
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
      15_000, `Fallback video scene ${sceneIndex}`
    );
  } catch {
    await exec(
      `${FFMPEG_BIN} -y -f lavfi -i "color=c=black:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
      `-t ${duration} -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
    ).catch(() => { fs.writeFileSync(outputPath, Buffer.alloc(0)); });
  }
  return outputPath;
}

// ─── 3d. Fetch All Visuals for a Scene ───────────────────────────────────────
// Returns array of valid clip paths (AI image first, then Pexels clips)
async function fetchSceneVisuals(
  scene: Scene,
  workDir: string
): Promise<string[]> {
  const halfDur = Math.max(3, Math.ceil(scene.duration / 3));
  const aiClipPath = path.join(workDir, `scene_${scene.index}_ai.mp4`);

  // Run AI image gen and Pexels fetch in parallel
  const [aiResult, pexelsResults] = await Promise.allSettled([
    generateStabilityAIClip(scene.aiImagePrompt, halfDur, aiClipPath, scene.index),
    fetchPexelsClips(scene.pexelsQuery, halfDur, workDir, scene.index, 2),
  ]);

  const aiClip = aiResult.status === "fulfilled" ? aiResult.value : null;
  const pexelsClips = pexelsResults.status === "fulfilled" ? pexelsResults.value : [];

  const clips: string[] = [];

  // AI image goes first (primary visual)
  if (aiClip) clips.push(aiClip);

  // Then Pexels clips
  for (const clip of pexelsClips) {
    clips.push(clip);
  }

  // If nothing worked, use color fallback
  if (clips.length === 0) {
    console.warn(`[Pipeline] Scene ${scene.index}: All visuals failed, using color fallback`);
    clips.push(await generateColorFallback(scene.index, scene.duration + 1, workDir));
  }

  console.log(`[Pipeline] Scene ${scene.index}: ${clips.length} clip(s) ready (AI: ${aiClip ? "✓" : "✗"}, Pexels: ${pexelsClips.length})`);
  return clips;
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

  const badgeText = `${sceneIndex + 1} / ${totalScenes}`;
  ctx.fillStyle = "rgba(120,60,220,0.9)";
  ctx.beginPath();
  ctx.roundRect(30, 20, 110, 40, 20);
  ctx.fill();
  ctx.font = "bold 22px NotoSans";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.fillText(badgeText, 85, 47);

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
    20_000, "Intro card render"
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
    20_000, "Outro card render"
  );

  try { fs.unlinkSync(pngPath); } catch { /* ignore */ }
  return outputPath;
}

// ─── 5. Compose Scene Video (multi-clip with xfade transitions) ───────────────
async function composeSceneVideo(
  scene: Scene,
  clips: string[],
  audioPath: string,
  duration: number,
  workDir: string,
  totalScenes: number
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${scene.index}_composed.mp4`);

  // Ensure we have at least one valid clip
  const validClips = clips.filter(p => fs.existsSync(p) && fs.statSync(p).size > 100);
  const safeClips = validClips.length > 0
    ? validClips
    : [await generateColorFallback(scene.index, duration + 1, workDir)];

  // Validate audio
  const audioValid = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 100;
  let safeAudioPath = audioPath;
  if (!audioValid) {
    safeAudioPath = path.join(workDir, `scene_${scene.index}_silent.mp3`);
    try {
      await withTimeout(
        exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${duration} -c:a libmp3lame -b:a 64k "${safeAudioPath}" 2>/dev/null`),
        10_000, `Silent fallback scene ${scene.index}`
      );
    } catch {
      fs.writeFileSync(safeAudioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(413).fill(0)]));
    }
  }

  // Subtitle overlay
  let subtitlePath: string | null = null;
  try {
    subtitlePath = await renderSubtitleOverlay(scene.text, scene.index, totalScenes, workDir);
  } catch (err) {
    console.warn(`[Pipeline] Scene ${scene.index}: subtitle render failed:`, err);
  }

  const OVERLAY_H = 160;
  const overlayY = VIDEO_HEIGHT - OVERLAY_H;
  const fadeFilter = `fade=t=in:st=0:d=0.2,fade=t=out:st=${Math.max(0, duration - 0.2)}:d=0.2`;
  const xfadeDur = 0.4;

  try {
    if (safeClips.length >= 2) {
      // Multi-clip with xfade transitions
      // Build filter_complex for N clips
      const clipDur = Math.max(2, Math.floor(duration / safeClips.length));
      const inputs = safeClips.map(c => `-i "${c}"`).join(" ");
      const scaleFilters = safeClips.map((_, i) =>
        `[${i}:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}[v${i}]`
      ).join(";");

      // Chain xfades: [v0][v1]xfade...[xf01]; [xf01][v2]xfade...[xf012]; etc.
      let xfadeChain = "";
      let lastLabel = "v0";
      for (let i = 1; i < safeClips.length; i++) {
        const offset = Math.max(0.5, clipDur * i - xfadeDur);
        const outLabel = i === safeClips.length - 1 ? "xfaded" : `xf${i}`;
        xfadeChain += `;[${lastLabel}][v${i}]xfade=transition=fade:duration=${xfadeDur}:offset=${offset}[${outLabel}]`;
        lastLabel = outLabel;
      }

      if (subtitlePath && fs.existsSync(subtitlePath)) {
        const subInput = `-loop 1 -i "${subtitlePath}"`;
        const subIdx = safeClips.length;
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y ${inputs} -i "${safeAudioPath}" ${subInput} ` +
            `-filter_complex "${scaleFilters}${xfadeChain};[xfaded][${subIdx + 1}:v]overlay=x=0:y=${overlayY}:shortest=1,${fadeFilter}[vout]" ` +
            `-map "[vout]" -map "${subIdx}:a" ` +
            `-t ${duration} -c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 64k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
          ),
          120_000, `Compose multi-clip scene ${scene.index}`
        );
      } else {
        const audioIdx = safeClips.length;
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y ${inputs} -i "${safeAudioPath}" ` +
            `-filter_complex "${scaleFilters}${xfadeChain};[xfaded]${fadeFilter}[vout]" ` +
            `-map "[vout]" -map "${audioIdx}:a" ` +
            `-t ${duration} -c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 64k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
          ),
          120_000, `Compose multi-clip scene ${scene.index} (no subtitle)`
        );
      }
    } else {
      // Single clip
      const clip = safeClips[0];
      if (subtitlePath && fs.existsSync(subtitlePath)) {
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y -i "${clip}" -i "${safeAudioPath}" -loop 1 -i "${subtitlePath}" ` +
            `-filter_complex "[0:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}[scaled];[scaled][2:v]overlay=x=0:y=${overlayY}:shortest=1,${fadeFilter}[vout]" ` +
            `-map "[vout]" -map "1:a" ` +
            `-t ${duration} -c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 64k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
          ),
          75_000, `Compose 1-clip scene ${scene.index}`
        );
      } else {
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y -i "${clip}" -i "${safeAudioPath}" ` +
            `-filter_complex "[0:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},${fadeFilter}[vout]" ` +
            `-map "[vout]" -map "1:a" ` +
            `-t ${duration} -c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 64k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
          ),
          75_000, `Compose 1-clip scene ${scene.index} (no subtitle)`
        );
      }
    }
  } catch (composeErr) {
    // Last resort: simple mux
    console.warn(`[Pipeline] Scene ${scene.index}: compose failed, trying simple mux:`, composeErr);
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -i "${safeClips[0]}" -i "${safeAudioPath}" ` +
        `-t ${duration} -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 64k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
      ),
      45_000, `Simple mux scene ${scene.index}`
    );
  }

  if (subtitlePath) { try { fs.unlinkSync(subtitlePath); } catch { /* ignore */ } }
  return outputPath;
}

// ─── 6. Fast Background Music ─────────────────────────────────────────────────
async function generateBackgroundMusic(duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "bg_music.mp3");
  try {
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
      30_000, "Background music generation"
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

  const [introPath, outroPath] = await Promise.all([
    renderIntroCard(videoTitle, 3, workDir),
    renderOutroCard(4, workDir),
  ]);

  const validScenePaths = scenePaths.filter(p => {
    try { return fs.existsSync(p) && fs.statSync(p).size > 100; } catch { return false; }
  });
  if (validScenePaths.length === 0) throw new Error("No valid composed scene files to concatenate");

  const allClips = [introPath, ...validScenePaths, outroPath];
  const listContent = allClips.map(p => `file '${p}'`).join("\n");
  fs.writeFileSync(listFile, listContent, "utf-8");

  const totalWithCards = totalDuration + 3 + 4;

  const [, musicPath] = await Promise.all([
    withTimeout(
      exec(`${FFMPEG_BIN} -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 64k -movflags +faststart "${concatPath}" 2>/dev/null`),
      600_000, // 10 min for large videos (30+ scenes)
      "Scene concatenation"
    ),
    generateBackgroundMusic(totalWithCards + 5, workDir),
  ]);

  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
      `-filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.10[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
      `-map "0:v" -map "[aout]" ` +
      `-c:v copy -c:a aac -b:a 64k -movflags +faststart "${outputPath}" 2>/dev/null`
    ),
    120_000, "Background music mixing"
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
  customVoiceoverUrl?: string,
  videoLength: string = "8-12"
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
      // Process voiceovers in batches of 8 to avoid Fish Audio rate limits
      const voiceLimit = pLimit(8);
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
        300_000, // 5 min for all voiceovers
        "Voiceover generation stage"
      );
    }
    scenes.forEach((scene, i) => { scene.duration = Math.max(durations[i], 4); });
    console.log(`[Pipeline] Stage 2 (voiceovers): ${scenes.length} in ${((Date.now()-t1)/1000).toFixed(1)}s`);

    // ── Stage 3: Fetch AI images + Pexels clips in parallel batches ───────────
    onProgress?.({ stage: STAGE_LABELS.visuals, percent: 20 });
    const t2 = Date.now();

    // Process visuals in batches of 4 to avoid Stability AI rate limits
    const visualLimit = pLimit(4);
    let completedVisuals = 0;
    const sceneVisuals: string[][] = await withTimeout(
      Promise.all(scenes.map(scene => visualLimit(async () => {
        const clips = await fetchSceneVisuals(scene, workDir);
        completedVisuals++;
        onProgress?.({
          stage: `Generating AI visuals... (${completedVisuals}/${scenes.length} done)`,
          percent: 20 + Math.round((completedVisuals / scenes.length) * 25)
        });
        return clips;
      }))),
      1800_000, // 30 min hard limit for all visuals (large scene count)
      "Visual generation stage"
    );
    console.log(`[Pipeline] Stage 3 (visuals): ${((Date.now()-t2)/1000).toFixed(1)}s`);

    // ── Stage 4: Compose all scenes in parallel batches ───────────────────────
    onProgress?.({ stage: STAGE_LABELS.composing, percent: 47 });
    const t3 = Date.now();

    // Process compose in batches of 4 to avoid CPU saturation
    const composeLimit = pLimit(4);
    let completedCompose = 0;
    const composedScenes = await withTimeout(
      Promise.all(
        scenes.map((scene, i) => composeLimit(async () => {
          const result = await composeSceneVideo(scene, sceneVisuals[i], audioPaths[i], scene.duration, workDir, scenes.length);
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

    // ── Stage 5: Concatenate + intro/outro + music ────────────────────────────
    onProgress?.({ stage: STAGE_LABELS.assembling, percent: 77 });
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
      300_000, // 5 min upload timeout for large files
      "S3 upload"
    );
    console.log(`[Pipeline] Stage 6 (upload): ${((Date.now()-t5)/1000).toFixed(1)}s, size: ${(videoBuffer.length/1024/1024).toFixed(1)}MB`);

    onProgress?.({ stage: STAGE_LABELS.complete, percent: 100 });
    const totalMs = Date.now() - t0;
    console.log(`[Pipeline] Video ${videoId} COMPLETE in ${(totalMs/60000).toFixed(1)} min: ${url}`);
    return url;
  } finally {
    try {
      const { exec: execSync } = require("child_process");
      execSync(`rm -rf "${workDir}"`);
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
