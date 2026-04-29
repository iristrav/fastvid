/**
 * Fastvid — AI Video Generation Pipeline
 *
 * Pipeline stages:
 * 1. Parse script into scenes with visual cues
 * 2. Generate TTS voiceover per scene (espeak-ng → WAV → MP3)
 * 3. Fetch visuals per scene: AI-generated image OR Pexels stock video (alternating)
 * 4. Compose final video with FFmpeg: visuals + voiceover + text overlays + background music
 * 5. Upload to S3 and return URL
 */

import { exec as execCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { generateImage } from "./_core/imageGeneration";
import { storagePut } from "./storage";
import { invokeLLM } from "./_core/llm";

const exec = promisify(execCb);

// ─── Types ────────────────────────────────────────────────────────────────────

export type Scene = {
  index: number;
  text: string;           // narration text for this scene
  visualCue: string;      // keyword/description for visuals
  useAI: boolean;         // true = AI-generated image, false = Pexels stock video
  duration?: number;      // seconds (calculated from TTS)
};

export type PipelineProgress = {
  stage: string;
  percent: number;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const PEXELS_API_KEY = process.env.PEXELS_API_KEY ?? "";
const TMP_DIR = os.tmpdir();
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

// ─── 1. Script Parser ─────────────────────────────────────────────────────────

export async function parseScriptIntoScenes(script: string): Promise<Scene[]> {
  // Use LLM to extract scenes with visual cues
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a video production assistant. Parse the given YouTube video script into scenes.
For each scene, extract:
- The narration text (what will be spoken)
- A visual cue (a short 3-5 word description of what should be shown visually)
- Whether it should use AI-generated image (true) or stock video (false)
  - Use AI images for: abstract concepts, futuristic topics, emotions, metaphors
  - Use stock video for: real-world actions, nature, people, cities, technology in use

Return JSON array of scenes. Keep scenes to 2-4 sentences max each. Aim for 8-15 scenes total.`,
      },
      {
        role: "user",
        content: `Parse this script into scenes:\n\n${script.slice(0, 6000)}`,
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
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Failed to parse script into scenes");

  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  return (parsed.scenes as Omit<Scene, "index">[]).map((s, i) => ({ ...s, index: i }));
}

// ─── 2. TTS Voiceover ─────────────────────────────────────────────────────────

export async function generateVoiceover(text: string, outputPath: string): Promise<number> {
  // Generate WAV with espeak-ng, then convert to MP3 with ffmpeg
  const wavPath = outputPath.replace(/\.mp3$/, ".wav");

  // Clean text for TTS (remove markdown, special chars)
  const cleanText = text
    .replace(/#{1,6}\s/g, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .replace(/\[.*?\]\(.*?\)/g, "")
    .replace(/[<>]/g, "")
    .trim();

  // Write text to temp file to avoid shell escaping issues
  const textFile = `${wavPath}.txt`;
  fs.writeFileSync(textFile, cleanText, "utf-8");

  // Generate WAV
  await exec(`espeak-ng -v en+m3 -s 150 -p 50 -a 180 -f "${textFile}" -w "${wavPath}"`);

  // Convert WAV to MP3
  await exec(`ffmpeg -y -i "${wavPath}" -codec:a libmp3lame -qscale:a 4 "${outputPath}" 2>/dev/null`);

  // Get duration
  const { stdout } = await exec(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`
  );
  const duration = parseFloat(stdout.trim()) || 5;

  // Cleanup
  try { fs.unlinkSync(wavPath); fs.unlinkSync(textFile); } catch { /* ignore */ }

  return duration;
}

// ─── 3a. AI Image Generation ──────────────────────────────────────────────────

export async function generateAIVisual(visualCue: string, sceneIndex: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, `scene_${sceneIndex}_ai.jpg`);

  const prompt = `Cinematic YouTube video still, ${visualCue}, 16:9 aspect ratio, professional photography, high quality, vivid colors, dramatic lighting, 4K`;

  const { url } = await generateImage({ prompt });

  // Download the image
  const response = await fetch(url as string);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);

  // Ensure it's the right size with ffmpeg
  const resizedPath = path.join(workDir, `scene_${sceneIndex}_ai_resized.jpg`);
  await exec(`ffmpeg -y -i "${outputPath}" -vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}" "${resizedPath}" 2>/dev/null`);

  try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
  return resizedPath;
}

// ─── 3b. Pexels Stock Video ───────────────────────────────────────────────────

export async function fetchPexelsVideo(visualCue: string, sceneIndex: number, workDir: string, duration: number): Promise<string> {
  const outputPath = path.join(workDir, `scene_${sceneIndex}_stock.mp4`);

  // Search Pexels
  const query = encodeURIComponent(visualCue);
  const searchRes = await fetch(
    `https://api.pexels.com/videos/search?query=${query}&per_page=5&min_duration=3&max_duration=30&orientation=landscape`,
    { headers: { Authorization: PEXELS_API_KEY } }
  );
  const searchData = await searchRes.json() as { videos?: Array<{ video_files: Array<{ link: string; width: number; quality: string }> }> };

  let videoUrl: string | null = null;

  if (searchData.videos && searchData.videos.length > 0) {
    // Pick a random video from results for variety
    const randomVideo = searchData.videos[Math.floor(Math.random() * Math.min(searchData.videos.length, 3))];
    // Prefer HD quality
    const hdFile = randomVideo.video_files.find(f => f.width >= 1280 && f.quality !== "sd");
    const anyFile = randomVideo.video_files[0];
    videoUrl = (hdFile ?? anyFile)?.link ?? null;
  }

  if (!videoUrl) {
    // Fallback: generate a colored background video
    return generateFallbackVisual(sceneIndex, workDir, duration);
  }

  // Download video
  const videoRes = await fetch(videoUrl as string);
  const buffer = Buffer.from(await videoRes.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);

  return outputPath;
}

