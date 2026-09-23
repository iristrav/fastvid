/**
 * YOUTUBE, FETCHED WHEN NOTHING IS WAITING FOR IT — RONDE 640.
 *
 * ── What render 603 measured ────────────────────────────────────────────────────────────────
 *
 *     youtubeFound=49  youtubeDownloaded=0
 *     ~45 of 59 attempts: scene_budget_too_short_to_start (0–10s left)
 *
 * Search works. The download is the step that fails, and it fails for one reason above all the
 * others: by the time YouTube's turn comes, the scene has seconds left. Rounds 52 to 639 tuned how
 * a download copes inside that window — shares, floors, latches, preflights, a source memo — and
 * every one of them was right about the window and none of them could make it bigger.
 *
 * ── What this does instead ──────────────────────────────────────────────────────────────────
 *
 * A render WRITES DOWN what it found (`enqueueYoutubePrefetch`): video id, title, the query that
 * found it and the licence mode it was found under. That costs one INSERT and never waits.
 *
 * When no render is running, the worker FETCHES from that list (`runYoutubePrefetchBatch`) with a
 * five-minute window per segment instead of a scene's last seconds, cuts a few segments out of
 * each video, and hands them to the curated archive through the one door every external clip
 * already uses — `ingestExternalClipToArchiveWithReason`, with its stock exclusion, quality gate,
 * baked-text gate and source-URL dedup, none of which is touched.
 *
 * A later render finds them there, and judges each one against its own beat like any other
 * archive clip. Nothing here says a video is RELEVANT; it says it was found and fetched.
 *
 * ── What it deliberately is not ─────────────────────────────────────────────────────────────
 *
 *   · Not a second downloader. Every byte comes through the pipeline's own
 *     `downloadYouTubeCCClip` — the same routes, the same refusal memo, the same licence rules.
 *   · Not a competitor for a render. It starts only when neither the generation queue nor the
 *     render-job worker has anything running in this process, and checks again before every
 *     segment. A segment already in flight when a render starts finishes; nothing new starts.
 *   · Not a gate. It never refuses, delays or fails a render; the enqueue swallows every error.
 *   · Not a promise about the first render on a new subject. That render finds the videos; the
 *     ones after it are the ones that get them.
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { and, asc, eq, inArray, lt, lte, or } from "drizzle-orm";
import { youtubePrefetchQueue, type YoutubePrefetchRow } from "../drizzle/schema";
import { affectedRowCount, getDb } from "./db";
import type { IngestMetadata, IngestOutcome } from "./archiveIngestion";
import { inferArchiveAssetTagsFromTitle } from "./visualBeatTags";

/* ═══════════════════════ knobs — every one bounded ═══════════════════════ */

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** On unless ENABLE_YOUTUBE_PREFETCH=false. It also needs YouTube sourcing and archive ingestion. */
export function youtubePrefetchEnabled(): boolean {
  return process.env.ENABLE_YOUTUBE_PREFETCH !== "false";
}

/** How many new videos one render may add. A render that searches forty queries adds forty, not 400. */
export function prefetchEnqueueCapPerRender(): number {
  return intEnv("YOUTUBE_PREFETCH_ENQUEUE_PER_RENDER", 40, 0, 500);
}

/** Segments cut out of one video. Each becomes its own archive clip, judged on its own. */
export function prefetchSegmentsPerVideo(): number {
  return intEnv("YOUTUBE_PREFETCH_SEGMENTS", 3, 1, 6);
}

/** Videos per quiet batch. Small, so a render that starts mid-batch waits for at most one segment. */
export function prefetchVideosPerBatch(): number {
  return intEnv("YOUTUBE_PREFETCH_BATCH", 3, 1, 20);
}

/** How often the worker looks for a quiet moment. */
export function prefetchIntervalMs(): number {
  return intEnv("YOUTUBE_PREFETCH_INTERVAL_MIN", 3, 1, 120) * 60_000;
}

/**
 * One archive clip's length. Well inside the archive's own 3–120s admission window, and long
 * enough that a beat's trim has room to choose.
 */
export const PREFETCH_SEGMENT_SEC = 30;

/**
 * The window one segment's download gets. This is the whole point of the module: a render gives a
 * YouTube download what a scene has left, often nothing; this gives it five minutes, which the
 * pipeline's own shares then split between its two routes exactly as they always do.
 */
export const PREFETCH_DOWNLOAD_WINDOW_MS = 5 * 60_000;

/** After this many tries a video is left alone. `failed` rows past it are never claimed again. */
export const PREFETCH_MAX_ATTEMPTS = 4;

/** A `fetching` row older than this belonged to a worker that died mid-fetch. */
export const PREFETCH_STALE_CLAIM_MS = 30 * 60_000;

