/**
 * RONDE 653 — A MUSIC CATALOGUE THAT ONLY HOLDS WHAT FREESOUND SAYS IS CC0.
 *
 * The delivered (cinematic) film has never had music: `musicDirector.ts` plans a cue sheet and
 * asks a catalogue for tracks, and the only catalogue ever registered is the empty one. That file
 * is right that a list of track ids written from memory would be fabrication. This catalogue writes
 * none down. It asks Freesound's search API, per process and at most every few hours, for music
 * under the Creative Commons 0 licence, and keeps only results whose licence field — as Freesound
 * returned it, not as the filter promised — is CC0. Every track carries Freesound's own id, title,
 * duration and page URL, so a human can check each one, and the renderer fetches it through the
 * same `freesound:<id>` route the ambience track already uses.
 *
 * What it is not: a mood engine. Four searches supply four broad moods; a cue asks for its role and
 * intensity and gets the closest unused track long enough to cover it, or nothing. Tracks with
 * vocals are left out — a singer under a narrator is worse than silence.
 */
import type { MusicCatalogue, MusicCueRole, MusicRequest, MusicTrack } from "./musicDirector";
import { EMPTY_MUSIC_CATALOGUE } from "./musicDirector";

const FREESOUND_API = "https://freesound.org/apiv2";
const POOL_TTL_MS = 6 * 60 * 60_000;
const MIN_TRACK_SEC = 30;
const MAX_TRACK_SEC = 600;

type MoodSearch = { query: string; moods: MusicCueRole[]; energy: number };

/** Four searches, four broad moods. The roles are the ones `planMusicCues` emits. */
export const MUSIC_SEARCHES: readonly MoodSearch[] = [
  { query: "ambient documentary", moods: ["intro", "transition", "release", "outro"], energy: 30 },
  { query: "piano melancholic", moods: ["intro", "release", "outro"], energy: 35 },
  { query: "dark ambient tension", moods: ["build", "tension"], energy: 65 },
  { query: "cinematic epic orchestral", moods: ["build", "climax"], energy: 85 },
];

const VOCAL_TAGS = /^(vocal|vocals|voice|voices|singing|singer|sing|speech|spoken|lyrics|rap|choir-vocals|talking)$/i;

type FreesoundResult = {
  id: number;
  name?: string;
  license?: string;
  duration?: number;
  username?: string;
  tags?: string[];
  url?: string;
};

/** Freesound returns the licence as a URL or a name; only CC0 is accepted. */
export function isCc0Licence(licence: string | undefined): boolean {
  const l = licence?.trim().toLowerCase() ?? "";
  return l.includes("publicdomain/zero") || l === "creative commons 0" || l === "cc0";
}

export function trackFromFreesound(r: FreesoundResult, search: MoodSearch): MusicTrack | null {
  if (!Number.isInteger(r.id) || r.id <= 0) return null;
  if (!isCc0Licence(r.license)) return null;
  const durationSec = Number(r.duration);
  if (!Number.isFinite(durationSec) || durationSec < MIN_TRACK_SEC || durationSec > MAX_TRACK_SEC) return null;
  if ((r.tags ?? []).some((t) => VOCAL_TAGS.test(t))) return null;
  const title = r.name?.trim() || `Freesound #${r.id}`;
  return {
    identity: {
      provider: "freesound",
      providerAssetId: String(r.id),
      title,
      ...(r.url ? { sourcePageUrl: r.url } : {}),
    },
    title,
    moods: search.moods,
    energy: search.energy,
    instrumentation: [],
    durationSec,
    licence: "CC0",
    ...(r.url ? { sourcePageUrl: r.url } : {}),
  };
}

export type MusicSearchFetch = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * Search once per mood. Tries the documented text-search path and, if Freesound answers 404
 * there, the newer unified path. Never throws; a failed search simply adds nothing, and says so.
 */
