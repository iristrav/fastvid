/**
 * USAGE DIVERSITY — the one owner of "prefer what was used less".
 *
 * ONE ROUTE: dedup (`visualDedupRegistry`) answers "has THIS video used this picture?" and refuses.
 * Diversity answers a softer question and refuses nothing: among the pictures that already MATCH a
 * sentence, which should be tried first? The ones used in fewer recent videos on the same subject,
 * and — inside one render — the ones from archives drawn on less. It reorders within near-tied
 * score bands only, so a genuinely better match is never displaced for the sake of variety.
 *
 * Recent use is persisted to disk (survives restarts on the Railway volume / local uploads dir).
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

/**
 * How many of the last N same-subject videos (this one excluded) used each archive asset. An asset
 * absent from the map was used by none of them.
 */
export function recentUsageCounts(
  topic: string,
  currentVideoId: number,
  lastVideos = archiveCrossVideoCooldownVideos()
): Map<number, number> {
  loadStore();
  const key = normalizeArchiveTopicKey(topic);
  const counts = new Map<number, number>();
  let matchedVideos = 0;
  for (let i = entries.length - 1; i >= 0 && matchedVideos < lastVideos; i--) {
    const e = entries[i]!;
    if (e.videoId === currentVideoId) continue;
    if (!archiveTopicsShareSubject(e.topicKey, key)) continue;
    matchedVideos++;
    for (const id of new Set(e.assetIds)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Prefer the less-used among candidates that already match: within each band of near-tied scores
 * (top of the band minus `bandWidth`), fewer recent same-subject uses first, then fewer uses of the
 * candidate's archive in this render. Order across bands — the match itself — is untouched.
 */
export function preferLessUsed<T extends { score: number; asset: { id: number }; archiveName: string }>(
  ranked: T[],
  usage: { recentVideoUses?: ReadonlyMap<number, number>; archiveUsesThisRender?: ReadonlyMap<string, number> },
  bandWidth = 3
): T[] {
  const recent = usage.recentVideoUses;
  const archives = usage.archiveUsesThisRender;
  if (ranked.length <= 1 || (!recent?.size && !archives?.size)) return ranked;
  const out: T[] = [];
  let i = 0;
  while (i < ranked.length) {
    const bandTop = ranked[i]!.score;
    let j = i + 1;
    while (j < ranked.length && ranked[j]!.score >= bandTop - bandWidth) j++;
    const band = ranked.slice(i, j);
    if (band.length > 1) {
      band.sort(
        (a, b) =>
          (recent?.get(a.asset.id) ?? 0) - (recent?.get(b.asset.id) ?? 0) ||
          (archives?.get(a.archiveName) ?? 0) - (archives?.get(b.archiveName) ?? 0)
      );
    }
    out.push(...band);
    i = j;
  }
  return out;
}