/** 15 min, 1 h, 4 h, then a day: a route that is down now is often up in an hour. */
export function prefetchBackoffMs(attempts: number): number {
  const base = 15 * 60_000;
  return Math.min(24 * 60 * 60_000, base * 4 ** Math.max(0, attempts - 1));
}

/* ═══════════════════════ which seconds of a video ═══════════════════════ */

/**
 * Where in a video the segments start, or null when its length is unknown.
 *
 * Spread across the body of the video — 15% to 80% — because the first seconds of a documentary
 * are its title card and the last are its credits, and neither is a picture any beat wants.
 * Segments never overlap: two starts closer than one segment collapse into one.
 *
 * Null rather than a guess. The caller then asks for ONE segment and lets the download layer
 * re-derive the start from the real file (`startIsExact=false`), which is what it already does
 * whenever it has no length to go on.
 */
export function prefetchSegmentStarts(
  sourceDurationSec: number,
  segmentSec: number,
  maxSegments: number
): number[] | null {
  if (!(sourceDurationSec > 0) || !(segmentSec > 0) || maxSegments < 1) return null;
  if (sourceDurationSec <= segmentSec + 5) return [0];
  const lastStart = Math.floor(sourceDurationSec - segmentSec);
  const fractions =
    maxSegments === 1
      ? [0.4]
      : Array.from({ length: maxSegments }, (_, i) => 0.15 + (0.65 * i) / (maxSegments - 1));
  const starts: number[] = [];
  for (const f of fractions) {
    const s = Math.max(0, Math.min(lastStart, Math.floor(sourceDurationSec * f)));
    if (starts.every((prev) => Math.abs(prev - s) >= segmentSec)) starts.push(s);
  }
  return starts;
}

/* ═══════════════════════ the render's side: write it down ═══════════════════════ */

export type YoutubePrefetchCandidate = {
  videoId: string;
  title?: string | null;
  /** The query that found it — carried into the archive so a later search can find it again. */
  query?: string | null;
  /** The licence label a render records on the pool candidate; null when the pass filtered nothing. */
  licenseMode?: string | null;
};

/** A YouTube video id, and nothing that merely looks like a URL or a sentence. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

/** Keyed by the render's own sourcing cache, so the cap dies with the render. */
const offeredPerRender = new WeakMap<object, Set<string>>();

/**
 * Which of these candidates this render may still offer, by the per-render cap.
 *
 * A video offered twice in one render counts once — the same query runs in several passes, and
 * the cap is about how much one render may add, not how often it says so.
 */
export function takeEnqueueSlots(
  renderKey: object | undefined,
  candidates: readonly YoutubePrefetchCandidate[],
  cap = prefetchEnqueueCapPerRender()
): YoutubePrefetchCandidate[] {
  const valid = candidates.filter((c) => VIDEO_ID_RE.test(c.videoId ?? ""));
  if (!renderKey) return valid.slice(0, cap);
  let offered = offeredPerRender.get(renderKey);
  if (!offered) {
    offered = new Set();
    offeredPerRender.set(renderKey, offered);
  }
  const out: YoutubePrefetchCandidate[] = [];
  for (const c of valid) {
    if (offered.has(c.videoId)) continue;
    if (offered.size >= cap) break;
    offered.add(c.videoId);
    out.push(c);
  }
  return out;
}

const clip = (s: string | null | undefined, n: number): string | null => {
  const t = (s ?? "").trim();
  return t ? t.slice(0, n) : null;
};

/**
 * Write down what a render found. Fire-and-forget: returns at once, never throws, never waits.
 *
 * INSERT IGNORE on the unique video id, so a video found again — by this render or any other —
 * keeps the row it has, including its attempts and its backoff.
 */
export function enqueueYoutubePrefetch(
  candidates: readonly YoutubePrefetchCandidate[],
  opts: { renderKey?: object; sourceVideoId?: number } = {}
): void {
  if (!youtubePrefetchEnabled() || candidates.length === 0) return;
  const take = takeEnqueueSlots(opts.renderKey, candidates);
  if (take.length === 0) return;
  void (async () => {
    try {
      const db = await getDb();
      if (!db) return;
      const result = await db
        .insert(youtubePrefetchQueue)
        .ignore()
        .values(
          take.map((c) => ({
            videoId: c.videoId,
            title: clip(c.title, 512),
            query: clip(c.query, 512),
            licenseMode: clip(c.licenseMode, 32),
            sourceVideoId: opts.sourceVideoId ?? null,
            /**
             * Every time on this row comes from this process's clock, never the database's
             * `now()`: the claim compares them against `new Date()`, and two clocks in two time
             * zones would move a retry by hours without anyone noticing.
             */
            nextAttemptAt: new Date(),
          }))
        );
      const added = affectedRowCount(result);
      if (added !== 0) {
        console.log(
          `[YouTubePrefetch] QUEUED video=${opts.sourceVideoId ?? "?"} offered=${take.length} ` +
            `new=${added ?? "unknown"} — fetched later, outside any render, into the archive`
        );
      }
    } catch (err) {
      /** A list of things to fetch later can never be the reason this render does not finish. */
      console.warn(`[YouTubePrefetch] enqueue failed: ${(err as Error).message?.slice(0, 160)}`);
    }
  })();
}

