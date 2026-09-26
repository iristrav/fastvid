/**
 * RONDE 658 — ONE POOL OF YOUTUBE CANDIDATES FOR THE WHOLE VIDEO.
 *
 *   whole video → one query → SEARCH #1 (≤ 50) → videos.list (1 unit) → local filter + look at every
 *   thumbnail → the archive's YouTube material added → pool → enough?
 *        yes → every beat takes its candidates from the pool
 *        no  → SEARCH #2, aimed at the biggest gap → pool topped up → YouTube STOPS for this video
 *
 * The beats still download, cut and judge exactly as before — the per-beat turn, the download
 * ceiling, the picture editor, the placeholder gate are all unchanged. What changed is where a
 * beat's candidates come from: the pool, never a search of its own. A search inside a render that
 * does not come from here is refused (see `searchYoutubeVideoCandidates`).
 *
 * Downloads are not searches: one search may feed eight downloads and twelve clips. The limit is on
 * `search.list` only, and it is kept by the database (`youtubeSearchBudget.ts`), so a retry, a
 * requeue after a deploy, a second replica or a user trying again never gets a fresh budget.
 */
import { claimYoutubeSearch, type YoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import {
  analyzeVideo,
  planGapQuery,
  planVideoQuery,
  type PlannerDeps,
  type PlannerInput,
  type VideoAnalysis,
} from "./youtubeVideoSearchPlanner";

export type SearchItem = { videoId: string; title: string; description: string; channel: string; thumb: string };
export type ItemDetails = { durationSec: number; embeddable: boolean; live: boolean };
export type FootageType = "real_footage" | "archival_footage" | "talking_head" | "text_or_graphic" | "animation_or_game" | "other";
export type Triage = { footageType: FootageType; servesBeats: number[]; depicts: string };

export type PoolCandidate = {
  videoId: string;
  title: string;
  description: string;
  thumb: string;
  durationSec: number;
  footageType: FootageType | "unjudged";
  /** Sentence indices of the whole script this video's footage can honestly be shown under. */
  serves: number[];
  /** 1 or 2: which search found it; 0: the archive already held it. */
  from: 0 | 1 | 2;
  usable: boolean;
  why: string;
};

export type VideoYoutubePool = {
  videoId: number;
  sentences: string[];
  query1: string | null;
  query2: string | null;
  searches: number;
  candidates: PoolCandidate[];
  coverage1: number;
  archiveUsable: number;
  search2Needed: boolean;
  search2Reason: string;
  finalCoverage: number;
  decided: boolean;
};

export type PoolDeps = PlannerDeps & {
  store: YoutubeSearchBudgetStore;
  /** One search.list call. Only ever called after the budget granted it. */
  search: (query: string) => Promise<{ status: number; items: SearchItem[] }>;
  /** One videos.list call (1 quota unit, up to 50 ids). */
  details: (ids: string[]) => Promise<Map<string, ItemDetails>>;
  /** Look at one thumbnail against the whole script. */
  triage: (item: SearchItem, title: string, sentences: string[]) => Promise<Triage | null>;
  /** The archive's own YouTube-origin assets that clear its floor, as items with a thumbnail. */
  archive: (sentences: string[]) => Promise<SearchItem[]>;
  /** The title genre filter: a parody or reaction is never footage. */
  notFootage: (title: string) => string | null;
  /** When the official API is in its quota cooldown, a search is not spent on a refusal. */
  inCooldown?: () => boolean;
  concurrency?: number;
};

const MIN_SOURCE_SEC = 10;
/** The downloader fetches whole sources under an 80 MB ceiling: longer than this is not fetchable. */
const MAX_SOURCE_SEC = 20 * 60;

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    })
  );
  return out;
}

