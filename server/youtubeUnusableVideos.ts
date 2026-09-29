/**
 * VIDEO 618 — YOUTUBE VIDEOS THAT DO NOT WORK ARE REMEMBERED, AND NOT ASKED FOR AGAIN.
 *
 * ── What the day's log showed ────────────────────────────────────────────────────────────────
 *
 * 27 cuts on 29 Sep ended `ffmpeg exited with code 8`: googlevideo answered the stream itself with
 * an HTTP error (see `stream_refused` in `providerFailureClass`). 22 of the 27 were three videos —
 * 5GZpQahYhPk, kqO6NANnRCc, mqGPviWPZj0 — refused on every attempt at every start point, while
 * other videos fetched fine in the same minutes. Render 618 asked for them, the background fetch
 * asked again at 08:04, 08:19, 08:22 and 09:23, and had the next try booked for 13:23. Each ask
 * costs proxy traffic and a download slot a beat could have spent on a video that works.
 *
 * The render already forgets nothing within itself for the reasons it recognises (private,
 * unavailable, country block…), but `code 8` was `other`, and the memo dies with the render.
 *
 * ── The rule ────────────────────────────────────────────────────────────────────────────────
 *
 * A refusal counts against a VIDEO only when the cloud route was refused for a reason about the
 * video (`VIDEO_REFUSAL_CLASSES`) AND nothing delivered it — RapidAPI fetching it after a cloud
 * `code 8` means the video works. A bot check, a rate limit, a timeout, a proxy fault or a budget
 * stand-aside is about the moment or the route, and neither counts nor resets anything.
 *
 * Refusals are counted since the video last DELIVERED; a delivery resets the count to zero. At
 * `YOUTUBE_UNUSABLE_AFTER_REFUSALS` the video is written off for good. Three, not one: the same
 * day's log has four videos that delivered at one start point and got one `code 8` at another
 * (ofqkKDH_LKM, 2Ota5yMqelU, efKlMJ5mMQ4, Hi0zbU3DW6o) — none got two in a row. The three that
 * never worked got four to ten.
 *
 * ── Where it is read ────────────────────────────────────────────────────────────────────────
 *
 * The list is loaded from the database when a render starts and when the background fetch runs,
 * and kept up to date in memory as videos are written off. A written-off video is taken out of the
 * search results before they are ranked, is never queued for the background fetch, is refused by
 * the background fetch before a byte moves, and `downloadYouTubeCCClip` refuses it without a
 * network request — the one place every YouTube download passes through.
 */
