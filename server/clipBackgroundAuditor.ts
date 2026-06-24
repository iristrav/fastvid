/**
 * Background clip auditor — proactively checks archive clips against their tags/title.
 * Runs on worker startup + periodic batches; results cached on disk for ranking.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { getMediaArchiveAssetById, getAllMediaArchives, getMediaArchiveAssets, normalizeMediaTags } from "./db";
import { LOCAL_UPLOADS_DIR, resolveLocalVideoPath } from "./storageLocal";
import {
  embedTextQuery,
  extractFrameAtFraction,
  localVisionEnabled,
  probeImageMeanLuma,
  scoreEmbeddingSimilarity,
} from "./localClipVision";
import {
  indexArchiveClipEmbedding,
  loadStoredClipEmbedding,
  loadStoredFrameEmbeddings,
} from "./archiveClipEmbedding";

export type StoredClipAudit = {
  assetId: number;
  tagMatchScore: number;
  qualityScore: number;
  lumaMin: number | null;
  lumaOk: boolean;
  pass: boolean;
  issues: string[];
  auditedAt: string;
};

function auditDir(): string {
  const dir = path.join(LOCAL_UPLOADS_DIR, "archive-clip-audits");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function auditPath(assetId: number): string {
  return path.join(auditDir(), `${assetId}.json`);
}

export function clipAuditorEnabled(): boolean {
  if (!localVisionEnabled()) return false;
  return process.env.ENABLE_CLIP_BACKGROUND_AUDITOR !== "false";
}

export function auditorBatchSize(): number {
  const raw = process.env.CLIP_AUDITOR_BATCH_SIZE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 100) return n;
  }
  return 15;
}

export function auditorIntervalMs(): number {
  const raw = process.env.CLIP_AUDITOR_INTERVAL_MIN?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5 && n <= 240) return n * 60_000;
  }
  return 20 * 60_000;
}

export function resolveArchiveAssetLocalPath(asset: {
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

export function loadStoredClipAudit(assetId: number): StoredClipAudit | null {
  if (!clipAuditorEnabled()) return null;
  const p = auditPath(assetId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as StoredClipAudit;
  } catch {
    return null;
  }
}

function saveClipAudit(audit: StoredClipAudit): void {
  fs.writeFileSync(auditPath(audit.assetId), JSON.stringify(audit), "utf8");
}

function buildAssetVisualQuery(asset: {
  title?: string | null;
  tags?: string[] | null;
  sourceNote?: string | null;
}): string {
  const tags = normalizeMediaTags(asset.tags ?? []);
  return [asset.title?.trim(), ...tags, asset.sourceNote?.trim()]
    .filter((p): p is string => Boolean(p && p.length >= 2))
    .join(". ")
    .slice(0, 400);
}

function minTagMatchScore(): number {
  const raw = process.env.CLIP_AUDITOR_MIN_TAG_SCORE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 3 && n <= 9) return n;
  }
  return 5;
}

/** Score adjustment from a prior background audit (0 if no audit yet). */
export function applyBackgroundClipAuditScore(assetId: number): number {
  const audit = loadStoredClipAudit(assetId);
  if (!audit) return 0;
  if (!audit.pass) return -120;
  if (audit.qualityScore >= 8) return 14;
  if (audit.qualityScore >= 6) return 5;
  return -25;
}

