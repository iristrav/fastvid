/**
 * Video 618 — YouTube videos that do not work are remembered, and not asked for again.
 *
 * 29 Sep: 27 cuts ended `ffmpeg exited with code 8`; 22 of them were three videos refused on every
 * attempt at every start point, asked for again by render 618 and by the background fetch at
 * 08:04, 08:19, 08:22 and 09:23. Four other videos delivered at one start point and got a single
 * `code 8` at another. The rule has to write off the first three and keep the other four.
 *
 * No network and no database: the store is an in-memory stand-in, the download route is never
 * reached, and the only file on disk is a temporary work directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { classifyYoutubeServiceRefusal, youtubeServiceRefusalReason } from "./providerFailureClass";
import {
  YOUTUBE_UNUSABLE_AFTER_REFUSALS,
  loadUnusableYoutubeVideos,
  recordYoutubeVideoOutcome,
  setUnusableVideoStoreForTests,
  videoRefusalOf,
  withoutUnusableYoutubeVideos,
  youtubeVideoUnusable,
  type UnusableVideoStore,
  type YoutubeAttemptRecord,
} from "./youtubeUnusableVideos";
import { memoryStore } from "./youtubeUnusableVideos.test.support";
import { decidePrefetchVerdict, prefetchOneVideo, type PrefetchDeps } from "./youtubePrefetch";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const PREFETCH = fs.readFileSync(path.join(__dirname, "youtubePrefetch.ts"), "utf8");

const code8: YoutubeAttemptRecord[] = [
  { route: "cloud", status: "DOWNLOAD_FAILED", detail: youtubeServiceRefusalReason(502, '{"detail":"ERROR: ffmpeg exited with code 8"}') },
  { route: "rapidapi", status: "DOWNLOAD_FAILED", detail: "http_403:ip_locked" },
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

describe("Video 618 — `code 8` is named, not `other`", () => {
  it("the service's code 8 is a refused stream; its other codes keep their classes", () => {
    expect(classifyYoutubeServiceRefusal(502, '{"detail":"ERROR: ffmpeg exited with code 8"}')).toBe("stream_refused");
    expect(youtubeServiceRefusalReason(502, '{"detail":"ERROR: ffmpeg exited with code 8"}')).toBe("http_502:stream_refused");
    expect(classifyYoutubeServiceRefusal(502, '{"detail":"ERROR: ffmpeg exited with code 251"}')).toBe("other");
    expect(classifyYoutubeServiceRefusal(502, '{"detail":"ERROR: ffmpeg exited with code 146"}')).toBe("other");
    expect(classifyYoutubeServiceRefusal(502, '{"detail":"ERROR: ffmpeg exited with code 80"}')).toBe("other");
  });
});

describe("Video 618 — which failures count against a video", () => {
  it("a refusal about the video on the cloud route, with nothing delivered", () => {
    expect(videoRefusalOf(false, code8)).toBe("http_502:stream_refused");
    for (const cls of ["no_format", "unavailable", "private", "members_only", "geo_blocked"]) {
      expect(videoRefusalOf(false, [{ route: "cloud", status: "DOWNLOAD_FAILED", detail: `http_502:${cls}` }])).toBe(`http_502:${cls}`);
    }
  });

  it("not the moment, not the route, and not a video that was fetched after all", () => {
    const one = (detail: string, route = "cloud") => videoRefusalOf(false, [{ route, status: "DOWNLOAD_FAILED", detail }]);
    expect(one("http_502:bot_check")).toBeNull();
    expect(one("http_502:rate_limited")).toBeNull();
    expect(one("http_502:network")).toBeNull();
    expect(one("http_502:other:ERROR: ffmpeg exited with code 251")).toBeNull();
    expect(one("http_403:ip_locked", "rapidapi")).toBeNull();
    expect(one("http_502:stream_refused", "rapidapi")).toBeNull();
    /** Cloud said code 8, RapidAPI fetched it: the video works. */
    expect(videoRefusalOf(true, code8)).toBeNull();
    expect(videoRefusalOf(false, [])).toBeNull();
  });
});

