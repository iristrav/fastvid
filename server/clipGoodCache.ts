/**
 * Local cache of successfully adopted clips — boosts future archive ranking (zero API cost).
 */
import fs from "fs";
import path from "path";
import { LOCAL_UPLOADS_DIR } from "./storageLocal";
import type { ClipAdoptEntry } from "./clipAdoptAudit";

type GoodCacheAsset = {
  id: number;
  storageUrl?: string | null;
  tags?: string[] | null;
};

export type GoodClipRecord = {
  basename: string;
  assetId?: number;
  source: string;
  beatText: string;
  segmentGeoLock?: string | null;
  adoptedAt: string;
  adoptCount: number;
};

const MAX_RECORDS = 400;

function cachePath(): string {
  const dir = path.join(LOCAL_UPLOADS_DIR, "clip-good-cache");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "good-clips.json");
}

function loadRecords(): GoodClipRecord[] {
  const p = cachePath();
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as GoodClipRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecords(records: GoodClipRecord[]): void {
  fs.writeFileSync(cachePath(), JSON.stringify(records.slice(0, MAX_RECORDS), null, 0), "utf8");
}

export function clipGoodCacheEnabled(): boolean {
  return process.env.ENABLE_CLIP_GOOD_CACHE !== "false";
}

/** Persist a successfully adopted clip for future ranking boost. */
export function recordGoodClipAdoption(entry: ClipAdoptEntry, assetId?: number): void {
  if (!clipGoodCacheEnabled()) return;
  const records = loadRecords();
  const basename = entry.basename.toLowerCase();
  const existing = records.find((r) => r.basename === basename);
  if (existing) {
    existing.adoptCount += 1;
    existing.adoptedAt = new Date().toISOString();
    if (assetId) existing.assetId = assetId;
  } else {
    records.unshift({
      basename,
      assetId,
      source: entry.source,
      beatText: entry.beatText.slice(0, 200),
      segmentGeoLock: entry.segmentGeoLock,
      adoptedAt: new Date().toISOString(),
      adoptCount: 1,
    });
  }
  saveRecords(records.slice(0, MAX_RECORDS));
}

/** Score boost 0–18 for archive assets previously adopted with good results. */
export function goodClipCacheBoost(asset: GoodCacheAsset, beatText: string): number {
  if (!clipGoodCacheEnabled()) return 0;
  const records = loadRecords();
  if (records.length === 0) return 0;

  const assetBasename = (asset.storageUrl ?? "").split("/").pop()?.toLowerCase() ?? "";
  const beatLower = beatText.toLowerCase();

  let boost = 0;
  for (const rec of records) {
    if (rec.assetId === asset.id) {
      boost = Math.max(boost, 12 + Math.min(6, rec.adoptCount));
      continue;
    }
    if (assetBasename && rec.basename && assetBasename.includes(rec.basename.replace(/\.[^.]+$/, ""))) {
      boost = Math.max(boost, 8 + Math.min(4, rec.adoptCount));
    }
    const sharedWords = rec.beatText
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 5 && beatLower.includes(w));
    if (sharedWords.length >= 2) {
      boost = Math.max(boost, 4 + Math.min(3, rec.adoptCount));
    }
  }
  return boost;
}

export function listGoodClipCache(limit = 20): GoodClipRecord[] {
  return loadRecords().slice(0, limit);
}
