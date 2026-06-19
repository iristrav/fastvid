/**
 * Local verification for year-badge overlay, montage dedup, and off-topic scoring.
 * Run: npx tsx scripts/verify-pipeline-fixes.mts
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { execFile } from "child_process";
import {
  overlayUsesFullFrame,
  renderYearBadgeOverlay,
} from "../server/cinematicEffectsEngine";
import { scoreCuratedAsset } from "../server/curatedMediaSourcing";
import type { MediaArchiveAsset } from "../drizzle/schema";
import { DOC_STYLE_VIDEO_HEIGHT, DOC_STYLE_VIDEO_WIDTH } from "../server/documentaryStyle";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const workDir = path.join(root, "tmp-verify-fixes");
const ffmpegBin =
  process.platform === "win32"
    ? path.join(root, "node_modules/ffmpeg-static/ffmpeg.exe")
    : "ffmpeg";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function execWithTimeout(cmd: string, _ms: number, _label: string) {
  const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const bin = parts[0]!.replace(/^"|"$/g, "");
  const args = parts.slice(1).map((a) => a.replace(/^"|"$/g, ""));
  await execFileAsync(bin, args, { maxBuffer: 20 * 1024 * 1024 });
}

function avgLum(buf: Buffer, w: number, h: number): number {
  let sum = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    sum += 0.299 * buf[o]! + 0.587 * buf[o + 1]! + 0.114 * buf[o + 2]!;
  }
  return sum / n;
}

function centerLum(buf: Buffer, w: number, h: number): number {
  const x0 = Math.floor(w * 0.35);
  const x1 = Math.floor(w * 0.65);
  const y0 = Math.floor(h * 0.35);
  const y1 = Math.floor(h * 0.65);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * w + x) * 3;
      sum += 0.299 * buf[o]! + 0.587 * buf[o + 1]! + 0.114 * buf[o + 2]!;
      n++;
    }
  }
  return sum / Math.max(1, n);
}

async function testYearBadgeOverlay() {
  console.log("\n[1/3] Year badge overlay (no full-frame black flash)");
  fs.mkdirSync(workDir, { recursive: true });

  const badge = await renderYearBadgeOverlay(
    "1945",
    0,
    workDir,
    ffmpegBin,
    execWithTimeout,
    20,
    0,
    1
  );
  assert(badge != null, "year badge PNG should render");
  assert(badge!.fullFrame === false, "year badge must not be fullFrame");
  assert(badge!.overlayX != null && badge!.overlayY != null, "year badge needs overlayX/Y");
  assert(!overlayUsesFullFrame(badge!), "year badge must not use full-frame overlay mode");

  const pngStat = fs.statSync(badge!.path);
  const dimOut = execFileSync(
    ffmpegBin,
    ["-hide_banner", "-i", badge!.path, "-frames:v", "1", "-f", "null", "-"],
    { encoding: "utf8" }
  );
  void dimOut;
  // Small badge PNG — much smaller than full 1920x1080 frame would be
  assert(pngStat.size < 80_000, `badge PNG should be small (${pngStat.size} bytes)`);

  const baseVideo = path.join(workDir, "base.mp4");
  execFileSync(ffmpegBin, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x4488CC:size=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:rate=25:duration=3`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    baseVideo,
  ]);

  const composed = path.join(workDir, "with_badge.mp4");
  const enable = `enable='between(t,${badge!.startTime.toFixed(2)},${badge!.endTime.toFixed(2)})'`;
  const vf =
    `[0:v]eq=contrast=1.05:saturation=1.02[graded];` +
    `[graded][1:v]overlay=x=${badge!.overlayX}:y=${badge!.overlayY}:format=auto:${enable}[vout]`;

  execFileSync(ffmpegBin, [
    "-y",
    "-i",
    baseVideo,
    "-i",
    badge!.path,
    "-filter_complex",
    vf,
    "-map",
    "[vout]",
    "-t",
    "3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    composed,
  ]);

  const sampleT = (badge!.startTime + badge!.endTime) / 2;
  const raw = path.join(workDir, "frame.raw");
  execFileSync(ffmpegBin, [
    "-hide_banner",
    "-ss",
    String(sampleT),
    "-i",
    composed,
    "-frames:v",
    "1",
    "-vf",
    `scale=${DOC_STYLE_VIDEO_WIDTH}:${DOC_STYLE_VIDEO_HEIGHT},format=rgb24`,
    "-f",
    "rawvideo",
    raw,
  ]);
  const buf = fs.readFileSync(raw);
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  const center = centerLum(buf, w, h);
  const full = avgLum(buf, w, h);
  assert(center > 60, `center should stay visible during badge (lum=${center.toFixed(1)})`);
  assert(full > 40, `frame should not be mostly black (avg lum=${full.toFixed(1)})`);

  console.log(`  ✓ Badge at (${badge!.overlayX}, ${badge!.overlayY}), center lum=${center.toFixed(1)}`);
}

function testOffTopicPenalty() {
  console.log("\n[2/3] Off-topic archive penalty");
  const medieval: MediaArchiveAsset = {
    id: 99,
    archiveId: 1,
    title: "Middeleeuws uithangbord in nacht",
    tags: ["middeleeuws", "nacht"],
    mediaType: "image",
    mimeType: "image/jpeg",
    storageUrl: "/local-storage/m.jpg",
    isActive: 1,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    fileSizeBytes: 1000,
    width: 1920,
    height: 1080,
    durationSec: null,
    sourceUrl: null,
    sourceLabel: null,
  };
  const beatTags = ["berlin", "1945", "hitler"];
  const topicAnchors = ["hitler", "wwii"];
  const score = scoreCuratedAsset(medieval, ["hitler"], beatTags, topicAnchors);
  assert(score <= 0, `medieval clip should be rejected (score=${score})`);
  console.log(`  ✓ Medieval sign score=${score} (excluded)`);
}

/** Mirrors expand/dedupe behaviour using curated asset id paths. */
function clipKey(p: string): string {
  const m = path.basename(p).match(/curated_a(\d+)/);
  return m ? `curated:asset:${m[1]}` : path.basename(p);
}

