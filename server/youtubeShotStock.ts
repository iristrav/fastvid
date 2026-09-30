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

/** Seconds taken from each YouTube video: enough for several shots, small enough to arrive quickly. */
export const STOCK_SECTION_SEC = 40;
/** At most this many videos are stocked for one film. */
export const MAX_STOCK_VIDEOS = 6;
/** Downloads running at the same time. */
export const STOCK_CONCURRENCY = 3;

export type StockCandidate = {
  videoId: string;
  title: string;
  durationSec: number;
  /** How many of the script's sentences this video was judged to serve — the most useful first. */
  serves: number;
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
};

type Entry = { status: "pending" | "ready" | "failed"; done: Promise<void>; shots: StockShot[]; reason?: string };

/** Per film (render video id): YouTube video id → its stock. */
const stocks = new Map<number, Map<string, Entry>>();

/** The order a pool's usable videos are stocked in: the most sentences served first, then the list order. */
export function stockOrder(candidates: readonly StockCandidate[], max = MAX_STOCK_VIDEOS): StockCandidate[] {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.serves - a.c.serves || a.i - b.i)
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
  const todo = stockOrder(candidates).filter((c) => !film.has(c.videoId));
  if (!todo.length) return;
  say(`[YouTubeStock] film=${filmId} stocking ${todo.length} video(s) before the beats need them`);

  let next = 0;
  const releases: Array<() => void> = [];
  for (const c of todo) {
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    film.set(c.videoId, { status: "pending", done, shots: [] });
    releases.push(release);
  }
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= todo.length) return;
      const c = todo[i]!;
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
      say(
        `[YouTubeStock] film=${filmId} video=${c.videoId} ${entry.status} in ${Math.round((Date.now() - t0) / 1000)}s` +
          (entry.status === "ready" ? ` — ${entry.shots.length} shot(s)` : ` — ${entry.reason}`)
      );
      releases[i]!();
    }
  };
  for (let k = 0; k < Math.min(STOCK_CONCURRENCY, todo.length); k++) void worker();
}

/** Whether this video is in the film's stock at all (on its way, ready or failed). */
export function isStocked(filmId: number, videoId: string): boolean {
  return stocks.get(filmId)?.has(videoId) ?? false;
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
  const entry = stocks.get(filmId)?.get(videoId);
  if (!entry) return { shot: null, reason: "not_stocked" };
  if (entry.status === "pending" && maxWaitMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([entry.done, new Promise<void>((r) => (timer = setTimeout(r, maxWaitMs)))]);
    if (timer) clearTimeout(timer);
  }
  if (entry.status === "pending") return { shot: null, reason: "still_downloading" };
  if (entry.status === "failed") return { shot: null, reason: "download_failed" };
  let best: StockShot | null = null;
  for (const s of entry.shots) {
    if (refused(s)) continue;
    if (!best || s.handedOut < best.handedOut) best = s;
  }
  if (!best) return { shot: null, reason: "all_refused" };
  best.handedOut++;
  return { shot: best };
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

export function releaseYoutubeShotStock(filmId: number): void {
  stocks.delete(filmId);
}
