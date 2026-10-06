/**
 * Video 619 — a channel whose videos YouTube keeps refusing is asked last.
 *
 * All three "Keeping Up With The Kardashians" videos failed across renders 618 and 619 (two
 * `code 8`, one unreadable file) while small channels — Full Circle, gretchen — delivered in the
 * same minutes. The channel is not refused; its videos are only tried after every other channel's.
 *
 * No network and no database: the store is the in-memory stand-in from the video memory's own test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { youtubeServiceRefusalReason } from "./providerFailureClass";
import {
  CHANNEL_UNRELIABLE_AFTER_VIDEOS,
  channelIsUnreliable,
  deliveryStatement,
  loadUnusableYoutubeVideos,
  noteYoutubeVideoChannel,
  recordYoutubeVideoOutcome,
  refusalStatements,
  setUnusableVideoStoreForTests,
  unreliableChannelsLast,
  unreliableYoutubeChannel,
  unreliableYoutubeChannels,
  type YoutubeAttemptRecord,
} from "./youtubeUnusableVideos";
import { memoryStore } from "./youtubeUnusableVideos.test.support";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const POOL = fs.readFileSync(path.join(__dirname, "youtubeVideoPool.ts"), "utf8");
const KUWTK = "Keeping Up With The Kardashians";
const code8: YoutubeAttemptRecord[] = [
  { route: "cloud", status: "DOWNLOAD_FAILED", detail: youtubeServiceRefusalReason(502, '{"detail":"ERROR: ffmpeg exited with code 8"}') },
];

let store: ReturnType<typeof memoryStore>;
beforeEach(() => {
  store = memoryStore();
  setUnusableVideoStoreForTests(store);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setUnusableVideoStoreForTests(null);
  vi.restoreAllMocks();
});

describe("Video 619 — when a channel is asked last", () => {
  it("at least two refused videos, and more refused than delivered", () => {
    expect(CHANNEL_UNRELIABLE_AFTER_VIDEOS).toBe(2);
    expect(channelIsUnreliable({ refusedVideos: 2, deliveredVideos: 1 })).toBe(true);
    expect(channelIsUnreliable({ refusedVideos: 1, deliveredVideos: 0 })).toBe(false);
    expect(channelIsUnreliable({ refusedVideos: 2, deliveredVideos: 2 })).toBe(false);
    expect(channelIsUnreliable({ refusedVideos: 3, deliveredVideos: 5 })).toBe(false);
    expect(channelIsUnreliable(undefined)).toBe(false);
  });

  it("KUWTK, from renders 618 and 619: two refused, one delivered once via RapidAPI — asked last", async () => {
    for (const id of ["mqGPviWPZj0", "2NRzxEUfUhI"]) noteYoutubeVideoChannel(id, KUWTK);
    await recordYoutubeVideoOutcome("mqGPviWPZj0", false, code8);
    expect(unreliableYoutubeChannel(KUWTK)).toBeNull();
    await recordYoutubeVideoOutcome("mqGPviWPZj0", true, []);
    await recordYoutubeVideoOutcome("2NRzxEUfUhI", false, code8);
    expect(unreliableYoutubeChannel(KUWTK)).toMatchObject({ channel: KUWTK, refusedVideos: 2, deliveredVideos: 1 });
    expect(console.warn).toHaveBeenCalledWith(
      `[YouTubeUnusable] channel="${KUWTK}" asked last from now on — 2 of its videos refused, 1 delivered`
    );
  });

  it("one video refused ten times is one refused video, not ten", async () => {
    noteYoutubeVideoChannel("5GZpQahYhPk", "Some Channel");
    for (let i = 0; i < 10; i++) await recordYoutubeVideoOutcome("5GZpQahYhPk", false, code8);
    expect(unreliableYoutubeChannel("Some Channel")).toBeNull();
  });

  it("a small channel that delivers is never marked, even with a single unlucky refusal", async () => {
    for (const id of ["ofqkKDH_LKM", "2Ota5yMqelU"]) {
      noteYoutubeVideoChannel(id, "Full Circle");
      await recordYoutubeVideoOutcome(id, true, []);
      await recordYoutubeVideoOutcome(id, false, code8);
    }
    expect(unreliableYoutubeChannel("Full Circle")).toBeNull();
  });

  it("bot checks and timeouts count against no channel", async () => {
    for (const id of ["aaaaaaaaaa1", "aaaaaaaaaa2", "aaaaaaaaaa3"]) {
      noteYoutubeVideoChannel(id, "Busy Channel");
      await recordYoutubeVideoOutcome(id, false, [{ route: "cloud", status: "DOWNLOAD_FAILED", detail: "http_502:bot_check" }]);
    }
    expect(unreliableYoutubeChannel("Busy Channel")).toBeNull();
  });

  it("the next render reads every channel's record back from the store", async () => {
    store.rows.set("x1", { refusals: 0, lastReason: null, unusableAt: null, channel: KUWTK, refusedEver: 1, deliveries: 1 });
    store.rows.set("x2", { refusals: 1, lastReason: "http_502:stream_refused", unusableAt: null, channel: KUWTK, refusedEver: 1 });
    store.rows.set("x3", { refusals: 0, lastReason: null, unusableAt: null, channel: "Vogue", deliveries: 1 });
    await loadUnusableYoutubeVideos();
    expect(unreliableYoutubeChannels().map((c) => c.channel)).toEqual([KUWTK]);
    /** The name is matched without regard to case. */
    expect(unreliableYoutubeChannel(KUWTK.toUpperCase())).not.toBeNull();
  });
});

