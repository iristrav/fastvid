/**
 * Tracks archive assets used in recent videos so the next generation picks different footage.
 * Persisted to disk (survives restarts on Railway volume / local uploads dir).
 */
import { foldSearchText } from "./searchTextNormalize";
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

/**
 * VIDEO 623 — a topic's key is its own distinctive words, the same for every subject. It used to
 * have hand-made buckets for four subjects (Hitler, World War II, the Titanic, Musk) and nothing
 * for any other; two videos now share a cooldown when their topics share a distinctive word — the
 * name they are about — see `archiveTopicsShareSubject`.
 */
const TOPIC_FILLER = new Set([
  "documentary", "story", "stories", "history", "historical", "video", "rise", "fall", "life", "lives",
  "facts", "fact", "truth", "true", "secret", "secrets", "untold", "real", "inside", "world", "years",
  "days", "final", "first", "last", "great", "greatest", "biggest", "strange", "rumors", "rumours",
  "about", "what", "when", "where", "which", "while", "with", "from", "into", "their", "they", "this",
  "that", "these", "those", "there", "here", "have", "were", "will", "your", "does", "done",
]);

export function normalizeArchiveTopicKey(topic: string): string {
  const words = foldSearchText(topic.toLowerCase())
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !TOPIC_FILLER.has(w))
    .slice(0, 4);
  return words.join("_") || "general";
}

/** Do two topic keys share a distinctive word ("hitler_third_reich" and "adolf_hitler")? */
export function archiveTopicsShareSubject(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === "general" || b === "general") return false;
  const words = new Set(a.split("_"));
  return b.split("_").some((w) => words.has(w));
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
    if (!archiveTopicsShareSubject(e.topicKey, key)) continue;
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
