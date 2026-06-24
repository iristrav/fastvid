/**
 * Visual dedup for archive clips — skip near-identical frames during upload and cleanup.
 */
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { withForkRetry } from "./_core/execForkRetry";
import type { VideoClipSegment } from "./archiveVideoSplitter";
import { LOCAL_UPLOADS_DIR, resolveLocalVideoPath } from "./storageLocal";

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}

export function dHashFromGray8x8(gray: Buffer): bigint {
  if (gray.length < 64) return 0n;
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 7; x++) {
      const i = y * 8 + x;
      hash <<= 1n;
      if (gray[i]! < gray[i + 1]!) hash |= 1n;
    }
  }
  return hash;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export function isNearDuplicateHash(a: bigint, b: bigint, maxDistance = defaultMaxHamming()): boolean {
  if (a === b) return true;
  if (a === 0n || b === 0n) return false;
  return hammingDistance(a, b) <= maxDistance;
}

export function defaultMaxHamming(): number {
  const raw = process.env.ARCHIVE_DEDUP_HAMMING?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0 && n <= 24) return n;
  }
  return 8;
}

async function extractGray8x8FromFile(
  filePath: string,
  seekSec?: number
): Promise<Buffer | null> {
  if (!fs.existsSync(filePath)) return null;
  const args = seekSec != null && seekSec >= 0
    ? ["-y", "-ss", seekSec.toFixed(3), "-i", filePath, "-frames:v", "1", "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "-"]
    : ["-y", "-i", filePath, "-frames:v", "1", "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "-"];

  try {
    const raw = await withForkRetry(() => new Promise<Buffer>((resolve, reject) => {
      const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        reject(new Error("frame timeout"));
      }, 12_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        if (code === 0 && buf.length >= 64) resolve(buf.subarray(0, 64));
        else reject(new Error(stderr.slice(-100) || `ffmpeg exit ${code}`));
      });
      child.on("error", reject);
    }));
    return raw;
  } catch {
    return null;
  }
}

function seekPointsForDuration(durationSec?: number | null): number[] {
  if (durationSec != null && durationSec > 0.8) {
    if (durationSec <= 1.5) return [durationSec * 0.35, durationSec * 0.65];
    return [durationSec * 0.25, durationSec * 0.5, durationSec * 0.75];
  }
  return [0.35];
}

function seeksForFingerprint(durationSec?: number | null, fast = false): number[] {
  if (fast) {
    if (durationSec != null && durationSec > 0.8) return [durationSec * 0.35];
    return [0.35];
  }
  return seekPointsForDuration(durationSec);
}

function dedupeFingerprintConcurrency(): number {
  const raw = process.env.ARCHIVE_DEDUP_CONCURRENCY?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 12) return n;
  }
  return 6;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return out;
}

function fragmentsAreRedundant(a: ParsedArchiveFragment, b: ParsedArchiveFragment): boolean {
  if (a.sourceKey !== b.sourceKey) return false;
  if (a.startSec === b.startSec && a.endSec === b.endSec) return true;
  return (
    rangesOverlapRatio(
      { startSec: a.startSec, endSec: a.endSec },
      { startSec: b.startSec, endSec: b.endSec }
    ) >= 0.85
  );
}

function exactSampleKey(localPath: string): string | null {
  try {
    const stat = fs.statSync(localPath);
    const sampleLen = Math.min(stat.size, 96_000);
    const sample = Buffer.alloc(sampleLen);
    const fd = fs.openSync(localPath, "r");
    try {
      fs.readSync(fd, sample, 0, sampleLen, 0);
    } finally {
      fs.closeSync(fd);
    }
    return exactBufferKey(sample);
  } catch {
    return null;
  }
}

export async function fingerprintMediaFile(
  filePath: string,
  opts?: { seekSec?: number; mimeType?: string; durationSec?: number | null }
): Promise<bigint | null> {
  const hashes = await fingerprintMediaFileMulti(filePath, opts);
  return hashes?.[0] ?? null;
}