export async function searchFreesoundMusic(params: {
  apiKey: string;
  fetch: MusicSearchFetch;
  log?: (line: string) => void;
}): Promise<MusicTrack[]> {
  const log = params.log ?? ((l: string) => console.log(l));
  const filter = `license:"Creative Commons 0" duration:[${MIN_TRACK_SEC} TO ${MAX_TRACK_SEC}] tag:music`;
  const fields = "id,name,license,duration,username,tags,url";
  const pool: MusicTrack[] = [];
  const seen = new Set<string>();
  for (const search of MUSIC_SEARCHES) {
    const qs =
      `query=${encodeURIComponent(search.query)}&filter=${encodeURIComponent(filter)}` +
      `&fields=${fields}&page_size=15&sort=rating_desc&token=${encodeURIComponent(params.apiKey)}`;
    let results: FreesoundResult[] = [];
    let status = 0;
    for (const p of ["search/text/", "search/"]) {
      try {
        const resp = await params.fetch(`${FREESOUND_API}/${p}?${qs}`);
        status = resp.status;
        if (resp.status === 404) continue;
        if (resp.status !== 200) break;
        const body = (await resp.json()) as { results?: FreesoundResult[] };
        results = Array.isArray(body.results) ? body.results : [];
        break;
      } catch (err) {
        log(`[MusicCatalogue] search "${search.query}" failed: ${(err as Error).message?.slice(0, 120)}`);
        break;
      }
    }
    let kept = 0;
    for (const r of results) {
      const t = trackFromFreesound(r, search);
      if (!t || seen.has(t.identity.providerAssetId!)) continue;
      seen.add(t.identity.providerAssetId!);
      pool.push(t);
      kept++;
    }
    log(`[MusicCatalogue] search "${search.query}" status=${status} results=${results.length} keptCC0=${kept}`);
  }
  return pool;
}

/**
 * A catalogue over a fixed pool, for ONE film: a track is used at most once, so the score does
 * not repeat itself, and a cue is only given a track long enough to cover it.
 */
export function catalogueFromPool(
  name: string,
  pool: readonly MusicTrack[],
  state: { used: Set<string>; last: string | null } = { used: new Set(), last: null }
): MusicCatalogue {
  if (pool.length === 0) return EMPTY_MUSIC_CATALOGUE;
  const key = (t: MusicTrack) => t.identity.providerAssetId ?? t.title;
  const pick = (choices: MusicTrack[], req: MusicRequest): MusicTrack | null => {
    if (!choices.length) return null;
    const fitting = choices.filter((t) => t.moods.includes(req.role));
    return [...(fitting.length ? fitting : choices)].sort(
      (a, b) => Math.abs(a.energy - req.intensity) - Math.abs(b.energy - req.intensity)
    )[0]!;
  };
  return {
    name,
    find(req: MusicRequest): MusicTrack | null {
      const long = pool.filter((t) => t.durationSec >= req.minDurationSec);
      /**
       * A fresh track first. RONDE 657 — when the pool has none left, one heard earlier in the film
       * rather than no music at all; never the one that just played, so a track never follows itself.
       */
      const best =
        pick(long.filter((t) => !state.used.has(key(t))), req) ??
        pick(long.filter((t) => key(t) !== state.last), req);
      if (!best) return null;
      state.used.add(key(best));
      state.last = key(best);
      return best;
    },
    fork: () => catalogueFromPool(name, pool, { used: new Set(state.used), last: state.last }),
  };
}

let cachedPool: { at: number; pool: MusicTrack[] } | null = null;
let inFlight: Promise<MusicTrack[]> | null = null;

/**
 * The catalogue a production render scores from. Empty — and the render says so — when there is
 * no FREESOUND_API_KEY or Freesound returned nothing usable; never an invented track.
 */
export async function productionMusicCatalogue(now: number = Date.now()): Promise<MusicCatalogue> {
  const apiKey = process.env.FREESOUND_API_KEY?.trim();
  if (!apiKey || process.env.MUSIC_CATALOGUE === "off") return EMPTY_MUSIC_CATALOGUE;
  if (!cachedPool || now - cachedPool.at > POOL_TTL_MS) {
    inFlight ??= searchFreesoundMusic({
      apiKey,
      fetch: (url) => fetch(url, { signal: AbortSignal.timeout(10_000) }),
    }).finally(() => {
      inFlight = null;
    });
    const pool = await inFlight;
    /** An empty answer is not cached for hours: the next render asks again. */
    cachedPool = pool.length ? { at: now, pool } : null;
  }
  return cachedPool ? catalogueFromPool("freesound-cc0", cachedPool.pool) : EMPTY_MUSIC_CATALOGUE;
}

/** For tests. */
export function resetMusicPoolCache(): void {
  cachedPool = null;
  inFlight = null;
}