describe("Video 618 — the day's own sequence", () => {
  it(`the three that never worked are written off at the ${YOUTUBE_UNUSABLE_AFTER_REFUSALS}rd refusal`, async () => {
    expect(YOUTUBE_UNUSABLE_AFTER_REFUSALS).toBe(3);
    /** 5GZpQahYhPk: render 618 at 07:58, then the prefetch's three segments at 08:04. */
    await recordYoutubeVideoOutcome("5GZpQahYhPk", false, code8);
    await recordYoutubeVideoOutcome("5GZpQahYhPk", false, code8);
    expect(youtubeVideoUnusable("5GZpQahYhPk")).toBeNull();
    await recordYoutubeVideoOutcome("5GZpQahYhPk", false, code8);
    expect(youtubeVideoUnusable("5GZpQahYhPk")).toBe("http_502:stream_refused");
    expect(console.warn).toHaveBeenCalledWith(
      "[YouTubeUnusable] video=5GZpQahYhPk written off after 3 refusals (http_502:stream_refused) — not asked for again"
    );
    /** Further refusals are counted, but written off once. */
    await recordYoutubeVideoOutcome("5GZpQahYhPk", false, code8);
    expect(vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes("written off"))).toHaveLength(1);
  });

  it("the four that delivered at one start and failed at another are kept", async () => {
    for (const id of ["ofqkKDH_LKM", "2Ota5yMqelU", "efKlMJ5mMQ4", "Hi0zbU3DW6o"]) {
      await recordYoutubeVideoOutcome(id, true, []);
      await recordYoutubeVideoOutcome(id, true, []);
      await recordYoutubeVideoOutcome(id, false, code8);
      expect(youtubeVideoUnusable(id)).toBeNull();
    }
    /** A delivery starts the count again: two refusals, a delivery, two more is not three in a row. */
    await recordYoutubeVideoOutcome("aaaaaaaaaa1", false, code8);
    await recordYoutubeVideoOutcome("aaaaaaaaaa1", false, code8);
    await recordYoutubeVideoOutcome("aaaaaaaaaa1", true, code8);
    await recordYoutubeVideoOutcome("aaaaaaaaaa1", false, code8);
    await recordYoutubeVideoOutcome("aaaaaaaaaa1", false, code8);
    expect(youtubeVideoUnusable("aaaaaaaaaa1")).toBeNull();
  });

  it("bot checks and timeouts never write a video off, however many", async () => {
    const bot: YoutubeAttemptRecord[] = [{ route: "cloud", status: "DOWNLOAD_FAILED", detail: "http_502:bot_check" }];
    const late: YoutubeAttemptRecord[] = [{ route: "cloud", status: "DOWNLOAD_TIMEOUT", detail: "aborted" }];
    for (let i = 0; i < 10; i++) {
      await recordYoutubeVideoOutcome("bbbbbbbbbb1", false, bot);
      await recordYoutubeVideoOutcome("bbbbbbbbbb1", false, late);
    }
    expect(youtubeVideoUnusable("bbbbbbbbbb1")).toBeNull();
    expect(store.rows.has("bbbbbbbbbb1")).toBe(false);
  });

  it("the next render and the next worker read the list back from the store", async () => {
    store.rows.set("kqO6NANnRCc", { refusals: 8, lastReason: "http_502:stream_refused", unusableAt: new Date() });
    store.rows.set("ccccccccc01", { refusals: 1, lastReason: "http_502:stream_refused", unusableAt: null });
    expect(await loadUnusableYoutubeVideos()).toBe(1);
    expect(youtubeVideoUnusable("kqO6NANnRCc")).toBe("http_502:stream_refused");
    expect(youtubeVideoUnusable("ccccccccc01")).toBeNull();
  });

  it("a store that cannot be read or written never stops a render", async () => {
    setUnusableVideoStoreForTests({
      noteRefusal: async () => { throw new Error("db down"); },
      noteDelivered: async () => { throw new Error("db down"); },
      loadUnusable: async () => { throw new Error("db down"); },
      loadChannels: async () => { throw new Error("db down"); },
    });
    await expect(loadUnusableYoutubeVideos()).resolves.toBe(0);
    await expect(recordYoutubeVideoOutcome("ddddddddd01", false, code8)).resolves.toBeUndefined();
    await expect(recordYoutubeVideoOutcome("ddddddddd01", true, [])).resolves.toBeUndefined();
  });
});

