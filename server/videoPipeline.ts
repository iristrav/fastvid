/**
 * Fastvid — AI Video Generation Pipeline (Vidrush-level)
 *
 * Pipeline stages (all parallel where possible):
 * 1. Parse script into max 8 scenes with visual cues + image prompts  (max 45 sec)
 * 2. Generate ALL voiceovers in parallel                               (max 8 min)
 * 3. Generate ALL AI visuals in parallel — 3 images per scene         (max 12 min)
 *    → Each scene gets 3 unique AI-generated cinematic images
 *    → Each image shown for ~3s with xfade crossfade transitions
 * 4. Compose each scene video in parallel                              (max 20 min)
 *    → Ken Burns zoom-pan on each image
 *    → xfade crossfade between images within a scene
 *    → Subtitle lower-third overlay (canvas-rendered PNG)
 *    → Scene number badge (top-right corner)
 * 5. Concatenate all scenes into final MP4                             (max 10 min)
 *    → Mix background ambient music at 15% volume under voiceovers
 * 6. Upload to S3                                                      (max 5 min)
 *
 * Total hard cap: 1 hour (enforced via global timeout in routers.ts)
 * All visuals are 100% AI-generated — no stock footage used.
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

// ─── Types ────────────────────────────────────────────────────────────────────
interface Scene {
  index: number;
  text: string;
  visualCue: string;
  imagePrompts: string[]; // 3 prompts per scene
  duration: number;
}

export interface PipelineProgress {
  stage: string;
  percent: number;
}

const TMP_DIR = os.tmpdir();
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const MAX_SCENES = 8;
const IMAGES_PER_SCENE = 3; // 3 AI images per scene, each ~3s with xfade

// ─── Timeout helper ───────────────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${Math.round(ms / 1000)}s`)), ms)
    ),
  ]);
}

// ─── Stage labels with max-time estimates (shown in the UI) ──────────────────
export const STAGE_LABELS = {
  parsing:    `Parsing script into ${MAX_SCENES} scenes... (max 45 sec)`,
  voiceovers: `Generating voiceovers for all ${MAX_SCENES} scenes... (max 8 min)`,
  visuals:    `Generating ${IMAGES_PER_SCENE} AI visuals per scene (${MAX_SCENES * IMAGES_PER_SCENE} total)... (max 12 min)`,
  composing:  `Composing all ${MAX_SCENES} scenes with transitions... (max 20 min)`,
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
- imagePrompts: An array of exactly ${IMAGES_PER_SCENE} different AI image generation prompts for this scene.
  Each prompt should be 15-25 words, vivid, cinematic, photorealistic, suitable for a YouTube video.
  The ${IMAGES_PER_SCENE} prompts should show different angles/aspects of the same topic for visual variety.
  Style: cinematic 4K, dramatic lighting, ultra-detailed, professional photography or digital art.
  Example for "Morgan Freeman owns a Cessna":
    ["Morgan Freeman standing beside a vintage Cessna 414 airplane on a sunlit airfield, cinematic 4K",
     "Close-up of a polished propeller engine on a classic twin-engine aircraft, golden hour lighting",
     "Interior cockpit view of a vintage propeller plane with leather seats, dramatic shadows"]
IMPORTANT: Return exactly ${MAX_SCENES} scenes with exactly ${IMAGES_PER_SCENE} imagePrompts each.`,
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
                    imagePrompts: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: ["text", "visualCue", "imagePrompts"],
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
    // Ensure exactly IMAGES_PER_SCENE prompts
    imagePrompts: Array.from({ length: IMAGES_PER_SCENE }, (_, j) =>
      s.imagePrompts?.[j] || `${s.visualCue}, cinematic 4K, dramatic lighting, scene ${j + 1}`
    ),
  }));
}

// ─── 2. TTS Voiceover ─────────────────────────────────────────────────────────
/**
 * Generates a voiceover MP3 using node-gtts (Google TTS via HTTP).
 * - Timeout per attempt: 60 seconds
 * - Retries: up to 3 attempts with exponential backoff (2s, 4s, 8s)
 * - Fallback: silent MP3 via FFmpeg if all attempts fail
 */
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

