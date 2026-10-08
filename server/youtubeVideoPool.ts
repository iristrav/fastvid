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
import { judgeFootageTitle, judgeFootageType } from "./visualJudge";
import { claimYoutubeSearch, MAX_YOUTUBE_SEARCHES_PER_VIDEO, type YoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import {
  analyzeVideo,
  contentWords,
  planEntityQuery,
  planGapQuery,
  planVideoQuery,
  queryNames,
  type PlannerDeps,
  type PlannerInput,
  type VideoAnalysis,
  type VisualNeed,
} from "./youtubeVideoSearchPlanner";

export type SearchItem = { videoId: string; title: string; description: string; channel: string; thumb: string };
export type ItemDetails = {
  durationSec: number;
  embeddable: boolean;
  live: boolean;
  /** VIDEO 624 — YouTube's own title, description and channel, from the same videos.list call. */
  title?: string;
  description?: string;
  channel?: string;
  /** YouTube's own licence for the video (`status.license`: "youtube" or "creativeCommon"), same call. */
  license?: string;
};
export type FootageType = "real_footage" | "archival_footage" | "talking_head" | "text_or_graphic" | "animation_or_game" | "other";
export type Triage = {
  footageType: FootageType;
  servesBeats: number[];
  depicts: string;
  /** VISUAL NEEDS — which of the subjects it was shown the video really shows on screen (their numbers). */
  shows?: number[];
};

export type PoolCandidate = {
  videoId: string;
  title: string;
  description: string;
  thumb: string;
  durationSec: number;
  footageType: FootageType | "unjudged";
  /** Sentence indices of the whole script this video's footage can honestly be shown under. */
  serves: number[];
  /** 1..MAX_YOUTUBE_SEARCHES_PER_VIDEO: which search found it; 0: the archive already held it. */
  from: number;
  usable: boolean;
  why: string;
  /** VIDEO 619 — the channel YouTube's search named; absent in pools stored before it was kept. */
  channel?: string;
  /** YouTube's own licence for the video, from `videos.list`; absent when it was not reported. */
  license?: string;
  /**
   * VISUAL NEEDS — the script's subjects the look says this video really shows (the subject itself, not
   * a relative or the theme). Absent when the look was not asked (older pools): then its title,
   * description and `depicts` decide, as before.
   */
  shows?: string[];
  /** What the look saw on the thumbnail, in its own words. */
  depicts?: string;
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
  /** MULTI-PERSON SEARCH — the named subjects a search was aimed at, with that search's number. */
  entityTargets?: EntityTarget[];
  /** The number of the search aimed at the coverage gap, when one ran (absent in older pools). */
  gapSearch?: number;
  /** VISUAL NEEDS — what the script must show, as the planner read it with search #1. */
  visualNeeds?: VisualNeed[];
};

/** One targeted search: which subject, why, which search number, what it asked. */
export type EntityTarget = MissingSubject & { n: number; query: string; score: number };

/**
 * "name": a run of capitalised words the pipeline's name extractor reads as a name — a person
 * ("Kris Jenner"), but also a place, group or brand ("Tesla Fremont", "East Berliners", "Kylie
 * Cosmetics"). It is not called a person here because the extractor cannot tell; every one of them
 * is a concrete, searchable subject. "company"/"brand": the real-entity rules. "subject": a VISUAL NEED
 * the planner read from the script (`VisualNeed`) — a place, building, event, war, product, vehicle,
 * technology, animal, object, team or match, named as a whole ("Tesla Model 3", "Berlin Wall").
 */
export type NamedSubjectKind = "name" | "company" | "brand" | "subject";
export type NamedSubject = { name: string; kind: NamedSubjectKind };
/** A subject the narration names that no usable pool video names: what a targeted search is for. */
export type MissingSubject = { name: string; kind: NamedSubjectKind; beats: number[]; reason: string };
/** A named subject of the script, its sentences, its weight, and whether a usable pool video names it. */
export type NamedSubjectCoverage = MissingSubject & { score: number; covered: boolean };

export type PoolDeps = PlannerDeps & {
  store: YoutubeSearchBudgetStore;
  /** One search.list call. Only ever called after the budget granted it. */
  search: (query: string) => Promise<{ status: number; items: SearchItem[] }>;
  /** One videos.list call (1 quota unit, up to 50 ids). */
  details: (ids: string[]) => Promise<Map<string, ItemDetails>>;
  /**
   * Look at one thumbnail against the whole script — and, VISUAL NEEDS, against the script's subjects:
   * which of them the video really shows (`Triage.shows`).
   */
  triage: (item: SearchItem, title: string, sentences: string[], subjects?: readonly string[]) => Promise<Triage | null>;
  /** The archive's own YouTube-origin assets that clear its floor, as items with a thumbnail. */
  archive: (sentences: string[]) => Promise<SearchItem[]>;
  /** When the official API is in its quota cooldown, a search is not spent on a refusal. */
  inCooldown?: () => boolean;
  concurrency?: number;
  /**
   * VIDEO 640 — the people, companies and brands one sentence names (the pipeline's own extractors).
   * Absent: search #2 is decided by `search2Reasons` alone, exactly as before.
   */
  namedSubjects?: (sentence: string) => NamedSubject[];
};

const MIN_SOURCE_SEC = 10;
/**
 * P5 — the longest source the pool keeps. It was 20 minutes, "the downloader fetches whole sources
 * under an 80 MB ceiling" — no longer so: the one download route left, the cloud yt-dlp service,
 * fetches only the requested section (`download_ranges`, services/ytdlp-download/main.py) and
 * checks the 80 MB against that cut. The 20-minute line threw away the long archive compilations
 * a historical query finds most of. Two hours keeps a bound; live streams stay refused.
 */
const MAX_SOURCE_SEC = 2 * 60 * 60;

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

/**
 * VIDEO 624 — an archive item keeps the title the archive stored, and tnBQmEqBCY0 had none: the
 * clip reached the beat with an empty title, the person check had no text to read, and the only
 * fresh YouTube footage of the render was refused for `entity_evidence`. YouTube's own title,
 * description and channel came back in the videos.list answer the pool already asked for; an empty
 * or placeholder field is filled from it. A real title the item already carries is never replaced.
 */
export function withYoutubeOwnText(item: SearchItem, d: ItemDetails | null): SearchItem {
  if (!d) return item;
  const missing = (t: string | undefined) => !t?.trim() || /^YouTube [\w-]{11}$/.test(t.trim());
  return {
    ...item,
    title: missing(item.title) && d.title?.trim() ? d.title.trim() : item.title,
    description: !item.description?.trim() && d.description?.trim() ? d.description.trim() : item.description,
    channel: (!item.channel?.trim() || item.channel === "archive") && d.channel?.trim() ? d.channel.trim() : item.channel,
  };
}

/** Judge a set of items the same way, wherever they came from. */
async function judge(
  deps: PoolDeps,
  items: SearchItem[],
  details: Map<string, ItemDetails> | null,
  from: number,
  title: string,
  sentences: string[],
  subjects: readonly string[] = []
): Promise<PoolCandidate[]> {
  return mapLimit(items, deps.concurrency ?? 8, async (item) => {
    const d = details?.get(item.videoId) ?? null;
    const it = withYoutubeOwnText(item, d);
    const byTitle = judgeFootageTitle(it.title);
    let why = "ok";
    /** Video 613 — a Short is never downloaded: by its hashtag, or by its measured length. */
    const short = youtubeResultIsShort(it.title, it.description, d?.durationSec ?? null);
    if (byTitle.decision === "REJECT") why = byTitle.reason;
    else if (short) why = `youtube short (${short})`;
    /** A result whose length is unknown could be a Short: it is not looked at. */
    else if (!d) why = "no details — length unknown, may be a Short";
    else if (d?.live) why = "live";
    else if (d && d.durationSec > 0 && d.durationSec < MIN_SOURCE_SEC) why = `too short ${d.durationSec}s`;
    else if (d && d.durationSec > MAX_SOURCE_SEC) why = `too long ${Math.round(d.durationSec / 60)}min (download ceiling)`;
    else if (d && !d.embeddable) why = "not embeddable";
    const t = why === "ok" ? await deps.triage(it, title, sentences, subjects).catch(() => null) : null;
    if (why === "ok") {
      if (!t) why = "not judged";
      else if (judgeFootageType(t.footageType).decision === "REJECT") why = judgeFootageType(t.footageType).reason;
      /**
       * ONE ROUTE — "serves no beat" is not a refusal any more: whether a picture fits a sentence is
       * the VisualJudge's question, on the downloaded frames. `serves` stays as the look's ranking
       * signal (which sentences try this video first, and the order the pool is stocked in).
       */
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
      ...(d?.license ? { license: d.license } : {}),
      /** VISUAL NEEDS — only when the look was asked about the subjects and answered. */
      ...(usable && subjects.length && Array.isArray(t!.shows)
        ? { shows: [...new Set(t!.shows.filter((k) => Number.isInteger(k) && k >= 0 && k < subjects.length).map((k) => subjects[k]!))] }
        : {}),
      ...(usable && t!.depicts ? { depicts: t!.depicts } : {}),
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

/**
 * VIDEO 640 — A SUBJECT THE NARRATION NAMES THAT NO USABLE POOL VIDEO SHOWS.
 *
 * 640 searched "Kim Kardashian footage" for a film about the family's wealth. Scene 1 was about Kris
 * Jenner; the planner had refused her three times for search #1 ("built on one scene"), the pool's
 * coverage on paper was 7/13, so search #2 stayed unspent — and every moment offered to her sentence
 * showed Kim (`entity_evidence`, `does_not_fit`), while an archive clip of Kris Jenner was judged FIT
 * for that same sentence. One search of the two allowed went unused while a named person had no
 * candidate at all.
 *
 * From data the render already has: the subjects the planner read from the whole script with search
 * #1 (`VisualNeed` — people, places, events, products, vehicles …) and the names each sentence carries,
 * minus the ones a search already asked for, and only when no usable pool video SHOWS the subject —
 * the look's own answer, not a word in a title (`candidateShows`). Each missing subject, most
 * important first, gets one targeted search while the budget lasts.
 */
const SUBJECT_PRIORITY: Record<NamedSubjectKind, number> = { name: 0, subject: 0, company: 1, brand: 1 };
const SUBJECT_REASON: Record<NamedSubjectKind, string> = {
  name: "missing_named_subject",
  subject: "missing_visual_subject",
  company: "missing_company",
  brand: "missing_product",
};

/** The same subject: the same meaningful words ("Kris Jenner's" is "Kris Jenner"). */
function subjectKey(name: string): string {
  return contentWords(name.replace(/['’]s\b/gi, "")).join(" ");
}

/**
 * Does this usable candidate SHOW the subject? The look's own answer when it was asked (`shows`): a
 * video can show the Berlin Wall without "Berlin Wall" in its title, and a Kim Kardashian red carpet
 * does not show Kris Jenner however much of the family's name its title carries. Without that answer
 * (pools judged before it existed) its title, description and what the look saw (`depicts`) decide.
 */
export function candidateShows(c: Pick<PoolCandidate, "title" | "description" | "shows" | "depicts">, name: string): boolean {
  if (c.shows) return c.shows.some((s) => subjectKey(s) === subjectKey(name));
  return queryNames(`${c.title} ${c.description} ${c.depicts ?? ""}`, name);
}

/**
 * VISUAL NEEDS — every subject the script must show, from the two readers the render already has:
 * the planner's reading of the whole script (`pool.visualNeeds`: places, events, products, vehicles …
 * whole subjects, with their sentences) and the narration's own names per sentence (`namedSubjects`).
 * One subject once: when the planner's subject holds every word of a name ("Berlin Wall 1989" and
 * "Berlin Wall"), the name's sentences join the planner's subject. One-word names stay out ("Hollywood");
 * the planner may keep a one-word subject only when the narration writes it as a name ("SpaceX").
 */
export function scriptVisualNeeds(
  pool: Pick<VideoYoutubePool, "sentences" | "visualNeeds">,
  namedSubjects?: (sentence: string) => NamedSubject[]
): Array<{ name: string; kind: NamedSubjectKind; beats: number[]; listed: boolean }> {
  const out: Array<{ name: string; kind: NamedSubjectKind; beats: number[]; listed: boolean }> = [];
  for (const n of pool.visualNeeds ?? []) {
    const beats = n.beats.filter((b) => b >= 0 && b < pool.sentences.length);
    if (!subjectKey(n.subject) || !beats.length) continue;
    const same = out.find((o) => subjectKey(o.name) === subjectKey(n.subject));
    if (same) same.beats = [...new Set([...same.beats, ...beats])];
    else out.push({ name: n.subject.replace(/['’]s\b/gi, "").trim(), kind: "subject", beats, listed: true });
  }
  pool.sentences.forEach((sentence, i) => {
    for (const s of namedSubjects?.(sentence) ?? []) {
      const name = s.name.replace(/['’]s\b/gi, "").trim();
      const words = contentWords(name);
      if (!words.length || (s.kind === "name" && words.length < 2)) continue;
      const holder =
        out.find((o) => subjectKey(o.name) === words.join(" ")) ??
        out.find((o) => o.listed && words.every((w) => contentWords(o.name).includes(w)));
      if (holder) {
        if (!holder.beats.includes(i)) holder.beats.push(i);
        /** The planner named it too: it keeps the narration's kind (a person stays a person). */
        if (holder.kind === "subject" && subjectKey(holder.name) === words.join(" ")) holder.kind = s.kind;
        else if (SUBJECT_PRIORITY[s.kind] < SUBJECT_PRIORITY[holder.kind]) holder.kind = s.kind;
        continue;
      }
      out.push({ name, kind: s.kind, beats: [i], listed: false });
    }
  });
  return out;
}

/**
 * MULTI-PERSON / VISUAL NEEDS — every subject the script must show, weighed, and whether the pool shows it.
 *
 * The weight is what the script itself says about importance: the number of sentences that need the
 * subject, one more when the user's prompt or the title names it, and one more when the planner, reading
 * the whole script, listed it as something the viewer must see. A subject five sentences need comes
 * before one named in passing. Subjects a search already asked for are left out (they are the subject
 * of that search). "Covered" means a usable pool video SHOWS it (`candidateShows`): a search for it
 * would buy nothing.
 */
export function namedSubjectCoverage(
  pool: Pick<VideoYoutubePool, "candidates" | "sentences" | "query1" | "visualNeeds">,
  namedSubjects?: (sentence: string) => NamedSubject[],
  opts: { asked?: readonly string[]; important?: string } = {}
): NamedSubjectCoverage[] {
  const asked = new Set([pool.query1 ?? "", ...(opts.asked ?? [])].flatMap((q) => contentWords(q)));
  const usable = pool.candidates.filter((c) => c.usable);
  return scriptVisualNeeds(pool, namedSubjects)
    .filter((e) => !contentWords(e.name).every((w) => asked.has(w)))
    .map((e) => ({
      name: e.name,
      kind: e.kind,
      beats: [...e.beats].sort((a, b) => a - b),
      reason: SUBJECT_REASON[e.kind],
      score: e.beats.length + (opts.important && queryNames(opts.important, e.name) ? 1 : 0) + (e.listed ? 1 : 0),
      covered: usable.some((c) => candidateShows(c, e.name)),
    }))
    .sort(
      (a, b) =>
        Number(a.covered) - Number(b.covered) ||
        b.score - a.score ||
        SUBJECT_PRIORITY[a.kind] - SUBJECT_PRIORITY[b.kind] ||
        a.beats[0]! - b.beats[0]!
    );
}

/** The most important subject the pool cannot show (VIDEO 640's Kris Jenner), or null. */
export function missingNamedSubject(
  pool: Pick<VideoYoutubePool, "candidates" | "sentences" | "query1" | "visualNeeds">,
  namedSubjects?: (sentence: string) => NamedSubject[],
  opts: { asked?: readonly string[]; important?: string } = {}
): MissingSubject | null {
  const top = namedSubjectCoverage(pool, namedSubjects, opts).find((e) => !e.covered);
  return top ? { name: top.name, kind: top.kind, beats: top.beats, reason: top.reason } : null;
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
    else if (prev.usable && c.usable) {
      const shows = prev.shows || c.shows ? { shows: [...new Set([...(prev.shows ?? []), ...(c.shows ?? [])])] } : {};
      byId.set(c.videoId, { ...prev, serves: [...new Set([...prev.serves, ...c.serves])], ...shows });
    }
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
  /** VISUAL NEEDS — the subjects every look is asked about: the planner's reading plus the narration's names. */
  const subjectsToLookFor = (): string[] => scriptVisualNeeds(pool, deps.namedSubjects).map((e) => e.name);
  const persist = async (patch: Parameters<YoutubeSearchBudgetStore["record"]>[1]) =>
    deps.store.record(input.videoId, { ...patch, poolJson: JSON.stringify(pool) }).catch((err: Error) =>
      log(`[YouTubeSearchPlan] video=${input.videoId} not recorded: ${err.message?.slice(0, 120)}`)
    );

  /** A later attempt of the same video: its searches are spent, its candidates are reused. */
  if (pool.searches >= MAX_YOUTUBE_SEARCHES_PER_VIDEO || (pool.decided && refused.size === 0)) {
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
    if (plan.visualNeeds?.length) pool.visualNeeds = plan.visualNeeds;
    log(
      `[VISUAL_NEEDS] video=${input.videoId} planner=${JSON.stringify((plan.visualNeeds ?? []).map((n) => `${n.subject} [${n.beats.join(",")}]`))} ` +
        `looked_for=${JSON.stringify(subjectsToLookFor())}`
    );
    const got = await deps.search(plan.query).catch(() => ({ status: 0, items: [] as SearchItem[] }));
    const details = got.items.length ? await deps.details(got.items.map((i) => i.videoId)).catch(() => null) : null;
    pool.candidates = mergeCandidates(pool.candidates, await judge(deps, got.items, details, 1, input.title, analysis.sentences, subjectsToLookFor()));
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
  const archiveJudged = await judge(deps, archiveNew, archiveDetails ?? new Map(), 0, input.title, analysis.sentences, subjectsToLookFor());
  pool.candidates = mergeCandidates(pool.candidates, archiveJudged);
  if (!pool.decided) pool.archiveUsable = archiveJudged.filter((c) => c.usable).length;

  /* ── enough? ── */
  const reasons = search2Reasons(pool, refused);
  pool.search2Needed = reasons.length > 0;
  pool.search2Reason = reasons.join("; ");
  await persist({ archiveUsable: pool.archiveUsable, search2Needed: pool.search2Needed ? 1 : 0, search2Reason: pool.search2Reason });

  /** One search, claimed, sent, judged; its candidates carry its number. Null when not granted. */
  const runSearch = async (query: string): Promise<{ n: number; found: number; usable: number } | null> => {
    const n = pool.searches + 1;
    if (!(await claimYoutubeSearch(deps.store, input.videoId, n, log))) return null;
    pool.searches = n;
    if (n === 2) pool.query2 = query;
    const got = await deps.search(query).catch(() => ({ status: 0, items: [] as SearchItem[] }));
    const fresh = got.items.filter((i) => !pool.candidates.some((c) => c.videoId === i.videoId));
    const details = fresh.length ? await deps.details(fresh.map((i) => i.videoId)).catch(() => null) : null;
    pool.candidates = mergeCandidates(pool.candidates, await judge(deps, fresh, details, n, input.title, analysis.sentences, subjectsToLookFor()));
    const usable = pool.candidates.filter((c) => c.from === n && c.usable).length;
    if (n === 2) {
      await persist({
        search2CompletedAt: new Date(),
        search2Query: query,
        search2Status: got.status === 200 ? "ok" : `http_${got.status}`,
        search2Candidates: got.items.length,
        search2Usable: usable,
      });
    } else {
      await persist({});
    }
    return { n, found: got.items.length, usable };
  };

  /* ── the coverage gap: only for a real gap, only a different question, once ── */
  const gapAlreadySearched = pool.gapSearch != null || (pool.gapSearch === undefined && pool.searches >= 2 && !pool.entityTargets?.length);
  if (pool.search2Needed && pool.searches >= 1 && pool.searches < MAX_YOUTUBE_SEARCHES_PER_VIDEO && !gapAlreadySearched && !deps.inCooldown?.()) {
    const plan = await planGapQuery(deps, input, analysis, { query1: pool.query1 ?? "", uncovered: gapOf(pool, refused) });
    const ran = plan ? await runSearch(plan.query) : null;
    if (ran) pool.gapSearch = ran.n;
  }

  /**
   * MULTI-PERSON SEARCH — the named people and entities the pool cannot show, most important first,
   * one targeted search each while the budget lasts. Coverage is measured again after every search:
   * a video that shows two of them answers both. Only when the pool is first built; a top-up after
   * on-screen refusals keeps to the coverage gap above.
   */
  if (!pool.decided && pool.searches >= 1 && (deps.namedSubjects || pool.visualNeeds?.length)) {
    const important = `${input.prompt} ${input.title}`;
    const asked = () => [pool.query1 ?? "", ...(pool.entityTargets ?? []).map((t) => t.query), pool.query2 ?? ""].filter(Boolean);
    const first = namedSubjectCoverage(pool, deps.namedSubjects, { asked: asked(), important });
    const covered = first.filter((e) => e.covered);
    const missing = first.filter((e) => !e.covered);
    log(`[MULTI_PERSON_SEARCH] video=${input.videoId} entities=${first.length} ${JSON.stringify(first.map((e) => e.name))}`);
    log(
      `[MULTI_PERSON_COVERAGE] video=${input.videoId} covered=${covered.map((e) => e.name).join(",") || "none"} ` +
        `missing=${missing.map((e) => e.name).join(",") || "none"}`
    );
    if (missing.length) {
      log(
        `[MULTI_PERSON_PRIORITY] video=${input.videoId} ` +
          missing.map((e, i) => `${i + 1}=${e.name}(score=${e.score},beats=[${e.beats.join(",")}])`).join(" ")
      );
    }
    const tried = new Set<string>();
    while (pool.searches < MAX_YOUTUBE_SEARCHES_PER_VIDEO && !deps.inCooldown?.()) {
      const next = namedSubjectCoverage(pool, deps.namedSubjects, { asked: asked(), important }).find(
        (e) => !e.covered && !tried.has(e.name)
      );
      if (!next) break;
      tried.add(next.name);
      const plan = planEntityQuery(deps, input, analysis, { name: next.name, asked: asked() });
      if (!plan) continue;
      const ran = await runSearch(plan.query);
      if (!ran) break;
      (pool.entityTargets ??= []).push({ name: next.name, kind: next.kind, beats: next.beats, reason: next.reason, n: ran.n, query: plan.query, score: next.score });
      log(
        `[MULTI_PERSON_SEARCH] video=${input.videoId} search=#${ran.n} entity="${next.name}" reason=${next.reason} ` +
          `query="${plan.query}" candidates=${ran.found} usable=${ran.usable} ` +
          `sentences=${JSON.stringify(next.beats.map((b) => analysis.sentences[b]?.slice(0, 90)))}`
      );
    }
    /**
     * VIDEO 641 — every need of the script, one line each: its sentences, its kind, its weight, whether
     * the pool showed it before a search, and which search (if any) was aimed at it.
     */
    const gapQuery = pool.gapSearch === 2 ? pool.query2 : null;
    const askedBy = (name: string): string | null => {
      const words = contentWords(name);
      if (pool.query1 && words.every((w) => contentWords(pool.query1!).includes(w))) return `#1 query="${pool.query1}" (main search)`;
      if (gapQuery && words.every((w) => contentWords(gapQuery).includes(w))) return `#2 query="${gapQuery}" (coverage gap)`;
      return null;
    };
    for (const e of namedSubjectCoverage({ ...pool, query1: null }, deps.namedSubjects, { important })) {
      const target = (pool.entityTargets ?? []).find((t) => t.name === e.name);
      const before = first.find((f) => f.name === e.name);
      const asked = target ? `#${target.n} query="${target.query}"` : askedBy(e.name);
      log(
        `[VISUAL_NEED] video=${input.videoId} subject="${e.name}" kind=${e.kind} ` +
          `sentences=[${e.beats.join(",")}] score=${e.score} covered_before=${before ? (before.covered ? "yes" : "no") : "asked"} ` +
          `searched=${asked ?? "no"} covered_now=${e.covered ? "yes" : "no"}` +
          (asked || before?.covered ? "" : ` reason=${pool.searches >= MAX_YOUTUBE_SEARCHES_PER_VIDEO ? "budget_spent" : "no_query"}`)
      );
    }
    const targeted = pool.entityTargets ?? [];
    log(
      `[MULTI_PERSON_SUMMARY] video=${input.videoId} searches=${pool.searches} budget=${MAX_YOUTUBE_SEARCHES_PER_VIDEO} ` +
        `targeted_searches=${targeted.length} ` +
        `targeted_candidates=${pool.candidates.filter((c) => targeted.some((t) => t.n === c.from)).length} ` +
        `targeted_usable=${pool.candidates.filter((c) => c.usable && targeted.some((t) => t.n === c.from)).length}`
    );
  }

  pool.finalCoverage = coverageOf(pool.candidates);
  pool.decided = true;
  await persist({ finalCoverage: pool.finalCoverage });
  log(formatSearchPlan(pool));
  log(`[YouTubeSearchPlan] video=${input.videoId} YouTube search DONE for this video — the rest goes to archive, open sources, stock, AI`);
  return pool;
}

/**
 * MULTI-PERSON SEARCH — what each targeted search finally became, read at the end of the render
 * from the YouTube lifecycle rows (one per moment): downloaded, adopted (every adoption had the
 * picture editor's FIT for its own sentence), and in the final video. One line per subject, then
 * the totals — the line that says whether the right person reached the right sentence.
 */
export function formatMultiPersonOutcome(
  videoId: number,
  pool: Pick<VideoYoutubePool, "entityTargets" | "candidates" | "searches">,
  rows: ReadonlyArray<{ providerAssetId?: string; sceneIndex: number; beatIndex: number; downloaded: boolean; adopted: boolean; finalVideo: boolean }>,
  /**
   * VIDEO 641 — the YouTube footage of the rendered timeline (`youtubeFootageInTimeline().clips`). An
   * archive clip cut from a targeted answer reaches the film under the archive's id, which the
   * lifecycle rows do not carry; the timeline's origin (`youtube_via_archive`) does.
   */
  film: ReadonlyArray<{ videoId: string | null; origin: string; seconds: number }> = [],
  /**
   * VIDEO 641 — the film's stock per answer (`stockVideoState`). `downloaded` counts lifecycle rows,
   * which exist only once a sentence was offered a moment: I6dUAtWoTII was downloaded, cut into two
   * shots and never offered, and counted as nothing. Said apart: stock_downloaded, stock_offered.
   */
  stock?: (videoId: string) => { status: "pending" | "ready" | "failed"; offered: boolean } | null
): string[] {
  const targets = pool.entityTargets ?? [];
  if (!targets.length) return [];
  const lines: string[] = [];
  const total = { downloaded: 0, adopted: 0, final: 0, filmSec: 0, stockDownloaded: 0, stockOffered: 0 };
  for (const t of targets) {
    const ids = new Set(pool.candidates.filter((c) => c.from === t.n).map((c) => c.videoId));
    const mine = rows.filter((r) => r.providerAssetId != null && ids.has(r.providerAssetId));
    const inFilm = film.filter((f) => f.videoId != null && ids.has(f.videoId));
    const filmSec = Number(inFilm.reduce((a, f) => a + f.seconds, 0).toFixed(2));
    const n = { downloaded: mine.filter((r) => r.downloaded).length, adopted: mine.filter((r) => r.adopted).length, final: mine.filter((r) => r.finalVideo).length };
    total.downloaded += n.downloaded;
    total.adopted += n.adopted;
    total.final += n.final;
    total.filmSec += filmSec;
    const stockOf = (id: string) => stock?.(id) ?? null;
    const stockDownloaded = [...ids].filter((id) => stockOf(id)?.status === "ready").length;
    const stockOffered = [...ids].filter((id) => stockOf(id)?.status === "ready" && stockOf(id)!.offered).length;
    total.stockDownloaded += stockDownloaded;
    total.stockOffered += stockOffered;
    const finals = mine.filter((r) => r.finalVideo).map((r) => `s${r.sceneIndex}b${r.beatIndex}`);
    lines.push(
      `[MULTI_PERSON_OUTCOME] video=${videoId} entity="${t.name}" search=#${t.n} downloaded=${n.downloaded} adopted=${n.adopted} ` +
        `final=${n.final}${finals.length ? ` finalBeats=${finals.join(",")}` : ""} entityBeats=[${t.beats.join(",")}]` +
        (film.length ? ` filmSec=${filmSec}` : "") +
        (stock ? ` stock_downloaded=${stockDownloaded} stock_offered=${stockOffered}` : "")
    );
    /** One line per answer that got anywhere: how far it came, sentence by sentence. */
    for (const id of ids) {
      const r = mine.filter((x) => x.providerAssetId === id);
      const f = inFilm.filter((x) => x.videoId === id);
      if (!r.length && !f.length) {
        /** Never offered to a sentence: what its stock download came to, if it had one. */
        const st = stockOf(id);
        if (st && st.status !== "pending") {
          lines.push(
            `[TARGETED_VISUAL] video=${videoId} subject="${t.name}" search=#${t.n} videoId=${id} ` +
              `stage=${st.status === "ready" ? (st.offered ? "STOCK_OFFERED" : "STOCK_READY_NOT_OFFERED") : "STOCK_DOWNLOAD_FAILED"}`
          );
        }
        continue;
      }
      const stage = r.some((x) => x.finalVideo) || f.length ? "FINAL_VIDEO" : r.some((x) => x.adopted) ? "ADOPTED" : r.some((x) => x.downloaded) ? "DOWNLOADED" : "FOUND";
      lines.push(
        `[TARGETED_VISUAL] video=${videoId} subject="${t.name}" search=#${t.n} videoId=${id} stage=${stage} ` +
          `sentences=[${[...new Set(r.map((x) => `s${x.sceneIndex}b${x.beatIndex}`))].join(",")}]` +
          (f.length ? ` filmSec=${Number(f.reduce((a, x) => a + x.seconds, 0).toFixed(2))} via=${[...new Set(f.map((x) => x.origin))].join("+")}` : "")
      );
    }
  }
  lines.push(
    `[MULTI_PERSON_SUMMARY] video=${videoId} searches=${pool.searches} targeted_searches=${targets.length} ` +
      `targeted_downloaded=${total.downloaded} targeted_adopted=${total.adopted} targeted_final=${total.final}` +
      (film.length ? ` targeted_film_sec=${Number(total.filmSec.toFixed(2))}` : "") +
      (stock ? ` targeted_stock_downloaded=${total.stockDownloaded} targeted_stock_offered=${total.stockOffered}` : "")
  );
  return lines;
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
  return !pool.candidates.some((c) => c.usable && c.from >= 1);
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
 * VIDEO 628 — the video has a pool that is not known to have come back without YouTube. A pool
 * still being built counts: the beat's own route waits for it and reads `poolGaveNoYoutube` then.
 */
export function videoPoolMayOfferYoutube(videoId: number | undefined | null): boolean {
  return hasVideoYoutubePool(videoId) && !poolsWithoutYoutube.has(videoId!);
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
  /** YouTube's own licence for the video, as the pool recorded it; absent when not reported. */
  license?: string;
  /**
   * W2 (video 636) — the pool's look judged this video to serve THIS sentence. Kept on the row, so
   * the order it gives survives the thumbnail ranker that re-sorts the rows afterwards.
   */
  servesBeat?: boolean;
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
  /** Kept for the callers; the look, not a name string, decides since video 624. */
  _requiredPersonName = ""
): PoolRow[] {
  const mine = new Set(beatSentences(pool, beatText));
  const rows: PoolRow[] = [];
  const servesMine = new Set<string>();
  for (const c of pool.candidates) {
    if (!c.usable) continue;
    const hay = `${c.title} ${c.description}`.toLowerCase();
    /**
     * VIDEO 624 — FIRST LOOK, THEN DOWNLOAD. The pool looked at every candidate's thumbnail and said
     * which sentences it serves. RONDE 659's rule still holds: a video the look judged to serve this
     * beat is never second-guessed by a name string.
     *
     * ONE ROUTE — the look RANKS, it does not refuse: a usable video it did not assign to this
     * sentence is still offered, after every one it did. Whether the picture fits is the
     * VisualJudge's answer on the downloaded frames.
     */
    if (c.serves.some((s) => mine.has(s))) servesMine.add(c.videoId);
    const text = relevanceKeywords.filter((k) => k.length >= 3 && hay.includes(k.toLowerCase())).length;
    rows.push({
      item: { id: { videoId: c.videoId }, snippet: { title: c.title, description: c.description, channelTitle: c.channel, thumbnails: { high: { url: c.thumb } } } },
      title: c.title,
      desc: c.description,
      thumb: c.thumb,
      rel: Math.max(3, text + 3),
      durationSec: c.durationSec > 0 ? c.durationSec : 0,
      ...(c.license ? { license: c.license } : {}),
    });
  }
  for (const r of rows) if (servesMine.has(r.item.id.videoId)) r.servesBeat = true;
  const serving = (r: PoolRow) => (servesMine.has(r.item.id.videoId) ? 1 : 0);
  return rows.sort((a, b) => serving(b) - serving(a) || b.rel - a.rel);
}
