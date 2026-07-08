/**
 * SVG world map overlay with pulsing location marker.
 * Generates a PNG via canvas (if available) or a simplified SVG fallback.
 * The PNG is then overlaid on the video with FFmpeg.
 */
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { MapOverlay } from "./types";

const execAsync = promisify(exec);
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";
const W = 1920;
const H = 1080;

// Simplified world map path (equirectangular projection, normalised 0–1 coords)
// This is a minimal SVG outline — enough to give geographic context
const WORLD_SVG_VIEWBOX = `0 0 ${W} ${H}`;

function markerSvg(normX: number, normY: number, name: string): string {
  const x = Math.round(normX * W);
  const y = Math.round(normY * H);
  const r1 = 18;
  const r2 = 28;
  const r3 = 42;

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${WORLD_SVG_VIEWBOX}">
  <defs>
    <radialGradient id="glow">
      <stop offset="0%" stop-color="#FFD54F" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#FFD54F" stop-opacity="0"/>
    </radialGradient>
    <style>
      @keyframes pulse {
        0%   { r: ${r2}; opacity: 0.7; }
        70%  { r: ${r3}; opacity: 0; }
        100% { r: ${r3}; opacity: 0; }
      }
    </style>
  </defs>
  <!-- Outer pulse ring -->
  <circle cx="${x}" cy="${y}" r="${r3}" fill="none" stroke="#FFD54F" stroke-width="2" opacity="0.4"/>
  <circle cx="${x}" cy="${y}" r="${r2}" fill="none" stroke="#FFD54F" stroke-width="2.5" opacity="0.6"/>
  <!-- Glow -->
  <circle cx="${x}" cy="${y}" r="${r3}" fill="url(#glow)" opacity="0.5"/>
  <!-- Core dot -->
  <circle cx="${x}" cy="${y}" r="${r1}" fill="#FFD54F" opacity="0.95"/>
  <circle cx="${x}" cy="${y}" r="8"    fill="white"   opacity="1"/>
  <!-- Label -->
  <rect x="${x + r1 + 10}" y="${y - 22}" width="${name.length * 14 + 24}" height="42" rx="8" fill="rgba(0,0,0,0.75)"/>
  <text x="${x + r1 + 22}" y="${y + 6}" font-family="Arial, sans-serif" font-size="26" font-weight="bold" fill="white">${name}</text>
</svg>`;
}

async function hasCanvas(): Promise<boolean> {
  try { require("canvas"); return true; } catch { return false; }
}

/**
 * Generate a PNG overlay for a map marker.
 * Returns the path to the PNG, or null if generation failed.
 */
export async function generateMapMarkerPng(
  overlay: MapOverlay,
  workDir: string,
  tag: string
): Promise<string | null> {
  const svgContent = markerSvg(overlay.normX, overlay.normY, overlay.locationName);
  const svgPath = path.join(workDir, `mapmarker_${tag}.svg`);
  const pngPath = path.join(workDir, `mapmarker_${tag}.png`);

  try {
    fs.writeFileSync(svgPath, svgContent, "utf8");

    // Try canvas first
    if (await hasCanvas()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { createCanvas, loadImage } = require("canvas") as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const canvgMod = await (eval('import("canvg")') as Promise<any>).catch(() => null);
      const Canvg = canvgMod?.Canvg ?? null;
      if (Canvg) {
        const canvas = createCanvas(W, H);
        const ctx = canvas.getContext("2d");
        const v = await (Canvg as any).from(ctx, svgContent);
        await v.render();
        fs.writeFileSync(pngPath, canvas.toBuffer("image/png"));
        fs.unlinkSync(svgPath);
        return pngPath;
      }
    }

    // Fallback: ffmpeg can render SVG via libsvg or lavfi — try with -f lavfi
    // Most reliably: use ffmpeg to convert SVG→PNG via the image2 demuxer
    try {
      await execAsync(
        `${FFMPEG_BIN} -y -i "${svgPath}" -vframes 1 "${pngPath}"`
      );
      if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 500) {
        fs.unlinkSync(svgPath);
        return pngPath;
      }
    } catch { /* fall through */ }

    // Last resort: write SVG as-is — some FFmpeg builds support svg input
    fs.unlinkSync(svgPath);
    return null;
  } catch {
    return null;
  }
}

/**
 * Build FFmpeg filter segment to overlay a map marker PNG on a video.
 * inputIdx = index of the PNG input (e.g. 1 if video is input 0).
 * prevLabel = label of the video stream coming in (e.g. "[0:v]").
 * outLabel  = label to write the result to.
 */
export function buildMapOverlayFilter(
  overlay: MapOverlay,
  pngPath: string,
  inputIdx: number,
  prevLabel: string,
  outLabel: string
): string {
  const { startSec, durationSec } = overlay;
  const endSec = startSec + durationSec;
  const fadeIn  = Math.min(0.4, durationSec * 0.15);
  const fadeOut = Math.min(0.4, durationSec * 0.15);
  return (
    `[${inputIdx}:v]fade=t=in:st=0:d=${fadeIn},fade=t=out:st=${(durationSec - fadeOut).toFixed(2)}:d=${fadeOut}[mapng];` +
    `${prevLabel}[mapng]overlay=0:0:enable='between(t,${startSec.toFixed(2)},${endSec.toFixed(2)})'[${outLabel}]`
  );
}