/* ═══════════════════════ the worker's side: claim, fetch, file ═══════════════════════ */

/**
 * The next due row, claimed by a conditional UPDATE so two workers cannot fetch one video.
 *
 * Same shape as `claimQueuedRenderJob`: the UPDATE only lands if the row is still in the state it
 * was read in, and an unknown row count is a lost claim — fetching a video twice is waste, and the
 * claim cannot prove it was not.
 */
export async function claimNextYoutubePrefetch(now = new Date()): Promise<YoutubePrefetchRow | null> {
  const db = await getDb();
  if (!db) return null;
  const q = youtubePrefetchQueue;
  const staleBefore = new Date(now.getTime() - PREFETCH_STALE_CLAIM_MS);
  const due = await db
    .select()
    .from(q)
    .where(
      and(
        lt(q.attempts, PREFETCH_MAX_ATTEMPTS),
        or(
          and(inArray(q.status, ["queued", "failed"]), lte(q.nextAttemptAt, now)),
          and(eq(q.status, "fetching"), lt(q.updatedAt, staleBefore))
        )
      )
    )
    .orderBy(asc(q.nextAttemptAt), asc(q.id))
    .limit(5);
  for (const row of due) {
    const result = await db
      .update(q)
      .set({ status: "fetching", attempts: row.attempts + 1, updatedAt: now })
      .where(and(eq(q.id, row.id), eq(q.status, row.status), eq(q.attempts, row.attempts)));
    if (affectedRowCount(result) === 1) {
      return { ...row, status: "fetching", attempts: row.attempts + 1 };
    }
  }
  return null;
}

export type PrefetchVerdict = {
  status: "queued" | "ingested" | "failed" | "refused";
  lastError: string | null;
  archiveAssetId: number | null;
  attempts: number;
  nextAttemptAt: Date;
};

async function recordPrefetchVerdict(id: number, v: PrefetchVerdict): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(youtubePrefetchQueue)
    .set({
      status: v.status,
      lastError: v.lastError?.slice(0, 512) ?? null,
      archiveAssetId: v.archiveAssetId,
      attempts: v.attempts,
      nextAttemptAt: v.nextAttemptAt,
      updatedAt: new Date(),
    })
    .where(eq(youtubePrefetchQueue.id, id));
}

export type PrefetchSegmentResult = {
  startSec: number;
  downloaded: boolean;
  /** The download layer's own classified reason, quoted, when it did not deliver. */
  downloadReason?: string;
  ingest?: IngestOutcome;
};

/**
 * Refusals that are about the PICTURE. Fetching the same seconds again would earn the same answer,
 * so a video whose every segment got one of these is not retried. Everything else — a storage
 * write, a missing archive, an unknown throw — is about this moment and is.
 */
const CONTENT_REFUSALS = new Set([
  "EXEMPT_SOURCE",
  "FILE_TOO_SMALL",
  "INVALID_DURATION",
  "BAKED_EDIT_TEXT",
  "PREVIEW_UNREADABLE",
]);

/** Refusals that are about the WHOLE video, so its remaining segments are not fetched. */
export const STOP_EARLY_REFUSALS = new Set(["BAKED_EDIT_TEXT"]);

/**
 * What one fetch means for the row. Pure: every input is something the fetch measured.
 *
 *   anything archived        → ingested (the rest of that video is not chased)
 *   a render started         → queued again, and the attempt is given back — it was not a failure
 *   the video was written off → refused (the download layer's own durable verdict, quoted)
 *   every segment refused for its picture → refused
 *   anything else            → failed, retried after `prefetchBackoffMs`
 */
