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
  // Check FFMPEG_PATH env var set by start.sh
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && fs.existsSync(envPath) && testBinary(envPath)) {
    console.log(`[Fastvid] Using FFMPEG_PATH env: ${envPath}`);
    return envPath;
  }
  // Try known system paths first
  const candidatePaths = [
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/nix/var/nix/profiles/default/bin/ffmpeg",
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p) && testBinary(p)) {
      console.log(`[Fastvid] Using system FFmpeg: ${p}`);
      return p;
    }
  }
  // Try which command
  try {
    const systemPath = execSync("which ffmpeg", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    if (systemPath && testBinary(systemPath)) {
      console.log(`[Fastvid] Using system FFmpeg (which): ${systemPath}`);
      return systemPath;
    }
  } catch {
    // system ffmpeg not found via which
  }
  // Try nix store — Railway Nixpacks installs ffmpeg here (use shell:true for glob)
  try {
    const nixPath = execSync("ls /nix/store/*/bin/ffmpeg 2>/dev/null | head -1", { encoding: "utf8", shell: "/bin/sh" }).trim();
    if (nixPath && fs.existsSync(nixPath) && testBinary(nixPath)) {
      console.log(`[Fastvid] Using nix store FFmpeg: ${nixPath}`);
      return nixPath;
    }
  } catch {
    // nix store not available
  }
  // Try find as last resort before ffmpeg-static
  try {
    const found = execSync("find /nix /usr /opt -name ffmpeg -type f 2>/dev/null | head -1", { encoding: "utf8", shell: "/bin/sh" }).trim();
    if (found && fs.existsSync(found) && testBinary(found)) {
      console.log(`[Fastvid] Using found FFmpeg: ${found}`);
      return found;
    }
  } catch {
    // find failed
  }
  // Fall back to ffmpeg-static — test if it actually works
  const staticPath = (ffmpegStatic as unknown as string) || "ffmpeg";
  if (staticPath && fs.existsSync(staticPath)) {
    try {
      execSync(`chmod +x "${staticPath}"`, { shell: "/bin/sh" });
    } catch { /* ignore */ }
    if (testBinary(staticPath)) {
      console.log(`[Fastvid] Using ffmpeg-static (validated): ${staticPath}`);
      return staticPath;
    } else {
      console.warn(`[Fastvid] ffmpeg-static exists but CANNOT RUN (missing glibc?): ${staticPath}`);
    }
  }
  // Last resort: try 'ffmpeg' from PATH
  if (testBinary('ffmpeg')) {
    console.log(`[Fastvid] Using 'ffmpeg' from PATH`);
    return 'ffmpeg';
  }
  console.error(`[Fastvid] CRITICAL: No working FFmpeg binary found! staticPath=${staticPath}`);
  return staticPath; // return anyway so error messages show the path
};
let FFMPEG_BIN: string = resolveFFmpegBin();
const execRaw = promisify(execCb);