describe("Video 619 — asked last, never refused", () => {
  const row = (id: string, channel?: string) => ({ item: { id: { videoId: id }, snippet: { channelTitle: channel } } });

  it("videos of an unreliable channel move behind the rest; each group keeps its order", async () => {
    store.rows.set("x1", { refusals: 1, lastReason: "r", unusableAt: null, channel: KUWTK, refusedEver: 1 });
    store.rows.set("x2", { refusals: 1, lastReason: "r", unusableAt: null, channel: KUWTK, refusedEver: 1 });
    await loadUnusableYoutubeVideos();
    const rows = [row("RwyhZJbvdII", KUWTK), row("4NHjTxh4BCI", "Full Circle"), row("2NRzxEUfUhI", KUWTK), row("Hi0zbU3DW6o", "Vogue"), row("nochannel01")];
    const { rows: out, movedBack } = unreliableChannelsLast(rows, (r) => r.item.id.videoId, (r) => r.item.snippet.channelTitle);
    expect(out.map((r) => r.item.id.videoId)).toEqual(["4NHjTxh4BCI", "Hi0zbU3DW6o", "nochannel01", "RwyhZJbvdII", "2NRzxEUfUhI"]);
    expect(out).toHaveLength(rows.length);
    expect(movedBack).toEqual([KUWTK]);
  });

  it("with no unreliable channel nothing moves", () => {
    const rows = [row("a1", "One"), row("a2", "Two")];
    const { rows: out, movedBack } = unreliableChannelsLast(rows, (r) => r.item.id.videoId, (r) => r.item.snippet.channelTitle);
    expect(out).toEqual(rows);
    expect(movedBack).toEqual([]);
  });

  it("the channel a row names is remembered for its download's outcome", async () => {
    unreliableChannelsLast([row("zzzzzzzzzz1", "Named Channel")], (r) => r.item.id.videoId, (r) => r.item.snippet.channelTitle);
    await recordYoutubeVideoOutcome("zzzzzzzzzz1", true, []);
    expect(store.rows.get("zzzzzzzzzz1")).toMatchObject({ channel: "Named Channel", deliveries: 1 });
  });
});

describe("Video 619 — the SQL the database gets", () => {
  it("a refusal carries the channel and marks the video refused for good", async () => {
    const { drizzle } = await import("drizzle-orm/mysql2");
    const [count] = refusalStatements(drizzle.mock(), "2NRzxEUfUhI", "http_502:stream_refused", 3, new Date(0), KUWTK);
    const c = count.toSQL();
    expect(c.sql).toContain("on duplicate key update `refusals` = `youtube_unusable_videos`.`refusals` + 1, `lastReason` = ?, `channel` = ?, `refusedEver` = ?");
    expect(c.params).toContain(KUWTK);
  });

  it("a delivery with a channel makes the row, without one it only updates", async () => {
    const { drizzle } = await import("drizzle-orm/mysql2");
    const withChannel = deliveryStatement(drizzle.mock(), "4NHjTxh4BCI", "Full Circle").toSQL().sql;
    expect(withChannel).toMatch(/^insert into `youtube_unusable_videos`/);
    expect(withChannel).toContain("`deliveries` = `youtube_unusable_videos`.`deliveries` + 1");
    expect(withChannel).toContain("`refusals` = ?");
    const without = deliveryStatement(drizzle.mock(), "4NHjTxh4BCI", null).toSQL().sql;
    expect(without).toMatch(/^update `youtube_unusable_videos` set `refusals` = \?, `lastReason` = \?, `deliveries` = `youtube_unusable_videos`.`deliveries` \+ 1/);
  });

  it("the migration adds the three columns and the index, and marks earlier refusals", () => {
    const sqlText = fs.readFileSync(path.join(__dirname, "../drizzle/0062_video619_youtube_channel_memory.sql"), "utf8");
    expect(sqlText).toContain("ADD `channel` varchar(128)");
    expect(sqlText).toContain("ADD `refusedEver` int NOT NULL DEFAULT 0");
    expect(sqlText).toContain("ADD `deliveries` int NOT NULL DEFAULT 0");
    expect(sqlText).toContain("SET `refusedEver` = 1 WHERE `refusals` > 0 OR `unusableAt` IS NOT NULL");
    expect(sqlText).toContain("CREATE INDEX `youtube_unusable_videos_channel_idx`");
  });
});

describe("Video 619 — wiring", () => {
  it("the pool keeps the channel and hands it to the beat's rows", () => {
    expect(POOL).toContain("...(it.channel ? { channel: it.channel } : {}),");
    expect(POOL).toContain("channelTitle: c.channel,");
  });

  it("the rows are reordered after the thumbnail ranking, so the ranking cannot undo it", () => {
    const at = PIPE.indexOf("const ordered = await youtubeRowsRankedByThumbnail(");
    const byChannel = PIPE.indexOf("const { rows: byChannel, movedBack } = unreliableChannelsLast(", at);
    /** W2 (video 636) — the loop reads `tried`, built from the same ordered rows. */
    const loop = PIPE.indexOf("for (const row of tried) {", at);
    expect(at).toBeGreaterThan(-1);
    expect(byChannel).toBeGreaterThan(at);
    expect(byChannel).toBeLessThan(loop);
  });

  it("a render names the channels it will ask last", () => {
    expect(PIPE).toContain("const lastChannels = unreliableYoutubeChannels();");
  });
});