export async function fingerprintMediaFileMulti(
  filePath: string,
  opts?: { seekSec?: number; mimeType?: string; durationSec?: number | null; fast?: boolean }
): Promise<bigint[] | null> {
  const mime = opts?.mimeType ?? "";
  if (mime.startsWith("image/") || /\.(jpe?g|png|webp|gif)$/i.test(filePath)) {
    const gray = await extractGray8x8FromFile(filePath);
    return gray ? [dHashFromGray8x8(gray)] : null;
  }

  const seeks =
    opts?.seekSec != null
      ? [opts.seekSec]
      : seeksForFingerprint(opts?.durationSec, opts?.fast);
  const hashes: bigint[] = [];
  for (const seek of seeks) {
    const gray = await extractGray8x8FromFile(filePath, seek);
    if (gray) hashes.push(dHashFromGray8x8(gray));
  }
  return hashes.length > 0 ? hashes : null;
}

export function isNearDuplicateFingerprint(
  a: bigint[],
  b: bigint[],
  maxDistance = defaultMaxHamming()
): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length === 1 && b.length === 1) return isNearDuplicateHash(a[0], b[0], maxDistance);

  let matches = 0;
  for (const ha of a) {
    if (b.some((hb) => isNearDuplicateHash(ha, hb, maxDistance))) matches += 1;
  }
  const needed = Math.max(1, Math.ceil((Math.min(a.length, b.length) * 2) / 3));
  return matches >= needed;
}