// Wrapper that retries with a different ffmpeg binary if the current one fails
const exec = async (cmd: string): Promise<{ stdout: string; stderr: string }> => {
  try {
    return await execRaw(cmd);
  } catch (err: unknown) {
    // If current FFMPEG_BIN failed with a binary-not-found error, try alternatives
    const errMsg = (err as Error)?.message || '';
    const isBinaryNotFound = errMsg.includes('not found') || errMsg.includes('No such file') || errMsg.includes('ENOENT') || errMsg.includes('Permission denied');
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

// Check canvas availability at startup
let CANVAS_AVAILABLE = false;
try {
  require('canvas');
  CANVAS_AVAILABLE = true;
  console.log('[Fastvid] Canvas: available');
} catch {
  console.warn('[Fastvid] Canvas: NOT available — using FFmpeg drawtext fallback for overlays');
}

const TMP_DIR = os.tmpdir();
// Use lower resolution on Railway (no Forge key = Railway environment) to avoid OOM
// Railway free tier has ~512MB RAM; 1280x720 FFmpeg compositing OOM-kills the process
const IS_RAILWAY = !process.env.BUILT_IN_FORGE_API_KEY;
const VIDEO_WIDTH = IS_RAILWAY ? 854 : 1280;
const VIDEO_HEIGHT = IS_RAILWAY ? 480 : 720;

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
      cfg_scale: 7,
      height: 768,
      width: 1344,
      samples: 1,
      steps: 30,
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

    // Convert to video — optimized Ken Burns: pre-scale to exact size first, then gentle zoompan
    // Pre-scaling to exact size before zoompan avoids the 2x upscale that made it slow
    const direction = sceneIndex % 2 === 0 ? 1 : -1; // alternate zoom direction per scene
    const zoomStart = 1.0;
    const zoomEnd = 1.06;
    const fps = 25;
    const totalFrames = Math.ceil(duration * fps);
    const zoomStep = (zoomEnd - zoomStart) / totalFrames;
    const panX = direction > 0 ? `iw/2-(iw/zoom/2)` : `iw/2-(iw/zoom/2)+${Math.floor(VIDEO_WIDTH * 0.02)}`;
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -loop 1 -i "${pngPath}" ` +
        `-vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},` +
        `zoompan=z='min(zoom+${zoomStep.toFixed(6)},${zoomEnd})':x='${panX}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${fps},` +
        `fade=t=in:st=0:d=0.4,fade=t=out:st=${Math.max(0, duration - 0.4)}:d=0.4" ` +
        `-t ${duration} -r ${fps} -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p "${outputPath}"`
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
        // Ken Burns effect: alternate between zoom-in and zoom-out with slow pan
        const totalFrames = Math.ceil(clipDuration * 25);
        const kbDirection = (sceneIndex + idx) % 4;
        let zoompanFilter: string;
        if (kbDirection === 0) {
          // Zoom in, pan right
          zoompanFilter = `zoompan=z='min(zoom+0.0008,1.12)':x='iw/2-(iw/zoom/2)+((iw/zoom/2)*0.08*(on/${totalFrames}))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=25`;
        } else if (kbDirection === 1) {
          // Zoom out, pan left
          zoompanFilter = `zoompan=z='if(lte(zoom,1.0),1.12,max(1.0,zoom-0.0008))':x='iw/2-(iw/zoom/2)-((iw/zoom/2)*0.06*(on/${totalFrames}))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=25`;
        } else if (kbDirection === 2) {
          // Slow zoom in, pan up
          zoompanFilter = `zoompan=z='min(zoom+0.0006,1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)+((ih/zoom/2)*0.05*(on/${totalFrames}))':d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=25`;
        } else {
          // Slow zoom out, pan down
          zoompanFilter = `zoompan=z='if(lte(zoom,1.0),1.10,max(1.0,zoom-0.0006))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)-((ih/zoom/2)*0.04*(on/${totalFrames}))':d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=25`;
        }
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y ${loopFlag} -i "${rawPath}" ` +
            `-t ${clipDuration} ` +
            `-vf "scale=${VIDEO_WIDTH * 2}:${VIDEO_HEIGHT * 2}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH * 2}:${VIDEO_HEIGHT * 2},${zoompanFilter}" ` +
            `-c:v libx264 -preset ultrafast -crf 28 -an -pix_fmt yuv420p "${outPath}"`
          ),
          45_000,
          `Trim+KenBurns Pexels clip ${idx} scene ${sceneIndex}`
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

  // Verify FFmpeg binary exists before attempting
  if (!fs.existsSync(FFMPEG_BIN) && FFMPEG_BIN !== 'ffmpeg') {
    console.error(`[Pipeline] CRITICAL: FFmpeg binary not found at: ${FFMPEG_BIN}`);
  } else {
    console.log(`[Pipeline] Scene ${sceneIndex}: generating fallback video with FFmpeg: ${FFMPEG_BIN}`);
  }

  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -f lavfi -i "color=c=#${color}:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
        `-t ${duration} -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p "${outputPath}"`
      ),
      15_000, `Fallback video scene ${sceneIndex}`
    );
    console.log(`[Pipeline] Scene ${sceneIndex}: fallback video created (${(fs.statSync(outputPath).size / 1024).toFixed(0)}KB)`);
  } catch (err1) {
    console.error(`[Pipeline] Scene ${sceneIndex}: color fallback failed, trying black screen:`, err1);
    try {
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y -f lavfi -i "color=c=black:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
          `-t ${duration} -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p "${outputPath}"`
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

  const { createCanvas, registerFont } = await import("canvas");
  try {
    if (FONT_BOLD) registerFont(FONT_BOLD, { family: "NotoSans", weight: "bold" });
  } catch { /* already registered */ }

  const frames: KineticFrame[] = [];
  // Distribute keywords evenly across the scene duration (or use override timing)
  const slotDuration = sceneDuration / keywords.length;
  const showDuration = Math.max(1.5, slotDuration - 0.3);

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i];
    // Use override timing if provided (for sparse single-word mode), else distribute evenly
    const startTime = overrideStartTime !== undefined ? overrideStartTime : i * slotDuration + 0.15;
    const endTime = overrideEndTime !== undefined ? overrideEndTime : Math.min(startTime + showDuration, sceneDuration - 0.2);

    // Canvas: full video width, fixed height band for the text
    const CANVAS_W = VIDEO_WIDTH;
    const CANVAS_H = 120; // height of the kinetic text band
    const canvas = createCanvas(CANVAS_W, CANVAS_H);
    const ctx = canvas.getContext("2d");

    // Transparent background
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Measure text to draw pill background
    ctx.font = `bold 72px NotoSans`;
    const metrics = ctx.measureText(keyword);
    const textW = metrics.width;
    const textH = 72;
    const pillPadX = 32;
    const pillPadY = 16;
    const pillW = textW + pillPadX * 2;
    const pillH = textH + pillPadY * 2;
    const pillX = (CANVAS_W - pillW) / 2;
    const pillY = (CANVAS_H - pillH) / 2;

    // First keyword gets yellow highlight, rest get dark semi-transparent pill
    if (i === 0) {
      // Yellow pill background
      ctx.fillStyle = "rgba(255, 210, 0, 0.92)";
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 14);
      ctx.fill();
      // Dark text on yellow
      ctx.font = `bold 72px NotoSans`;
      ctx.fillStyle = "#0a0a0a";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.fillText(keyword, CANVAS_W / 2, CANVAS_H / 2);
    } else {
      // Dark semi-transparent pill background
      ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 14);
      ctx.fill();
      // White text with shadow
      ctx.font = `bold 72px NotoSans`;
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      ctx.shadowBlur = 8;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;
      ctx.fillText(keyword, CANVAS_W / 2, CANVAS_H / 2);
    }

    const pngPath = path.join(workDir, `scene_${sceneIndex}_kword_${i}.png`);
    fs.writeFileSync(pngPath, canvas.toBuffer("image/png"));
    frames.push({ path: pngPath, startTime, endTime });
  }

  return frames;
}

// ─── 4a. Canvas Subtitle Overlay ─────────────────────────────────────────────
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
  const safeText = text.replace(/[^a-zA-Z0-9 .,!?-]/g, ' ').slice(0, 80).trim().replace(/'/g, '');
  const badge = `${sceneIndex + 1}/${totalScenes}`;
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
  if (!CANVAS_AVAILABLE) {
    return renderSubtitleOverlayFFmpeg(text, sceneIndex, totalScenes, workDir);
  }
  const outputPath = path.join(workDir, `scene_${sceneIndex}_subtitle.png`);
  const { createCanvas, registerFont } = await import("canvas");

  try {
    if (FONT_BOLD) registerFont(FONT_BOLD, { family: "NotoSans", weight: "bold" });
    if (FONT_REGULAR) registerFont(FONT_REGULAR, { family: "NotoSans", weight: "normal" });
  } catch { /* already registered */ }

  // Documentary style: taller overlay, strong gradient, large bold text
  const OVERLAY_H = 220;
  const canvas = createCanvas(VIDEO_WIDTH, OVERLAY_H);
  const ctx = canvas.getContext("2d");

  // Deep gradient bar — nearly opaque at bottom for maximum readability
  const grad = ctx.createLinearGradient(0, 0, 0, OVERLAY_H);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.15, "rgba(0,0,0,0.82)");
  grad.addColorStop(1, "rgba(0,0,0,0.97)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, VIDEO_WIDTH, OVERLAY_H);

  // Yellow accent line at top of overlay (documentary style)
  ctx.fillStyle = "rgba(255,210,0,0.95)";
  ctx.fillRect(0, 0, VIDEO_WIDTH, 4);

  // Scene badge — compact, left-aligned
  const badgeText = `${sceneIndex + 1} / ${totalScenes}`;
  ctx.fillStyle = "rgba(255,210,0,0.95)";
  ctx.beginPath();
  ctx.roundRect(28, 14, 110, 38, 6);
  ctx.fill();
  ctx.font = "bold 22px NotoSans";
  ctx.fillStyle = "#0a0a0a";
  ctx.textAlign = "center";
  ctx.fillText(badgeText, 83, 39);

  // Main subtitle text — large, bold, white with strong shadow
  const cleanText = text.replace(/[^\x20-\x7E]/g, "").slice(0, 120).trim();
  ctx.font = "bold 50px NotoSans";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,1)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;

  const words = cleanText.split(" ");
  const lines: string[] = [];
  let currentLine = "";
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    // ~45 chars per line for 50px font at 1920px wide
    if (testLine.length > 45 && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
    if (lines.length >= 2) break;
  }
  if (currentLine && lines.length < 2) lines.push(currentLine);

  const lineHeight = 60;
  const startY = lines.length === 1 ? 148 : 110;
  lines.forEach((line, i) => {
    ctx.fillText(line, VIDEO_WIDTH / 2, startY + i * lineHeight);
  });

  fs.writeFileSync(outputPath, canvas.toBuffer("image/png"));
  return outputPath;
}

// ─── 4b. Branded Intro Title Card ────────────────────────────────────────────
async function renderIntroCardFFmpeg(videoTitle: string, duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "intro_card.mp4");
  const safeTitle = videoTitle.replace(/[^a-zA-Z0-9 .,!?:-]/g, ' ').slice(0, 60).trim().replace(/'/g, '');
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -f lavfi -i "color=c=#0a0a1e:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
      `-f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-filter_complex "[0:v]drawtext=text='FASTVID':fontcolor=#a064ff:fontsize=36:x=(w-text_w)/2:y=h/2-160,` +
      `drawtext=text='${safeTitle}':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=h/2-40:line_spacing=10,` +
      `drawtext=text='AI-Generated Video':fontcolor=#a0c8ff:fontsize=26:x=(w-text_w)/2:y=h/2+80,` +
      `fade=t=in:st=0:d=0.4,fade=t=out:st=${duration - 0.4}:d=0.4[vout]" ` +
      `-map "[vout]" -map "1:a" ` +
      `-t ${duration} -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -r 25 -c:a aac -b:a 64k -shortest "${outputPath}"`
    ),
    20_000, "Intro card FFmpeg render"
  );
  return outputPath;
}

