/**
 * VIDEO 620 — YOUTUBE IS FETCHED BEFORE THE FILM IS PUT TOGETHER, NOT WHILE IT IS.
 *
 * ── What video 620 showed ────────────────────────────────────────────────────────────────────
 *
 * The whole picture stage of a one-minute film has two minutes and forty-five seconds. One YouTube
 * download took 38 s, another failed once, ran into its 120 s limit and arrived after more than two
 * minutes. Every beat started its own download of the same few videos, and a clip that arrived
 * after its beat had moved on was archived and never shown: two YouTube videos were downloaded in
 * that render and neither reached the film.
 *
 * ── What this does ───────────────────────────────────────────────────────────────────────────
 *
 * As soon as the video's YouTube search is decided (the pool), the usable videos are downloaded
 * straight away — a section of each, a few at a time, while the voice-over is still being made —
 * and each section is cut into single shots. A beat then takes a shot from this stock instead of
 * downloading: instantly when it is there, and when that video's section is still on its way the
 * beat waits for that one download instead of starting a second one of the same video.
 *
 * The picture editor is not bypassed: a stock shot goes through exactly the same judgement as a
 * clip downloaded for the beat.
 *
 * A shot is not used up by being handed out. Render 620's lost clips were handed to a beat whose
 * turn had already ended; a shot handed out the same way here stays in the stock. It stops being
 * offered when the picture editor refused it or when its seconds are already in the film (the
 * caller's own checks) — another shot of the same video is still welcome. Between the shots that
 * are left, the one handed out least goes first, so beats running at the same time get different
 * shots.
 */
import * as fs from "fs";
import * as path from "path";

import { chooseMoments } from "./youtubeMoments";

/** Seconds taken from each YouTube video: enough for several shots, small enough to arrive quickly. */
export const STOCK_SECTION_SEC = 40;
/** At most this many videos are stocked for one film — W3: this many READY, not this many tried. */
export const MAX_STOCK_VIDEOS = 6;
/**
 * W3 (video 636) — the most downloads the stock starts for one film. 636 stocked six, three failed
 * (502, 502, no video stream) and nothing took their place while eight usable videos of the same
 * search waited. A failed download now hands its place to the next usable candidate, up to this
 * many attempts in all: three replacements, from the results the search already brought back.
 */
export const MAX_STOCK_ATTEMPTS = MAX_STOCK_VIDEOS + 3;
/** Downloads running at the same time. */
export const STOCK_CONCURRENCY = 3;

export type StockCandidate = {
  videoId: string;
  title: string;
  durationSec: number;
  /** How many of the script's sentences this video was judged to serve — the most useful first. */
  serves: number;
  /** W6 — a recent same-subject video already showed this source: it is stocked after the fresh ones. */
  shownRecently?: boolean;
  /**
   * VIDEO 640 — found by search #2 for a subject no other pool video shows. Stocked first: no beat
   * downloads outside the stock any more (637–640: `downloads=0`), so a rescue candidate that is not
   * stocked never reaches its sentence. The caller marks at most two.
   */
  rescue?: boolean;
};

export type StockShot = {
  videoId: string;
  title: string;
  path: string;
  /** Where in the YouTube video this shot starts and ends, in seconds. */
  sourceStartSec: number;
  sourceEndSec: number;
  /** How many beats this shot was offered to. */
  handedOut: number;
};

export type StockDeps = {
  workDir: string;
  /** Download `durationSec` of the video from `startSec` into `outPath`. True when a file arrived. */
  download: (videoId: string, startSec: number, durationSec: number, outPath: string, title: string) => Promise<boolean>;
  /** Cut a local file into single shots; each piece carries its seconds inside the file. */
  cut: (filePath: string, workDir: string) => Promise<Array<{ path: string; startSec: number; endSec: number }>>;
  /** Where in a video of this length the section starts. */
  startFor: (durationSec: number, takeSec: number, videoId: string) => number;
  log?: (line: string) => void;
  /** W3 — asked before a replacement starts: a video the render has meanwhile written off is passed over. */
  skip?: (videoId: string) => boolean;
};

type Entry = { status: "pending" | "ready" | "failed"; done: Promise<void>; shots: StockShot[]; reason?: string };

/** Per film (render video id): YouTube video id → its stock. */
const stocks = new Map<number, Map<string, Entry>>();

/**
 * The order a pool's usable videos are stocked in: a search #2 rescue candidate first (VIDEO 640),
 * then fresh sources before ones a recent same-subject video showed (W6), then the most sentences
 * served, then the list order.
 */
export function stockOrder(candidates: readonly StockCandidate[], max = MAX_STOCK_VIDEOS): StockCandidate[] {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        Number(Boolean(b.c.rescue)) - Number(Boolean(a.c.rescue)) ||
        Number(Boolean(a.c.shownRecently)) - Number(Boolean(b.c.shownRecently)) ||
        b.c.serves - a.c.serves ||
        a.i - b.i
    )
    .slice(0, max)
    .map((x) => x.c);
}