export function decidePrefetchVerdict(p: {
  attempts: number;
  segments: readonly PrefetchSegmentResult[];
  videoRefusal: string | null;
  interrupted: boolean;
  now: number;
}): PrefetchVerdict {
  const archived = p.segments.flatMap((s) =>
    s.ingest?.status === "ingested" ? [s.ingest.assetId] : []
  );
  const at = (ms: number) => new Date(p.now + ms);
  if (archived.length > 0) {
    return {
      status: "ingested",
      lastError: null,
      archiveAssetId: archived[0]!,
      attempts: p.attempts,
      nextAttemptAt: at(0),
    };
  }
  if (p.interrupted && !p.videoRefusal) {
    return {
      status: "queued",
      lastError: "interrupted_by_render",
      archiveAssetId: null,
      attempts: Math.max(0, p.attempts - 1),
      nextAttemptAt: at(0),
    };
  }
  if (p.videoRefusal) {
    return {
      status: "refused",
      lastError: `download:${p.videoRefusal}`,
      archiveAssetId: null,
      attempts: p.attempts,
      nextAttemptAt: at(0),
    };
  }
  const refusals = p.segments.flatMap((s) =>
    s.ingest?.status === "refused" ? [s.ingest.reasonCode] : []
  );
  if (
    p.segments.length > 0 &&
    refusals.length === p.segments.length &&
    refusals.every((c) => CONTENT_REFUSALS.has(c))
  ) {
    return {
      status: "refused",
      lastError: `ingest:${Array.from(new Set(refusals)).join("+")}`,
      archiveAssetId: null,
      attempts: p.attempts,
      nextAttemptAt: at(0),
    };
  }
  const reasons = p.segments.map((s) =>
    s.downloaded
      ? `ingest:${s.ingest?.status === "refused" ? s.ingest.reasonCode : "none"}`
      : `download:${s.downloadReason ?? "unknown"}`
  );
  return {
    status: "failed",
    lastError: Array.from(new Set(reasons)).join(",") || "no_segment_attempted",
    archiveAssetId: null,
    attempts: p.attempts,
    nextAttemptAt: at(prefetchBackoffMs(p.attempts)),
  };
}

/**
 * The provenance an archived segment carries. The same fields a render sends for a YouTube clip it
 * adopted (`archiveMetadataForExternalClip`), with the same rules:
 *
 *   · tags come from the PROVIDER'S OWN TITLE, never from the narration — RONDE 9: narration
 *     words describe what is said, not what is shown, and they poisoned the archive once.
 *     RONDE 644: they were EMPTY here, and the audit proved what that cost: archive routing
 *     (`scoreArchiveAssetSample`) and most of `scoreCuratedAsset` read `asset.tags` only, so a
 *     fetched segment was invisible to the router — and render 603 routed 135 of 200 beats to
 *     NO_RELEVANT_ARCHIVE. `inferArchiveAssetTagsFromTitle` is the same derivation the scorer
 *     already applies to titles; storing it lets routing see what scoring could.
 *   · the query is the one that FOUND it, never the title (RONDE 28).
 *   · the source URL names the second it starts at, so each segment is its own source to the
 *     archive's dedup, and a second fetch of the same seconds is recognised as a repeat.
 */
export function archiveMetadataForPrefetchedSegment(
  row: Pick<YoutubePrefetchRow, "videoId" | "title" | "query" | "licenseMode">,
  startSec: number,
  durationSec: number | undefined
): IngestMetadata {
  const start = Math.max(0, Math.floor(startSec));
  return {
    title: row.title?.trim() || row.query?.trim() || `YouTube ${row.videoId}`,
    tags: row.title?.trim() ? inferArchiveAssetTagsFromTitle({ title: row.title }) : [],
    personContext: false,
    sourceNote: `youtube_cc:${row.videoId}@${start}s`,
    mediaType: "video",
    mimeType: "video/mp4",
    durationSec: durationSec && durationSec > 0 ? durationSec : undefined,
    licenseNote: row.licenseMode ?? undefined,
    sourceUrl: `https://www.youtube.com/watch?v=${row.videoId}&t=${start}s`,
    sourcePlatform: "youtube_cc",
    originalQuery: row.query ?? undefined,
    matchedQuery: row.query ?? undefined,
  };
}

/** Everything the fetch touches outside itself, so a test can make exactly one part fail. */
export type PrefetchDeps = {
  /** True only when no render is running in this process. Asked before every segment. */
  isIdle: () => boolean;
  /** The source's length in seconds, 0 when unknown. */
  sourceDurationSec: (videoId: string) => Promise<number>;
  download: (p: {
    videoId: string;
    startSec: number;
    durationSec: number;
    startIsExact: boolean;
    outPath: string;
    title: string | undefined;
  }) => Promise<{ ok: boolean; reason?: string }>;
  /** The download layer's durable verdict about this video, if it has reached one. */
  videoRefusal: (videoId: string) => string | null;
  probeDurationSec: (filePath: string) => Promise<number>;
  ingest: (filePath: string, metadata: IngestMetadata) => Promise<IngestOutcome>;
  /** Drop anything the download layer is holding for this video — its files are about to go. */
  release: (videoId: string) => void;
  makeWorkDir: (videoId: string) => string;
  removeWorkDir: (dir: string) => void;
};

