/**
 * Fastvid — AI Video Generation Pipeline
 *
 * Pipeline stages (all parallel where possible):
 * 1. Parse script into max 8 scenes with visual cues              (max 45 sec)
 * 2. Generate ALL voiceovers in parallel                           (max 3 min)
 * 3. Generate ALL AI visuals in parallel (forge ImageService)      (max 8 min)
 *    → Each scene gets a unique AI-generated cinematic image
 *    → FFmpeg animates each image with Ken Burns zoom-pan effect
 * 4. Compose each scene video in parallel                          (max 20 min)
 * 5. Concatenate all scenes into final MP4                         (max 10 min)
 * 6. Upload to S3                                                  (max 5 min)
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

// ─── Types ────────────────────────────────────────────────────────────────────
interface Scene {
  index: number;
  text: string;
  visualCue: string;
  imagePrompt: string;
  duration: number;
}

export interface PipelineProgress {
  stage: string;
  percent: number;
}

const TMP_DIR = os.tmpdir();
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
// 8 scenes for better quality — parallel processing keeps total time well under 1 hour
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

// ─── Stage labels with max-time estimates (shown in the UI) ──────────────────
export const STAGE_LABELS = {
  parsing:    `Parsing script into ${MAX_SCENES} scenes... (max 45 sec)`,
  voiceovers: `Generating voiceovers for all ${MAX_SCENES} scenes... (max 8 min)`,
  visuals:    `Generating AI visuals for all ${MAX_SCENES} scenes... (max 8 min)`,
  composing:  `Composing all ${MAX_SCENES} scenes in parallel... (max 20 min)`,
  assembling: "Assembling final video... (max 10 min)",
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
- The narration text (what will be spoken — keep it concise, 2-3 sentences max per scene)
- A short visual cue (3-5 words describing what to show)
- A detailed AI image generation prompt (15-25 words) that describes a cinematic, photorealistic scene.
  The image prompt should be vivid, specific, and suitable for a YouTube video background.
  Style: cinematic 4K, dramatic lighting, ultra-detailed, professional photography or digital art.
  Examples:
    "Futuristic city skyline at night with neon lights reflecting on wet streets, cinematic 4K"
    "Close-up of a scientist examining glowing DNA strands in a dark laboratory, dramatic lighting"
    "Aerial view of a dense tropical rainforest with morning mist, golden hour lighting, 4K"
IMPORTANT: Return exactly ${MAX_SCENES} scenes. Distribute the script evenly across all scenes.`,
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
                    imagePrompt: { type: "string" },
                  },
                  required: ["text", "visualCue", "imagePrompt"],
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
  const scenes = (parsed.scenes as Omit<Scene, "index" | "duration">[]).slice(0, MAX_SCENES);
  return scenes.map((s, i) => ({ ...s, index: i, duration: 0 }));
}

// ─── 2. TTS Voiceover ─────────────────────────────────────────────────────────
/**
 * Generates a voiceover MP3 using node-gtts (Google TTS via HTTP).
 * - Timeout per attempt: 60 seconds (increased from 20s)
 * - Retries: up to 3 attempts with exponential backoff (2s, 4s, 8s)
 * - Fallback: silent audio clip generated by FFmpeg if all attempts fail
 *   so the pipeline never stops due to a TTS failure.
 */
export async function generateVoiceover(text: string, outputPath: string): Promise<number> {
  const cleanText = text
    .replace(/[#*_`~>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\x00-\x7F]/g, "")
    .trim()
    .slice(0, 500);

  const MAX_ATTEMPTS = 3;
  const TTS_TIMEOUT_MS = 60_000; // 60 seconds per attempt

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

      // Success — verify the file was written
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        const stats = fs.statSync(outputPath);
        const estimatedDuration = Math.max(3, Math.ceil(stats.size / 2000));
        return estimatedDuration;
      }
      throw new Error("TTS output file is empty or missing");
    } catch (err) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      if (isLastAttempt) {
        console.warn(`[Pipeline] TTS failed after ${MAX_ATTEMPTS} attempts, using silent audio fallback:`, err);
        // Fallback: generate a silent MP3 file so the pipeline can continue
        // Word-count estimate: average 2.5 words/second for spoken English
        const estimatedDuration = Math.max(3, Math.ceil(cleanText.split(" ").length / 2.5));
        try {
          // Use libmp3lame so the output is a valid .mp3 file (not AAC in an MP3 container)
          await withTimeout(
            exec(
              `${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${estimatedDuration} -c:a libmp3lame -b:a 128k "${outputPath}" 2>/dev/null`
            ),
            15_000,
            "Silent audio fallback"
          );
        } catch (fallbackErr) {
          console.error(`[Pipeline] Silent audio fallback also failed:`, fallbackErr);
          // Last resort: write a minimal valid MP3 header so FFmpeg can still mux it
          // (1152 samples of silence at 44100 Hz = ~26ms, enough for FFmpeg to accept)
          const silentMp3 = Buffer.from([
            0xff, 0xfb, 0x90, 0x00, // MP3 frame header (MPEG1, Layer3, 128kbps, 44100Hz, stereo)
            ...Array(413).fill(0),   // silent frame data
          ]);
          fs.writeFileSync(outputPath, silentMp3);
        }
        return estimatedDuration;
      }
      // Exponential backoff before retry
      const backoffMs = Math.pow(2, attempt) * 1000;
      console.warn(`[Pipeline] TTS attempt ${attempt} failed, retrying in ${backoffMs}ms:`, err);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }

  // Should never reach here, but TypeScript needs a return
  return 5;
}

