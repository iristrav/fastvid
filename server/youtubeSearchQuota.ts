/**
 * RONDE 653 — EVERY YOUTUBE SEARCH IS COUNTED, AND THE SAME QUESTION IS NOT PAID FOR TWICE.
 *
 * The project has 100 `search.list` calls a day for everything. The only cache was per RENDER:
 * the same query in the next render — the same topic again, or the same video re-queued after a
 * deploy — went out and was paid for again. And no line said, per search, whether it cost quota.
 *
 * Two things here, both small:
 *
 *   A process cache under the per-render one. A payload for exactly the same request (query,
 *   licence, page size, duration) is reused for a few hours; search results for a query do not
 *   change meaningfully in that time, and a hit costs nothing.
 *
 *   One line per search that reaches this layer: which video, which render, which scene, the query,
 *   whether it was served from the process cache or cost a call, and how many calls this process
 *   has made since Google's last reset (midnight Pacific). Only calls that reach the network are
 *   quota; the log says so explicitly with `quotaCall=`.
 */
import { nextQuotaResetMs } from "./youtubeApiKeys";

type Entry = { at: number; payload: unknown };
const cache = new Map<string, Entry>();
const MAX_ENTRIES = 1000;

export function youtubeSearchCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const min = Number.parseInt(env.YOUTUBE_SEARCH_CACHE_TTL_MIN?.trim() ?? "", 10);
  return (Number.isFinite(min) && min >= 0 && min <= 24 * 60 ? min : 360) * 60_000;
}

export function cachedYoutubeSearchPayload(key: string, now = Date.now()): unknown | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.at > youtubeSearchCacheTtlMs()) {
    cache.delete(key);
    return undefined;
  }
  return hit.payload;
}

export function storeYoutubeSearchPayload(key: string, payload: unknown, now = Date.now()): void {
  if (youtubeSearchCacheTtlMs() === 0) return;
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: now, payload });
}

/* ═══════════════════════ the day's count ═══════════════════════ */

let windowEndsAt = 0;
let callsThisWindow = 0;

/** Count one call that reached Google. Resets at Google's own reset, not at UTC midnight. */
export function countYoutubeQuotaCall(now = Date.now()): number {
  if (now >= windowEndsAt) {
    windowEndsAt = nextQuotaResetMs(now);
    callsThisWindow = 0;
  }
  callsThisWindow += 1;
  return callsThisWindow;
}

export function youtubeQuotaCallsToday(now = Date.now()): number {
  return now >= windowEndsAt ? 0 : callsThisWindow;
}

export function formatYoutubeSearchCall(p: {
  videoId: number | string | null | undefined;
  renderId: string | null | undefined;
  sceneIndex: number;
  query: string;
  source: "process_cache" | "network";
  status?: number | null;
  callsToday: number;
}): string {
  return (
    `[YouTubeSearchCall] video=${p.videoId ?? "none"} render=${p.renderId ?? "none"} scene=${p.sceneIndex} ` +
    `cacheHit=${p.source === "process_cache"} quotaCall=${p.source === "network"} ` +
    (p.status != null ? `status=${p.status} ` : "") +
    `processCallsToday=${p.callsToday} query="${p.query.slice(0, 120)}"`
  );
}

/** For tests. */
export function resetYoutubeSearchQuotaState(): void {
  cache.clear();
  windowEndsAt = 0;
  callsThisWindow = 0;
}