// ─── 3. AI Visual Generation ──────────────────────────────────────────────────
/**
 * Generates one AI image for a scene using the forge ImageService.
 * Returns the local file path.
 */
async function generateOneAIImage(
  prompt: string,
  outputPath: string,
  label: string
): Promise<string> {
  const { url: imageUrl } = await withTimeout(
    generateImage({ prompt }),
    45_000,
    label
  );

  if (!imageUrl) throw new Error(`No image URL returned for ${label}`);

  const response = await withTimeout(fetch(imageUrl), 15_000, `Download ${label}`);
  if (!response.ok) throw new Error(`Failed to download ${label}: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  console.log(`[Pipeline] ${label} saved (${buffer.length} bytes)`);
  return outputPath;
}

/**
 * Generates IMAGES_PER_SCENE AI images for a scene in parallel.
 * Falls back to solid-color PNG if any individual image fails.
 */
async function generateAIVisualsForScene(
  scene: Scene,
  workDir: string
): Promise<string[]> {
  const colors = ["0a0a1e", "0a1a2e", "1a0a2e", "0a2a1e", "1a1a0a", "2a0a1e", "0a1a1e", "1a0a1e"];

  return Promise.all(
    scene.imagePrompts.map(async (prompt, imgIdx) => {
      const outputPath = path.join(workDir, `scene_${scene.index}_img${imgIdx}.png`);
      const label = `scene ${scene.index} image ${imgIdx + 1}`;
      try {
        return await generateOneAIImage(prompt, outputPath, label);
      } catch (err) {
        console.warn(`[Pipeline] AI image failed for ${label}, using color fallback:`, err);
        const color = colors[(scene.index * IMAGES_PER_SCENE + imgIdx) % colors.length];
        try {
          await withTimeout(
            exec(`${FFMPEG_BIN} -y -f lavfi -i "color=c=#${color}:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=1" -frames:v 1 "${outputPath}" 2>/dev/null`),
            15_000,
            `Fallback PNG ${label}`
          );
        } catch {
          const blackPng = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108020000009001" + "2e00000000c4944415408d76360000000020001e221bc330000000049454e44ae426082", "hex");
          fs.writeFileSync(outputPath, blackPng);
        }
        return outputPath;
      }
    })
  );
}

// ─── 4a. Canvas Title Overlays ────────────────────────────────────────────────
/**
 * Renders a subtitle lower-third PNG using Node canvas.
 * Returns the path to the PNG file.
 *
 * Layout: semi-transparent black bar at bottom with white subtitle text
 * and a purple scene badge on the left.
 */
async function renderSubtitleOverlay(
  text: string,
  sceneIndex: number,
  totalScenes: number,
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${sceneIndex}_subtitle.png`);

  // Use canvas (Node.js) — drawtext not available in ffmpeg-static
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

  // Subtitle text (centered, white, bold)
  const cleanText = text
    .replace(/[^\x20-\x7E]/g, "")
    .slice(0, 120)
    .trim();

  ctx.font = "bold 46px NotoSans";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = 8;

  // Word-wrap: split into max 2 lines of ~60 chars each
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
 * Composes a scene from IMAGES_PER_SCENE AI images:
 * - Each image animated with Ken Burns zoom-pan (alternating directions)
 * - xfade crossfade transitions between images (0.5s)
 * - Subtitle lower-third overlay (canvas PNG)
 * - Voiceover audio track
 * - Fade in/out at scene boundaries
 */
async function composeSceneVideo(
  scene: Scene,
  imagePaths: string[],
  audioPath: string,
  duration: number,
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${scene.index}_composed.mp4`);

  // Render subtitle overlay PNG
  const subtitlePath = await renderSubtitleOverlay(
    scene.text,
    scene.index,
    MAX_SCENES,
    workDir
  );

  // Distribute duration across images
  const XFADE_DURATION = 0.5;
  const imgDuration = Math.max(3, duration / IMAGES_PER_SCENE);
  const frames = (t: number) => Math.ceil(t * 30);

  // Ken Burns zoom directions: alternate per image for variety
  const zoomDirs = ["+", "-", "+"];
  const panPatterns = [
    `iw/2-(iw/zoom/2)`,                    // center
    `iw/2-(iw/zoom/2)+${scene.index * 3}`, // slight right
    `iw/2-(iw/zoom/2)-${scene.index * 3}`, // slight left
  ];

  // Build FFmpeg filter_complex for multiple images with xfade
  // Each image: loop 1 → scale 2x → zoompan Ken Burns → scale to output
  const inputArgs = imagePaths.map(p => `-loop 1 -t ${imgDuration + XFADE_DURATION} -i "${p}"`).join(" ");
  const audioArg = `-i "${audioPath}"`;

  // Per-image Ken Burns filter
  const kenBurnsFilters = imagePaths.map((_, i) => {
    const zDir = zoomDirs[i % zoomDirs.length];
    const panX = panPatterns[i % panPatterns.length];
    const f = frames(imgDuration + XFADE_DURATION);
    return `[${i}:v]scale=${VIDEO_WIDTH * 2}:${VIDEO_HEIGHT * 2},zoompan=z='min(zoom${zDir}0.0005,1.25)':x='${panX}':y='ih/2-(ih/zoom/2)':d=${f}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=30[kb${i}]`;
  });

  // Chain xfade transitions between Ken Burns clips
  let xfadeChain = "";
  let prevLabel = "kb0";
  for (let i = 1; i < imagePaths.length; i++) {
    const offset = imgDuration * i - XFADE_DURATION * i;
    const outLabel = i === imagePaths.length - 1 ? "vbase" : `xf${i}`;
    xfadeChain += `[${prevLabel}][kb${i}]xfade=transition=fade:duration=${XFADE_DURATION}:offset=${offset.toFixed(2)}[${outLabel}];`;
    prevLabel = outLabel;
  }

  // If only 1 image (shouldn't happen but safety), just rename
  if (imagePaths.length === 1) {
    xfadeChain = `[kb0]copy[vbase];`;
  }

  // Overlay subtitle PNG at bottom of video
  const OVERLAY_H = 180;
  const overlayY = VIDEO_HEIGHT - OVERLAY_H;

  // Fade in/out on the final video
  const totalDuration = imgDuration * IMAGES_PER_SCENE - XFADE_DURATION * (IMAGES_PER_SCENE - 1);
  const fadeFilter = `fade=t=in:st=0:d=0.4,fade=t=out:st=${Math.max(0, totalDuration - 0.4)}:d=0.4`;

  const subtitleInput = `-loop 1 -i "${subtitlePath}"`;
  const subtitleIdx = imagePaths.length + 1; // +1 for audio

  const filterComplex = [
    ...kenBurnsFilters,
    xfadeChain,
    `[vbase][${subtitleIdx}:v]overlay=x=0:y=${overlayY}:shortest=1,${fadeFilter}[vout]`,
  ].join(";");

  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y ${inputArgs} ${audioArg} ${subtitleInput} ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[vout]" -map "${imagePaths.length}:a" ` +
      `-t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
    ),
    240_000,
    `Compose scene ${scene.index}`
  );

  // Cleanup overlay file
  try { fs.unlinkSync(subtitlePath); } catch { /* ignore */ }

  return outputPath;
}

// ─── 5. Generate Background Music ─────────────────────────────────────────────
/**
 * Generates a looping ambient music track using FFmpeg's sine wave generator.
 * This creates a simple but pleasant ambient tone that serves as background music.
 *
 * For a more professional result, a royalty-free music file could be used here.
 * The music is mixed at 15% volume under the voiceovers.
 */
async function generateAmbientMusic(duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "ambient_music.mp3");

  // Generate a layered ambient tone: multiple sine waves at different frequencies
  // Creates a cinematic, atmospheric sound
  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "sine=frequency=220:duration=${duration}" ` +
        `-f lavfi -i "sine=frequency=330:duration=${duration}" ` +
        `-f lavfi -i "sine=frequency=440:duration=${duration}" ` +
        `-f lavfi -i "sine=frequency=110:duration=${duration}" ` +
        `-filter_complex ` +
        `"[0]volume=0.3[a0];[1]volume=0.2[a1];[2]volume=0.15[a2];[3]volume=0.25[a3];` +
        `[a0][a1][a2][a3]amix=inputs=4:duration=first,` +
        `aecho=0.8:0.88:60:0.4,` +
        `lowpass=f=800,` +
        `volume=0.4[music]" ` +
        `-map "[music]" -c:a libmp3lame -b:a 128k "${outputPath}" 2>/dev/null`
      ),
      30_000,
      "Ambient music generation"
    );
    return outputPath;
  } catch (err) {
    console.warn("[Pipeline] Ambient music generation failed, using silence:", err);
    // Fallback: silent track
    await exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${duration} -c:a libmp3lame -b:a 128k "${outputPath}" 2>/dev/null`);
    return outputPath;
  }
}

// ─── 6. Final Concatenation + Music Mix ───────────────────────────────────────
/**
 * Concatenates all scene videos and mixes in background ambient music at 15% volume.
 */
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
    exec(
      `${FFMPEG_BIN} -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -movflags +faststart "${concatPath}" 2>/dev/null`
    ),
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

    // Stage 2: Generate ALL voiceovers in parallel (max 8 min)
    onProgress?.({ stage: STAGE_LABELS.voiceovers, percent: 12 });
    const audioPaths = scenes.map((_, i) => path.join(workDir, `scene_${i}_audio.mp3`));
    const durations = await withTimeout(
      Promise.all(scenes.map((scene, i) => generateVoiceover(scene.text, audioPaths[i]))),
      480_000,
      "Voiceover generation stage"
    );
    scenes.forEach((scene, i) => { scene.duration = Math.max(durations[i], IMAGES_PER_SCENE * 3); });
    console.log(`[Pipeline] All ${scenes.length} voiceovers generated in parallel`);

    // Stage 3: Generate ALL AI visuals in parallel — 3 images per scene (max 12 min)
    onProgress?.({ stage: STAGE_LABELS.visuals, percent: 25 });
    const sceneImagePaths = await withTimeout(
      Promise.all(scenes.map(scene => generateAIVisualsForScene(scene, workDir))),
      720_000, // 12 min — 3x images per scene
      "AI visual generation stage"
    );
    console.log(`[Pipeline] All ${scenes.length * IMAGES_PER_SCENE} AI images generated`);

    // Stage 4: Compose all scenes in parallel (max 20 min)
    onProgress?.({ stage: STAGE_LABELS.composing, percent: 50 });
    const composedScenes = await withTimeout(
      Promise.all(
        scenes.map((scene, i) =>
          composeSceneVideo(scene, sceneImagePaths[i], audioPaths[i], scene.duration, workDir)
        )
      ),
      1_200_000,
      "Scene composition stage"
    );
    console.log(`[Pipeline] All ${scenes.length} scenes composed in parallel`);

    // Cleanup intermediate files
    for (let i = 0; i < scenes.length; i++) {
      try {
        fs.unlinkSync(audioPaths[i]);
        for (const imgPath of sceneImagePaths[i]) {
          if (imgPath !== composedScenes[i]) fs.unlinkSync(imgPath);
        }
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
