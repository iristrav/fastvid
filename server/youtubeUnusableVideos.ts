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
import { eq, and, gte, isNotNull, isNull, sql } from "drizzle-orm";
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

/** One channel's record: how many of its videos were refused, and how many delivered. */
export type ChannelRecord = { channel: string; refusedVideos: number; deliveredVideos: number };

/** Where the counts live. The database in production; a test hands in its own. */
export type UnusableVideoStore = {
  /** One more refusal; returns the count since the last delivery and whether it is now written off. */
  noteRefusal(videoId: string, channel: string | null, reason: string, limit: number, now: Date): Promise<{ refusals: number; unusable: boolean }>;
  /** It delivered: the count starts again from zero. */
  noteDelivered(videoId: string, channel: string | null): Promise<void>;
  /** Every video written off so far. */
  loadUnusable(): Promise<Array<{ videoId: string; lastReason: string | null }>>;
  /** Every channel's record, or one channel's. */
  loadChannels(channel?: string): Promise<ChannelRecord[]>;
};

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** The two writes of one refusal, built but not run — so a test can read the SQL they send. */
export function refusalStatements(
  db: Pick<Db, "insert" | "update">,
  videoId: string,
  reason: string,
  limit: number,
  now: Date,
  channel: string | null = null
) {
  const t = youtubeUnusableVideos;
  return [
    db
      .insert(t)
      .values({ videoId, refusals: 1, lastReason: reason, refusedEver: 1, ...(channel ? { channel } : {}) })
      .onDuplicateKeyUpdate({
        set: { refusals: sql`${t.refusals} + 1`, lastReason: reason, refusedEver: 1, ...(channel ? { channel } : {}) },
      }),
    db
      .update(t)
      .set({ unusableAt: now })
      .where(and(eq(t.videoId, videoId), isNull(t.unusableAt), gte(t.refusals, limit))),
  ] as const;
}

/**
 * The write of one delivery. With a channel the row is made if it is missing, so the channel's
 * deliveries are counted too; without one only an existing row is touched, as before.
 */
export function deliveryStatement(db: Pick<Db, "insert" | "update">, videoId: string, channel: string | null) {
  const t = youtubeUnusableVideos;
  if (channel) {
    return db
      .insert(t)
      .values({ videoId, channel, deliveries: 1 })
      .onDuplicateKeyUpdate({ set: { refusals: 0, lastReason: null, deliveries: sql`${t.deliveries} + 1`, channel } });
  }
  return db
    .update(t)
    .set({ refusals: 0, lastReason: null, deliveries: sql`${t.deliveries} + 1` })
    .where(eq(t.videoId, videoId));
}

export const dbUnusableVideoStore: UnusableVideoStore = {
  async noteRefusal(videoId, channel, reason, limit, now) {
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
    const [count, verdict] = refusalStatements(db, videoId, reason, limit, now, channel);
    await count;
    await verdict;
    const [row] = await db
      .select({ refusals: t.refusals, unusableAt: t.unusableAt })
      .from(t)
      .where(eq(t.videoId, videoId))
      .limit(1);
    return { refusals: row?.refusals ?? 0, unusable: row?.unusableAt != null };
  },
  async noteDelivered(videoId, channel) {
    const db = await getDb();
    if (!db) return;
    await deliveryStatement(db, videoId, channel);
  },
  async loadUnusable() {
    const db = await getDb();
    if (!db) return [];
    const t = youtubeUnusableVideos;
    return db.select({ videoId: t.videoId, lastReason: t.lastReason }).from(t).where(isNotNull(t.unusableAt));
  },
  async loadChannels(channel) {
    const db = await getDb();
    if (!db) return [];
    const t = youtubeUnusableVideos;
    const rows = await db
      .select({
        channel: t.channel,
        refusedVideos: sql<number>`SUM(CASE WHEN ${t.refusedEver} > 0 THEN 1 ELSE 0 END)`,
        deliveredVideos: sql<number>`SUM(CASE WHEN ${t.deliveries} > 0 THEN 1 ELSE 0 END)`,
      })
      .from(t)
      .where(channel ? eq(t.channel, channel) : isNotNull(t.channel))
      .groupBy(t.channel);
    return rows
      .filter((r) => r.channel)
      .map((r) => ({ channel: r.channel!, refusedVideos: Number(r.refusedVideos) || 0, deliveredVideos: Number(r.deliveredVideos) || 0 }));
  },
};

let store: UnusableVideoStore = dbUnusableVideoStore;
/** The written-off videos this process knows about, with the reason that wrote each one off. */
const unusable = new Map<string, string>();
/** Which channel each video belongs to, as the searches this process saw named it. */
const channelByVideo = new Map<string, string>();
/** Each channel's record, keyed by its name in lower case. */
const channels = new Map<string, ChannelRecord>();

/**
 * VIDEO 619 — a channel whose videos YouTube keeps refusing is asked last.
 *
 * All three "Keeping Up With The Kardashians" videos failed (two `code 8`, one unreadable file)
 * while small channels — Full Circle, gretchen — delivered in the same minutes. A channel counts
 * as unreliable once at least this many of its videos were refused AND more were refused than
 * delivered: one unlucky video does not mark a channel, and a channel that mostly delivers is never
 * marked. Its videos are not refused — they are only tried after every other channel's.
 */
