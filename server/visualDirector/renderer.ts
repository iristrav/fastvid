/**
 * Visual Director renderer — applies SceneDirective to a video clip.
 * Orchestrates all directive renderers into a single FFmpeg pass.
 */
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { SceneDirective, VideoDirective, Directive, MapMarker, Timeline } from "./types";
import { buildPersonLabelFilters } from "./renderers/personLabel";
import { buildComparisonFilters } from "./renderers/comparison";
import { buildBulletListFilters } from "./renderers/bulletList";
import { buildStatHighlightFilters } from "./renderers/statHighlight";
import { buildCounterFilter } from "../cinematicMotion/counter";
import { generateMapMarkerPng, buildMapOverlayFilter } from "../cinematicMotion/mapOverlay";
import { generateTimelinePng } from "./renderers/timeline";

const execAsync = promisify(exec);
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";
const TIMEOUT_MS = 60_000;

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

interface PngOverlay {
  pngPath: string;
  startSec: number;
  durationSec: number;
  tag: string;
}

export async function applySceneDirective(
  videoPath: string,
  directive: SceneDirective,
  workDir: string
): Promise<string> {
  if (!directive.directives.length) return videoPath;
  if (!fs.existsSync(videoPath)) return videoPath;

  const videoDur = await probeDuration(videoPath);
  if (videoDur < 0.5) return videoPath;

  const outputPath = path.join(workDir, `vd_s${directive.sceneIndex}.mp4`);

  // ── Collect drawtext filters (all text-based directives) ─────────────────
  const drawtextFilters: string[] = [];
  // ── Collect PNG overlays (map markers, timelines) ─────────────────────────
  const pngOverlays: PngOverlay[] = [];

  for (const d of directive.directives) {
    // Clamp times to video duration
    const start = Math.max(0, Math.min(d.startSec, videoDur - 0.5));
    const dur   = Math.max(0.5, Math.min(d.durationSec, videoDur - start - 0.1));
    const cd    = { ...d, startSec: start, durationSec: dur } as Directive;

    switch (cd.kind) {
      case "person_label":
        drawtextFilters.push(...buildPersonLabelFilters(cd));
        break;
      case "counter":
        drawtextFilters.push(buildCounterFilter({
          label: cd.label, fromValue: 0, toValue: cd.value, suffix: cd.suffix,
          startSec: cd.startSec, durationSec: cd.durationSec,
        }));
        break;
      case "stat_highlight":
        drawtextFilters.push(...buildStatHighlightFilters(cd));
        break;
      case "comparison":
        drawtextFilters.push(...buildComparisonFilters(cd));
        break;
      case "bullet_list":
        drawtextFilters.push(...buildBulletListFilters(cd));
        break;
      case "map_marker": {
        const png = await generateMapMarkerPng(
          { locationName: cd.locationName, normX: cd.normX, normY: cd.normY,
            markerStyle: "pulse", startSec: cd.startSec, durationSec: cd.durationSec },
          workDir, `vd_s${directive.sceneIndex}_map`
        );
        if (png) pngOverlays.push({ pngPath: png, startSec: cd.startSec, durationSec: cd.durationSec, tag: "map" });
        break;
      }
      case "timeline": {
        const png = await generateTimelinePng(cd, workDir, `vd_s${directive.sceneIndex}_tl`);
        if (png) pngOverlays.push({ pngPath: png, startSec: cd.startSec, durationSec: cd.durationSec, tag: "tl" });
        break;
      }
      case "quote":
        // Typewriter effect via drawtext — show full text with fade
        drawtextFilters.push(
          `drawtext=text='${cd.text.replace(/'/g, "\\'").replace(/:/g, "\\:").slice(0, 80)}':` +
          `fontcolor=white:fontsize=52:x=(w-text_w)/2:y=(h-text_h)/2:` +
          `alpha='if(lt(t,${cd.startSec.toFixed(2)}),0,if(lt(t,${(cd.startSec+0.4).toFixed(2)}),(t-${cd.startSec.toFixed(2)})/0.4,if(gt(t,${(cd.startSec+cd.durationSec-0.4).toFixed(2)}),(${(cd.startSec+cd.durationSec).toFixed(2)}-t)/0.4,1)))':` +
          `shadowcolor=black:shadowx=3:shadowy=3`
        );
        if (cd.attribution) {
          drawtextFilters.push(
            `drawtext=text='— ${cd.attribution.replace(/'/g, "\\'").replace(/:/g, "\\:")}':` +
            `fontcolor=0xFFD54F:fontsize=34:x=(w-text_w)/2:y=h/2+80:` +
            `alpha='if(lt(t,${(cd.startSec+0.6).toFixed(2)}),0,if(lt(t,${(cd.startSec+1.0).toFixed(2)}),(t-${(cd.startSec+0.6).toFixed(2)})/0.4,1))':` +
            `shadowcolor=black:shadowx=2:shadowy=2`
          );
        }
        break;
    }
  }

  // ── Path A: only drawtext ─────────────────────────────────────────────────
  if (pngOverlays.length === 0) {
    if (!drawtextFilters.length) return videoPath;
    try {
      await withTimeout(
        execAsync(
          `${FFMPEG_BIN} -y -i "${videoPath}" ` +
          `-vf "${drawtextFilters.join(",")}" ` +
          `-c:v libx264 -preset fast -crf 18 -c:a copy "${outputPath}"`
        ),
        TIMEOUT_MS
      );
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10_000) {
        console.log(`[VisualDirector] s${directive.sceneIndex}: rendered ${directive.directives.map(d=>d.kind).join(", ")}`);
        return outputPath;
      }
    } catch (err) {
      console.warn(`[VisualDirector] drawtext failed s${directive.sceneIndex}:`, (err as Error).message?.slice(0, 100));
    }
    return videoPath;
  }

  // ── Path B: PNG overlays + optional drawtext — filter_complex ─────────────
  const extraInputs = pngOverlays.map(o => `-i "${o.pngPath}"`).join(" ");
  let filterComplex = drawtextFilters.length
    ? `[0:v]${drawtextFilters.join(",")}[vdt];`
    : "";
  let prevLabel = drawtextFilters.length ? "vdt" : "0:v";

  for (let i = 0; i < pngOverlays.length; i++) {
    const o         = pngOverlays[i];
    const inputIdx  = i + 1;
    const outLabel  = i === pngOverlays.length - 1 ? "vout" : `vpng${i}`;
    const fadeIn    = Math.min(0.4, o.durationSec * 0.15);
    const fadeOut   = Math.min(0.4, o.durationSec * 0.15);
    filterComplex +=
      `[${inputIdx}:v]fade=t=in:st=0:d=${fadeIn},fade=t=out:st=${(o.durationSec - fadeOut).toFixed(2)}:d=${fadeOut}[png${i}];` +
      `[${prevLabel}][png${i}]overlay=0:0:enable='between(t,${o.startSec.toFixed(2)},${(o.startSec + o.durationSec).toFixed(2)})'[${outLabel}];`;
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
      console.log(`[VisualDirector] s${directive.sceneIndex}: rendered with PNG overlays`);
      for (const o of pngOverlays) try { fs.unlinkSync(o.pngPath); } catch { /* ignore */ }
      return outputPath;
    }
  } catch (err) {
    console.warn(`[VisualDirector] PNG overlay failed s${directive.sceneIndex}:`, (err as Error).message?.slice(0, 100));
    for (const o of pngOverlays) try { fs.unlinkSync(o.pngPath); } catch { /* ignore */ }
  }

  return videoPath;
}

export async function applyVideoDirective(
  scenePaths: string[],
  directive: VideoDirective,
  workDir: string
): Promise<string[]> {
  const results: string[] = [];
  for (let i = 0; i < scenePaths.length; i++) {
    const sd = directive.scenes[i];
    if (!sd?.directives.length) { results.push(scenePaths[i]); continue; }
    results.push(await applySceneDirective(scenePaths[i], sd, workDir));
  }
  return results;
}
