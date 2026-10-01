/**
 * Local cache of successfully adopted clips — boosts future archive ranking (zero API cost).
 */
import fs from "fs";
import path from "path";
import { LOCAL_UPLOADS_DIR } from "./storageLocal";
import { foldSearchText } from "./searchTextNormalize";

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

export function clipGoodCacheEnabled(): boolean {
  return process.env.ENABLE_CLIP_GOOD_CACHE !== "false";
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
    // RONDE 88A: folded, and `beatLower` is folded to match. `\W` cut "Führerbunker" into "f"
    // and "hrerbunker", so the one word that made two beats about the same thing never counted.
    const sharedWords = foldSearchText(rec.beatText)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 5 && beatLower.includes(w));
    if (sharedWords.length >= 2) {
      boost = Math.max(boost, 4 + Math.min(3, rec.adoptCount));
    }
  }
  return boost;
}