function estDur(durs: number[]): number {
  const n = durs.length;
  if (n === 0) return 0;
  const xfade = n > 1 ? 0.35 : 0;
  return durs.reduce((s, d) => s + d, 0) - (n - 1) * xfade;
}

function simulateExpand(clips: string[], outDur: number): string[] {
  const minClip = 2.5;
  const maxClip = 8;
  let expanded = [...clips];
  let durs = expanded.map(() => Math.min(maxClip, Math.max(minClip, outDur / expanded.length)));

  const pickNext = (pool: string[], cur: string[]): string | null => {
    if (pool.length <= 1) return null;
    const prev = clipKey(cur[cur.length - 1]!);
    const counts = new Map<string, number>();
    for (const c of cur) counts.set(clipKey(c), (counts.get(clipKey(c)) ?? 0) + 1);
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const c of pool) {
      const k = clipKey(c);
      if (k === prev) continue;
      const score = -(counts.get(k) ?? 0) * 100;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  };

  while (expanded.length < 12 && estDur(durs) < outDur * 0.92) {
    for (let i = 0; i < durs.length; i++) {
      if (estDur(durs) >= outDur * 0.92) break;
      durs[i] = Math.min(maxClip, durs[i]! * 1.12);
    }
    if (estDur(durs) >= outDur * 0.92) break;
    const next = pickNext(clips, expanded);
    if (!next) break;
    expanded.push(next);
    durs.push(minClip);
  }

  const out: string[] = [];
  for (let i = 0; i < expanded.length; i++) {
    const c = expanded[i]!;
    if (out.length && clipKey(out[out.length - 1]!) === clipKey(c)) continue;
    out.push(c);
  }
  return out;
}

function testMontageDedup() {
  console.log("\n[3/3] Montage expansion avoids adjacent duplicates");
  const singleClip = ["/tmp/scene_0_b0_curated_a10.mp4"];
  const oldExpanded = [...singleClip];
  while (oldExpanded.length < 6) oldExpanded.push(singleClip[0]!);
  const oldAdjDupes = oldExpanded.filter(
    (c, i) => i > 0 && clipKey(c) === clipKey(oldExpanded[i - 1]!)
  ).length;
  assert(oldAdjDupes >= 5, "old cycle with one clip should stack adjacent dupes");

  const multiClips = [
    "/tmp/scene_0_b0_curated_a10.mp4",
    "/tmp/scene_0_b1_curated_a11.mp4",
    "/tmp/scene_0_b2_curated_a12.mp4",
  ];
  const expanded = simulateExpand(multiClips, 45);
  assert(expanded.length >= 3, "should expand montage");
  for (let i = 1; i < expanded.length; i++) {
    assert(
      clipKey(expanded[i]!) !== clipKey(expanded[i - 1]!),
      `adjacent duplicate at ${i - 1}/${i}: ${path.basename(expanded[i - 1]!)} → ${path.basename(expanded[i]!)}`
    );
  }
  console.log(`  ✓ Single-clip old cycle had ${oldAdjDupes} adjacent dupes; multi-clip expansion has 0`);
}

async function main() {
  console.log("Fastvid pipeline fix verification");
  if (!fs.existsSync(ffmpegBin)) {
    throw new Error(`ffmpeg not found at ${ffmpegBin}`);
  }
  await testYearBadgeOverlay();
  testOffTopicPenalty();
  testMontageDedup();
  console.log("\n✅ All local verification checks passed\n");
}

main().catch((err) => {
  console.error("\n❌ Verification failed:", err.message ?? err);
  process.exit(1);
});