/** Fetch one claimed video's segments and file each one with the archive. Never throws. */
export async function prefetchOneVideo(
  row: Pick<YoutubePrefetchRow, "videoId" | "title" | "query" | "licenseMode">,
  deps: PrefetchDeps,
  segmentsWanted = prefetchSegmentsPerVideo()
): Promise<{
  segments: PrefetchSegmentResult[];
  interrupted: boolean;
  videoRefusal: string | null;
  /** Set when the fetch stopped before its planned segments because the picture was refused. */
  stoppedEarlyFor: string | null;
}> {
  const segments: PrefetchSegmentResult[] = [];
  let interrupted = false;
  let stoppedEarlyFor: string | null = null;
  let videoRefusal: string | null = null;
  let workDir: string | null = null;
  try {
    const sourceSec = await deps.sourceDurationSec(row.videoId).catch(() => 0);
    const planned = prefetchSegmentStarts(sourceSec, PREFETCH_SEGMENT_SEC, segmentsWanted);
    /** Unknown length: one segment, and the download layer picks its start from the real file. */
    const starts = planned ?? [15];
    const startIsExact = planned !== null;
    workDir = deps.makeWorkDir(row.videoId);
    for (const startSec of starts) {
      if (!deps.isIdle()) {
        interrupted = true;
        break;
      }
      const outPath = path.join(workDir, `seg_${startSec}.mp4`);
      const got = await deps
        .download({
          videoId: row.videoId,
          startSec,
          durationSec: PREFETCH_SEGMENT_SEC,
          startIsExact,
          outPath,
          title: row.title ?? undefined,
        })
        .catch((err: Error) => ({ ok: false, reason: `threw:${err.message?.slice(0, 80)}` }));
      if (!got.ok || !fs.existsSync(outPath)) {
        segments.push({ startSec, downloaded: false, downloadReason: got.reason });
        videoRefusal = deps.videoRefusal(row.videoId);
        /** A video the layer has written off is written off for every one of its segments. */
        if (videoRefusal) break;
        continue;
      }
      const measured = await deps.probeDurationSec(outPath).catch(() => 0);
      const ingest = await deps.ingest(
        outPath,
        archiveMetadataForPrefetchedSegment(row, startSec, measured)
      );
      segments.push({ startSec, downloaded: true, ingest });
      /**
       * RONDE 645 — A LOGO IN ONE SEGMENT IS A LOGO IN ALL OF THEM.
       *
       * Render 603's prefetch fetched all three segments of four videos whose first segment the
       * archive had already refused for burnt-in text — a channel logo or a subtitle track runs the
       * length of the video. Twelve transfers to learn what the first one had said. So a text
       * refusal ends this video, and the next one in the queue gets the time.
       */
      if (ingest.status === "refused" && STOP_EARLY_REFUSALS.has(ingest.reasonCode)) {
        stoppedEarlyFor = ingest.reasonCode;
        break;
      }
    }
  } catch (err) {
    segments.push({ startSec: -1, downloaded: false, downloadReason: `threw:${(err as Error).message?.slice(0, 80)}` });
  } finally {
    deps.release(row.videoId);
    if (workDir) {
      try {
        deps.removeWorkDir(workDir);
      } catch {
        /* the boot sweep collects what this could not */
      }
    }
  }
  return { segments, interrupted, videoRefusal, stoppedEarlyFor };
}

export function formatPrefetchLine(
  row: Pick<YoutubePrefetchRow, "videoId">,
  fetched: { segments: readonly PrefetchSegmentResult[] },
  verdict: PrefetchVerdict
): string {
  const downloaded = fetched.segments.filter((s) => s.downloaded).length;
  const archived = fetched.segments.filter((s) => s.ingest?.status === "ingested").length;
  return (
    `[YouTubePrefetch] video=${row.videoId} segments=${fetched.segments.length} ` +
    `downloaded=${downloaded} archived=${archived} status=${verdict.status}` +
    (verdict.archiveAssetId != null ? ` assetId=${verdict.archiveAssetId}` : "") +
    (verdict.lastError ? ` reason=${verdict.lastError}` : "") +
    (verdict.status === "failed" ? ` retryAt=${verdict.nextAttemptAt.toISOString()}` : "")
  );
}

/* ═══════════════════════ another video, when this one carries text ═══════════════════════ */

/**
 * RONDE 645 — A VIDEO REFUSED FOR ITS LOGO IS A REASON TO LOOK ELSEWHERE.
 *
 * Render 603's queue held what that render's own searches returned, and those searches ask for the
 * narration's subject — "Hitler Berlin" — which on YouTube is mostly modern documentaries: a channel
 * logo in the corner, subtitles, title cards. Six of the first eight were refused for burnt-in text.
 * The archive's refusal is right and stays; what was missing is looking further.
 *
 * So a video refused for text makes the worker search once more, for the same query with a word
 * that asks for the original material rather than a programme about it — "archive footage",
 * "newsreel" — and queue what that finds. The new rows go through exactly the same fetch, the same
 * validation and the same archive gates.
 *
 * Bounded three ways: one alternative search per refused video; each (query, suffix) searched once
 * across every replica and every restart (a `worker_once_claims` row); and a daily cap per worker,
 * because a YouTube search spends quota a render needs.
 */