import { eq, and, gt, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { youtubeUnusableVideos } from "../drizzle/schema";
import { getDb } from "./db";

/** Refusals about the video, since it last delivered, after which it is not asked for again. */
export const YOUTUBE_UNUSABLE_AFTER_REFUSALS = 3;

/**
 * The cloud service's refusal classes that are facts about the VIDEO. `bot_check` is deliberately
 * absent: it is about the address asking, and a rotating proxy's next address may be let through.
 */
export const VIDEO_REFUSAL_CLASSES: ReadonlySet<string> = new Set([
  "stream_refused",
  "no_format",
  "unavailable",
  "private",
  "members_only",
  "geo_blocked",
]);

/** One route's attempt, as `downloadYouTubeCCClip` records it. */
export type YoutubeAttemptRecord = { route: string; status: string; detail: string };

/**
 * The refusal that counts against this video, or null. The detail is the classified reason
 * `http_<status>:<class>` (with a sanitised tail only for `other`), so the class is its second part.
 */
export function videoRefusalOf(delivered: boolean, attempts: readonly YoutubeAttemptRecord[]): string | null {
  if (delivered) return null;
  for (const a of attempts) {
    if (a.route !== "cloud") continue;
    const cls = a.detail.split(":")[1]?.trim() ?? "";
    if (VIDEO_REFUSAL_CLASSES.has(cls)) return a.detail.slice(0, 128);
  }
  return null;
}

/** Where the counts live. The database in production; a test hands in its own. */
export type UnusableVideoStore = {
  /** One more refusal; returns the count since the last delivery and whether it is now written off. */
  noteRefusal(videoId: string, reason: string, limit: number, now: Date): Promise<{ refusals: number; unusable: boolean }>;
  /** It delivered: the count starts again from zero. */
  noteDelivered(videoId: string): Promise<void>;
  /** Every video written off so far. */
  loadUnusable(): Promise<Array<{ videoId: string; lastReason: string | null }>>;
};

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** The two writes of one refusal, built but not run — so a test can read the SQL they send. */
export function refusalStatements(db: Pick<Db, "insert" | "update">, videoId: string, reason: string, limit: number, now: Date) {
  const t = youtubeUnusableVideos;
  return [
    db
      .insert(t)
      .values({ videoId, refusals: 1, lastReason: reason })
      .onDuplicateKeyUpdate({ set: { refusals: sql`${t.refusals} + 1`, lastReason: reason } }),
    db
      .update(t)
      .set({ unusableAt: now })
      .where(and(eq(t.videoId, videoId), isNull(t.unusableAt), gte(t.refusals, limit))),
  ] as const;
}

export const dbUnusableVideoStore: UnusableVideoStore = {
  async noteRefusal(videoId, reason, limit, now) {
    const db = await getDb();
    if (!db) return { refusals: 0, unusable: false };
    const t = youtubeUnusableVideos;
    /**
     * The count in one statement, so two workers cannot lose a refusal between a read and a write.
     * The verdict in a second one, deliberately: drizzle writes ON DUPLICATE KEY assignments in the
     * table's column order, not the order given, so a condition on `refusals` inside the same
     * statement would read the count before or after its own increment depending on the schema.
     * The second UPDATE only ever sets a missing `unusableAt`, so running it twice changes nothing.
     */
    const [count, verdict] = refusalStatements(db, videoId, reason, limit, now);
    await count;
    await verdict;
    const [row] = await db
      .select({ refusals: t.refusals, unusableAt: t.unusableAt })
      .from(t)
      .where(eq(t.videoId, videoId))
      .limit(1);
    return { refusals: row?.refusals ?? 0, unusable: row?.unusableAt != null };
  },
  async noteDelivered(videoId) {
    const db = await getDb();
    if (!db) return;
    const t = youtubeUnusableVideos;
    /** Only a row that has refusals to forget is touched; a video that always works writes nothing. */
    await db
      .update(t)
      .set({ refusals: 0, lastReason: null })
      .where(and(eq(t.videoId, videoId), gt(t.refusals, 0)));
  },
  async loadUnusable() {
    const db = await getDb();
    if (!db) return [];
    const t = youtubeUnusableVideos;
    return db.select({ videoId: t.videoId, lastReason: t.lastReason }).from(t).where(isNotNull(t.unusableAt));
  },
};

let store: UnusableVideoStore = dbUnusableVideoStore;
/** The written-off videos this process knows about, with the reason that wrote each one off. */
const unusable = new Map<string, string>();

/** Tests only: a store that is not the database, and an empty list. */
export function setUnusableVideoStoreForTests(s: UnusableVideoStore | null): void {
  store = s ?? dbUnusableVideoStore;
  unusable.clear();
}

/** Why this video is written off, or null while it may still be asked for. */
export function youtubeVideoUnusable(videoId: string | null | undefined): string | null {
  return videoId ? (unusable.get(videoId) ?? null) : null;
}

/** The rows whose video is not written off, in their order. */
export function withoutUnusableYoutubeVideos<T>(rows: readonly T[], idOf: (row: T) => string | null | undefined): T[] {
  return rows.filter((r) => !youtubeVideoUnusable(idOf(r)));
}

/**
 * Read the written-off list from the database. Called when a render starts and when the
 * background fetch runs. Never throws: a list that cannot be read leaves the one already held.
 */
export async function loadUnusableYoutubeVideos(): Promise<number> {
  try {
    const rows = await store.loadUnusable();
    for (const r of rows) unusable.set(r.videoId, r.lastReason ?? "refused");
    return unusable.size;
  } catch (err) {
    console.warn(`[YouTubeUnusable] could not read the list: ${(err as Error).message?.slice(0, 120)}`);
    return unusable.size;
  }
}

/**
 * One download's outcome, onto the video's record. Returns when it is written, never throws;
 * callers on a render path do not await it.
 */
export async function recordYoutubeVideoOutcome(
  videoId: string,
  delivered: boolean,
  attempts: readonly YoutubeAttemptRecord[],
  now = new Date()
): Promise<void> {
  if (!videoId) return;
  try {
    if (delivered) {
      await store.noteDelivered(videoId);
      return;
    }
    const reason = videoRefusalOf(false, attempts);
    if (!reason) return;
    const { refusals, unusable: writtenOff } = await store.noteRefusal(
      videoId,
      reason,
      YOUTUBE_UNUSABLE_AFTER_REFUSALS,
      now
    );
    if (writtenOff && !unusable.has(videoId)) {
      unusable.set(videoId, reason);
      console.warn(
        `[YouTubeUnusable] video=${videoId} written off after ${refusals} refusals (${reason}) — ` +
          `not asked for again`
      );
    }
  } catch (err) {
    console.warn(`[YouTubeUnusable] could not record ${videoId}: ${(err as Error).message?.slice(0, 120)}`);
  }
}
