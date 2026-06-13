/**
 * Tracks archive assets used in recent videos so the next generation picks different footage.
 * Persisted to disk (survives restarts on Railway volume / local uploads dir).
 */
import * as fs from "fs";
import * as path from "path";
import { LOCAL_UPLOADS_DIR } from "./storageLocal";
import { archiveCrossVideoCooldownVideos } from "./sourcingPolicy";

type UsageEntry = {
  videoId: number;
  topicKey: string;
  assetIds: number[];
  at: number;
};

const STORE_PATH = path.join(LOCAL_UPLOADS_DIR, ".archive-recent-usage.json");
const MAX_ENTRIES = 40;

let entries: UsageEntry[] = [];
let loaded = false;

function loadStore(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as UsageEntry[];
      if (Array.isArray(raw)) entries = raw.slice(-MAX_ENTRIES);
    }
  } catch {
    entries = [];
  }
}

function persistStore(): void {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    /* non-fatal */
  }
}

/** Normalize topic so similar prompts share a cooldown bucket (e.g. Hitler docs). */
export function normalizeArchiveTopicKey(topic: string): string {
  const t = topic.toLowerCase();
  const buckets: Array<[RegExp, string]> = [
    [/hitler|third reich|nazi|nsdap|führer|fuhrer/, "hitler"],
    [/world war|ww2|wwii|1939|1945/, "ww2"],
    [/titanic|maritime|ship/, "maritime"],
    [/musk|tesla|spacex|elon/, "musk"],
  ];
  for (const [re, key] of buckets) {
    if (re.test(t)) return key;
  }
  const words = t
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 4);
  return words.join("_") || "general";
}

export function recordArchiveVideoUsage(
  videoId: number,
  assetIds: Iterable<number>,
  topic: string
): void {
  loadStore();
  const ids = [...new Set(assetIds)].filter((id) => id > 0);
  if (!ids.length) return;
  entries = entries.filter((e) => e.videoId !== videoId);
  entries.push({
    videoId,
    topicKey: normalizeArchiveTopicKey(topic),
    assetIds: ids,
    at: Date.now(),
  });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  persistStore();
  console.log(
    `[ArchiveVariety] Recorded ${ids.length} asset(s) for video ${videoId} topic="${normalizeArchiveTopicKey(topic)}"`
  );
}

/** Asset IDs used in the last N videos on the same topic (excluding current video). */
export function getCrossVideoExcludeAssetIds(
  topic: string,
  currentVideoId: number,
  lastVideos = archiveCrossVideoCooldownVideos()
): Set<number> {
  loadStore();
  const key = normalizeArchiveTopicKey(topic);
  const ids = new Set<number>();
  let matchedVideos = 0;
  for (let i = entries.length - 1; i >= 0 && matchedVideos < lastVideos; i--) {
    const e = entries[i]!;
    if (e.videoId === currentVideoId) continue;
    if (e.topicKey !== key) continue;
    matchedVideos++;
    for (const id of e.assetIds) ids.add(id);
  }
  return ids;
}

/** Seeded shuffle for stable but varied ordering within a score band. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  if (items.length <= 1) return items;
  const out = [...items];
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