export const ALTERNATIVE_QUERY_SUFFIXES = ["archive footage", "newsreel"] as const;

/** The alternative queries for a base query, none for a query that is already an alternative. */
export function alternativeQueries(query: string | null | undefined): string[] {
  const base = (query ?? "").trim().replace(/\s+/g, " ");
  if (!base) return [];
  const lower = base.toLowerCase();
  if (ALTERNATIVE_QUERY_SUFFIXES.some((s) => lower.endsWith(s))) return [];
  return ALTERNATIVE_QUERY_SUFFIXES.map((s) => `${base} ${s}`.slice(0, 480));
}

/** Only a refusal for burnt-in text asks for another video; a dead link or a storage error does not. */
export function shouldSearchAlternatives(verdict: Pick<PrefetchVerdict, "status" | "lastError">): boolean {
  return verdict.status === "refused" && (verdict.lastError ?? "").includes("BAKED_EDIT_TEXT");
}

/** Alternative searches one worker may spend per UTC day. 0 switches the feature off. */
export function prefetchAltSearchesPerDay(): number {
  return intEnv("YOUTUBE_PREFETCH_ALT_SEARCHES_PER_DAY", 20, 0, 200);
}

/** The words a result must mention to count as about the same thing: the base query's own. */
export function relevanceWordsFor(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3)
    )
  ).slice(0, 12);
}

export type AlternativeDeps = {
  /** True only for the one caller, ever, that may search this key. */
  claim: (key: string) => Promise<boolean>;
  search: (query: string, licenseMode: string | null, relevanceWords: string[]) => Promise<YoutubePrefetchCandidate[]>;
  enqueue: (candidates: YoutubePrefetchCandidate[]) => void;
  /** Spend one from today's allowance; false when it is spent. */
  takeDailySlot: () => boolean;
  log: (line: string) => void;
};

export function alternativeClaimKey(query: string): string {
  return `yt-alt:${createHash("sha256").update(query.toLowerCase()).digest("hex").slice(0, 40)}`;
}

/** Search once for another video and queue what it finds. Never throws. */
export async function queueAlternativesFor(
  row: Pick<YoutubePrefetchRow, "videoId" | "query" | "licenseMode">,
  deps: AlternativeDeps
): Promise<{ query: string | null; queued: number }> {
  try {
    for (const alt of alternativeQueries(row.query)) {
      if (!(await deps.claim(alternativeClaimKey(alt)).catch(() => false))) continue;
      if (!deps.takeDailySlot()) {
        deps.log(`[YouTubePrefetch] ALTERNATIVES for=${row.videoId} skipped — today's search allowance is spent`);
        return { query: null, queued: 0 };
      }
      const found = (await deps.search(alt, row.licenseMode ?? null, relevanceWordsFor(row.query ?? "")))
        .filter((c) => c.videoId && c.videoId !== row.videoId)
        .slice(0, 5)
        .map((c) => ({ ...c, query: alt, licenseMode: row.licenseMode ?? null }));
      if (found.length > 0) deps.enqueue(found);
      deps.log(
        `[YouTubePrefetch] ALTERNATIVES for=${row.videoId} reason=BAKED_EDIT_TEXT query=${JSON.stringify(alt)} ` +
          `found=${found.length}`
      );
      return { query: alt, queued: found.length };
    }
  } catch (err) {
    deps.log(`[YouTubePrefetch] ALTERNATIVES for=${row.videoId} failed: ${(err as Error).message?.slice(0, 120)}`);
  }
  return { query: null, queued: 0 };
}

let altDay = "";
let altUsed = 0;
function takeDailyAltSlot(now = new Date()): boolean {
  const day = now.toISOString().slice(0, 10);
  if (day !== altDay) {
    altDay = day;
    altUsed = 0;
  }
  if (altUsed >= prefetchAltSearchesPerDay()) return false;
  altUsed++;
  return true;
}

async function productionAlternativeDeps(sourceVideoId: number | null): Promise<AlternativeDeps> {
  const pipeline = await import("./videoPipeline");
  const { claimOnce } = await import("./apifyLiveTest");
  const holder = `${process.env.RAILWAY_REPLICA_ID ?? "replica"}:${process.pid}`;
  return {
    claim: (key) => claimOnce(key, holder),
    search: async (query, licenseMode, words) => {
      const mode = licenseMode === "creative_common" || licenseMode === "youtube" ? licenseMode : "any";
      const rows = await pipeline.searchYoutubeVideoCandidates(query, -1, mode, words, 1, "", 10);
      return rows
        .filter((r) => r.rel >= 1)
        .map((r) => ({ videoId: r.item.id?.videoId ?? "", title: r.title }));
    },
    enqueue: (cands) => enqueueYoutubePrefetch(cands, { sourceVideoId: sourceVideoId ?? undefined }),
    takeDailySlot: () => takeDailyAltSlot(),
    log: (l) => console.log(l),
  };
}