/**
 * Start stocking a film's YouTube videos. Returns at once; every video's download and cut runs in
 * the background, `STOCK_CONCURRENCY` at a time.
 */
export function startYoutubeShotStock(filmId: number, candidates: readonly StockCandidate[], deps: StockDeps): void {
  const say = deps.log ?? ((l: string) => console.log(l));
  const film = stocks.get(filmId) ?? new Map<string, Entry>();
  stocks.set(filmId, film);
  const queue = stockOrder(candidates, candidates.length).filter((c) => !film.has(c.videoId));
  const todo = queue.slice(0, MAX_STOCK_VIDEOS);
  /** W3 — the rest of the search's usable videos, in the same order: replacements for failures. */
  const spare = queue.slice(MAX_STOCK_VIDEOS);
  if (!todo.length) return;
  say(`[YouTubeStock] film=${filmId} stocking ${todo.length} video(s) before the beats need them`);

  const releases = new Map<string, () => void>();
  const register = (c: StockCandidate): void => {
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    film.set(c.videoId, { status: "pending", done, shots: [] });
    releases.set(c.videoId, release);
  };
  for (const c of todo) register(c);
  let attempts = 0;
  let inFlight = 0;
  const readyNow = () => [...film.values()].filter((e) => e.status === "ready").length;
  /**
   * The next video to fetch: the planned ones first; then a replacement, only while fewer than
   * MAX_STOCK_VIDEOS are ready or on their way and the attempts allow it. A replacement enters the
   * film's stock only when it starts, so until then a beat may still fetch that video itself.
   */
  const nextCandidate = (): StockCandidate | null => {
    const planned = todo.shift();
    if (planned) return planned;
    while (spare.length > 0 && attempts < MAX_STOCK_ATTEMPTS && readyNow() + inFlight < MAX_STOCK_VIDEOS) {
      const c = spare.shift()!;
      if (film.has(c.videoId) || deps.skip?.(c.videoId)) continue;
      register(c);
      say(`[YouTubeStock] film=${filmId} video=${c.videoId} replaces a failed download (${readyNow()} ready so far)`);
      return c;
    }
    return null;
  };
  const worker = async () => {
    for (;;) {
      const c = nextCandidate();
      if (!c) return;
      attempts++;
      inFlight++;
      const entry = film.get(c.videoId)!;
      const take = c.durationSec > 0 ? Math.min(STOCK_SECTION_SEC, c.durationSec) : STOCK_SECTION_SEC;
      const startSec = c.durationSec > 0 ? deps.startFor(c.durationSec, take, c.videoId) : 0;
      const outPath = path.join(deps.workDir, `ytstock_${c.videoId}_${Math.round(startSec)}.mp4`);
      const t0 = Date.now();
      try {
        const ok = await deps.download(c.videoId, startSec, take, outPath, c.title);
        if (!ok || !fs.existsSync(outPath)) {
          entry.status = "failed";
          entry.reason = "the download delivered nothing";
        } else {
          /** Each video's shots in their own folder: the cutter names its pieces shot_1, shot_2, … */
          const pieceDir = path.join(deps.workDir, `ytstock_${c.videoId}_shots`);
          fs.mkdirSync(pieceDir, { recursive: true });
          const pieces = await deps.cut(outPath, pieceDir);
          entry.shots = pieces.map((p) => ({
            videoId: c.videoId,
            title: c.title,
            path: p.path,
            sourceStartSec: Number((startSec + p.startSec).toFixed(2)),
            sourceEndSec: Number((startSec + p.endSec).toFixed(2)),
            handedOut: 0,
          }));
          entry.status = entry.shots.length ? "ready" : "failed";
          if (!entry.shots.length) entry.reason = "no single shot long enough to use";
        }
      } catch (err) {
        entry.status = "failed";
        entry.reason = (err as Error)?.message?.slice(0, 120) ?? "threw";
      }
      inFlight--;
      say(
        `[YouTubeStock] film=${filmId} video=${c.videoId} ${entry.status} in ${Math.round((Date.now() - t0) / 1000)}s` +
          (entry.status === "ready" ? ` — ${entry.shots.length} shot(s)` : ` — ${entry.reason}`)
      );
      releases.get(c.videoId)?.();
    }
  };
  for (let k = 0; k < Math.min(STOCK_CONCURRENCY, todo.length); k++) void worker();
}

/** Whether this video is in the film's stock at all (on its way, ready or failed). */
export function isStocked(filmId: number, videoId: string): boolean {
  return stocks.get(filmId)?.has(videoId) ?? false;
}

/** VIDEO 636 — whether this video's shots are already cut and waiting (no download left to do). */
export function isStockReady(filmId: number, videoId: string): boolean {
  return stocks.get(filmId)?.get(videoId)?.status === "ready";
}

/**
 * VIDEO 636 — the beat's YouTube rows with the videos already in the film's stock first.
 *
 * The thumbnail ranker put an unstocked BBC interview first for nearly every sentence (similarities
 * of 0.28–0.31: barely an opinion), so a beat spent its turn on a 63 s download while three stocked
 * videos — "Tesla Factory Tour with Elon Musk!" among them — waited unseen, one of them for the whole
 * render. A ready video costs nothing; the picture editor still judges every moment of it. The
 * ranker's order is kept inside each group.
 */