/** Judge a set of items the same way, wherever they came from. */
async function judge(
  deps: PoolDeps,
  items: SearchItem[],
  details: Map<string, ItemDetails> | null,
  from: 0 | 1 | 2,
  title: string,
  sentences: string[]
): Promise<PoolCandidate[]> {
  return mapLimit(items, deps.concurrency ?? 8, async (it) => {
    const genre = deps.notFootage(it.title);
    const d = details?.get(it.videoId) ?? null;
    let why = "ok";
    if (genre) why = `title genre ${genre}`;
    else if (details && !d) why = "no details";
    else if (d?.live) why = "live";
    else if (d && d.durationSec > 0 && d.durationSec < MIN_SOURCE_SEC) why = `too short ${d.durationSec}s`;
    else if (d && d.durationSec > MAX_SOURCE_SEC) why = `too long ${Math.round(d.durationSec / 60)}min (download ceiling)`;
    else if (d && !d.embeddable) why = "not embeddable";
    const t = why === "ok" ? await deps.triage(it, title, sentences).catch(() => null) : null;
    if (why === "ok") {
      if (!t) why = "not judged";
      else if (t.footageType !== "real_footage" && t.footageType !== "archival_footage") why = `footage type ${t.footageType}`;
      else if (!t.servesBeats.length) why = "serves no beat";
    }
    const usable = why === "ok";
    return {
      videoId: it.videoId,
      title: it.title,
      description: it.description,
      thumb: it.thumb,
      durationSec: d?.durationSec ?? 0,
      footageType: t?.footageType ?? "unjudged",
      serves: usable ? [...new Set(t!.servesBeats)].filter((b) => b >= 0 && b < sentences.length) : [],
      from,
      usable,
      why,
    };
  });
}

/** The agreed rules for search #2, measured on the pool as it stands. Empty when none applies. */
export function search2Reasons(pool: Pick<VideoYoutubePool, "candidates" | "sentences">): string[] {
  const usable = pool.candidates.filter((c) => c.usable);
  const beats = pool.sentences.length;
  const covered = new Set(usable.flatMap((c) => c.serves)).size;
  const distinct = new Set(usable.map((c) => c.videoId)).size;
  const need = Math.max(6, Math.ceil(beats / 2));
  const reasons: string[] = [];
  if (usable.length < need) reasons.push(`usable candidates ${usable.length} < max(6, beats/2)=${need}`);
  if (distinct < 4) reasons.push(`distinct usable videos ${distinct} < 4`);
  if (covered < beats / 2) reasons.push(`coverage ${covered}/${beats} < 50%`);
  return reasons;
}

export function coverageOf(candidates: PoolCandidate[]): number {
  return new Set(candidates.filter((c) => c.usable).flatMap((c) => c.serves)).size;
}

function uncoveredOf(pool: VideoYoutubePool): number[] {
  const covered = new Set(pool.candidates.filter((c) => c.usable).flatMap((c) => c.serves));
  return pool.sentences.map((_, i) => i).filter((i) => !covered.has(i));
}

function mergeCandidates(a: PoolCandidate[], b: PoolCandidate[]): PoolCandidate[] {
  const byId = new Map<string, PoolCandidate>();
  for (const c of [...a, ...b]) {
    const prev = byId.get(c.videoId);
    if (!prev) byId.set(c.videoId, c);
    else if (!prev.usable && c.usable) byId.set(c.videoId, c);
    else if (prev.usable && c.usable) byId.set(c.videoId, { ...prev, serves: [...new Set([...prev.serves, ...c.serves])] });
  }
  return [...byId.values()];
}

export function formatSearchPlan(pool: VideoYoutubePool): string {
  const s1 = pool.candidates.filter((c) => c.from === 1);
  const s2 = pool.candidates.filter((c) => c.from === 2);
  return (
    `[YouTubeSearchPlan] video=${pool.videoId} searches=${pool.searches} beats=${pool.sentences.length} ` +
    `search1Query=${JSON.stringify(pool.query1 ?? "")} search1Candidates=${s1.length} search1Usable=${s1.filter((c) => c.usable).length} ` +
    `coverage1=${pool.coverage1}/${pool.sentences.length} archiveUsable=${pool.archiveUsable} ` +
    `search2=${pool.search2Needed ? "YES" : "NO"}${pool.search2Needed ? ` search2Reason=${JSON.stringify(pool.search2Reason)}` : ""}` +
    (pool.query2 != null ? ` search2Query=${JSON.stringify(pool.query2)} search2Candidates=${s2.length} search2Usable=${s2.filter((c) => c.usable).length}` : "") +
    ` finalCoverage=${pool.finalCoverage}/${pool.sentences.length}`
  );
}

/**
 * Build (or recover) the pool of one video. Never throws: a failure leaves fewer candidates, and
 * the beats go on to the archive, open sources and stock exactly as they would without YouTube.
 */