async function renderIntroCard(videoTitle: string, duration: number, workDir: string): Promise<string> {
  if (!CANVAS_AVAILABLE) {
    return renderIntroCardFFmpeg(videoTitle, duration, workDir);
  }
  const outputPath = path.join(workDir, "intro_card.mp4");
  const { createCanvas, registerFont } = await import("canvas");

  try {
    if (FONT_BOLD) registerFont(FONT_BOLD, { family: "NotoSans", weight: "bold" });
    if (FONT_REGULAR) registerFont(FONT_REGULAR, { family: "NotoSans", weight: "normal" });
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
      `${FFMPEG_BIN} -y -loop 1 -i "${pngPath}" -f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-t ${duration} ` +
      `-vf "fade=t=in:st=0:d=0.4,fade=t=out:st=${duration - 0.4}:d=0.4" ` +
      `-c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -r 25 -c:a aac -b:a 64k -shortest "${outputPath}"`
    ),
    20_000, "Intro card render"
  );

  try { fs.unlinkSync(pngPath); } catch { /* ignore */ }
  return outputPath;
}

//// ─── 4c. Branded Outro Card ────────────────────────────────────────────
async function renderOutroCardFFmpeg(duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "outro_card.mp4");
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -f lavfi -i "color=c=#0a0a1e:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
      `-f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-filter_complex "[0:v]drawtext=text='Thanks for watching!':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=h/2-160,` +
      `drawtext=text='SUBSCRIBE':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=h/2-40:box=1:boxcolor=red@0.9:boxborderw=20,` +
      `drawtext=text='Like and Subscribe for more AI-generated videos':fontcolor=#a0c8ff:fontsize=26:x=(w-text_w)/2:y=h/2+80,` +
      `drawtext=text='FASTVID':fontcolor=#a064ff:fontsize=34:x=(w-text_w)/2:y=h/2+160,` +
      `fade=t=in:st=0:d=0.4,fade=t=out:st=${duration - 0.4}:d=0.4[vout]" ` +
      `-map "[vout]" -map "1:a" ` +
      `-t ${duration} -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -r 25 -c:a aac -b:a 64k -shortest "${outputPath}"`
    ),
    20_000, "Outro card FFmpeg render"
  );
  return outputPath;
}

