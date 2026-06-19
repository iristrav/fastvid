import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const ffmpeg = path.join(root, "node_modules/ffmpeg-static/ffmpeg.exe");
const data = JSON.parse(fs.readFileSync(path.join(root, "tmp-video-198.json"), "utf8"));
const scenes = data.videoScenes ?? [];

let t = 0;
const sceneStarts = scenes.map((s) => {
  const start = t / 1000;
  t += s.durationMs ?? 0;
  return { index: s.sceneIndex, startSec: start, durSec: (s.durationMs ?? 0) / 1000 };
});

const scene13 = sceneStarts.find((s) => s.index === 13);
const streamUrl = `https://fastvid-production-dd68.up.railway.app/local-storage/videos_198_final_63c4492a.mp4`;
const outDir = path.join(root, "tmp-video-198-analysis");
fs.mkdirSync(outDir, { recursive: true });

function centerLum(rawPath, w, h) {
  const buf = fs.readFileSync(rawPath);
  let sum = 0;
  let n = 0;
  const x0 = Math.floor(w * 0.35);
  const x1 = Math.floor(w * 0.65);
  const y0 = Math.floor(h * 0.35);
  const y1 = Math.floor(h * 0.65);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * w + x) * 3;
      sum += 0.299 * buf[o] + 0.587 * buf[o + 1] + 0.114 * buf[o + 2];
      n++;
    }
  }
  return sum / Math.max(1, n);
}

function sampleAt(sec, label) {
  const raw = path.join(outDir, `${label}.raw`);
  execFileSync(ffmpeg, [
    "-hide_banner", "-y",
    "-ss", String(sec),
    "-i", streamUrl,
    "-frames:v", "1",
    "-vf", "scale=320:180,format=rgb24",
    "-f", "rawvideo", raw,
  ], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 });
  const lum = centerLum(raw, 320, 180);
  const jpg = path.join(outDir, `${label}.jpg`);
  execFileSync(ffmpeg, [
    "-hide_banner", "-y",
    "-ss", String(sec),
    "-i", streamUrl,
    "-frames:v", "1",
    "-vf", "scale=640:360",
    jpg,
  ], { stdio: "ignore" });
  fs.unlinkSync(raw);
  return lum;
}

const samples = [];
if (scene13) {
  const base = scene13.startSec;
  const yearOffset = scene13.durSec * 0.72;
  for (const dt of [0, 2, 5, yearOffset - 1, yearOffset, yearOffset + 1, yearOffset + 2, scene13.durSec - 2]) {
    const sec = Math.min(437, Math.max(1, base + dt));
    const label = `s13_${dt.toFixed(1).replace(".", "_")}`;
    try {
      const lum = sampleAt(sec, label);
      samples.push({ sec: Math.round(sec * 10) / 10, dt, centerLum: Math.round(lum * 10) / 10, black: lum < 15 });
    } catch (e) {
      samples.push({ sec, dt, error: String(e.message ?? e) });
    }
  }
}

console.log(JSON.stringify({ sceneStarts: sceneStarts.slice(12, 15), samples }, null, 2));
