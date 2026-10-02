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

/* ═══════════════════ OCTOBER 2026 — one footage must not fill the film ═══════════════════ */

/**
 * Renders 612 and 616 were refused at the very end — `ONE_FOOTAGE_FILLS_FILM` — because nothing
 * earlier preferred anything else. Dedup forbids the same SECONDS twice; it says nothing against
 * the same YouTube video coming back under every sentence in different seconds, and the moments a
 * beat now gets from one video (`youtubeMoments.ts`) make that easier, not harder.
 *
 * So the film's own screen time is counted per footage as clips are pushed, and every beat's
 * ranked list puts the candidates of a footage that already fills much of the film behind the
 * others. A soft order, not a cap: nothing is refused, the picture editor still sees such a
 * candidate when nothing else fits, and the delivery gate's 50% stays the last check.
 */

/** The footage a clip comes from: a YouTube video for any of its fragments; otherwise the clip itself. */
export function footageKeyOf(contentKey: string | null | undefined): string | null {
  const key = contentKey?.trim();
  if (!key) return null;
  const at = key.indexOf("@t");
  return key.startsWith("youtube_cc:") && at > 0 ? key.slice(0, at) : key;
}

type FilmFootage = { byFootage: Map<string, number>; totalSec: number };
/** Keyed by the render's dedup state, so it lives and dies with the render — no second registry. */
const filmFootage = new WeakMap<object, FilmFootage>();

/** A clip went on screen for `seconds`. Called at the one push point. */
export function noteFootageOnScreen(film: object, contentKey: string | null | undefined, seconds: number): void {
  const key = footageKeyOf(contentKey);
  if (!key || !(seconds > 0)) return;
  const f = filmFootage.get(film) ?? { byFootage: new Map<string, number>(), totalSec: 0 };
  f.byFootage.set(key, (f.byFootage.get(key) ?? 0) + seconds);
  f.totalSec += seconds;
  filmFootage.set(film, f);
}

/**
 * The share of the film's pictured seconds this footage already holds. Measured against at least
 * `FILM_SHARE_FLOOR_SEC`, so the film's first clip does not read as "100% of the film".
 */
export const FILM_SHARE_FLOOR_SEC = 20;
export function footageShareSoFar(film: object, contentKey: string | null | undefined): number {
  const key = footageKeyOf(contentKey);
  const f = filmFootage.get(film);
  if (!key || !f) return 0;
  return (f.byFootage.get(key) ?? 0) / Math.max(f.totalSec, FILM_SHARE_FLOOR_SEC);
}

/** Below this share a footage is not held back at all; from the second one it goes behind everything fresher. */
export const FOOTAGE_SHARE_TIERS = [0.15, 0.3] as const;

/**
 * The beat's ranked candidates, with those whose footage already fills much of the film moved
 * behind the rest. Stable: inside each tier the ranking is exactly what it was. `moved` names the
 * candidates that lost places, for the log.
 */
export function preferLessFilledFootage(
  ranked: readonly string[],
  contentKeyOf: (path: string) => string | null | undefined,
  film: object
): { paths: string[]; moved: Array<{ path: string; share: number }> } {
  if (ranked.length <= 1 || !filmFootage.get(film)) return { paths: [...ranked], moved: [] };
  const tierOf = (share: number) => FOOTAGE_SHARE_TIERS.filter((t) => share >= t).length;
  const rows = ranked.map((p, i) => {
    const share = footageShareSoFar(film, contentKeyOf(p));
    return { p, i, share, tier: tierOf(share) };
  });
  const sorted = [...rows].sort((a, b) => a.tier - b.tier || a.i - b.i);
  const moved = sorted
    .map((r, at) => ({ r, at }))
    .filter(({ r, at }) => at > r.i)
    .map(({ r }) => ({ path: r.p, share: r.share }));
  return { paths: sorted.map((r) => r.p), moved };
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

