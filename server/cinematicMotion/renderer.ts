/**
 * Cinematic Motion Renderer
 * Applies the SceneMotionPlan to a composed scene video:
 *   1. Counters via drawtext
 *   2. Map marker PNG overlay
 * Image card treatment is applied at still-encode time (see imageCard.ts).
 */
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { SceneMotionPlan, VideoMotionPlan } from "./types";
import { buildCounterFilter } from "./counter";
import { generateMapMarkerPng, buildMapOverlayFilter } from "./mapOverlay";

const execAsync = promisify(exec);
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";
const TIMEOUT_MS = 45_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Timeout ${ms}ms`)), ms)),
  ]);
}

async function probeDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await withTimeout(
      execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`),
      10_000
    );
    return parseFloat(stdout.trim()) || 0;
  } catch { return 0; }
}

/**
 * Apply motion overlays (counters + maps) to a composed scene clip.
 * Returns output path (may be same as input if nothing to apply).
 */
export async function applyMotionOverlays(
  videoPath: string,
  plan: SceneMotionPlan,
  workDir: string
): Promise<string> {
  if (!fs.existsSync(videoPath)) return videoPath;
  const hasCounters = plan.counters.length > 0;
  const hasMaps     = plan.maps.length > 0;
  if (!hasCounters && !hasMaps) return videoPath;

  const videoDur = await probeDuration(videoPath);
  if (videoDur < 0.5) return videoPath;

  const outputPath = path.join(workDir, `cm_s${plan.sceneIndex}_motion.mp4`);

  // ── Build extra inputs (map PNGs) ────────────────────────────────────────
  const mapPngs: Array<{ pngPath: string; overlay: typeof plan.maps[0] }> = [];
  for (let i = 0; i < plan.maps.length; i++) {
    const mo = plan.maps[i];
    // Clamp times
    const start = Math.max(0, Math.min(mo.startSec, videoDur - 0.5));
    const dur   = Math.min(mo.durationSec, videoDur - start - 0.1);
    if (dur < 0.5) continue;
    const png = await generateMapMarkerPng(
      { ...mo, startSec: start, durationSec: dur },
      workDir,
      `s${plan.sceneIndex}_m${i}`
    );
    if (png) mapPngs.push({ pngPath: png, overlay: { ...mo, startSec: start, durationSec: dur } });
  }

  // ── Build drawtext filters for counters ──────────────────────────────────
  const drawtextParts: string[] = [];
  for (const ctr of plan.counters) {
    const start = Math.max(0, Math.min(ctr.startSec, videoDur - 0.5));
    const dur   = Math.min(ctr.durationSec, videoDur - start - 0.1);
    if (dur < 0.3) continue;
    drawtextParts.push(buildCounterFilter({ ...ctr, startSec: start, durationSec: dur }));
  }

  // ── Path A: counters only — simple -vf ──────────────────────────────────
  if (mapPngs.length === 0 && drawtextParts.length > 0) {
    const vf = drawtextParts.join(",");
    try {
      await withTimeout(
        execAsync(
          `${FFMPEG_BIN} -y -i "${videoPath}" -vf "${vf}" ` +
          `-c:v libx264 -preset fast -crf 18 -c:a copy "${outputPath}"`
        ),
        TIMEOUT_MS
      );
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10_000) {
        console.log(`[CinematicMotion] s${plan.sceneIndex}: counter overlay applied`);
        return outputPath;
      }
    } catch (err) {
      console.warn(`[CinematicMotion] counter overlay failed s${plan.sceneIndex}:`, (err as Error).message?.slice(0, 100));
    }
    return videoPath;
  }

  // ── Path B: map PNGs (+ optional counters) — filter_complex ─────────────
  if (mapPngs.length > 0) {
    const extraInputs = mapPngs.map(m => `-i "${m.pngPath}"`).join(" ");

    // Build filter chain: start with drawtext on [0:v], then overlay maps
    let filterComplex = "";
    let prevLabel = "0:v";

    if (drawtextParts.length > 0) {
      filterComplex += `[0:v]${drawtextParts.join(",")}[vdt];`;
      prevLabel = "vdt";
    }

    for (let i = 0; i < mapPngs.length; i++) {
      const inputIdx = i + 1;
      const outLabel = i === mapPngs.length - 1 ? "vout" : `vmap${i}`;
      filterComplex += buildMapOverlayFilter(
        mapPngs[i].overlay,
        mapPngs[i].pngPath,
        inputIdx,
        `[${prevLabel}]`,
        outLabel
      ) + ";";
      prevLabel = outLabel;
    }

    try {
      await withTimeout(
        execAsync(
          `${FFMPEG_BIN} -y -i "${videoPath}" ${extraInputs} ` +
          `-filter_complex "${filterComplex}" ` +
          `-map "[vout]" -map "0:a?" ` +
          `-c:v libx264 -preset fast -crf 18 -c:a copy "${outputPath}"`
        ),
        TIMEOUT_MS
      );
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10_000) {
        console.log(`[CinematicMotion] s${plan.sceneIndex}: map overlay applied (${mapPngs.length} marker(s))`);
        // Cleanup PNGs
        for (const { pngPath } of mapPngs) {
          try { fs.unlinkSync(pngPath); } catch { /* ignore */ }
        }
        return outputPath;
      }
    } catch (err) {
      console.warn(`[CinematicMotion] map overlay failed s${plan.sceneIndex}:`, (err as Error).message?.slice(0, 100));
    }

    // Cleanup on failure
    for (const { pngPath } of mapPngs) {
      try { fs.unlinkSync(pngPath); } catch { /* ignore */ }
    }
  }

  return videoPath;
}

/**
 * Apply cinematic motion overlays to all composed scenes.
 */
export async function applyMotionOverlaysToScenes(
  scenePaths: string[],
  plan: VideoMotionPlan,
  workDir: string
): Promise<string[]> {
  const results: string[] = [];
  for (let i = 0; i < scenePaths.length; i++) {
    const sp = plan.scenes[i];
    if (!sp || (sp.counters.length === 0 && sp.maps.length === 0)) {
      results.push(scenePaths[i]);
      continue;
    }
    const result = await applyMotionOverlays(scenePaths[i], sp, workDir);
    results.push(result);
  }
  return results;
}
