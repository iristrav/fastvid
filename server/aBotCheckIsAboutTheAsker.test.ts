/**
 * A BOT CHECK IS ABOUT THE ASKER, NOT THE VIDEO — RONDE 646.
 *
 * Production, 2026-09-24 02:30:
 *
 *   [YouTubePrefetch] video=yGKzBH4D27A segments=1 downloaded=0 archived=0 status=refused
 *                     reason=download:DOWNLOAD_FAILED:http_502:bot_check
 *
 * The download layer remembers a bot check for the rest of one render. The prefetch turned that
 * into `refused` in the queue — a verdict nothing ever revisits. These tests hold the difference:
 *
 *   §1  a bot check is retried on the backoff; a fact about the video is still refused
 *   §2  a quiet fetch forgets the last render's verdict before asking, so the retry really asks
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  decidePrefetchVerdict,
  prefetchBackoffMs,
  prefetchOneVideo,
  refusalIsAboutTheVideo,
  type PrefetchDeps,
} from "./youtubePrefetch";
import {
  forgetYoutubeDownloadRefusal,
  noteYoutubeDownloadRefusal,
  resetPermanentDownloadRefusals,
  youtubeDownloadRefusal,
} from "./providerFailureClass";

const now = Date.UTC(2026, 8, 24, 2, 30);

describe("§1 — what the queue is told", () => {
  it("the production line: a bot check is failed and retried, not refused", () => {
    const v = decidePrefetchVerdict({
      attempts: 1,
      segments: [{ startSec: 15, downloaded: false, downloadReason: "cloud:http_502:bot_check" }],
      videoRefusal: "DOWNLOAD_FAILED:http_502:bot_check",
      interrupted: false,
      now,
    });
    expect(v.status).toBe("failed");
    expect(v.lastError).toContain("bot_check");
    expect(v.nextAttemptAt.getTime()).toBe(now + prefetchBackoffMs(1));
  });

  it("a fact about the video is still refused, and quoted", () => {
    for (const cls of ["private", "members_only", "unavailable", "geo_blocked", "no_format"]) {
      const v = decidePrefetchVerdict({
        attempts: 1,
        segments: [{ startSec: 15, downloaded: false }],
        videoRefusal: `DOWNLOAD_FAILED:http_502:${cls}`,
        interrupted: false,
        now,
      });
      expect(v.status, cls).toBe("refused");
      expect(v.lastError).toBe(`download:DOWNLOAD_FAILED:http_502:${cls}`);
    }
  });

  it("a permanent download status with no class stays refused", () => {
    expect(refusalIsAboutTheVideo("DOWNLOAD_UNSUPPORTED")).toBe(true);
    expect(refusalIsAboutTheVideo("DOWNLOAD_FAILED:http_502:bot_check")).toBe(false);
  });

  it("a render starting during a bot-checked fetch still gives the attempt back", () => {
    const v = decidePrefetchVerdict({
      attempts: 2,
      segments: [],
      videoRefusal: null,
      interrupted: true,
      now,
    });
    expect(v.status).toBe("queued");
    expect(v.attempts).toBe(1);
  });
});

describe("§2 — the retry really asks", () => {
  it("the real memo: a noted bot check is forgotten for that video only", () => {
    resetPermanentDownloadRefusals();
    expect(noteYoutubeDownloadRefusal("yGKzBH4D27A", "DOWNLOAD_FAILED", "http_502:bot_check")).toBe(true);
    expect(noteYoutubeDownloadRefusal("otherVid123", "DOWNLOAD_FAILED", "http_502:private")).toBe(true);
    expect(youtubeDownloadRefusal("yGKzBH4D27A")).toBe("DOWNLOAD_FAILED:http_502:bot_check");
    forgetYoutubeDownloadRefusal("yGKzBH4D27A");
    expect(youtubeDownloadRefusal("yGKzBH4D27A")).toBeNull();
    expect(youtubeDownloadRefusal("otherVid123")).toBe("DOWNLOAD_FAILED:http_502:private");
    resetPermanentDownloadRefusals();
  });

  it("the fetch forgets before its first download, not after", async () => {
    const log: string[] = [];
    const deps: PrefetchDeps = {
      isIdle: () => true,
      sourceDurationSec: async () => 600,
      download: async (p) => {
        log.push(`download ${p.startSec}`);
        return { ok: false, reason: "cloud:http_502:bot_check" };
      },
      videoRefusal: () => "DOWNLOAD_FAILED:http_502:bot_check",
      forgetRefusal: (id) => log.push(`forget ${id}`),
      probeDurationSec: async () => 30,
      ingest: async () => ({ status: "ingested", assetId: 1, storageKey: "k" }),
      release: () => {},
      makeWorkDir: () => "/nonexistent/prefetch-test",
      removeWorkDir: () => {},
    };
    const r = await prefetchOneVideo({ videoId: "yGKzBH4D27A", title: "t", query: "q", licenseMode: null }, deps, 3);
    expect(log[0]).toBe("forget yGKzBH4D27A");
    expect(log[1]).toBe("download 90");
    /** Within one fetch the verdict still stops the other segments: one ask, not three. */
    expect(log.filter((l) => l.startsWith("download"))).toHaveLength(1);
    expect(r.videoRefusal).toBe("DOWNLOAD_FAILED:http_502:bot_check");
  });

  it("the production deps wire the real memo", () => {
    const src = readFileSync(join(__dirname, "youtubePrefetch.ts"), "utf8");
    expect(src).toContain("forgetRefusal: (videoId) => failure.forgetYoutubeDownloadRefusal(videoId)");
  });
});
