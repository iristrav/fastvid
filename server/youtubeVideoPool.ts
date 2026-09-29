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
import { youtubeResultIsShort } from "./youtubeNonFootage";
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
  /** VIDEO 619 — the channel YouTube's search named; absent in pools stored before it was kept. */
  channel?: string;
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
    /** Video 613 — a Short is never downloaded: by its hashtag, or by its measured length. */
    const short = youtubeResultIsShort(it.title, it.description, d?.durationSec ?? null);
    if (genre) why = `title genre ${genre}`;
    else if (short) why = `youtube short (${short})`;
    /** A result whose length is unknown could be a Short: it is not looked at. */
    else if (!d) why = "no details — length unknown, may be a Short";
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
      ...(it.channel ? { channel: it.channel } : {}),
    };
  });
}

/** The agreed rules for search #2, measured on the pool as it stands. Empty when none applies. */
export function search2Reasons(
  pool: Pick<VideoYoutubePool, "candidates" | "sentences">,
  /**
   * VIDEO 616 — pool videos whose downloaded fragment this render refused (on-screen text, black).
   * Found on paper is not usable on screen: they do not count as usable here, and three of them
   * are a reason of their own. Empty when the pool is first judged, which is exactly as before.
   */
  refused: ReadonlySet<string> = new Set()
): string[] {
  const usable = pool.candidates.filter((c) => c.usable && !refused.has(c.videoId));
  const beats = pool.sentences.length;
  const covered = new Set(usable.flatMap((c) => c.serves)).size;
  const distinct = new Set(usable.map((c) => c.videoId)).size;
  const need = Math.max(6, Math.ceil(beats / 2));
  const reasons: string[] = [];
  if (usable.length < need) reasons.push(`usable candidates ${usable.length} < max(6, beats/2)=${need}`);
  if (distinct < 4) reasons.push(`distinct usable videos ${distinct} < 4`);
  if (covered < beats / 2) reasons.push(`coverage ${covered}/${beats} < 50%`);
  const refusedInPool = pool.candidates.filter((c) => c.usable && refused.has(c.videoId)).length;
  if (refusedInPool >= POOL_REFUSALS_FOR_SEARCH2) {
    reasons.push(`refused in this render ${refusedInPool} >= ${POOL_REFUSALS_FOR_SEARCH2}`);
  }
  return reasons;
}

export function coverageOf(candidates: PoolCandidate[]): number {
  return new Set(candidates.filter((c) => c.usable).flatMap((c) => c.serves)).size;
}

/** VIDEO 616 — distinct pool videos refused on screen before search #2 is asked for. */
export const POOL_REFUSALS_FOR_SEARCH2 = 3;

function uncoveredOf(pool: VideoYoutubePool, refused: ReadonlySet<string> = new Set()): number[] {
  const covered = new Set(pool.candidates.filter((c) => c.usable && !refused.has(c.videoId)).flatMap((c) => c.serves));
  return pool.sentences.map((_, i) => i).filter((i) => !covered.has(i));
}

/**
 * The beats search #2 is aimed at. Normally the ones no usable candidate serves. VIDEO 616 — when
 * the pool covered every beat on paper and its videos were then refused on screen, the gap is the
 * beats those refused videos were meant to serve (every beat, when they served none in particular).
 */