export const CHANNEL_UNRELIABLE_AFTER_VIDEOS = 2;

const channelKey = (channel: string) => channel.trim().toLowerCase();

export function channelIsUnreliable(record: Pick<ChannelRecord, "refusedVideos" | "deliveredVideos"> | undefined): boolean {
  return !!record && record.refusedVideos >= CHANNEL_UNRELIABLE_AFTER_VIDEOS && record.refusedVideos > record.deliveredVideos;
}

/** Tests only: a store that is not the database, and empty lists. */
export function setUnusableVideoStoreForTests(s: UnusableVideoStore | null): void {
  store = s ?? dbUnusableVideoStore;
  unusable.clear();
  channelByVideo.clear();
  channels.clear();
}

/** Why this video is written off, or null while it may still be asked for. */
export function youtubeVideoUnusable(videoId: string | null | undefined): string | null {
  return videoId ? (unusable.get(videoId) ?? null) : null;
}

/** Remember which channel a video belongs to, as a search result names it. */
export function noteYoutubeVideoChannel(videoId: string | null | undefined, channel: string | null | undefined): void {
  const name = (channel ?? "").trim().slice(0, 128);
  if (videoId && name) channelByVideo.set(videoId, name);
}

/** The channel a search named for this video, or null. */
export function youtubeVideoChannel(videoId: string): string | null {
  return channelByVideo.get(videoId) ?? null;
}

/** This channel's record when it is unreliable, or null. */
export function unreliableYoutubeChannel(channel: string | null | undefined): ChannelRecord | null {
  if (!channel) return null;
  const record = channels.get(channelKey(channel));
  return channelIsUnreliable(record) ? record! : null;
}

/** The rows whose video is not written off, in their order. */
export function withoutUnusableYoutubeVideos<T>(rows: readonly T[], idOf: (row: T) => string | null | undefined): T[] {
  return rows.filter((r) => !youtubeVideoUnusable(idOf(r)));
}

/**
 * The same rows, with those from an unreliable channel moved behind the rest — each group keeps its
 * own order. The channel each row names is remembered on the way, for the outcome of its download.
 */
export function unreliableChannelsLast<T>(
  rows: readonly T[],
  idOf: (row: T) => string | null | undefined,
  channelOf: (row: T) => string | null | undefined
): { rows: T[]; movedBack: string[] } {
  const first: T[] = [];
  const last: T[] = [];
  const movedBack = new Set<string>();
  for (const r of rows) {
    noteYoutubeVideoChannel(idOf(r), channelOf(r));
    const unreliable = unreliableYoutubeChannel(channelOf(r));
    if (unreliable) {
      last.push(r);
      movedBack.add(unreliable.channel);
    } else first.push(r);
  }
  return { rows: [...first, ...last], movedBack: [...movedBack] };
}

/**
 * Read the written-off videos and every channel's record from the database. Called when a render
 * starts and when the background fetch runs. Never throws: a list that cannot be read leaves the
 * one already held.
 */
export async function loadUnusableYoutubeVideos(): Promise<number> {
  try {
    const rows = await store.loadUnusable();
    for (const r of rows) unusable.set(r.videoId, r.lastReason ?? "refused");
    for (const c of await store.loadChannels()) channels.set(channelKey(c.channel), c);
    return unusable.size;
  } catch (err) {
    console.warn(`[YouTubeUnusable] could not read the list: ${(err as Error).message?.slice(0, 120)}`);
    return unusable.size;
  }
}

/** The channels asked last, for the render's opening line. */
export function unreliableYoutubeChannels(): ChannelRecord[] {
  return [...channels.values()].filter((c) => channelIsUnreliable(c));
}

/** Re-read one channel after an outcome, and say so when it has just become unreliable. */
async function refreshChannel(channel: string): Promise<void> {
  const before = unreliableYoutubeChannel(channel);
  const [record] = await store.loadChannels(channel);
  if (!record) return;
  channels.set(channelKey(channel), record);
  if (!before && channelIsUnreliable(record)) {
    console.warn(
      `[YouTubeUnusable] channel="${record.channel}" asked last from now on — ${record.refusedVideos} of its ` +
        `videos refused, ${record.deliveredVideos} delivered`
    );
  }
}

/**
 * One download's outcome, onto the video's record and its channel's. Returns when it is written,
 * never throws; callers on a render path do not await it.
 */
export async function recordYoutubeVideoOutcome(
  videoId: string,
  delivered: boolean,
  attempts: readonly YoutubeAttemptRecord[],
  now = new Date()
): Promise<void> {
  if (!videoId) return;
  const channel = youtubeVideoChannel(videoId);
  try {
    if (delivered) {
      await store.noteDelivered(videoId, channel);
      if (channel) await refreshChannel(channel);
      return;
    }
    const reason = videoRefusalOf(false, attempts);
    if (!reason) return;
    const { refusals, unusable: writtenOff } = await store.noteRefusal(
      videoId,
      channel,
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
    if (channel) await refreshChannel(channel);
  } catch (err) {
    console.warn(`[YouTubeUnusable] could not record ${videoId}: ${(err as Error).message?.slice(0, 120)}`);
  }
}
