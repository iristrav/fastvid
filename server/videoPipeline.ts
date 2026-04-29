/**
 * Fastvid — AI Video Generation Pipeline
 *
 * Pipeline stages (all parallel where possible):
 * 1. Parse script into max 8 scenes with visual cues          (max 45 sec)
 * 2. Generate ALL voiceovers in parallel                       (max 3 min)
 * 3. Fetch ALL visuals in parallel (Pexels first, AI fallback) (max 5 min)
 * 4. Compose each scene video in parallel                      (max 20 min)
 * 5. Concatenate all scenes into final MP4                     (max 10 min)
 * 6. Upload to S3                                              (max 5 min)
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

// ─── Types ────────────────────────────────────────────────────────────────────
interface Scene {
  index: number;
  text: string;
  visualCue: string;
  useAI: boolean;
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
  voiceovers: `Generating voiceovers for all ${MAX_SCENES} scenes... (max 3 min)`,
  visuals:    `Fetching visuals for all ${MAX_SCENES} scenes... (max 5 min)`,
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
- A visual cue (3-5 word description of what should be shown visually, good for stock video search)
- Whether it should use AI-generated image (true) or stock video (false)
  - Use AI images (true) for: abstract concepts, futuristic topics, emotions, metaphors
  - Use stock video (false) for: real-world actions, nature, people, cities, technology in use
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
                    useAI: { type: "boolean" },
                  },
                  required: ["text", "visualCue", "useAI"],
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
  const scenes = (parsed.scenes as Omit<Scene, "index">[]).slice(0, MAX_SCENES);
  return scenes.map((s, i) => ({ ...s, index: i, duration: 0 }));
}

// ─── 2. TTS Voiceover ─────────────────────────────────────────────────────────
export async function generateVoiceover(text: string, outputPath: string): Promise<number> {
  const cleanText = text
    .replace(/[#*_`~>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\x00-\x7F]/g, "")
    .trim()
    .slice(0, 500);

  const tts = gTTS("en");

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      tts.save(outputPath, cleanText, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    }),
    20_000,
    "TTS for scene"
  );

  const stats = fs.statSync(outputPath);
  const estimatedDuration = Math.max(3, Math.ceil(stats.size / 2000));
  return estimatedDuration;
}

// ─── 3a. AI Visual Generation ────────────────────────────────────────────────
async function generateAIVisual(visualCue: string, sceneIndex: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, `scene_${sceneIndex}_visual.jpg`);
  const prompt = `${visualCue}, cinematic 4K YouTube video thumbnail, professional lighting, high quality`;

  const { url: imageUrl } = await withTimeout(
    generateImage({ prompt }),
    25_000,
    `AI image for scene ${sceneIndex}`
  );

  const response = await fetch(imageUrl as string);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

// ─── 3b. Pexels Stock Video ───────────────────────────────────────────────────
export async function fetchPexelsVideo(
  visualCue: string,
  sceneIndex: number,
  workDir: string,
  _duration: number
): Promise<string> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) throw new Error("PEXELS_API_KEY not set");

  const query = encodeURIComponent(visualCue);
  const res = await withTimeout(
    fetch(`https://api.pexels.com/videos/search?query=${query}&per_page=5&orientation=landscape`, {
      headers: { Authorization: apiKey },
    }),
    10_000,
    `Pexels search for scene ${sceneIndex}`
  );

  if (!res.ok) throw new Error(`Pexels API error: ${res.status}`);
  const data = await res.json() as {
    videos?: Array<{ video_files?: Array<{ link?: string; width?: number; quality?: string }> }>
  };

  if (!data.videos?.length) throw new Error("No Pexels videos found");

  const video = data.videos[Math.floor(Math.random() * Math.min(3, data.videos.length))];
  const files = video.video_files ?? [];
  const hdFile = files.find(f => f.quality === "hd" && f.width && f.width >= 1280);
  const sdFile = files.find(f => f.quality === "sd");
  const videoFile = hdFile ?? sdFile ?? files[0];

  const videoUrl = videoFile?.link;
  if (!videoUrl) throw new Error("No suitable video file found");

  const outputPath = path.join(workDir, `scene_${sceneIndex}_stock.mp4`);
  const videoRes = await withTimeout(
    fetch(videoUrl as string),
    15_000,
    `Pexels download for scene ${sceneIndex}`
  );
  const buffer = Buffer.from(await videoRes.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

// ─── 3c. Fallback Visual (colored background) ────────────────────────────────
async function generateFallbackVisual(sceneIndex: number, workDir: string, duration: number): Promise<string> {
  const outputPath = path.join(workDir, `scene_${sceneIndex}_fallback.mp4`);
  const colors = ["0a0a1e", "1a0a2e", "0a1a2e", "0a2a1e", "1a1a0a", "2a0a1e", "0a1a1e", "1a0a1e"];
  const hex = colors[sceneIndex % colors.length];
  await exec(
    `ffmpeg -y -f lavfi -i "color=c=#${hex}:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=30" -t ${duration} -c:v libx264 -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
  );
  return outputPath;
}

// ─── 3. Fetch Visual (Pexels first, AI fallback, then color fallback) ─────────
async function fetchVisual(scene: Scene, workDir: string): Promise<{ path: string; isImage: boolean }> {
  try {
    const videoPath = await fetchPexelsVideo(scene.visualCue, scene.index, workDir, scene.duration);
    return { path: videoPath, isImage: false };
  } catch (pexelsErr) {
    console.warn(`[Pipeline] Pexels failed for scene ${scene.index}, trying AI image:`, pexelsErr);
  }

  try {
    const imagePath = await generateAIVisual(scene.visualCue, scene.index, workDir);
    return { path: imagePath, isImage: true };
  } catch (aiErr) {
    console.warn(`[Pipeline] AI image failed for scene ${scene.index}, using color fallback:`, aiErr);
  }

  const fallbackPath = await generateFallbackVisual(scene.index, workDir, scene.duration);
  return { path: fallbackPath, isImage: false };
}

// ─── 4. Compose Scene Video ───────────────────────────────────────────────────
async function composeSceneVideo(
  scene: Scene,
  visualPath: string,
  audioPath: string,
  duration: number,
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${scene.index}_composed.mp4`);
  const isImage = visualPath.endsWith(".jpg") || visualPath.endsWith(".png");

  const safeText = scene.text
    .slice(0, 120)
    .replace(/[\\':]/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();

  const drawTextFilter = `drawtext=text='${safeText}':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=h-text_h-80:box=1:boxcolor=black@0.65:boxborderw=12:line_spacing=8`;
  const fadeFilter = `fade=t=in:st=0:d=0.5,fade=t=out:st=${Math.max(0, duration - 0.5)}:d=0.5`;

  if (isImage) {
    await withTimeout(
      exec(
        `ffmpeg -y -loop 1 -i "${visualPath}" -i "${audioPath}" ` +
        `-filter_complex "[0:v]scale=${VIDEO_WIDTH * 2}:${VIDEO_HEIGHT * 2},zoompan=z='min(zoom+0.0008,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.ceil(duration * 30)}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=30,${drawTextFilter},${fadeFilter}[v]" ` +
        `-map "[v]" -map "1:a" -t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
      ),
      180_000,
      `Compose scene ${scene.index} (image)`
    );
  } else {
    await withTimeout(
      exec(
        `ffmpeg -y -stream_loop -1 -i "${visualPath}" -i "${audioPath}" ` +
        `-filter_complex "[0:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},${drawTextFilter},${fadeFilter}[v]" ` +
        `-map "[v]" -map "1:a" -t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
      ),
      180_000,
      `Compose scene ${scene.index} (video)`
    );
  }
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
      `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -movflags +faststart "${outputPath}" 2>/dev/null`
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
      180_000,
      "Voiceover generation stage"
    );
    scenes.forEach((scene, i) => { scene.duration = Math.max(durations[i], 3); });
    console.log(`[Pipeline] All ${scenes.length} voiceovers generated in parallel`);

    // Stage 3: Fetch ALL visuals in parallel (max 5 min total)
    onProgress?.({ stage: STAGE_LABELS.visuals, percent: 35 });
    const visuals = await withTimeout(
      Promise.all(scenes.map(scene => fetchVisual(scene, workDir))),
      300_000,
      "Visual fetching stage"
    );
    console.log(`[Pipeline] All ${scenes.length} visuals fetched in parallel`);

    // Stage 4: Compose all scenes in parallel (max 20 min total)
    onProgress?.({ stage: STAGE_LABELS.composing, percent: 55 });
    const composedScenes = await withTimeout(
      Promise.all(
        scenes.map((scene, i) =>
          composeSceneVideo(scene, visuals[i].path, audioPaths[i], scene.duration, workDir)
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
        if (visuals[i].path !== composedScenes[i]) fs.unlinkSync(visuals[i].path);
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