/* ═══════════════════════ which route first, in the background ═══════════════════════ */

/**
 * RONDE 643 — WHICH ROUTE THE BACKGROUND ASKS FIRST, DECIDED BY MEASUREMENT.
 *
 * The production route test on an HD video (Big Buck Bunny, 18:22 on 2026-09-23):
 *
 *     route=cloud     ok=true   bytes=7734664  ms=12038   (9 s inside a 58 s window)
 *     route=rapidapi  ok=false  http_403:ip_locked       ms=1118
 *
 * RapidAPI's file link is a googlevideo URL signed for RapidAPI's own address; fetched from this
 * worker, YouTube refuses it. An earlier run had it succeed 3/3 — on a 2005 video whose old
 * progressive format carries no such lock, which is why that test was replaced. For the videos a
 * render actually finds, RapidAPI's transfer is refused, so it goes SECOND, as it does in a render.
 *
 * The cloud route delivered once it was given time — which a render never gave it, and this does.
 * `YOUTUBE_PREFETCH_ROUTE_ORDER=rapidapi_first` swaps them, for a RapidAPI plan whose links are not
 * address-locked.
 */
export function prefetchRouteOrder(env: NodeJS.ProcessEnv = process.env): Array<"cloud" | "rapidapi"> {
  const cloud = Boolean(env.YOUTUBE_CC_DL_SERVICE?.trim());
  const rapid = Boolean(env.RAPIDAPI_KEY?.trim());
  const order: Array<"cloud" | "rapidapi"> =
    env.YOUTUBE_PREFETCH_ROUTE_ORDER?.trim() === "rapidapi_first" ? ["rapidapi", "cloud"] : ["cloud", "rapidapi"];
  return order.filter((r) => (r === "cloud" ? cloud : rapid));
}

/* ═══════════════════════ production wiring ═══════════════════════ */

const WORK_DIR_PREFIX = "fastvid_ytprefetch_";

/** Is anything rendering in this process? Both queues, because both download through one layer. */
export async function workerIsIdle(): Promise<boolean> {
  const { workerLocalActiveJobs } = await import("./videoQueue");
  const { activeRenderJobCount } = await import("./renderJobWorker");
  return workerLocalActiveJobs() === 0 && activeRenderJobCount() === 0;
}