export async function buildVideoYoutubePool(
  deps: PoolDeps,
  input: PlannerInput & { videoId: number }
): Promise<VideoYoutubePool> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const analysis: VideoAnalysis = analyzeVideo(input);
  const empty: VideoYoutubePool = {
    videoId: input.videoId,
    sentences: analysis.sentences,
    query1: null,
    query2: null,
    searches: 0,
    candidates: [],
    coverage1: 0,
    archiveUsable: 0,
    search2Needed: false,
    search2Reason: "",
    finalCoverage: 0,
    decided: false,
  };
  const row = await deps.store.load(input.videoId).catch(() => null);
  let pool: VideoYoutubePool = empty;
  if (row?.poolJson) {
    try {
      const stored = JSON.parse(row.poolJson) as VideoYoutubePool;
      if (Array.isArray(stored.candidates)) pool = { ...stored, sentences: analysis.sentences, videoId: input.videoId };
    } catch {
      /* a damaged record is an empty pool, never a fresh budget */
    }
  }
  pool.searches = Math.max(pool.searches, row?.searchCount ?? 0);
  const persist = async (patch: Parameters<YoutubeSearchBudgetStore["record"]>[1]) =>
    deps.store.record(input.videoId, { ...patch, poolJson: JSON.stringify(pool) }).catch((err: Error) =>
      log(`[YouTubeSearchPlan] video=${input.videoId} not recorded: ${err.message?.slice(0, 120)}`)
    );

  /** A later attempt of the same video: its searches are spent, its candidates are reused. */
  if (pool.decided || pool.searches >= 2) {
    log(`[YouTubeSearchPlan] video=${input.videoId} REUSED searches=${pool.searches} candidates=${pool.candidates.length} — no new search`);
    return pool;
  }

  /* ── search #1 ── */
  if (pool.searches === 0) {
    if (deps.inCooldown?.()) {
      log(`[YouTubeSearchPlan] video=${input.videoId} search #1 not spent — the official API is in its quota cooldown`);
      return pool;
    }
    const plan = await planVideoQuery(deps, input, analysis);
    if (!plan) return pool;
    if (!(await claimYoutubeSearch(deps.store, input.videoId, 1, log))) {
      log(`[YouTubeSearchPlan] video=${input.videoId} search #1 not granted — YouTube adds nothing new to this attempt`);
      return pool;
    }
    pool.searches = 1;
    pool.query1 = plan.query;
    const got = await deps.search(plan.query).catch(() => ({ status: 0, items: [] as SearchItem[] }));
    const details = got.items.length ? await deps.details(got.items.map((i) => i.videoId)).catch(() => null) : null;
    pool.candidates = mergeCandidates(pool.candidates, await judge(deps, got.items, details, 1, input.title, analysis.sentences));
    pool.coverage1 = coverageOf(pool.candidates);
    await persist({
      beatsTotal: analysis.sentences.length,
      search1CompletedAt: new Date(),
      search1Query: plan.query,
      search1Status: got.status === 200 ? "ok" : `http_${got.status}`,
      search1Candidates: got.items.length,
      search1Usable: pool.candidates.filter((c) => c.from === 1 && c.usable).length,
      search1Coverage: pool.coverage1,
    });
  }

  /* ── the archive joins the pool; it never replaces search #1 ── */
  const archiveItems = await deps.archive(analysis.sentences).catch(() => [] as SearchItem[]);
  const known = new Set(pool.candidates.map((c) => c.videoId));
  const archiveJudged = await judge(deps, archiveItems.filter((i) => !known.has(i.videoId)), null, 0, input.title, analysis.sentences);
  pool.candidates = mergeCandidates(pool.candidates, archiveJudged);
  pool.archiveUsable = archiveJudged.filter((c) => c.usable).length;

  /* ── enough? ── */
  const reasons = search2Reasons(pool);
  pool.search2Needed = reasons.length > 0;
  pool.search2Reason = reasons.join("; ");
  await persist({ archiveUsable: pool.archiveUsable, search2Needed: pool.search2Needed ? 1 : 0, search2Reason: pool.search2Reason });

  /* ── search #2: only for a real gap, only a different question, and the last one ── */
  if (pool.search2Needed && pool.searches === 1 && !deps.inCooldown?.()) {
    const plan = await planGapQuery(deps, input, analysis, { query1: pool.query1 ?? "", uncovered: uncoveredOf(pool) });
    if (plan && (await claimYoutubeSearch(deps.store, input.videoId, 2, log))) {
      pool.searches = 2;
      pool.query2 = plan.query;
      const got = await deps.search(plan.query).catch(() => ({ status: 0, items: [] as SearchItem[] }));
      const fresh = got.items.filter((i) => !pool.candidates.some((c) => c.videoId === i.videoId));
      const details = fresh.length ? await deps.details(fresh.map((i) => i.videoId)).catch(() => null) : null;
      pool.candidates = mergeCandidates(pool.candidates, await judge(deps, fresh, details, 2, input.title, analysis.sentences));
      await persist({
        search2CompletedAt: new Date(),
        search2Query: plan.query,
        search2Status: got.status === 200 ? "ok" : `http_${got.status}`,
        search2Candidates: got.items.length,
        search2Usable: pool.candidates.filter((c) => c.from === 2 && c.usable).length,
      });
    }
  }

  pool.finalCoverage = coverageOf(pool.candidates);
  pool.decided = true;
  await persist({ finalCoverage: pool.finalCoverage });
  log(formatSearchPlan(pool));
  if (pool.searches >= 2 || !pool.search2Needed) {
    log(`[YouTubeSearchPlan] video=${input.videoId} YouTube search DONE for this video — the rest goes to archive, open sources, stock, AI`);
  }
  return pool;
}