async function renderOutroCard(duration: number, workDir: string): Promise<string> {
  if (!CANVAS_AVAILABLE) {
    return renderOutroCardFFmpeg(duration, workDir);
  }
  const outputPath = path.join(workDir, "outro_card.mp4");
  const { createCanvas, registerFont } = await import("canvas");

  try { if (FONT_BOLD) registerFont(FONT_BOLD, { family: "NotoSans", weight: "bold" }); } catch { /* already registered */ }

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
      `${FFMPEG_BIN} -y -loop 1 -i "${pngPath}" -f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-t ${duration} ` +
      `-vf "fade=t=in:st=0:d=0.4,fade=t=out:st=${duration - 0.4}:d=0.4" ` +
      `-c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -r 25 -c:a aac -b:a 64k -shortest "${outputPath}"`
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
  totalScenes: number,
  enableSubtitles = true
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
        exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${duration} -c:a libmp3lame -b:a 64k "${safeAudioPath}"`),
        10_000, `Silent fallback scene ${scene.index}`
      );
    } catch {
      fs.writeFileSync(safeAudioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(413).fill(0)]));
    }
  }

  // Subtitle overlay
  let subtitlePath: string | null = null;
  if (enableSubtitles) {
    try {
      subtitlePath = await renderSubtitleOverlay(scene.text, scene.index, totalScenes, workDir);
    } catch (err) {
      console.warn(`[Pipeline] Scene ${scene.index}: subtitle render failed:`, err);
    }
  }

  // Kinetic typography: sparse — only every 3rd scene, 1 impactful word, shown briefly in the middle
  // Always-on (not gated behind enableSubtitles). Keeps it subtle and documentary-like.
  let kineticFrames: KineticFrame[] = [];
  if (scene.index % 3 === 0) {
    try {
      const keywords = extractKeywords(scene.text, 1); // just 1 most impactful word
      if (keywords.length > 0) {
        // Show the word for 2s, centered in the scene duration
        const wordDuration = 2.0;
        const startTime = Math.max(0.5, (duration - wordDuration) / 2);
        const endTime = Math.min(startTime + wordDuration, duration - 0.3);
        kineticFrames = await renderKineticFrames(
          keywords,
          duration,
          scene.index,
          workDir,
          startTime,
          endTime
        );
        console.log(`[Pipeline] Scene ${scene.index}: kinetic word: "${keywords[0]}" (${startTime.toFixed(1)}s–${endTime.toFixed(1)}s)`);
      }
    } catch (err) {
      console.warn(`[Pipeline] Scene ${scene.index}: kinetic typography failed (non-fatal):`, err);
      kineticFrames = [];
    }
  }

  const OVERLAY_H = 220; // Updated to match renderSubtitleOverlay height
  const overlayY = VIDEO_HEIGHT - OVERLAY_H;
  // On Railway, limit FFmpeg threads to reduce memory usage
  const threadFlag = IS_RAILWAY ? "-threads 2" : "";
  // Kinetic text position: upper-center area (y=80 so the 120px band sits at 80-200px from top)
  const kineticY = 80;
  // Documentary-style color grading: warm, high-contrast, punchy
  const colorGrade = `eq=contrast=1.15:saturation=1.28:brightness=0.02:gamma=0.95,colorbalance=rs=0.04:gs=-0.01:bs=-0.03:rm=0.03:gm=-0.01:bm=-0.02:rh=0.02:gh=0:bh=-0.01`;
  // Note: colorbalance adds warm tones (slight red/orange push) for cinematic look
  const fadeFilter = `${colorGrade},fade=t=in:st=0:d=0.3,fade=t=out:st=${Math.max(0, duration - 0.3)}:d=0.3`;
  const xfadeDur = 0.4;

  // Helper: build the kinetic overlay chain on top of a labelled video stream.
  // Each kinetic frame is a full-width PNG (VIDEO_WIDTH x 120) overlaid at y=kineticY
  // with enable='between(t,start,end)' for timed visibility.
  // Returns the new output label and the extra -i inputs string.
  function buildKineticChain(
    baseLabel: string,
    baseInputCount: number
  ): { extraInputs: string; filterChain: string; finalLabel: string } {
    if (kineticFrames.length === 0) {
      return { extraInputs: "", filterChain: "", finalLabel: baseLabel };
    }
    const extraInputs = kineticFrames.map(f => `-loop 1 -i "${f.path}"`).join(" ");
    let chain = "";
    let prevLabel = baseLabel;
    kineticFrames.forEach((frame, idx) => {
      const inputIdx = baseInputCount + idx;
      const outLabel = idx === kineticFrames.length - 1 ? "kfinal" : `kf${idx}`;
      chain += `;[${prevLabel}][${inputIdx}:v]overlay=x=0:y=${kineticY}:enable='between(t,${frame.startTime.toFixed(2)},${frame.endTime.toFixed(2)})'[${outLabel}]`;
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
      // Multi-clip with xfade transitions
      const clipDur = Math.max(2, Math.floor(duration / safeClips.length));
      const inputs = safeClips.map(c => `-i "${c}"`).join(" ");
      const scaleFilters = safeClips.map((_, i) =>
        `[${i}:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}[v${i}]`
      ).join(";");

      // Chain xfades
      let xfadeChain = "";
      let lastLabel = "v0";
      for (let i = 1; i < safeClips.length; i++) {
        const offset = Math.max(0.5, clipDur * i - xfadeDur);
        const outLabel = i === safeClips.length - 1 ? "xfaded" : `xf${i}`;
        xfadeChain += `;[${lastLabel}][v${i}]xfade=transition=fade:duration=${xfadeDur}:offset=${offset}[${outLabel}]`;
        lastLabel = outLabel;
      }

      // Build kinetic chain on top of xfaded
      // Input indices: 0..N-1 = clips, N = audio, N+1 = subtitle (if any), N+1/N+2.. = kinetic frames
      const audioIdx = safeClips.length;
      const subIdx = audioIdx + 1;
      const kineticBaseIdx = subtitlePath ? subIdx + 1 : subIdx;
      const { extraInputs: kExtraInputs, filterChain: kChain, finalLabel: kFinalLabel } =
        buildKineticChain(subtitlePath ? "withsub" : "xfaded", kineticBaseIdx);

      if (subtitlePath && fs.existsSync(subtitlePath)) {
        const subInput = `-loop 1 -i "${subtitlePath}"`;
        // Apply subtitle first, then kinetic frames on top
        const subOverlay = `;[xfaded][${subIdx}:v]overlay=x=0:y=${overlayY}:shortest=1[withsub]`;
        const kineticInput = kExtraInputs ? ` ${kExtraInputs}` : "";
        const kineticChainStr = kChain ? kChain : "";
        const finalVideoLabel = kineticFrames.length > 0 ? kFinalLabel : "withsub";
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y ${inputs} -i "${safeAudioPath}" ${subInput}${kineticInput} ` +
            `-filter_complex "${scaleFilters}${xfadeChain}${subOverlay}${kineticChainStr};[${finalVideoLabel}]${fadeFilter}[vout]" ` +
            `-map "[vout]" -map "${audioIdx}:a" ` +
            `-t ${duration} ${threadFlag} -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 64k -pix_fmt yuv420p "${outputPath}"`
          ),
          120_000, `Compose multi-clip scene ${scene.index}`
        );
      } else {
        const kineticInput = kExtraInputs ? ` ${kExtraInputs}` : "";
        const kineticChainStr = kChain ? kChain : "";
        const finalVideoLabel = kineticFrames.length > 0 ? kFinalLabel : "xfaded";
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y ${inputs} -i "${safeAudioPath}"${kineticInput} ` +
            `-filter_complex "${scaleFilters}${xfadeChain}${kineticChainStr};[${finalVideoLabel}]${fadeFilter}[vout]" ` +
            `-map "[vout]" -map "${audioIdx}:a" ` +
            `-t ${duration} ${threadFlag} -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 64k -pix_fmt yuv420p "${outputPath}"`
          ),
          120_000, `Compose multi-clip scene ${scene.index} (no subtitle)`
        );
      }
    } else {
      // Single clip
      const clip = safeClips[0];
      const audioIdx = 1;
      const subIdx = 2;
      const kineticBaseIdx = subtitlePath ? subIdx + 1 : subIdx;
      const { extraInputs: kExtraInputs, filterChain: kChain, finalLabel: kFinalLabel } =
        buildKineticChain(subtitlePath ? "withsub" : "scaled", kineticBaseIdx);

      if (subtitlePath && fs.existsSync(subtitlePath)) {
        const kineticInput = kExtraInputs ? ` ${kExtraInputs}` : "";
        const kineticChainStr = kChain ? kChain : "";
        const finalVideoLabel = kineticFrames.length > 0 ? kFinalLabel : "withsub";
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y -i "${clip}" -i "${safeAudioPath}" -loop 1 -i "${subtitlePath}"${kineticInput} ` +
            `-filter_complex "[0:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}[scaled];[scaled][${subIdx}:v]overlay=x=0:y=${overlayY}:shortest=1[withsub]${kineticChainStr};[${finalVideoLabel}]${fadeFilter}[vout]" ` +
            `-map "[vout]" -map "${audioIdx}:a" ` +
            `-t ${duration} ${threadFlag} -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 64k -pix_fmt yuv420p "${outputPath}"`
          ),
          75_000, `Compose 1-clip scene ${scene.index}`
        );
      } else {
        const kineticInput = kExtraInputs ? ` ${kExtraInputs}` : "";
        const kineticChainStr = kChain ? kChain : "";
        const finalVideoLabel = kineticFrames.length > 0 ? kFinalLabel : "scaled";
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y -i "${clip}" -i "${safeAudioPath}"${kineticInput} ` +
            `-filter_complex "[0:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}[scaled]${kineticChainStr};[${finalVideoLabel}]${fadeFilter}[vout]" ` +
            `-map "[vout]" -map "${audioIdx}:a" ` +
            `-t ${duration} ${threadFlag} -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 64k -pix_fmt yuv420p "${outputPath}"`
          ),
          75_000, `Compose 1-clip scene ${scene.index} (no subtitle)`
        );
      }
    }
  } catch (composeErr) {
    // Last resort: simple mux (no overlays)
    console.warn(`[Pipeline] Scene ${scene.index}: compose failed, trying simple mux:`, composeErr);
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -i "${safeClips[0]}" -i "${safeAudioPath}" ` +
        `-t ${duration} ${threadFlag} -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 64k -pix_fmt yuv420p "${outputPath}"`
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
        `-map "[music]" -c:a libmp3lame -b:a 64k "${outputPath}"`
      ),
      30_000, "Background music generation"
    );
    return outputPath;
  } catch (err) {
    console.warn("[Pipeline] Music generation failed, using silence:", err);
    await exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${duration} -c:a libmp3lame -b:a 64k "${outputPath}"`).catch((e) => { console.error('[Pipeline] Music silence fallback failed:', e); });
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
    try {
      const exists = fs.existsSync(p);
      const size = exists ? fs.statSync(p).size : 0;
      if (!exists) console.error(`[Pipeline] Concat: scene file MISSING: ${p}`);
      else if (size <= 100) console.error(`[Pipeline] Concat: scene file too small (${size} bytes): ${p}`);
      return exists && size > 100;
    } catch { return false; }
  });
  if (validScenePaths.length === 0) throw new Error("No valid composed scene files to concatenate");

  const allClips = [introPath, ...validScenePaths, outroPath];
  const listContent = allClips.map(p => `file '${p}'`).join("\n");
  fs.writeFileSync(listFile, listContent, "utf-8");

  const totalWithCards = totalDuration + 3 + 4;

  const [, musicPath] = await Promise.all([
    withTimeout(
      exec(`${FFMPEG_BIN} -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 64k -movflags +faststart "${concatPath}"`),
      600_000, // 10 min for large videos (30+ scenes)
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
  let concatHasAudio = false;
  try {
    const { execSync: es } = await import("child_process");
    const probeOut = es(`${FFMPEG_BIN.replace(/ffmpeg$/, 'ffprobe')} -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${concatPath}"`, { encoding: 'utf8' });
    concatHasAudio = probeOut.trim().includes('audio');
  } catch { concatHasAudio = false; }
  console.log(`[Pipeline] Concat has audio: ${concatHasAudio}`);

  if (concatHasAudio) {
    // Normal path: mix voiceover audio with background music
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
        `-filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.10[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
        `-map "0:v" -map "[aout]" ` +
        `-c:v copy -c:a aac -b:a 64k -movflags +faststart "${outputPath}"`
      ),
      120_000, "Background music mixing"
    );
  } else {
    // Fallback: concat has no audio — use only background music
    console.warn("[Pipeline] Concat has no audio stream, using background music only");
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
        `-filter_complex "[1:a]volume=0.3[aout]" ` +
        `-map "0:v" -map "[aout]" ` +
        `-c:v copy -c:a aac -b:a 64k -movflags +faststart "${outputPath}"`
      ),
      120_000, "Background music mixing (no voiceover)"
    );
  }

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
  videoLength: string = "8-12",
  enableSubtitles = true
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

    // Process visuals in batches — fewer on Railway to avoid OOM
    const visualLimit = pLimit(IS_RAILWAY ? 2 : 4);
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

    // Process compose in batches — fewer on Railway to avoid OOM
    const composeLimit = pLimit(IS_RAILWAY ? 1 : 4);
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