async function productionPrefetchDeps(): Promise<PrefetchDeps> {
  const pipeline = await import("./videoPipeline");
  const failure = await import("./providerFailureClass");
  const { ingestExternalClipToArchiveWithReason } = await import("./archiveIngestion");
  const { workerLocalActiveJobs } = await import("./videoQueue");
  const { activeRenderJobCount } = await import("./renderJobWorker");
  return {
    isIdle: () => workerLocalActiveJobs() === 0 && activeRenderJobCount() === 0,
    sourceDurationSec: async (videoId) =>
      pipeline.rapidApiYoutubeMetaDurationSec(await pipeline.fetchRapidApiYoutubeMeta(videoId, -1)),
    download: async (p) => {
      /**
       * One route at a time, each inside a scope of its own with the whole window — see
       * `prefetchRouteOrder`. Outside any scope the layer reads an infinite clock and grants the
       * cloud route only its floor, so the scope is what gives it the time a render cannot.
       */
      const reasons: string[] = [];
      for (const route of prefetchRouteOrder()) {
        const outcome: { status?: string; reason?: string } = {};
        const ok = await pipeline
          .withSceneFetchTimeout(
            () =>
              pipeline.downloadYouTubeCCClip(
                p.videoId,
                p.durationSec,
                p.startSec,
                p.outPath,
                -1,
                p.title,
                undefined,
                p.startIsExact,
                outcome as never,
                undefined,
                route
              ),
            PREFETCH_DOWNLOAD_WINDOW_MS,
            `youtube prefetch ${route} ${p.videoId}@${p.startSec}s`
          )
          .catch((err: Error) => {
            outcome.reason = `threw:${err.message?.slice(0, 80)}`;
            return false;
          });
        if (ok) return { ok: true, reason: `${route}:${outcome.reason ?? "ok"}` };
        reasons.push(`${route}:${outcome.reason ?? outcome.status ?? "failed"}`);
      }
      return { ok: false, reason: reasons.join(" ") || "no_route_configured" };
    },
    videoRefusal: (videoId) => failure.youtubeDownloadRefusal(videoId),
    probeDurationSec: (filePath) => pipeline.probeVideoDurationSec(filePath),
    ingest: (filePath, metadata) => ingestExternalClipToArchiveWithReason(filePath, metadata),
    release: (videoId) => failure.forgetYoutubeSourceFile(videoId),
    makeWorkDir: (videoId) =>
      fs.mkdtempSync(path.join(pipeline.TMP_DIR, `${WORK_DIR_PREFIX}${videoId}_`)),
    removeWorkDir: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Why the prefetch does nothing, or null when it can run. Said once at boot. */
export async function prefetchDisabledReason(): Promise<string | null> {
  if (!youtubePrefetchEnabled()) return "ENABLE_YOUTUBE_PREFETCH=false";
  const { youtubeSourcingEnabled, externalAssetIngestionEnabled } = await import("./sourcingPolicy");
  if (!youtubeSourcingEnabled()) return "ENABLE_YOUTUBE_SOURCING is not true";
  if (!externalAssetIngestionEnabled()) return "ENABLE_EXTERNAL_ASSET_INGESTION=false";
  if (!process.env.RAPIDAPI_KEY && !process.env.YOUTUBE_CC_DL_SERVICE) {
    return "no YouTube download route (RAPIDAPI_KEY and YOUTUBE_CC_DL_SERVICE both MISSING)";
  }
  return null;
}

let batchInFlight = false;

/** One quiet batch: up to `prefetchVideosPerBatch` videos, stopping the moment a render starts. */
export async function runYoutubePrefetchBatch(): Promise<{ videos: number; archived: number }> {
  if (batchInFlight) return { videos: 0, archived: 0 };
  if (!(await workerIsIdle())) return { videos: 0, archived: 0 };
  batchInFlight = true;
  let videos = 0;
  let archived = 0;
  try {
    const deps = await productionPrefetchDeps();
    /**
     * The route's egress latch is render-scoped and nothing between renders reopens it, so a latch
     * the last render closed would decide every fetch until the next render. A quiet batch is a
     * fresh measurement, the same as a render start is.
     */
    const { resetCloudEgressBlocked } = await import("./providerFailureClass");
    resetCloudEgressBlocked();
    for (let i = 0; i < prefetchVideosPerBatch(); i++) {
      if (!deps.isIdle()) break;
      const row = await claimNextYoutubePrefetch();
      if (!row) break;
      videos++;
      const fetched = await prefetchOneVideo(row, deps);
      const verdict = decidePrefetchVerdict({
        attempts: row.attempts,
        segments: fetched.segments,
        videoRefusal: fetched.videoRefusal,
        interrupted: fetched.interrupted,
        now: Date.now(),
      });
      if (verdict.status === "ingested") {
        archived += fetched.segments.filter((s) => s.ingest?.status === "ingested").length;
      }
      console.log(
        formatPrefetchLine(row, fetched, verdict) +
          (fetched.stoppedEarlyFor ? ` stoppedEarly=${fetched.stoppedEarlyFor}` : "")
      );
      if (shouldSearchAlternatives(verdict)) {
        await queueAlternativesFor(row, await productionAlternativeDeps(row.sourceVideoId ?? null));
      }
      await recordPrefetchVerdict(row.id, verdict).catch((err) =>
        console.warn(`[YouTubePrefetch] could not record ${row.videoId}: ${(err as Error).message?.slice(0, 120)}`)
      );
    }
  } catch (err) {
    console.warn(`[YouTubePrefetch] batch failed: ${(err as Error).message?.slice(0, 160)}`);
  } finally {
    batchInFlight = false;
  }
  return { videos, archived };
}

/** Work directories a killed process left behind. At boot nothing can be using them. */
export function sweepPrefetchWorkDirs(tmpDir: string): number {
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(tmpDir)) {
      if (!entry.startsWith(WORK_DIR_PREFIX)) continue;
      fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
      removed++;
    }
  } catch {
    /* a missing tmp dir has nothing to sweep */
  }
  return removed;
}

let prefetchTimer: ReturnType<typeof setInterval> | null = null;

export async function startYoutubePrefetchWorker(): Promise<void> {
  const disabled = await prefetchDisabledReason();
  if (disabled) {
    console.log(`[YouTubePrefetch] OFF — ${disabled}`);
    return;
  }
  const { TMP_DIR } = await import("./videoPipeline");
  const swept = sweepPrefetchWorkDirs(TMP_DIR);
  if (prefetchTimer) clearInterval(prefetchTimer);
  prefetchTimer = setInterval(() => {
    void runYoutubePrefetchBatch();
  }, prefetchIntervalMs());
  prefetchTimer.unref?.();
  console.log(
    `[YouTubePrefetch] ON — up to ${prefetchVideosPerBatch()} video(s) × ${prefetchSegmentsPerVideo()} ` +
      `segment(s) of ${PREFETCH_SEGMENT_SEC}s every ${prefetchIntervalMs() / 60_000} min, only while ` +
      `no render runs` + (swept > 0 ? ` (swept ${swept} abandoned work dir(s))` : "")
  );
}
