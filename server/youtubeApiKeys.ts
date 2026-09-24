/**
 * RONDE 651 — MORE THAN ONE YOUTUBE SEARCH KEY, USED ONE AFTER THE OTHER.
 *
 * The YouTube Data API gives each Google Cloud project 10,000 units a day and a search costs 100.
 * Render 607 ran its only key dry at 18:18 (HTTP 429) and spent the rest of the render on the
 * scraped fallback. A second project gives a second 10,000 units; this is what lets the render use
 * it without anyone touching the deployment when the first runs out.
 *
 * Keys are read from `YOUTUBE_API_KEY`, `YOUTUBE_API_KEY_2` … `YOUTUBE_API_KEY_5`, in that order.
 * A key that answers 429 is set aside until Google's daily reset (midnight, Pacific time) and the
 * next one is used. A key is never printed: logs name it by its position only.
 *
 * Per process: each worker replica learns a spent key from its own first 429, which costs one
 * search, not a render.
 */

const KEY_NAMES = ["YOUTUBE_API_KEY", "YOUTUBE_API_KEY_2", "YOUTUBE_API_KEY_3", "YOUTUBE_API_KEY_4", "YOUTUBE_API_KEY_5"];

/** Position (1-based) → the moment it may be tried again. */
const spentUntil = new Map<number, number>();

export type YoutubeSearchKey = { key: string; position: number };

/** Every configured key, in order, without duplicates. */
export function youtubeSearchKeys(): YoutubeSearchKey[] {
  const seen = new Set<string>();
  const out: YoutubeSearchKey[] = [];
  KEY_NAMES.forEach((name, i) => {
    const key = process.env[name]?.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ key, position: i + 1 });
  });
  return out;
}

/** The next midnight in America/Los_Angeles — when the YouTube Data API quota resets. */
export function nextQuotaResetMs(now = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0) % 24;
  const elapsed = (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000;
  return now - elapsed + 24 * 3600 * 1000;
}

/** Keys that have not answered 429 since the last reset, in order. */
export function usableYoutubeSearchKeys(now = Date.now()): YoutubeSearchKey[] {
  return youtubeSearchKeys().filter((k) => (spentUntil.get(k.position) ?? 0) <= now);
}

/** A 429 on this key: set it aside until the reset. Returns the next usable key, if any. */
export function markYoutubeKeySpent(position: number, now = Date.now()): YoutubeSearchKey | null {
  const until = nextQuotaResetMs(now);
  spentUntil.set(position, until);
  const next = usableYoutubeSearchKeys(now)[0] ?? null;
  console.warn(
    `[YouTubeKeys] key #${position} spent (429) until ${new Date(until).toISOString()} — ` +
      (next ? `continuing with key #${next.position}` : "no other key configured or left")
  );
  return next;
}

export function __resetYoutubeKeysForTests(): void {
  spentUntil.clear();
}