function gapOf(pool: VideoYoutubePool, refused: ReadonlySet<string>): number[] {
  const uncovered = uncoveredOf(pool, refused);
  if (uncovered.length) return uncovered;
  if (refused.size > 0) {
    const lost = [...new Set(pool.candidates.filter((c) => refused.has(c.videoId)).flatMap((c) => c.serves))];
    if (lost.length) return lost.sort((a, b) => a - b);
  }
  /**
   * Video 616, round two — search #2 is due (too few usable candidates) while every beat is covered
   * on paper by the few that are left: the gap is the beats with the fewest usable candidates.
   * Without this a pool the triage thinned correctly got a reason for search #2 and no question.
   */
  const usable = pool.candidates.filter((c) => c.usable && !refused.has(c.videoId));
  const perBeat = pool.sentences.map((_, i) => usable.filter((c) => c.serves.includes(i)).length);
  const fewest = Math.min(...perBeat);
  return perBeat.flatMap((n, i) => (n === fewest ? [i] : []));
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
  input: PlannerInput & { videoId: number },
  /**
   * VIDEO 616 — asked again during the render once the pool proved unusable on screen: the stored
   * pool is reloaded, nothing already spent is spent again, and only search #2 can still run.
   */
  opts: { refusedVideoIds?: readonly string[] } = {}
): Promise<VideoYoutubePool> {
  const refused = new Set(opts.refusedVideoIds ?? []);
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
      /**
       * Video 613 — a pool stored by an earlier attempt was judged before the Shorts rule. Its
       * candidates are asked again here, so a reused pool can never hand a beat a Short.
       */
      pool.candidates = pool.candidates.map((c) => {
        if (!c.usable) return c;
        const short = youtubeResultIsShort(c.title, c.description, c.durationSec || null);
        if (short) return { ...c, usable: false, serves: [], why: `youtube short (${short})` };
        if (!(c.durationSec > 0)) return { ...c, usable: false, serves: [], why: "no details — length unknown, may be a Short" };
        return c;
      });
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
  if (pool.searches >= 2 || (pool.decided && refused.size === 0)) {
    log(`[YouTubeSearchPlan] video=${input.videoId} REUSED searches=${pool.searches} candidates=${pool.candidates.length} — no new search`);
    return pool;
  }

  /* ── search #1 ── */
  if (pool.searches === 0 && !pool.decided) {
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
  const archiveItems = pool.decided ? [] : await deps.archive(analysis.sentences).catch(() => [] as SearchItem[]);
  const known = new Set(pool.candidates.map((c) => c.videoId));
  const archiveNew = archiveItems.filter((i) => !known.has(i.videoId));
  /**
   * Video 613 — the archive's YouTube items are measured too before their thumbnail is looked at:
   * a Short an earlier render archived without a hashtag is known by its length. One videos.list
   * call, the same 1 unit as the search's own.
   */
  const archiveDetails = archiveNew.length ? await deps.details(archiveNew.map((i) => i.videoId)).catch(() => null) : null;
  const archiveJudged = await judge(deps, archiveNew, archiveDetails ?? new Map(), 0, input.title, analysis.sentences);
  pool.candidates = mergeCandidates(pool.candidates, archiveJudged);
  if (!pool.decided) pool.archiveUsable = archiveJudged.filter((c) => c.usable).length;

  /* ── enough? ── */
  const reasons = search2Reasons(pool, refused);
  pool.search2Needed = reasons.length > 0;
  pool.search2Reason = reasons.join("; ");
  await persist({ archiveUsable: pool.archiveUsable, search2Needed: pool.search2Needed ? 1 : 0, search2Reason: pool.search2Reason });

  /* ── search #2: only for a real gap, only a different question, and the last one ── */
  if (pool.search2Needed && pool.searches === 1 && !deps.inCooldown?.()) {
    const plan = await planGapQuery(deps, input, analysis, { query1: pool.query1 ?? "", uncovered: gapOf(pool, refused) });
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

/** Videos whose pool finished WITHOUT a usable YouTube answer — see `poolGaveNoYoutube`. */
const poolsWithoutYoutube = new Set<number>();

/**
 * Video 612 — did the central route actually bring back YouTube footage?
 *
 * Only a video that a pool SEARCH found (`from` 1 or 2) and the triage judged usable counts. So
 * all of these are "no answer about YouTube", and the beats may search per beat:
 *   - the planner found no query (nothing was searched);
 *   - the search failed — HTTP error or network error both leave no candidates;
 *   - the search answered, but no video could be judged usable (including a triage that failed).
 * The archive's own items (`from` 0) are not a YouTube search result and do not count.
 */
export function poolGaveNoYoutube(pool: Pick<VideoYoutubePool, "candidates">): boolean {
  return !pool.candidates.some((c) => c.usable && (c.from === 1 || c.from === 2));
}

/**
 * VIDEO 616 — the pool asked again when it proves unusable on screen.
 *
 * `topUp` is the render's own `buildVideoYoutubePool` call, given the refused videos: it reloads the
 * stored pool and can run only search #2, under the same budget and gate. Asked at most once per
 * render, when the third distinct pool video is refused; the beats read the topped-up pool on their
 * next turn. A top-up that fails leaves the pool exactly as it was.
 */
const poolTopUps = new Map<number, (refusedVideoIds: string[]) => Promise<VideoYoutubePool>>();
const poolRefusals = new Map<number, Set<string>>();

export function noteVideoYoutubePoolRefusal(videoId: number, youtubeVideoId: string): void {
  const topUp = poolTopUps.get(videoId);
  const current = pools.get(videoId);
  if (!topUp || !current || !youtubeVideoId) return;
  const refused = poolRefusals.get(videoId) ?? new Set<string>();
  poolRefusals.set(videoId, refused);
  if (refused.has(youtubeVideoId)) return;
  refused.add(youtubeVideoId);
  if (refused.size !== POOL_REFUSALS_FOR_SEARCH2) return;
  poolTopUps.delete(videoId);
  console.log(
    `[YouTubeSearchPlan] video=${videoId} ${refused.size} pool videos refused on screen ` +
      `(${[...refused].join(",")}) — the pool is asked whether search #2 is due`
  );
  pools.set(videoId, current.then((before) => topUp([...refused]).catch(() => before)));
}

export function registerVideoYoutubePool(
  videoId: number,
  pool: Promise<VideoYoutubePool>,
  topUp?: (refusedVideoIds: string[]) => Promise<VideoYoutubePool>
): void {
  pools.set(videoId, pool);
  poolRefusals.delete(videoId);
  if (topUp) poolTopUps.set(videoId, topUp);
  else poolTopUps.delete(videoId);
  poolsWithoutYoutube.delete(videoId);
  void pool.then(
    (p) => {
      if (pools.get(videoId) === pool && poolGaveNoYoutube(p)) poolsWithoutYoutube.add(videoId);
    },
    () => {
      if (pools.get(videoId) === pool) poolsWithoutYoutube.add(videoId);
    }
  );
}

export function hasVideoYoutubePool(videoId: number | undefined | null): boolean {
  return videoId != null && pools.has(videoId);
}

/**
 * True once this video's pool has finished without usable YouTube. Its beats then search YouTube
 * per beat, through the existing per-beat route, instead of reading an empty pool.
 */
export function videoYoutubePoolGaveNoYoutube(videoId: number | undefined | null): boolean {
  return videoId != null && poolsWithoutYoutube.has(videoId);
}

export function releaseVideoYoutubePool(videoId: number): void {
  pools.delete(videoId);
  poolTopUps.delete(videoId);
  poolRefusals.delete(videoId);
  poolsWithoutYoutube.delete(videoId);
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
  item: { id: { videoId: string }; snippet: { title: string; description: string; channelTitle?: string; thumbnails: { high: { url: string } } } };
  title: string;
  desc: string;
  thumb: string;
  rel: number;
  /** VIDEO 616 — measured by `videos.list` when the pool was judged; 0 when unknown. */
  durationSec: number;
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
    const serves = c.serves.some((s) => mine.has(s));
    /**
     * RONDE 659 — video 608: the person lock read "Hitler Took", this took its LAST word, and no
     * YouTube title contains "took" — every candidate of every beat was dropped. A video the picture
     * triage already judged to serve THIS beat is not second-guessed by a name string; any other
     * must carry some real part of the name (four letters or more) in its title or description.
     */
    if (requiredPersonName && !serves) {
      const parts = requiredPersonName.toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
      if (parts.length && !parts.some((w) => hay.includes(w))) continue;
    }
    const text = relevanceKeywords.filter((k) => k.length >= 3 && hay.includes(k.toLowerCase())).length;
    rows.push({
      item: { id: { videoId: c.videoId }, snippet: { title: c.title, description: c.description, channelTitle: c.channel, thumbnails: { high: { url: c.thumb } } } },
      title: c.title,
      desc: c.description,
      thumb: c.thumb,
      rel: serves ? Math.max(3, text + 3) : text,
      durationSec: c.durationSec > 0 ? c.durationSec : 0,
    });
  }
  return rows.sort((a, b) => b.rel - a.rel);
}