describe("Video 618 — a written-off video is not asked for again", () => {
  beforeEach(async () => {
    store.rows.set("5GZpQahYhPk", { refusals: 10, lastReason: "http_502:stream_refused", unusableAt: new Date() });
    await loadUnusableYoutubeVideos();
  });

  it("it is taken out of the search results, which keep their order", () => {
    const rows = [{ id: "a1" }, { id: "5GZpQahYhPk" }, { id: "b2" }];
    expect(withoutUnusableYoutubeVideos(rows, (r) => r.id)).toEqual([{ id: "a1" }, { id: "b2" }]);
  });

  it("the download itself refuses it without a request, and says why", async () => {
    const { downloadYouTubeCCClip } = await import("./videoPipeline");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const box: { status?: string; reason?: string; transferStarted?: boolean } = {};
    const out = path.join(os.tmpdir(), "v618-never-written.mp4");
    const ok = await downloadYouTubeCCClip("5GZpQahYhPk", 4, 10, out, 1, "t", undefined, false, box as never);
    expect(ok).toBe(false);
    expect(box).toEqual({ status: "DOWNLOAD_FAILED", reason: "known_unusable:http_502:stream_refused", transferStarted: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe("Video 618 — wiring", () => {
  it("every download's outcome is recorded at the one exit, and the guard sits before any transfer", () => {
    const fn = PIPE.slice(PIPE.indexOf("export async function downloadYouTubeCCClip("));
    const exit = fn.slice(fn.indexOf("const reportDownload = "), fn.indexOf("const writtenOff = youtubeVideoUnusable(videoId);"));
    expect(exit).toContain('void recordYoutubeVideoOutcome(videoId, status === "DOWNLOAD_SUCCESS", attempts);');
    const guard = fn.indexOf("const writtenOff = youtubeVideoUnusable(videoId);");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fn.indexOf("if (youtubeTransferReentry === outPath)"));
  });

  it("search and pool rows are filtered before they are ranked; a render loads the list first", () => {
    expect(PIPE).toContain(
      "const ordered = await youtubeRowsRankedByThumbnail(\n          withoutUnusableYoutubeVideos<(typeof items)[number]>(items, (r) => r.item.id?.videoId),"
    );
    const start = PIPE.indexOf("resetPermanentDownloadRefusals();");
    expect(PIPE.indexOf("const writtenOffVideos = await loadUnusableYoutubeVideos();", start)).toBeGreaterThan(start);
  });

  it("the background fetch loads the list, never queues a written-off video, and asks before fetching", () => {
    expect(PREFETCH).toContain("await loadUnusableYoutubeVideos();");
    expect(PREFETCH).toContain("takeEnqueueSlots(opts.renderKey, withoutUnusableYoutubeVideos(candidates, (c) => c.videoId))");
    expect(PREFETCH).toContain("videoRefusal: (videoId) => failure.youtubeDownloadRefusal(videoId) ?? writtenOffReason(videoId),");
    expect(PREFETCH).toContain("    writtenOff: writtenOffReason,");
    expect(PREFETCH).toContain("videoRefusal = deps.writtenOff?.(row.videoId) ?? null;");
  });

  it("the database gets a count in one statement and the verdict in a second, from the counted value", async () => {
    const { drizzle } = await import("drizzle-orm/mysql2");
    const { refusalStatements } = await import("./youtubeUnusableVideos");
    const now = new Date("2026-09-29T08:04:22Z");
    const [count, verdict] = refusalStatements(drizzle.mock(), "5GZpQahYhPk", "http_502:stream_refused", 3, now);
    const c = count.toSQL();
    expect(c.sql).toBe(
      "insert into `youtube_unusable_videos` (`id`, `videoId`, `refusals`, `lastReason`, `unusableAt`, `channel`, `refusedEver`, `deliveries`, `createdAt`, `updatedAt`) " +
        "values (default, ?, ?, ?, default, default, ?, default, default, default) on duplicate key update " +
        "`refusals` = `youtube_unusable_videos`.`refusals` + 1, `lastReason` = ?, `refusedEver` = ?"
    );
    expect(c.params).toEqual(["5GZpQahYhPk", 1, "http_502:stream_refused", 1, "http_502:stream_refused", 1]);
    const v = verdict.toSQL();
    expect(v.sql).toBe(
      "update `youtube_unusable_videos` set `unusableAt` = ? where (`youtube_unusable_videos`.`videoId` = ? " +
        "and `youtube_unusable_videos`.`unusableAt` is null and `youtube_unusable_videos`.`refusals` >= ?)"
    );
    /** The time goes through the column's own mapping, as MySQL's `YYYY-MM-DD hh:mm:ss`, not ISO text. */
    expect(v.params[0]).toBe("2026-09-29 08:04:22.000");
    expect(v.params.slice(1)).toEqual(["5GZpQahYhPk", 3]);
  });

  it("the table the migration creates is the table the schema describes", () => {
    const sqlText = fs.readFileSync(path.join(__dirname, "../drizzle/0061_video618_youtube_unusable_videos.sql"), "utf8");
    for (const col of ["`videoId` varchar(32) NOT NULL", "`refusals` int NOT NULL DEFAULT 0", "`lastReason` varchar(128)", "`unusableAt` timestamp NULL"]) {
      expect(sqlText).toContain(col);
    }
    expect(sqlText).toContain("UNIQUE(`videoId`)");
    const journal = JSON.parse(fs.readFileSync(path.join(__dirname, "../drizzle/meta/_journal.json"), "utf8"));
    expect(journal.entries.map((e: { tag: string }) => e.tag)).toContain("0061_video618_youtube_unusable_videos");
  });
});
