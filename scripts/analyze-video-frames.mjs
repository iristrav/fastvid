/**
 * Deep frame analysis: hashes, diffs, PNG exports.
 * Usage: node scripts/analyze-video-frames.mjs <url-or-id> [fromSec] [toSec]
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const ffmpeg = path.join(root, "node_modules/ffmpeg-static/ffmpeg.exe");
const base = "https://fastvid-production-dd68.up.railway.app";

const arg = process.argv[2] ?? "230";
const fromSec = Number(process.argv[3] ?? 0);
const toSec = Number(process.argv[4] ?? 70);

async function resolveUrl(input) {
  if (/^https?:\/\//i.test(input)) return input;
  const id = parseInt(input, 10);
  const res = await fetch(`${base}/api/internal/video/${id}`, {
    headers: { "x-internal-key": "dev-trigger-key-2026" },
  });
  if (!res.ok) throw new Error(`video ${id}: HTTP ${res.status}`);
  const v = await res.json();
  const rel = v.videoUrl || v.fileProbe?.path;
  if (!rel) throw new Error(`video ${id}: no url`);
  return rel.startsWith("http") ? rel : `${base}${rel.startsWith("/") ? "" : "/"}${rel}`;
}

function extractFrame(url, sec, vf, outPath) {
  execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(sec),
      "-i",
      url,
      "-frames:v",
      "1",
      "-vf",
      vf,
      "-f",
      outPath.endsWith(".png") ? "image2" : "rawvideo",
      outPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 }
  );
}

function frameHash(url, sec, outDir) {
  const raw = path.join(outDir, "h.raw");
  extractFrame(url, sec, "scale=160:90,format=rgb24", raw);
  const buf = fs.readFileSync(raw);
  return crypto.createHash("md5").update(buf).digest("hex").slice(0, 12);
}

function frameDiff(url, aSec, bSec, outDir) {
  const rawA = path.join(outDir, "a.raw");
  const rawB = path.join(outDir, "b.raw");
  extractFrame(url, aSec, "scale=160:90,format=rgb24", rawA);
  extractFrame(url, bSec, "scale=160:90,format=rgb24", rawB);
  const a = fs.readFileSync(rawA);
  const b = fs.readFileSync(rawB);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return diff / (a.length * 255);
}

function lumStats(url, sec, outDir) {
  const raw = path.join(outDir, "l.raw");
  extractFrame(url, sec, "scale=320:180,format=rgb24", raw);
  const buf = fs.readFileSync(raw);
  const w = 320;
  const h = 180;
  const region = (x0, x1, y0, y1) => {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 3;
        sum += 0.299 * buf[o] + 0.587 * buf[o + 1] + 0.114 * buf[o + 2];
        n++;
      }
    }
    return sum / Math.max(1, n);
  };
  const center = region(
    Math.floor(w * 0.35),
    Math.floor(w * 0.65),
    Math.floor(h * 0.35),
    Math.floor(h * 0.65)
  );
  const left = region(0, Math.floor(w * 0.08), 0, h);
  const right = region(w - Math.floor(w * 0.08), w, 0, h);
  return {
    center: +center.toFixed(1),
    left: +left.toFixed(1),
    right: +right.toFixed(1),
    grayPad:
      center > 35 &&
      center < 52 &&
      left > 35 &&
      left < 52 &&
      Math.abs(center - left) < 8,
  };
}

const url = await resolveUrl(arg);
const label = arg.replace(/\W+/g, "_");
const outDir = path.join(root, `tmp-analysis-${label}`);
fs.mkdirSync(outDir, { recursive: true });

console.log(`Analyzing: ${url}`);
console.log(`Range: ${fromSec}s – ${toSec}s\n`);

console.log("=== Per-second luminance + hash ===");
const rows = [];
for (let t = fromSec; t <= toSec; t++) {
  const lum = lumStats(url, t, outDir);
  const hash = frameHash(url, t, outDir);
  rows.push({ t, hash, ...lum });
}

for (const r of rows) {
  const flags = [
    r.grayPad ? "GRAY" : "",
    r.t > fromSec && r.hash === rows[r.t - fromSec - 1]?.hash ? "IDENTICAL" : "",
    r.center < 20 ? "BLACK" : "",
  ].filter(Boolean);
  console.log(
    `t=${String(r.t).padStart(5)}s  C=${String(r.center).padStart(6)} L=${String(r.left).padStart(6)} hash=${r.hash}${flags.length ? "  " + flags.join(" ") : ""}`
  );
}

let best = { len: 1, start: fromSec };
let runStart = fromSec;
for (let i = 1; i < rows.length; i++) {
  if (rows[i].hash === rows[i - 1].hash) continue;
  const len = i - (runStart - fromSec);
  if (len > best.len) best = { len, start: runStart };
  runStart = rows[i].t;
}
const tailLen = rows.length - (runStart - fromSec);
if (tailLen > best.len) best = { len: tailLen, start: runStart };
console.log(`\nLongest identical-frame run: ${best.len}s from t=${best.start}`);

console.log("\n=== Frame diff vs previous second (8–25) ===");
for (let t = Math.max(8, fromSec + 1); t <= Math.min(25, toSec); t++) {
  const d = frameDiff(url, t - 1, t, outDir);
  const pct = (d * 100).toFixed(2);
  const flag = d < 0.002 ? " FROZEN" : d < 0.012 ? " slow/KenBurns" : "";
  console.log(`t=${String(t).padStart(5)}s  diff=${pct}%${flag}`);
}

console.log("\n=== PNG snapshots ===");
for (const t of [5, 6, 7, 8, 9, 10, 15, 30, 60].filter((t) => t >= fromSec && t <= toSec)) {
  const png = path.join(outDir, `t${t}.png`);
  extractFrame(url, t, "scale=640:360", png);
  console.log(png);
}

console.log("\n=== Visual similarity vs t=9 (same-scene if diff < 4%) ===");
const anchor = Math.max(9, fromSec);
for (let t = anchor; t <= Math.min(35, toSec); t++) {
  const d = t === anchor ? 0 : frameDiff(url, anchor, t, outDir) * 100;
  console.log(
    `t=${String(t).padStart(5)}s  diffVs${anchor}=${d.toFixed(1)}%${d < 4 ? "  SAME-SCENE" : ""}`
  );
}