/* ═══════════════════════ the render's pool, and a beat's share of it ═══════════════════════ */

const pools = new Map<number, Promise<VideoYoutubePool>>();

/** A pool with nothing in it: the beats go on to the archive, open sources and stock. */
export function emptyVideoYoutubePool(videoId: number): VideoYoutubePool {
  return {
    videoId,
    sentences: [],
    query1: null,
    query2: null,
    searches: 0,
    candidates: [],
    coverage1: 0,
    archiveUsable: 0,
    search2Needed: false,
    search2Reason: "",
    finalCoverage: 0,
    decided: false,
  };
}

/** RONDE 658 — the switch. `YOUTUBE_SEARCH_MODE=per_beat` restores the old per-beat searches. */
export function youtubeVideoPoolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YOUTUBE_SEARCH_MODE?.trim().toLowerCase() !== "per_beat";
}

export function registerVideoYoutubePool(videoId: number, pool: Promise<VideoYoutubePool>): void {
  pools.set(videoId, pool);
}

export function hasVideoYoutubePool(videoId: number | undefined | null): boolean {
  return videoId != null && pools.has(videoId);
}

export function releaseVideoYoutubePool(videoId: number): void {
  pools.delete(videoId);
}

/** The pool, waited for at most `maxWaitMs` — a beat never blocks on YouTube for longer than it can afford. */
export async function awaitVideoYoutubePool(videoId: number, maxWaitMs: number): Promise<VideoYoutubePool | null> {
  const p = pools.get(videoId);
  if (!p) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const out = await Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, maxWaitMs));
    }),
  ]);
  if (timer) clearTimeout(timer);
  return out;
}

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2)
  );
}

/** Does a production beat's text correspond to one of the script sentences the pool was judged on? */
export function beatSentences(pool: Pick<VideoYoutubePool, "sentences">, beatText: string): number[] {
  const b = tokens(beatText);
  if (!b.size) return [];
  const out: number[] = [];
  pool.sentences.forEach((s, i) => {
    const t = tokens(s);
    if (!t.size) return;
    let shared = 0;
    for (const w of t) if (b.has(w)) shared++;
    if (shared / Math.min(t.size, b.size) >= 0.6) out.push(i);
  });
  return out;
}

/** The row shape the per-beat fetcher already consumes (`YoutubeSearchRow`). */
export type PoolRow = {
  item: { id: { videoId: string }; snippet: { title: string; description: string; thumbnails: { high: { url: string } } } };
  title: string;
  desc: string;
  thumb: string;
  rel: number;
};

/**
 * A beat's candidates, from the pool: the usable videos judged to serve this beat first, then the
 * other usable videos by how much of the beat's own vocabulary their title and description carry.
 * `rel` is on the same scale the fetcher already filters with, so its relevance floor still holds.
 */
export function poolRowsForBeat(
  pool: VideoYoutubePool,
  beatText: string,
  relevanceKeywords: string[],
  requiredPersonName = ""
): PoolRow[] {
  const mine = new Set(beatSentences(pool, beatText));
  const rows: PoolRow[] = [];
  for (const c of pool.candidates) {
    if (!c.usable) continue;
    const hay = `${c.title} ${c.description}`.toLowerCase();
    if (requiredPersonName) {
      const last = requiredPersonName.trim().split(/\s+/).pop()?.toLowerCase() ?? "";
      if (last && !hay.includes(last)) continue;
    }
    const text = relevanceKeywords.filter((k) => k.length >= 3 && hay.includes(k.toLowerCase())).length;
    const serves = c.serves.some((s) => mine.has(s));
    rows.push({
      item: { id: { videoId: c.videoId }, snippet: { title: c.title, description: c.description, thumbnails: { high: { url: c.thumb } } } },
      title: c.title,
      desc: c.description,
      thumb: c.thumb,
      rel: serves ? Math.max(3, text + 3) : text,
    });
  }
  return rows.sort((a, b) => b.rel - a.rel);
}
