/**
 * Generate (optional) + QA a production FastVid video.
 * Usage: node scripts/qa-production-video.mjs [videoId]
 *        node scripts/qa-production-video.mjs --start
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const base = "https://fastvid-production-dd68.up.railway.app";
const key = "dev-trigger-key-2026";
const ffmpeg = path.join(root, "node_modules/ffmpeg-static/ffmpeg.exe");

const TARGET_1MIN = 58;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function edgeLum(rawPath, w, h, side) {
  const buf = fs.readFileSync(rawPath);
  let sum = 0;
  let n = 0;
  const x0 = side === "left" ? 0 : w - Math.floor(w * 0.08);
  const x1 = side === "left" ? Math.floor(w * 0.08) : w;
  for (let y = 0; y < h; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * w + x) * 3;
      sum += 0.299 * buf[o] + 0.587 * buf[o + 1] + 0.114 * buf[o + 2];
      n++;
    }
  }
  return sum / Math.max(1, n);
}

function sampleFrame(url, sec, label, outDir) {
  const raw = path.join(outDir, `${label}.raw`);
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
      "scale=320:180,format=rgb24",
      "-f",
      "rawvideo",
      raw,
    ],
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 }
  );
  const center = centerLum(raw, 320, 180);
  const left = edgeLum(raw, 320, 180, "left");
  const right = edgeLum(raw, 320, 180, "right");
  fs.unlinkSync(raw);
  return { center, left, right, blackCenter: center < 18, grayPad: center > 35 && center < 50 && left > 35 && left < 50 };
}

function longestFrozenRun(url, fromSec, toSec, outDir) {
  let best = 0;
  let bestStart = fromSec;
  let cur = 0;
  let curStart = fromSec;
  let prev = null;
  for (let t = fromSec; t <= toSec; t++) {
    const s = sampleFrame(url, t, `f_${t}`, outDir);
    const lum = Math.round(s.center * 10) / 10;
    if (prev !== null && lum === prev) {
      if (cur === 0) curStart = t - 1;
      cur++;
    } else {
      if (cur > best) {
        best = cur;
        bestStart = curStart;
      }
      cur = 0;
    }
    prev = lum;
  }
  if (cur > best) {
    best = cur;
    bestStart = curStart;
  }
  return { seconds: best + 1, startSec: bestStart };
}

function detectRepeatingMontageLoop(url, fromSec, toSec, outDir) {
  const hashes = [];
  for (let t = fromSec; t <= toSec; t++) {
    try {
      const raw = path.join(outDir, `loop_${t}.raw`);
      execFileSync(
        ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-ss",
          String(t),
          "-i",
          url,
          "-frames:v",
          "1",
          "-vf",
          "scale=160:90,format=rgb24",
          "-f",
          "rawvideo",
          raw,
        ],
        { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 }
      );
      const buf = fs.readFileSync(raw);
      let h = 0;
      for (let i = 0; i < Math.min(buf.length, 8000); i++) h = (h * 31 + buf[i]) >>> 0;
      hashes.push(h);
      fs.unlinkSync(raw);
    } catch {
      hashes.push(-1);
    }
  }
  for (let period = 3; period <= 8; period++) {
    if (hashes.length < period * 3) continue;
    let matches = 0;
    let checks = 0;
    for (let i = period; i < hashes.length; i++) {
      if (hashes[i] < 0 || hashes[i - period] < 0) continue;
      checks++;
      if (hashes[i] === hashes[i - period]) matches++;
    }
    if (checks >= period * 2 && matches / checks >= 0.85) {
      return { periodSec: period, matchRatio: matches / checks, startSec: fromSec + period };
    }
  }
  return null;
}

async function fetchVideo(id) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`${base}/api/internal/video/${id}`, {
      headers: { "x-internal-key": key },
    });
    if (res.ok) return res.json();
    if (res.status >= 500 && attempt < 7) {
      await sleep(8000);
      continue;
    }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("HTTP fetch retries exhausted");
}

async function startVideo() {
  const res = await fetch(`${base}/api/internal/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": key },
    body: JSON.stringify({
      prompt: "Adolf Hitler: Rise and Fall of the Third Reich — documentary QA",
      videoLength: "1",
      videoType: "documentary",
    }),
  });
  return res.json();
}

async function pollUntilDone(id, maxMin = 25) {
  for (let i = 0; i < maxMin * 4; i++) {
    const d = await fetchVideo(id);
    console.log(`[poll ${i}] ${d.status} ${d.progressStep ?? ""} ${d.progressPercent ?? 0}%`);
    if (d.status === "completed" || d.status === "failed") return d;
    await sleep(15000);
  }
  throw new Error("poll timeout");
}

function qaReport(data) {
  const url = data.videoUrl?.startsWith("http") ? data.videoUrl : base + data.videoUrl;
  const outDir = path.join(root, `tmp-qa-v${data.id}`);
  fs.mkdirSync(outDir, { recursive: true });

  const dur = data.fileProbe?.durationSec ?? 0;
  const sampleTimes = [3, 8, 15, 22, 30, 38, 45, 52, 58, 65, Math.max(5, dur - 5)];
  const uniqueTimes = [...new Set(sampleTimes.map((t) => Math.min(t, dur - 0.5)).filter((t) => t > 0))];

  const frames = uniqueTimes.map((t) => {
    try {
      const s = sampleFrame(url, t, `t${Math.round(t)}`, outDir);
      return { t: Math.round(t * 10) / 10, ...s };
    } catch (e) {
      return { t, error: String(e.message ?? e) };
    }
  });

  const frozen = dur > 10 ? longestFrozenRun(url, 2, Math.min(dur - 2, 68), outDir) : { seconds: 0, startSec: 0 };
  const montageLoop =
    dur > 15 ? detectRepeatingMontageLoop(url, 12, Math.min(dur - 3, 68), outDir) : null;
  const blackFrames = frames.filter((f) => f.blackCenter).length;
  const grayFrames = frames.filter((f) => f.grayPad).length;

  const issues = [];
  if (data.status !== "completed") issues.push(`status=${data.status} ${data.errorMessage ?? ""}`);
  if (dur < 45) issues.push(`video too short: ${dur}s (voice likely cut off)`);
  if (frozen.seconds >= 5) issues.push(`frozen segment ~${frozen.seconds}s at t=${frozen.startSec}s`);
  if (blackFrames >= 1) issues.push(`${blackFrames} near-black center frames`);
  if (grayFrames >= 3) issues.push(`${grayFrames} gray-pad filler frames (montage gap)`);
  if (montageLoop) {
    issues.push(
      `repeating montage loop ~every ${montageLoop.periodSec}s from t≈${montageLoop.startSec}s (${Math.round(montageLoop.matchRatio * 100)}% match)`
    );
  }

  const pass = issues.length === 0;
  const report = {
    videoId: data.id,
    status: data.status,
    durationSec: dur,
    sizeMb: data.fileProbe?.sizeBytes ? (data.fileProbe.sizeBytes / 1024 / 1024).toFixed(1) : null,
    url,
    frozen,
    montageLoop,
    blackFrames,
    grayFrames,
    frames,
    issues,
    pass,
  };

  const outPath = path.join(root, `tmp-qa-v${data.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const arg = process.argv[2];
let videoId = parseInt(arg, 10);
const timedRun = arg === "--start" || arg === "--timed";

if (arg === "--start" || arg === "--timed" || Number.isNaN(videoId)) {
  const t0 = Date.now();
  const start = await startVideo();
  videoId = start.videoId;
  console.log("Started video", videoId);
  if (!videoId) process.exit(1);
  const done = await pollUntilDone(videoId);
  const elapsedSec = Math.round((Date.now() - t0) / 1000);
  const report = qaReport(done);
  report.elapsedSec = elapsedSec;
  report.elapsedMin = (elapsedSec / 60).toFixed(1);
  console.log(`Generation time: ${report.elapsedMin} min (${elapsedSec}s)`);
  fs.writeFileSync(path.join(root, `tmp-qa-v${videoId}.json`), JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 1);
} else {
  const data = await fetchVideo(videoId);
  if (data.status !== "completed" && data.status !== "failed") {
    const done = await pollUntilDone(videoId);
    const report = qaReport(done);
    process.exit(report.pass ? 0 : 1);
  } else {
    const report = qaReport(data);
    process.exit(report.pass ? 0 : 1);
  }
}