// ─── 3c. Fallback Visual ──────────────────────────────────────────────────────

async function generateFallbackVisual(sceneIndex: number, workDir: string, duration: number): Promise<string> {
  const outputPath = path.join(workDir, `scene_${sceneIndex}_fallback.mp4`);
  const colors = ["#0a0a2e", "#1a0a3e", "#0a1a3e", "#0a2e1a", "#2e0a1a"];
  const color = colors[sceneIndex % colors.length];
  const hex = color.replace("#", "0x");
  await exec(
    `ffmpeg -y -f lavfi -i "color=c=${hex}:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=30" -t ${duration} -c:v libx264 -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
  );
  return outputPath;
}

// ─── 4. Scene Video Composer ──────────────────────────────────────────────────

async function composeSceneVideo(
  scene: Scene,
  visualPath: string,
  audioPath: string,
  duration: number,
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${scene.index}_composed.mp4`);
  const isImage = visualPath.endsWith(".jpg") || visualPath.endsWith(".png") || visualPath.endsWith(".jpeg");

  // Escape text for ffmpeg drawtext filter
  const safeText = scene.text
    .slice(0, 120)
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,");

  // Word-wrap: split into max 50-char lines
  const words = safeText.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > 55) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  const displayText = lines.slice(0, 3).join("\n");

  const drawTextFilter = `drawtext=fontfile='${FONT_PATH}':text='${displayText}':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=h-text_h-80:box=1:boxcolor=black@0.65:boxborderw=12:line_spacing=8`;

  // Fade in/out
  const fadeFilter = `fade=t=in:st=0:d=0.5,fade=t=out:st=${Math.max(0, duration - 0.5)}:d=0.5`;

  if (isImage) {
    // Static image → video with zoom effect (Ken Burns)
    await exec(
      `ffmpeg -y -loop 1 -i "${visualPath}" -i "${audioPath}" ` +
      `-filter_complex "[0:v]scale=${VIDEO_WIDTH * 2}:${VIDEO_HEIGHT * 2},zoompan=z='min(zoom+0.0008,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.ceil(duration * 30)}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=30,${drawTextFilter},${fadeFilter}[v]" ` +
      `-map "[v]" -map "1:a" -t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
    );
  } else {
    // Stock video → trim/loop to duration, add text overlay
    await exec(
      `ffmpeg -y -stream_loop -1 -i "${visualPath}" -i "${audioPath}" ` +
      `-filter_complex "[0:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},${drawTextFilter},${fadeFilter}[v]" ` +
      `-map "[v]" -map "1:a" -t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
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

  await exec(
    `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -movflags +faststart "${outputPath}" 2>/dev/null`
  );

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
    // Stage 1: Parse script into scenes
    onProgress?.({ stage: "Parsing script into scenes...", percent: 5 });
    const scenes = await parseScriptIntoScenes(script);
    console.log(`[Pipeline] ${scenes.length} scenes parsed for video ${videoId}`);

    const composedScenes: string[] = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const progressBase = 10 + Math.floor((i / scenes.length) * 75);

      // Stage 2: Generate voiceover for this scene
      onProgress?.({ stage: `Generating voiceover for scene ${i + 1}/${scenes.length}...`, percent: progressBase });
      const audioPath = path.join(workDir, `scene_${i}_audio.mp3`);
      const duration = await generateVoiceover(scene.text, audioPath);
      scene.duration = Math.max(duration, 3); // minimum 3 seconds per scene

      // Stage 3: Get visual for this scene
      onProgress?.({ stage: `Generating visuals for scene ${i + 1}/${scenes.length}...`, percent: progressBase + 3 });
      let visualPath: string;
      try {
        if (scene.useAI) {
          visualPath = await generateAIVisual(scene.visualCue, i, workDir);
        } else {
          visualPath = await fetchPexelsVideo(scene.visualCue, i, workDir, scene.duration);
        }
      } catch (err) {
        console.warn(`[Pipeline] Visual fetch failed for scene ${i}, using fallback:`, err);
        visualPath = await generateFallbackVisual(i, workDir, scene.duration);
      }

      // Stage 4: Compose scene video
      onProgress?.({ stage: `Composing scene ${i + 1}/${scenes.length}...`, percent: progressBase + 6 });
      const composedPath = await composeSceneVideo(scene, visualPath, audioPath, scene.duration, workDir);
      composedScenes.push(composedPath);

      // Cleanup intermediate files
      try {
        fs.unlinkSync(audioPath);
        if (visualPath !== composedPath) fs.unlinkSync(visualPath);
      } catch { /* ignore */ }
    }

    // Stage 5: Concatenate all scenes
    onProgress?.({ stage: "Assembling final video...", percent: 88 });
    const finalVideoPath = await concatenateScenes(composedScenes, workDir, videoId);

    // Stage 6: Upload to S3
    onProgress?.({ stage: "Uploading video...", percent: 95 });
    const videoBuffer = fs.readFileSync(finalVideoPath);
    const { url } = await storagePut(
      `videos/${videoId}/final.mp4`,
      videoBuffer,
      "video/mp4"
    );

    onProgress?.({ stage: "Complete!", percent: 100 });
    console.log(`[Pipeline] Video ${videoId} complete: ${url}`);

    return url;
  } finally {
    // Cleanup work directory
    try {
      await exec(`rm -rf "${workDir}"`);
    } catch { /* ignore */ }
  }
}