export function stockedRowsFirst<T>(rows: readonly T[], ready: (row: T) => boolean): T[] {
  return [...rows.filter((r) => ready(r)), ...rows.filter((r) => !ready(r))];
}

/**
 * W2 (video 636) — THE ORDER A BEAT'S YOUTUBE ROWS ARE TRIED IN.
 *
 * 636's mr9kK0_7x08 was cut and ready with five shots and was never offered: the thumbnail ranker
 * re-sorted every beat's rows and the top-five slice let it fall. The ranker's order is kept inside
 * each group; the groups say what is already known about a row:
 *
 *   first  ready in the film's stock AND judged by the pool to serve this sentence — offered
 *          whatever its thumbnail rank (no download, the Judge still judges every moment)
 *   rest   other ready stock, then rows still to download that serve the sentence, then the other
 *          downloads, then — W6 — sources a recent same-subject video already showed
 *
 * `first` only ever holds stock (at most the film's few stocked videos), so it cannot grow the
 * number of downloads; the caller applies its usual limits to `rest`.
 */
export function beatRowsInStockOrder<T>(
  rows: readonly T[],
  is: { ready: (row: T) => boolean; serves: (row: T) => boolean; shownRecently: (row: T) => boolean }
): { first: T[]; rest: T[] } {
  const first: T[] = [];
  const otherReady: T[] = [];
  const servingDownload: T[] = [];
  const otherDownload: T[] = [];
  const shown: T[] = [];
  for (const r of rows) {
    if (is.shownRecently(r)) shown.push(r);
    else if (is.ready(r)) (is.serves(r) ? first : otherReady).push(r);
    else (is.serves(r) ? servingDownload : otherDownload).push(r);
  }
  return { first, rest: [...otherReady, ...servingDownload, ...otherDownload, ...shown] };
}

export type StockTake =
  | { shot: StockShot }
  /** Why no shot: not in the stock, its section still on its way, its download failed, or every shot refused. */
  | { shot: null; reason: "not_stocked" | "still_downloading" | "download_failed" | "all_refused" };

/**
 * A stock shot of this video for a beat, waiting at most `maxWaitMs` for the video's section to
 * arrive. `refused` names the shots the picture editor already turned down this film.
 */
export async function takeStockShot(
  filmId: number,
  videoId: string,
  maxWaitMs: number,
  refused: (shot: StockShot) => boolean = () => false
): Promise<StockTake> {
  const took = await takeStockShots(filmId, videoId, maxWaitMs, refused, 1);
  return took.shots.length ? { shot: took.shots[0]! } : { shot: null, reason: took.reason! };
}

export type StockTakeMany =
  | { shots: StockShot[]; reason?: undefined }
  | { shots: []; reason: "not_stocked" | "still_downloading" | "download_failed" | "all_refused" };

/**
 * OCTOBER 2026 — up to `max` shots of this video for one beat, so the picture editor chooses the
 * moment instead of whichever shot happened to be handed out least (see `youtubeMoments.ts`).
 */
export async function takeStockShots(
  filmId: number,
  videoId: string,
  maxWaitMs: number,
  refused: (shot: StockShot) => boolean = () => false,
  max = 1
): Promise<StockTakeMany> {
  const entry = stocks.get(filmId)?.get(videoId);
  if (!entry) return { shots: [], reason: "not_stocked" };
  if (entry.status === "pending" && maxWaitMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([entry.done, new Promise<void>((r) => (timer = setTimeout(r, maxWaitMs)))]);
    if (timer) clearTimeout(timer);
  }
  if (entry.status === "pending") return { shots: [], reason: "still_downloading" };
  if (entry.status === "failed") return { shots: [], reason: "download_failed" };
  const open = entry.shots.filter((s) => !refused(s));
  if (!open.length) return { shots: [], reason: "all_refused" };
  const picks = chooseMoments(open, max);
  for (const s of picks) s.handedOut++;
  return { shots: picks };
}

/** What the film's stock came to, for the render's summary. */
export function stockSummary(filmId: number): { videos: number; ready: number; failed: number; shots: number; handedOut: number } {
  const film = stocks.get(filmId);
  const all = film ? [...film.values()] : [];
  return {
    videos: all.length,
    ready: all.filter((e) => e.status === "ready").length,
    failed: all.filter((e) => e.status === "failed").length,
    shots: all.reduce((n, e) => n + e.shots.length, 0),
    handedOut: all.reduce((n, e) => n + e.shots.filter((s) => s.handedOut > 0).length, 0),
  };
}

/** P5 — resolves when every video in the film's stock is ready or failed (at once when there is none). */
export function youtubeStockSettled(filmId: number): Promise<void> {
  const film = stocks.get(filmId);
  return Promise.all([...(film?.values() ?? [])].map((e) => e.done)).then(() => undefined);
}

export function releaseYoutubeShotStock(filmId: number): void {
  stocks.delete(filmId);
}
