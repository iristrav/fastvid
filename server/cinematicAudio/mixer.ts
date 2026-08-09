import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { VideoSoundPlan, SceneSoundPlan } from "./types";
import { resolveSoundAssets } from "./fetcher";
import { ffmpegSemaphore } from "../_core/semaphore";

const execRaw = promisify(exec);

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);
}

// Route every ffmpeg/ffprobe spawn in this file through the same global concurrency gate the
// rest of the render pipeline uses (server/videoPipeline.ts's exec()). Without this,
// generateCinematicAmbientTrack()'s Promise.all below fires one concurrent ffmpeg process per
// scene completely outside FFMPEG_CONCURRENCY_LIMIT — on a 4-vCPU box this is exactly the
// oversubscription shape that has already caused fork-pressure (EAGAIN) incidents elsewhere.
//
// The timeout is applied INSIDE the semaphore callback (not by the caller wrapping this
// function's result in a separate withTimeout()) — previously callers did
// `withTimeout(execAsync(cmd), ms)`, which started the timer before the semaphore slot was
// even acquired, so queue-wait time under contention (several scenes' ambient generation firing
// at once against a 3-slot semaphore) counted against the operation's own budget, causing
// spurious timeouts purely from queueing rather than a slow encode.
function execAsync(cmd: string, ms: number) {
  return ffmpegSemaphore.run(() => withTimeout(execRaw(cmd), ms));
}

const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";

async function probeDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      8_000
    );
    return parseFloat(stdout.trim()) || 0;
  } catch { return 0; }
}

/**
 * Generate a per-scene ambient audio file using available sound assets.
 * Falls back to FFmpeg-generated pink noise with EQ if no files are available.
 */
async function generateSceneAmbient(
  plan: SceneSoundPlan,
  durationSec: number,
  workDir: string,
  outPath: string
): Promise<boolean> {
  const cats = [...plan.ambience];
  if (!cats.length) return false;

  const assetMap = await resolveSoundAssets(cats);

  if (assetMap.size === 0) {
    // Fallback: FFmpeg pink noise shaped for ambient feel
    return generateSyntheticAmbient(plan, durationSec, outPath);
  }

  const inputs: string[] = [];
  const filterParts: string[] = [];
  const mixLabels: string[] = [];
  let idx = 0;

  for (const [cat, filePath] of Array.from(assetMap)) {
    const volDb = plan.ambienceVolumeDb;
    const vol = Math.pow(10, volDb / 20);
    const fadeIn = plan.fadeInMs / 1000;
    const fadeOut = plan.fadeOutMs / 1000;
    inputs.push(`-stream_loop -1 -i "${filePath}"`);
    filterParts.push(
      `[${idx}:a]volume=${vol.toFixed(4)},` +
      `afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${Math.max(0, durationSec - fadeOut).toFixed(2)}:d=${fadeOut},` +
      `atrim=0:${durationSec.toFixed(3)},asetpts=PTS-STARTPTS[amb${idx}]`
    );
    mixLabels.push(`[amb${idx}]`);
    idx++;
  }

  // Also add timed object sounds
  for (const obj of plan.objectSounds) {
    const objMap = await resolveSoundAssets([obj.category]);
    const objPath = objMap.get(obj.category);
    if (!objPath) continue;
    const vol = Math.pow(10, plan.objectVolumeDb / 20);
    const maxObjDur = Math.min(obj.durationSec, durationSec - obj.startSec);
    if (maxObjDur <= 0) continue;
    inputs.push(`-i "${objPath}"`);
    filterParts.push(
      `[${idx}:a]volume=${vol.toFixed(4)},atrim=0:${maxObjDur.toFixed(3)},` +
      `adelay=${Math.round(obj.startSec * 1000)}|${Math.round(obj.startSec * 1000)},` +
      `apad=pad_dur=${durationSec.toFixed(3)},atrim=0:${durationSec.toFixed(3)},asetpts=PTS-STARTPTS[obj${idx}]`
    );
    mixLabels.push(`[obj${idx}]`);
    idx++;
  }

  if (!mixLabels.length) return false;

  const mixFilter = mixLabels.length === 1
    ? `${mixLabels[0]}aresample=44100[ambout]`
    : `${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0,aresample=44100[ambout]`;

  const filterComplex = [...filterParts, mixFilter].join(";");
  const cmd =
    `${FFMPEG_BIN} -y ${inputs.join(" ")} ` +
    `-filter_complex "${filterComplex}" ` +
    `-map "[ambout]" -t ${durationSec.toFixed(3)} ` +
    `-c:a libmp3lame -b:a 128k "${outPath}"`;

  try {
    await execAsync(cmd, 30_000);
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 512;
  } catch (err) {
    console.warn(`[CinematicAudio] Scene ${plan.sceneIndex} ambient failed:`, (err as Error).message?.slice(0, 100));
    return false;
  }
}

/**
 * FFmpeg-generated synthetic ambient as fallback when no sound files are available.
 * Uses pink noise shaped with EQ filters to approximate environmental sound.
 */