// ─── 3. AI Visual Generation (100% AI — no stock footage) ────────────────────
/**
 * Generates a unique AI image for each scene using the forge ImageService,
 * then saves it locally for FFmpeg processing.
 *
 * The image is later animated with a Ken Burns zoom-pan effect in composeSceneVideo().
 */
async function generateAIVisualForScene(
  scene: Scene,
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${scene.index}_visual.png`);

  // Use the LLM-crafted imagePrompt for best results; fall back to visualCue
  const prompt = scene.imagePrompt ||
    `${scene.visualCue}, cinematic 4K YouTube video background, professional lighting, ultra-detailed, photorealistic`;

  console.log(`[Pipeline] Generating AI image for scene ${scene.index}: "${prompt.slice(0, 60)}..."`);

  const { url: imageUrl } = await withTimeout(
    generateImage({ prompt }),
    45_000,
    `AI image for scene ${scene.index}`
  );

  if (!imageUrl) throw new Error(`No image URL returned for scene ${scene.index}`);

  // Download the image from S3/storage URL
  const response = await withTimeout(
    fetch(imageUrl),
    15_000,
    `Download AI image for scene ${scene.index}`
  );

  if (!response.ok) throw new Error(`Failed to download AI image: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);

  console.log(`[Pipeline] AI image saved for scene ${scene.index} (${buffer.length} bytes)`);
  return outputPath;
}

/**
 * Fallback: generate a solid-color background image using FFmpeg if AI generation fails.
 * Uses the reliable `color` source filter (available in all FFmpeg builds including ffmpeg-static).
 * The `gradients` filter is NOT used as it is not available in ffmpeg-static 5.x.
 */
async function generateGradientFallback(
  scene: Scene,
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${scene.index}_fallback.png`);
  // Deep space color palette — matches Fastvid's brand
  const colors = ["0a0a1e", "0a1a2e", "1a0a2e", "0a2a1e", "1a1a0a", "2a0a1e", "0a1a1e", "1a0a1e"];
  const color = colors[scene.index % colors.length];
  try {
    // `color` source filter: available in all FFmpeg builds
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -f lavfi -i "color=c=#${color}:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=1" -frames:v 1 "${outputPath}" 2>/dev/null`
      ),
      15_000,
      `Fallback PNG for scene ${scene.index}`
    );
  } catch (err) {
    console.error(`[Pipeline] Fallback PNG generation failed for scene ${scene.index}:`, err);
    // Last resort: write a 1x1 black PNG (valid image FFmpeg can scale up)
    const blackPng = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
      "2e00000000c4944415408d76360000000020001e221bc330000000049454e44ae426082",
      "hex"
    );
    fs.writeFileSync(outputPath, blackPng);
  }
  return outputPath;
}

// ─── 4. Compose Scene Video (AI image → animated video clip) ─────────────────
/**
 * Escapes text for use inside an FFmpeg drawtext filter value.
 *
 * FFmpeg drawtext escaping rules (applied in order):
 *   1. Backslash must be doubled: \ → \\
 *   2. Single-quote must be escaped: ' → \\'
 *   3. Colon must be escaped: : → \\:
 *   4. Any remaining non-printable or non-ASCII chars are stripped
 *
 * We also write the text to a .txt file and use textfile= instead of text=
 * to completely avoid shell quoting issues with commas, brackets, etc.
 */