/** Audit one archive video: CLIP(tags/title ↔ frames) + luma. */
export async function auditArchiveClip(
  assetId: number,
  localVideoPath: string,
  meta?: { title?: string | null; tags?: string[] | null; sourceNote?: string | null }
): Promise<StoredClipAudit | null> {
  if (!clipAuditorEnabled() || !fs.existsSync(localVideoPath)) return null;

  const assetMeta = meta ?? (await getMediaArchiveAssetById(assetId));
  const query = buildAssetVisualQuery(assetMeta ?? {});
  const issues: string[] = [];

  if (!query.trim()) {
    issues.push("missing_title_and_tags");
  }

  let frameEmbeddings = loadStoredFrameEmbeddings(assetId);
  if (frameEmbeddings.length === 0) {
    await indexArchiveClipEmbedding(assetId, localVideoPath);
    frameEmbeddings = loadStoredFrameEmbeddings(assetId);
  }

  const workDir = path.join(os.tmpdir(), `fv_audit_${assetId}`);
  let tagMatchScore = 0;
  let lumaMin: number | null = null;

  try {
    fs.mkdirSync(workDir, { recursive: true });

    if (query.trim() && frameEmbeddings.length > 0) {
      const queryEmb = await embedTextQuery(query);
      if (queryEmb) {
        let bestSim = 0;
        for (const emb of frameEmbeddings) {
          bestSim = Math.max(bestSim, scoreEmbeddingSimilarity(queryEmb, emb));
        }
        tagMatchScore = Math.max(0, Math.min(10, Math.round(bestSim * 40)));
      } else {
        issues.push("clip_model_unavailable");
      }
    } else if (frameEmbeddings.length === 0) {
      issues.push("no_frame_embeddings");
    }

    const lumaFrame = path.join(workDir, `luma.jpg`);
    if (await extractFrameAtFraction(localVideoPath, lumaFrame, 0.45)) {
      const luma = await probeImageMeanLuma(lumaFrame);
      if (luma !== null) {
        lumaMin = Math.round(luma);
        if (luma < 14) issues.push("too_dark");
        if (luma < 8) issues.push("near_black");
      }
      try { fs.unlinkSync(lumaFrame); } catch { /* ignore */ }
    } else {
      issues.push("frame_extract_failed");
    }
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const lumaOk = lumaMin === null || lumaMin >= 14;
  const tagOk = tagMatchScore >= minTagMatchScore() || !query.trim();
  const qualityScore = Math.round(tagMatchScore * 0.7 + (lumaOk ? 3 : 0));
  const pass = tagOk && lumaOk && !issues.includes("near_black");

  const audit: StoredClipAudit = {
    assetId,
    tagMatchScore,
    qualityScore,
    lumaMin,
    lumaOk,
    pass,
    issues,
    auditedAt: new Date().toISOString(),
  };
  saveClipAudit(audit);

  const status = pass ? "OK" : "FAIL";
  console.log(
    `[ClipAuditor] Asset ${assetId} ${status}: tag=${tagMatchScore}/10 luma=${lumaMin ?? "?"}` +
      (issues.length ? ` (${issues.join(", ")})` : "")
  );
  return audit;
}

function auditStale(audit: StoredClipAudit | null): boolean {
  if (!audit) return true;
  const ageMs = Date.now() - new Date(audit.auditedAt).getTime();
  return ageMs > 7 * 24 * 60 * 60_000;
}

/** Process a batch of archive videos missing or stale audits. */
export async function runClipAuditorBatch(
  maxAssets = auditorBatchSize()
): Promise<{ audited: number; skipped: number; failed: number }> {
  if (!clipAuditorEnabled()) return { audited: 0, skipped: 0, failed: 0 };
  const { workerLocalActiveJobs } = await import("./videoQueue");
  if (workerLocalActiveJobs() > 0) {
    return { audited: 0, skipped: 0, failed: 0 };
  }

  const archives = (await getAllMediaArchives()).filter((a) => a.isActive === 1);
  let audited = 0;
  let skipped = 0;
  let failed = 0;

  for (const archive of archives) {
    if (audited >= maxAssets) break;
    const assets = await getMediaArchiveAssets(archive.id);
    for (const asset of assets) {
      if (audited >= maxAssets) break;
      if (asset.mediaType !== "video") {
        skipped++;
        continue;
      }
      const existing = loadStoredClipAudit(asset.id);
      if (existing && !auditStale(existing)) {
        skipped++;
        continue;
      }
      const local = resolveArchiveAssetLocalPath(asset);
      if (!local) {
        skipped++;
        continue;
      }
      const result = await auditArchiveClip(asset.id, local, asset);
      if (result) audited++;
      else failed++;
    }
  }

  if (audited > 0) {
    console.log(`[ClipAuditor] Batch done: audited ${audited}, skipped ${skipped}, failed ${failed}`);
  }
  return { audited, skipped, failed };
}

/** Audit one asset after upload/index (non-blocking). */
export function scheduleAuditForAsset(assetId: number): void {
  if (!clipAuditorEnabled()) return;
  void (async () => {
    try {
      const asset = await getMediaArchiveAssetById(assetId);
      if (!asset || asset.mediaType !== "video") return;
      const local = resolveArchiveAssetLocalPath(asset);
      if (!local) return;
      if (!loadStoredClipEmbedding(assetId)) {
        await indexArchiveClipEmbedding(assetId, local);
      }
      await auditArchiveClip(assetId, local, asset);
    } catch (err) {
      console.warn(`[ClipAuditor] asset ${assetId}:`, (err as Error).message?.slice(0, 80));
    }
  })();
}

let auditorTimer: ReturnType<typeof setInterval> | null = null;

/** Start background auditor on worker — initial batch + periodic runs. */
export function startClipBackgroundAuditor(): void {
  if (!clipAuditorEnabled()) {
    console.log("[ClipAuditor] Disabled (ENABLE_CLIP_BACKGROUND_AUDITOR=false or local vision off)");
    return;
  }

  void (async () => {
    await new Promise((r) => setTimeout(r, 120_000));
    try {
      await runClipAuditorBatch();
    } catch (err) {
      console.warn("[ClipAuditor] Initial batch failed:", (err as Error).message?.slice(0, 100));
    }
  })();

  if (auditorTimer) clearInterval(auditorTimer);
  auditorTimer = setInterval(() => {
    void runClipAuditorBatch().catch((err) =>
      console.warn("[ClipAuditor] Periodic batch failed:", (err as Error).message?.slice(0, 100))
    );
  }, auditorIntervalMs());

  console.log(
    `[ClipAuditor] Background auditor active — batch ${auditorBatchSize()}, every ${auditorIntervalMs() / 60_000}min`
  );
}

export async function summarizeClipAuditor(videoAssetCount?: number): Promise<{
  enabled: boolean;
  totalAudited: number;
  passed: number;
  failed: number;
  pendingEstimate: number;
}> {
  if (!clipAuditorEnabled()) {
    return { enabled: false, totalAudited: 0, passed: 0, failed: 0, pendingEstimate: 0 };
  }

  const dir = auditDir();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  let passed = 0;
  let failed = 0;
  for (const f of files) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as StoredClipAudit;
      if (a.pass) passed++;
      else failed++;
    } catch {
      /* ignore */
    }
  }

  let videoCount = videoAssetCount;
  if (videoCount == null) {
    const { summarizeActiveArchiveCounts } = await import("./db");
    videoCount = (await summarizeActiveArchiveCounts()).videoAssets;
  }

  return {
    enabled: true,
    totalAudited: files.length,
    passed,
    failed,
    pendingEstimate: Math.max(0, videoCount - files.length),
  };
}