async function generateSyntheticAmbient(
  plan: SceneSoundPlan,
  durationSec: number,
  outPath: string
): Promise<boolean> {
  const vol = Math.pow(10, (plan.ambienceVolumeDb - 6) / 20); // extra -6dB for generated noise
  const firstCat = plan.ambience[0];

  // Shape the noise based on category
  let eqFilter = "highpass=f=800,lowpass=f=4000"; // generic indoor room
  if (firstCat === "rain" || firstCat === "storm") {
    eqFilter = "highpass=f=2000,lowpass=f=8000"; // rain = high frequency hiss
  } else if (firstCat === "waves" || firstCat === "ocean") {
    eqFilter = "highpass=f=200,lowpass=f=2000,equalizer=f=400:width_type=o:w=2:g=6"; // low rumble
  } else if (firstCat === "wind") {
    eqFilter = "highpass=f=1000,lowpass=f=5000"; // mid-high whoosh
  } else if (firstCat === "traffic" || firstCat === "city") {
    eqFilter = "highpass=f=300,lowpass=f=3000"; // broad urban spectrum
  } else if (firstCat === "forest" || firstCat === "birds") {
    eqFilter = "highpass=f=2000,lowpass=f=8000,equalizer=f=3000:width_type=o:w=1:g=4"; // bird-like
  }

  const cmd =
    `${FFMPEG_BIN} -y -f lavfi ` +
    `-i "anoisesrc=color=pink:sample_rate=44100:duration=${durationSec.toFixed(3)}" ` +
    `-af "${eqFilter},volume=${vol.toFixed(4)},` +
    `afade=t=in:st=0:d=0.6,afade=t=out:st=${Math.max(0, durationSec - 0.8).toFixed(2)}:d=0.8" ` +
    `-c:a libmp3lame -b:a 128k "${outPath}"`;

  try {
    await execAsync(cmd, 15_000);
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 512;
  } catch {
    return false;
  }
}

/**
 * Concatenate per-scene ambient files into one continuous ambient track.
 * Scenes are expected to be in order; any missing scene gets silence.
 */
async function concatenateSceneAmbients(
  scenePaths: Array<{ path: string | null; durationSec: number }>,
  workDir: string,
  outPath: string
): Promise<boolean> {
  const parts: string[] = [];
  const inputs: string[] = [];
  const labels: string[] = [];
  let idx = 0;

  for (const { path: p, durationSec } of scenePaths) {
    if (p && fs.existsSync(p)) {
      inputs.push(`-i "${p}"`);
      labels.push(`[${idx}:a]`);
      idx++;
    } else {
      // Silence for this scene
      inputs.push(`-f lavfi -i "anullsrc=sample_rate=44100:duration=${durationSec.toFixed(3)}"`);
      labels.push(`[${idx}:a]`);
      idx++;
    }
  }

  if (!labels.length) return false;
  const concatFilter = `${labels.join("")}concat=n=${labels.length}:v=0:a=1[aout]`;

  const cmd =
    `${FFMPEG_BIN} -y ${inputs.join(" ")} ` +
    `-filter_complex "${concatFilter}" ` +
    `-map "[aout]" -c:a libmp3lame -b:a 128k "${outPath}"`;

  try {
    await execAsync(cmd, 60_000);
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 512;
  } catch (err) {
    console.warn("[CinematicAudio] Ambient concat failed:", (err as Error).message?.slice(0, 100));
    return false;
  }
}

/**
 * Generate the full cinematic ambient track for the video.
 * Returns the path to the ambient audio file, or null if generation failed.
 */
export async function generateCinematicAmbientTrack(
  plan: VideoSoundPlan,
  sceneDurations: number[],
  workDir: string
): Promise<string | null> {
  const ambientOutPath = path.join(workDir, "cinematic_ambient.mp3");

  const scenePaths: Array<{ path: string | null; durationSec: number }> = [];

  await Promise.all(
    plan.scenes.map(async (scenePlan, i) => {
      const dur = sceneDurations[i] ?? scenePlan.sceneIndex;
      const sceneAmbPath = path.join(workDir, `cinematic_amb_s${scenePlan.sceneIndex}.mp3`);
      const ok = await generateSceneAmbient(scenePlan, dur, workDir, sceneAmbPath);
      scenePaths[i] = { path: ok ? sceneAmbPath : null, durationSec: dur };
    })
  );

  const ok = await concatenateSceneAmbients(scenePaths, workDir, ambientOutPath);

  // Cleanup per-scene files
  for (const { path: p } of scenePaths) {
    if (p) try { fs.unlinkSync(p); } catch { /* ignore */ }
  }

  if (!ok) {
    console.warn("[CinematicAudio] Ambient track generation failed — skipping");
    return null;
  }

  const dur = await probeDuration(ambientOutPath);
  console.log(`[CinematicAudio] Ambient track ready: ${dur.toFixed(1)}s`);
  return ambientOutPath;
}

/**
 * Build the FFmpeg filter_complex string that mixes voice + music + cinematic ambient.
 * Drop-in replacement for the current two-input mix.
 *
 * Input slots expected:
 *   [0:a] = concatenated video with embedded voice audio
 *   [1:a] = background music
 *   [2:a] = cinematic ambient track
 */
export function buildCinematicAudioFilter(emotion: string): string {
  // Ambient volume based on emotion
  const ambVol = emotion === "dramatic" ? 0.18
    : emotion === "tense" ? 0.15
    : emotion === "sad" ? 0.12
    : 0.14;

  return (
    "[0:a]volume=1.0,asplit=2[voice][voicedet];" +
    "[1:a]volume=0.22,aloop=loop=-1:size=2e+09[musicloop];" +
    `[2:a]volume=${ambVol.toFixed(2)},aloop=loop=-1:size=2e+09[ambloop];` +
    // Sidechain: duck music when voice is active
    "[musicloop][voicedet]sidechaincompress=threshold=0.02:ratio=8:attack=5:release=200:makeup=1[music_ducked];" +
    // Sidechain: duck ambient slightly less aggressively
    "[ambloop][voice]sidechaincompress=threshold=0.03:ratio=4:attack=10:release=300:makeup=1[amb_ducked];" +
    "[voice][music_ducked][amb_ducked]amix=inputs=3:duration=first:dropout_transition=3[aout]"
  );
}