function escapeDrawtext(text: string): string {
  return text
    .slice(0, 100)                        // hard cap — long lines break layout
    .replace(/[^\x20-\x7E]/g, "")         // strip non-printable / non-ASCII
    .replace(/\\/g, "\\\\")               // 1. escape backslashes first
    .replace(/'/g, "\\\\'")               // 2. escape single quotes
    .replace(/:/g, "\\\\:")               // 3. escape colons
    .replace(/[,\[\]{}|<>]/g, " ")        // 4. replace other FFmpeg-special chars with space
    .trim();
}

/**
 * Converts an AI-generated image into a video clip with:
 * - Ken Burns zoom-pan animation (cinematic slow zoom)
 * - Subtitle text overlay written via textfile= (avoids shell quoting issues)
 * - Fade in/out transitions
 * - Voiceover audio track
 */
async function composeSceneVideo(
  scene: Scene,
  imagePath: string,
  audioPath: string,
  duration: number,
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${scene.index}_composed.mp4`);

  // Write subtitle text to a file — avoids ALL shell/FFmpeg quoting issues
  const subtitleFile = path.join(workDir, `scene_${scene.index}_subtitle.txt`);
  const subtitleText = scene.text
    .replace(/[^\x20-\x7E]/g, "")  // strip non-ASCII
    .slice(0, 100)
    .trim();
  fs.writeFileSync(subtitleFile, subtitleText, "utf-8");

  // Use textfile= instead of text= to avoid all quoting/escaping issues
  const drawTextFilter = `drawtext=textfile='${subtitleFile}':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=h-text_h-80:box=1:boxcolor=black@0.65:boxborderw=12:line_spacing=8`;
  const fadeFilter = `fade=t=in:st=0:d=0.5,fade=t=out:st=${Math.max(0, duration - 0.5)}:d=0.5`;
  const frames = Math.ceil(duration * 30);

  // Ken Burns effect: slow zoom from 1.0x to 1.3x, panning slightly
  // Alternates direction per scene for visual variety
  const zoomDir = scene.index % 2 === 0 ? "+" : "-";
  const panX = scene.index % 4 < 2
    ? `iw/2-(iw/zoom/2)`
    : `iw/2-(iw/zoom/2)+${scene.index * 5}`;
  const kenBurns = `scale=${VIDEO_WIDTH * 2}:${VIDEO_HEIGHT * 2},zoompan=z='min(zoom${zoomDir}0.0006,1.3)':x='${panX}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=30`;

  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -loop 1 -i "${imagePath}" -i "${audioPath}" ` +
      `-filter_complex "[0:v]${kenBurns},${drawTextFilter},${fadeFilter}[v]" ` +
      `-map "[v]" -map "1:a" -t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
    ),
    180_000,
    `Compose scene ${scene.index}`
  );

  // Cleanup subtitle file
  try { fs.unlinkSync(subtitleFile); } catch { /* ignore */ }

  return outputPath;
}

// ─── 5. Final Concatenation ───────────────────────────────────────────────────
async function concatenateScenes(scenePaths: string[], workDir: string, videoId: number): Promise<string> {
  const listFile = path.join(workDir, "concat_list.txt");
  const outputPath = path.join(workDir, `fastvid_${videoId}_final.mp4`);
  const listContent = scenePaths.map(p => `file '${p}'`).join("\n");
  fs.writeFileSync(listFile, listContent, "utf-8");
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -movflags +faststart "${outputPath}" 2>/dev/null`
    ),
    600_000,
    "Final concatenation"
  );
  return outputPath;
}

// ─── Main Pipeline (Parallel Processing + Per-Stage Timeouts) ────────────────
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

    // Stage 2: Generate ALL voiceovers in parallel (max 3 min total)
    onProgress?.({ stage: STAGE_LABELS.voiceovers, percent: 15 });
    const audioPaths = scenes.map((_, i) => path.join(workDir, `scene_${i}_audio.mp3`));
    const durations = await withTimeout(
      Promise.all(scenes.map((scene, i) => generateVoiceover(scene.text, audioPaths[i]))),
      480_000, // 8 min — allows up to 3 retries (60s each) per scene with backoff
      "Voiceover generation stage"
    );
    scenes.forEach((scene, i) => { scene.duration = Math.max(durations[i], 3); });
    console.log(`[Pipeline] All ${scenes.length} voiceovers generated in parallel`);

    // Stage 3: Generate ALL AI visuals in parallel (max 8 min total)
    // Each scene gets a unique AI-generated cinematic image via the forge ImageService
    onProgress?.({ stage: STAGE_LABELS.visuals, percent: 30 });
    const imagePaths = await withTimeout(
      Promise.all(
        scenes.map(scene =>
          generateAIVisualForScene(scene, workDir).catch(async (err) => {
            console.warn(`[Pipeline] AI image failed for scene ${scene.index}, using gradient fallback:`, err);
            return generateGradientFallback(scene, workDir);
          })
        )
      ),
      480_000,
      "AI visual generation stage"
    );
    console.log(`[Pipeline] All ${scenes.length} AI visuals generated in parallel`);

    // Stage 4: Compose all scenes in parallel (max 20 min total)
    // Each AI image is animated with Ken Burns effect + subtitle + voiceover
    onProgress?.({ stage: STAGE_LABELS.composing, percent: 55 });
    const composedScenes = await withTimeout(
      Promise.all(
        scenes.map((scene, i) =>
          composeSceneVideo(scene, imagePaths[i], audioPaths[i], scene.duration, workDir)
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
        if (imagePaths[i] !== composedScenes[i]) fs.unlinkSync(imagePaths[i]);
      } catch { /* ignore */ }
    }

    // Stage 5: Concatenate all scenes (max 10 min)
    onProgress?.({ stage: STAGE_LABELS.assembling, percent: 82 });
    const finalVideoPath = await concatenateScenes(composedScenes, workDir, videoId);

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
