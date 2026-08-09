/**
 * Timeline renderer — horizontal scrolling timeline with year markers.
 * Generated as an SVG → PNG overlay.
 */
import * as fs from "fs";
import * as path from "path";
import type { Timeline } from "../types";
import { ffmpegSemaphore } from "../../_core/semaphore";

const W = 1920;
const H = 1080;
const TRACK_Y = H - 220;
const TRACK_H = 6;
const ACCENT  = "#FFD54F";
const BG      = "rgba(0,0,0,0.70)";

function buildTimelineSvg(tl: Timeline): string {
  const events = tl.events.slice(0, 8);
  const count  = events.length;
  const startX = 160;
  const endX   = W - 160;
  const spacing = count > 1 ? (endX - startX) / (count - 1) : 0;

  let markers = "";
  for (let i = 0; i < count; i++) {
    const x    = count === 1 ? (startX + endX) / 2 : startX + i * spacing;
    const ev   = events[i];
    const isHL = ev.year === tl.highlightYear;
    const r    = isHL ? 14 : 8;
    const col  = isHL ? ACCENT : "white";

    markers += `
      <circle cx="${x}" cy="${TRACK_Y}" r="${r}" fill="${col}" opacity="${isHL ? 1 : 0.75}"/>
      ${isHL ? `<circle cx="${x}" cy="${TRACK_Y}" r="24" fill="none" stroke="${ACCENT}" stroke-width="2.5" opacity="0.6"/>` : ""}
      <text x="${x}" y="${TRACK_Y - 28}" text-anchor="middle"
            font-family="Arial, sans-serif" font-size="${isHL ? 34 : 26}"
            font-weight="${isHL ? "bold" : "normal"}" fill="${col}" opacity="${isHL ? 1 : 0.85}">
        ${ev.year}
      </text>
      ${ev.label ? `<text x="${x}" y="${TRACK_Y + 46}" text-anchor="middle"
            font-family="Arial, sans-serif" font-size="20" fill="white" opacity="0.7">${ev.label}</text>` : ""}
    `;
  }

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- Background strip -->
  <rect x="${startX - 40}" y="${TRACK_Y - 60}" width="${endX - startX + 80}" height="160"
        rx="12" fill="rgba(0,0,0,0.65)"/>
  <!-- Track line -->
  <line x1="${startX}" y1="${TRACK_Y}" x2="${endX}" y2="${TRACK_Y}"
        stroke="white" stroke-width="${TRACK_H}" stroke-linecap="round" opacity="0.35"/>
  <!-- Accent line up to highlight -->
  ${tl.highlightYear ? (() => {
    const hlIdx = events.findIndex(e => e.year === tl.highlightYear);
    if (hlIdx < 0) return "";
    const hlX = count === 1 ? (startX + endX) / 2 : startX + hlIdx * spacing;
    return `<line x1="${startX}" y1="${TRACK_Y}" x2="${hlX}" y2="${TRACK_Y}"
              stroke="${ACCENT}" stroke-width="${TRACK_H}" stroke-linecap="round" opacity="0.9"/>`;
  })() : ""}
  ${markers}
</svg>`;
}

export async function generateTimelinePng(
  tl: Timeline,
  workDir: string,
  tag: string
): Promise<string | null> {
  const svgContent = buildTimelineSvg(tl);
  const svgPath = path.join(workDir, `timeline_${tag}.svg`);
  const pngPath = path.join(workDir, `timeline_${tag}.png`);

  try {
    fs.writeFileSync(svgPath, svgContent, "utf8");

    // Try canvas + canvg
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { createCanvas } = require("canvas") as any;
      const canvgMod = await (eval('import("canvg")') as Promise<any>).catch(() => null);
      if (canvgMod?.Canvg) {
        const canvas = createCanvas(W, H);
        const ctx    = canvas.getContext("2d");
        const v      = await canvgMod.Canvg.from(ctx, svgContent);
        await v.render();
        fs.writeFileSync(pngPath, canvas.toBuffer("image/png"));
        fs.unlinkSync(svgPath);
        return pngPath;
      }
    } catch { /* fall through */ }

    // Fallback: FFmpeg SVG→PNG — routed through ffmpegSemaphore (previously ungated) and given
    // a real timeout (previously none at all — a hung ffmpeg here blocked indefinitely).
    const { exec } = require("child_process");
    const { promisify } = require("util");
    const execA = promisify(exec);
    const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
    try {
      await ffmpegSemaphore.run(() =>
        Promise.race([
          execA(`${FFMPEG} -y -i "${svgPath}" -vframes 1 "${pngPath}"`),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ffmpeg SVG->PNG timeout")), 15_000)),
        ])
      );
      if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 500) {
        fs.unlinkSync(svgPath);
        return pngPath;
      }
    } catch { /* ignore */ }

    fs.unlinkSync(svgPath);
  } catch { /* ignore */ }
  return null;
}