export async function fingerprintVideoBuffer(
  buffer: Buffer,
  mimeType: string,
  durationSec?: number
): Promise<bigint[] | null> {
  if (buffer.length < 800) return null;
  const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("mov") ? "mov" : "mp4";
  const tempPath = path.join(
    os.tmpdir(),
    `archive-fp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  );
  try {
    fs.writeFileSync(tempPath, buffer);
    return await fingerprintMediaFileMulti(tempPath, { durationSec, mimeType });
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  }
}

export function exactBufferKey(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 24);
}

export type ParsedArchiveFragment = {
  sourceKey: string;
  startSec: number;
  endSec: number;
};

/** Parse "Fragment uit file.mp4 (16:54–16:55)" from sourceNote. */
export function parseArchiveFragmentNote(note: string | null | undefined): ParsedArchiveFragment | null {
  if (!note?.trim()) return null;
  const m = note.trim().match(
    /^Fragment uit (.+?) \((\d+):(\d{2})[–-](\d+):(\d{2})\)$/
  );
  if (!m) return null;
  const startSec = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  const endSec = parseInt(m[4], 10) * 60 + parseInt(m[5], 10);
  if (endSec <= startSec) return null;
  return { sourceKey: m[1].trim().toLowerCase(), startSec, endSec };
}

function isAdjacentSameSourceFragment(
  kept: ParsedArchiveFragment,
  candidate: ParsedArchiveFragment,
  maxGapSec = 2.5
): boolean {
  if (kept.sourceKey !== candidate.sourceKey) return false;
  const gap = Math.min(
    Math.abs(candidate.startSec - kept.endSec),
    Math.abs(kept.startSec - candidate.endSec),
    Math.abs(candidate.startSec - kept.startSec)
  );
  return gap <= maxGapSec;
}

function rangesOverlapRatio(
  a: { startSec: number; endSec: number },
  b: { startSec: number; endSec: number }
): number {
  const overlap = Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec);
  if (overlap <= 0) return 0;
  const minDur = Math.min(a.endSec - a.startSec, b.endSec - b.startSec);
  return minDur > 0 ? overlap / minDur : 0;
}

export type ArchiveFingerprintEntry = {
  fp: bigint[];
  fragment: ParsedArchiveFragment | null;
  exactKey?: string;
};

/** Fingerprints of clips already stored in an archive (for upload dedup). */
export async function buildArchiveFingerprintIndex(
  assets: Array<{
    sourceNote?: string | null;
    storageUrl: string;
    storageKey: string | null;
    mimeType: string | null;
    mediaType: "video" | "image";
    durationSec: number | null;
  }>
): Promise<ArchiveFingerprintEntry[]> {
  const fast = assets.length > 12;
  const entries: ArchiveFingerprintEntry[] = [];
  const candidates = assets
    .map((asset) => ({ asset, local: resolveArchiveAssetPath(asset) }))
    .filter((row): row is { asset: (typeof assets)[0]; local: string } => Boolean(row.local));

  const rows = await mapWithConcurrency(candidates, dedupeFingerprintConcurrency(), async ({ asset, local }) => {
    try {
      const mime =
        asset.mimeType ?? (asset.mediaType === "image" ? "image/jpeg" : "video/mp4");
      const fp = await fingerprintMediaFileMulti(local, {
        durationSec: asset.durationSec,
        mimeType: mime,
        fast,
      });
      if (fp == null) return null;
      return {
        fp,
        fragment: parseArchiveFragmentNote(asset.sourceNote),
      } satisfies ArchiveFingerprintEntry;
    } catch {
      return null;
    }
  });

  for (const row of rows) {
    if (row) entries.push(row);
  }
  return entries;
}

function segmentMatchesArchiveIndex(
  seg: VideoClipSegment,
  exactKey: string,
  fp: bigint[] | null,
  fragment: ParsedArchiveFragment | null,
  index: ArchiveFingerprintEntry[],
  maxDist: number
): boolean {
  for (const entry of index) {
    if (entry.exactKey === exactKey) return true;
    if (fp != null && entry.fp.length > 0 && isNearDuplicateFingerprint(entry.fp, fp, maxDist)) {
      return true;
    }
    if (
      fragment != null &&
      entry.fragment != null &&
      fp != null &&
      entry.fp.length > 0 &&
      isAdjacentSameSourceFragment(entry.fragment, fragment, 4) &&
      isNearDuplicateFingerprint(entry.fp, fp, maxDist + 1)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Drop clips that duplicate existing archive entries or earlier clips in this upload batch.
 */
export async function dedupeSegmentsForArchiveUpload(
  segments: VideoClipSegment[],
  existingIndex: ArchiveFingerprintEntry[],
  parentSource?: string | null
): Promise<{ kept: VideoClipSegment[]; skipped: number }> {
  const maxDist = defaultMaxHamming();
  const index: ArchiveFingerprintEntry[] = [...existingIndex];
  const kept: VideoClipSegment[] = [];
  let skipped = 0;

  for (const seg of segments) {
    const exactKey = exactBufferKey(seg.buffer);
    const fragment = parentSource
      ? {
          sourceKey: parentSource.trim().toLowerCase(),
          startSec: seg.startSec,
          endSec: seg.endSec,
        }
      : null;

    const overlapsKept = kept.some((k) => rangesOverlapRatio(seg, k) >= 0.65);
    if (overlapsKept) {
      skipped += 1;
      continue;
    }

    const fp = await fingerprintVideoBuffer(seg.buffer, "video/mp4", seg.durationSec);

    if (segmentMatchesArchiveIndex(seg, exactKey, fp, fragment, index, maxDist)) {
      skipped += 1;
      console.log(
        `[ArchiveDedup] skip duplicate upload clip ${seg.index + 1} ` +
          `(${seg.startSec.toFixed(1)}–${seg.endSec.toFixed(1)}s)`
      );
      continue;
    }

    if (fp != null) {
      index.push({ fp, fragment, exactKey });
    }
    kept.push({ ...seg, index: kept.length });
  }

  if (skipped > 0) {
    console.log(`[ArchiveDedup] upload filter: ${skipped} duplicate(s) skipped, ${kept.length} unique`);
  }
  return { kept, skipped };
}

/** Drop visually near-duplicate segments from a split batch (keeps first occurrence). */
export async function dedupeVideoSegmentsVisually(
  segments: VideoClipSegment[]
): Promise<{ kept: VideoClipSegment[]; skipped: number }> {
  const maxDist = defaultMaxHamming();
  const kept: VideoClipSegment[] = [];
  const fingerprints: bigint[][] = [];
  const exactKeys = new Set<string>();
  let skipped = 0;

  for (const seg of segments) {
    const exact = exactBufferKey(seg.buffer);
    if (exactKeys.has(exact)) {
      skipped += 1;
      continue;
    }

    const overlapsKept = kept.some((k) => rangesOverlapRatio(seg, k) >= 0.65);
    if (overlapsKept) {
      skipped += 1;
      continue;
    }

    const fp = await fingerprintVideoBuffer(seg.buffer, "video/mp4", seg.durationSec);
    if (fp != null) {
      const dup = fingerprints.some((existing) => isNearDuplicateFingerprint(existing, fp, maxDist));
      if (dup) {
        skipped += 1;
        console.log(
          `[ArchiveDedup] skip visually duplicate clip ${seg.index + 1} (${seg.startSec.toFixed(1)}–${seg.endSec.toFixed(1)}s)`
        );
        continue;
      }
      fingerprints.push(fp);
    }

    exactKeys.add(exact);
    kept.push({ ...seg, index: kept.length });
  }

  if (skipped > 0) {
    console.log(`[ArchiveDedup] removed ${skipped} duplicate clip(s), kept ${kept.length}`);
  }
  return { kept, skipped };
}

export type ArchiveVisualDedupeResult = {
  scanned: number;
  deleted: number;
  kept: number;
};

function resolveArchiveAssetPath(asset: {
  storageUrl: string;
  storageKey: string | null;
}): string | null {
  const fromUrl = resolveLocalVideoPath(asset.storageUrl);
  if (fromUrl) return fromUrl;
  if (asset.storageKey) {
    const fromKey = path.join(LOCAL_UPLOADS_DIR, asset.storageKey.replace(/\//g, "_"));
    if (fs.existsSync(fromKey)) return fromKey;
  }
  if (asset.storageUrl.startsWith("/local-storage/")) {
    const fileName = asset.storageUrl.replace(/^\/local-storage\//, "");
    const p = path.join(LOCAL_UPLOADS_DIR, fileName);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Remove visually duplicate clips already stored in an archive (keeps oldest id per group). */
export async function dedupeArchiveVisualDuplicates(
  assets: Array<{
    id: number;
    title?: string | null;
    sourceNote?: string | null;
    storageUrl: string;
    storageKey: string | null;
    mimeType: string | null;
    mediaType: "video" | "image";
    durationSec: number | null;
  }>
): Promise<{ deleteIds: number[]; scanned: number; metadataDeleted: number }> {
  const maxDist = defaultMaxHamming();
  const sorted = [...assets].sort((a, b) => a.id - b.id);
  const deleteIds: number[] = [];
  const deleteSet = new Set<number>();
  let metadataDeleted = 0;

  const keptFragments: ParsedArchiveFragment[] = [];
  for (const asset of sorted) {
    const fragment = parseArchiveFragmentNote(asset.sourceNote);
    if (!fragment) continue;
    const redundant = keptFragments.some((f) => fragmentsAreRedundant(f, fragment));
    if (redundant) {
      deleteIds.push(asset.id);
      deleteSet.add(asset.id);
      metadataDeleted += 1;
      continue;
    }
    keptFragments.push(fragment);
  }

  const remaining = sorted.filter((a) => !deleteSet.has(a.id));
  const candidates = remaining
    .map((asset) => ({ asset, local: resolveArchiveAssetPath(asset) }))
    .filter((row): row is { asset: (typeof assets)[0]; local: string } => Boolean(row.local));

  type FpRow = {
    id: number;
    fp: bigint[] | null;
    fragment: ParsedArchiveFragment | null;
    exact: string | null;
  };

  const fpRows = await mapWithConcurrency(candidates, dedupeFingerprintConcurrency(), async ({ asset, local }) => {
    const mime =
      asset.mimeType ?? (asset.mediaType === "image" ? "image/jpeg" : "video/mp4");
    const fp = await fingerprintMediaFileMulti(local, {
      durationSec: asset.durationSec,
      mimeType: mime,
      fast: true,
    });
    return {
      id: asset.id,
      fp,
      fragment: parseArchiveFragmentNote(asset.sourceNote),
      exact: exactSampleKey(local),
    } satisfies FpRow;
  });

  const keptEntries: Array<{ fp: bigint[]; fragment: ParsedArchiveFragment | null }> = [];
  const keptExact = new Set<string>();

  for (const row of fpRows.sort((a, b) => a.id - b.id)) {
    if (deleteSet.has(row.id)) continue;

    if (row.exact && keptExact.has(row.exact)) {
      deleteIds.push(row.id);
      deleteSet.add(row.id);
      continue;
    }

    const visualDup =
      row.fp != null &&
      keptEntries.some((entry) => isNearDuplicateFingerprint(entry.fp, row.fp!, maxDist));

    const adjacentDup =
      row.fragment != null &&
      row.fp != null &&
      keptEntries.some(
        (entry) =>
          entry.fragment != null &&
          isAdjacentSameSourceFragment(entry.fragment, row.fragment!) &&
          isNearDuplicateFingerprint(entry.fp, row.fp!, maxDist + 2)
      );

    if (visualDup || adjacentDup) {
      deleteIds.push(row.id);
      deleteSet.add(row.id);
      continue;
    }

    if (row.exact) keptExact.add(row.exact);
    if (row.fp != null) keptEntries.push({ fp: row.fp, fragment: row.fragment });
  }

  return { deleteIds, scanned: assets.length, metadataDeleted };
}
