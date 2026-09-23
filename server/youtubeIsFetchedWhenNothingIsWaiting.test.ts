/**
 * YOUTUBE IS FETCHED WHEN NOTHING IS WAITING FOR IT — RONDE 640.
 *
 * Render 603: `youtubeFound=49 youtubeDownloaded=0`, and ~45 of 59 attempts refused with
 * `scene_budget_too_short_to_start`. The download fails because a scene reaches YouTube with
 * seconds left, and no tuning of the download can give a scene more seconds.
 *
 * So a render writes down what it found, and the worker fetches it between renders into the
 * archive. These tests hold the properties that make that safe:
 *
 *   §1  which seconds of a video are fetched
 *   §2  a render adds a bounded list, once per video
 *   §3  what one fetch means for the row — and a render starting is not a failure
 *   §4  what the archive is told, under the rules every external clip already follows
 *   §5  the fetch yields to a render, and always cleans up
 *   §6  it is wired where it claims to be, through the pipeline's own downloader
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  PREFETCH_SEGMENT_SEC,
  archiveMetadataForPrefetchedSegment,
  decidePrefetchVerdict,
  prefetchBackoffMs,
  prefetchOneVideo,
  prefetchSegmentStarts,
  takeEnqueueSlots,
  type PrefetchDeps,
} from "./youtubePrefetch";
import type { IngestOutcome } from "./archiveIngestion";

const src = (f: string) => readFileSync(join(__dirname, f), "utf8");

/* ═══════════ §1 ═══════════ */

describe("§1 — which seconds of a video are fetched", () => {
  it("spread across the body of the video, not its title card or credits", () => {
    expect(prefetchSegmentStarts(600, 30, 3)).toEqual([90, 285, 480]);
  });

  it("never past the last full segment", () => {
    for (const d of [40, 61, 95, 200, 3600]) {
      for (const s of prefetchSegmentStarts(d, 30, 4) ?? []) {
        expect(s + 30).toBeLessThanOrEqual(Math.max(d, 30));
      }
    }
  });

  it("segments never overlap — close starts collapse into one", () => {
    const starts = prefetchSegmentStarts(80, 30, 6)!;
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(30);
    }
  });

  it("a video barely longer than one segment is one segment from the start", () => {
    expect(prefetchSegmentStarts(33, 30, 3)).toEqual([0]);
  });

  it("AN UNKNOWN LENGTH IS NULL, NOT A GUESS", () => {
    expect(prefetchSegmentStarts(0, 30, 3)).toBeNull();
    expect(prefetchSegmentStarts(Number.NaN, 30, 3)).toBeNull();
  });

  it("the segment is inside the archive's own 3–120s admission window", () => {
    expect(PREFETCH_SEGMENT_SEC).toBeGreaterThanOrEqual(3);
    expect(PREFETCH_SEGMENT_SEC).toBeLessThanOrEqual(120);
  });
});

/* ═══════════ §2 ═══════════ */

describe("§2 — a render adds a bounded list, once per video", () => {
  const c = (videoId: string) => ({ videoId, title: `t ${videoId}`, query: "q" });

  it("the cap is per render", () => {
    const render = {};
    expect(takeEnqueueSlots(render, [c("aaaaaaaaaa1"), c("aaaaaaaaaa2"), c("aaaaaaaaaa3")], 2)).toHaveLength(2);
    expect(takeEnqueueSlots(render, [c("aaaaaaaaaa4")], 2)).toHaveLength(0);
    expect(takeEnqueueSlots({}, [c("aaaaaaaaaa4")], 2)).toHaveLength(1);
  });

  it("a video offered twice in one render counts once", () => {
    const render = {};
    expect(takeEnqueueSlots(render, [c("bbbbbbbbbb1")], 5)).toHaveLength(1);
    expect(takeEnqueueSlots(render, [c("bbbbbbbbbb1"), c("bbbbbbbbbb2")], 5).map((x) => x.videoId)).toEqual([
      "bbbbbbbbbb2",
    ]);
  });

  it("anything that is not a video id is dropped, not queued", () => {
    const out = takeEnqueueSlots({}, [c(""), c("https://youtu.be/x"), c("ok_video-1")], 10);
    expect(out.map((x) => x.videoId)).toEqual(["ok_video-1"]);
  });
});

/* ═══════════ §3 ═══════════ */

describe("§3 — what one fetch means for the row", () => {
  const now = 1_000_000;
  const ingested = (assetId: number): IngestOutcome => ({ status: "ingested", assetId, storageKey: "k" });
  const refused = (reasonCode: string): IngestOutcome =>
    ({ status: "refused", reasonCode, reasonDetail: "d" }) as IngestOutcome;

  it("anything archived is ingested", () => {
    const v = decidePrefetchVerdict({
      attempts: 1,
      segments: [
        { startSec: 0, downloaded: false, downloadReason: "x" },
        { startSec: 90, downloaded: true, ingest: ingested(42) },
      ],
      videoRefusal: null,
      interrupted: false,
      now,
    });
    expect(v.status).toBe("ingested");
    expect(v.archiveAssetId).toBe(42);
  });

  it("A RENDER STARTING IS NOT A FAILURE — THE ATTEMPT IS GIVEN BACK", () => {
    const v = decidePrefetchVerdict({ attempts: 2, segments: [], videoRefusal: null, interrupted: true, now });
    expect(v.status).toBe("queued");
    expect(v.attempts).toBe(1);
    expect(v.nextAttemptAt.getTime()).toBe(now);
  });

  it("the download layer's durable verdict is quoted, not re-decided", () => {
    const v = decidePrefetchVerdict({
      attempts: 1,
      segments: [{ startSec: 0, downloaded: false }],
      videoRefusal: "DOWNLOAD_FAILED:http_502:video_unavailable",
      interrupted: false,
      now,
    });
    expect(v.status).toBe("refused");
    expect(v.lastError).toBe("download:DOWNLOAD_FAILED:http_502:video_unavailable");
  });

  it("every segment refused for its picture is refused, not retried", () => {
    const v = decidePrefetchVerdict({
      attempts: 1,
      segments: [
        { startSec: 0, downloaded: true, ingest: refused("BAKED_EDIT_TEXT") },
        { startSec: 90, downloaded: true, ingest: refused("PREVIEW_UNREADABLE") },
      ],
      videoRefusal: null,
      interrupted: false,
      now,
    });
    expect(v.status).toBe("refused");
  });

  it("but a storage failure is about the moment, and is retried", () => {
    const v = decidePrefetchVerdict({
      attempts: 1,
      segments: [{ startSec: 0, downloaded: true, ingest: refused("STORAGE_WRITE_FAILED") }],
      videoRefusal: null,
      interrupted: false,
      now,
    });
    expect(v.status).toBe("failed");
    expect(v.nextAttemptAt.getTime()).toBe(now + prefetchBackoffMs(1));
  });

  it("a failed download is retried later, with the reason quoted", () => {
    const v = decidePrefetchVerdict({
      attempts: 3,
      segments: [{ startSec: 0, downloaded: false, downloadReason: "rapidapi_http_403" }],
      videoRefusal: null,
      interrupted: false,
      now,
    });
    expect(v.status).toBe("failed");
    expect(v.lastError).toContain("rapidapi_http_403");
    expect(v.nextAttemptAt.getTime()).toBe(now + prefetchBackoffMs(3));
  });

  it("the backoff grows and is capped at a day", () => {
    expect(prefetchBackoffMs(2)).toBeGreaterThan(prefetchBackoffMs(1));
    expect(prefetchBackoffMs(20)).toBe(24 * 60 * 60_000);
  });
});

/* ═══════════ §4 ═══════════ */

describe("§4 — what the archive is told", () => {
  const row = { videoId: "abcDEF12345", title: "Berlin 1945 newsreel", query: "berlin ruins 1945", licenseMode: null };

  it("RONDE 9 — NO NARRATION TAGS; TAGS COME FROM THE PROVIDER'S OWN TITLE ONLY", () => {
    const m = archiveMetadataForPrefetchedSegment(row, 90, 30);
    expect(m.title).toBe("Berlin 1945 newsreel");
    /** RONDE 644: routing reads tags only, so a title-only segment was invisible to it. */
    expect(m.tags).toContain("berlin");
    /** The query ("berlin ruins 1945") came from the narration: "ruins" is in it, not in the title. */
    expect(m.tags).not.toContain("ruins");
  });

  it("no title, no tags — nothing is invented", () => {
    expect(archiveMetadataForPrefetchedSegment({ ...row, title: null }, 0, 30).tags).toEqual([]);
  });

  it("RONDE 28 — THE QUERY THAT FOUND IT, NEVER THE TITLE", () => {
    const m = archiveMetadataForPrefetchedSegment(row, 90, 30);
    expect(m.matchedQuery).toBe("berlin ruins 1945");
    expect(m.originalQuery).toBe("berlin ruins 1945");
  });

  it("each segment is its own source to the archive's dedup", () => {
    const a = archiveMetadataForPrefetchedSegment(row, 90, 30);
    const b = archiveMetadataForPrefetchedSegment(row, 285, 30);
    expect(a.sourceUrl).toBe("https://www.youtube.com/watch?v=abcDEF12345&t=90s");
    expect(a.sourceUrl).not.toBe(b.sourceUrl);
    expect(a.sourceNote).not.toBe(b.sourceNote);
  });

  it("filed as youtube_cc, with the licence label the search pass carried", () => {
    const m = archiveMetadataForPrefetchedSegment({ ...row, licenseMode: "creative_common" }, 0, 30);
    expect(m.sourcePlatform).toBe("youtube_cc");
    expect(m.licenseNote).toBe("creative_common");
    expect(archiveMetadataForPrefetchedSegment(row, 0, 30).licenseNote).toBeUndefined();
  });

  it("an unmeasured duration is absent, not zero", () => {
    expect(archiveMetadataForPrefetchedSegment(row, 0, 0).durationSec).toBeUndefined();
  });
});

/* ═══════════ §5 ═══════════ */

function fakeDeps(over: Partial<PrefetchDeps> & { log?: string[] } = {}): PrefetchDeps & { log: string[] } {
  const log = over.log ?? [];
  return {
    log,
    isIdle: () => true,
    sourceDurationSec: async () => 600,
    download: async (p) => {
      log.push(`download ${p.startSec} exact=${p.startIsExact}`);
      return { ok: false, reason: "not_in_this_test" };
    },
    videoRefusal: () => null,
    probeDurationSec: async () => 30,
    ingest: async () => ({ status: "ingested", assetId: 1, storageKey: "k" }),
    release: (id) => log.push(`release ${id}`),
    makeWorkDir: () => "/nonexistent/prefetch-test",
    removeWorkDir: (d) => log.push(`remove ${d}`),
    ...over,
  };
}

describe("§5 — the fetch yields to a render, and always cleans up", () => {
  const row = { videoId: "abcDEF12345", title: "t", query: "q", licenseMode: null };

  it("every planned segment is asked for, at its own planned second", async () => {
    const deps = fakeDeps();
    const r = await prefetchOneVideo(row, deps, 3);
    expect(deps.log.filter((l) => l.startsWith("download"))).toEqual([
      "download 90 exact=true",
      "download 285 exact=true",
      "download 480 exact=true",
    ]);
    expect(r.segments).toHaveLength(3);
  });

  it("an unknown length asks for one segment and lets the download layer pick its start", async () => {
    const deps = fakeDeps({ sourceDurationSec: async () => 0 });
    await prefetchOneVideo(row, deps, 3);
    expect(deps.log.filter((l) => l.startsWith("download"))).toEqual(["download 15 exact=false"]);
  });

  it("A RENDER STARTING STOPS THE FETCH BEFORE THE NEXT SEGMENT", async () => {
    let calls = 0;
    const deps = fakeDeps({ isIdle: () => calls++ < 1 });
    const r = await prefetchOneVideo(row, deps, 3);
    expect(r.interrupted).toBe(true);
    expect(deps.log.filter((l) => l.startsWith("download"))).toHaveLength(1);
  });

  it("a video the layer wrote off is not asked for again in the same fetch", async () => {
    const deps = fakeDeps({ videoRefusal: () => "DOWNLOAD_FAILED:x" });
    const r = await prefetchOneVideo(row, deps, 3);
    expect(r.videoRefusal).toBe("DOWNLOAD_FAILED:x");
    expect(deps.log.filter((l) => l.startsWith("download"))).toHaveLength(1);
  });

  it("the held source is released and the work dir removed on every path, a throw included", async () => {
    const deps = fakeDeps({
      download: async () => {
        throw new Error("boom");
      },
    });
    const r = await prefetchOneVideo(row, deps, 2);
    expect(deps.log).toContain("release abcDEF12345");
    expect(deps.log).toContain("remove /nonexistent/prefetch-test");
    expect(r.segments.every((s) => !s.downloaded)).toBe(true);
  });
});

/* ═══════════ §6 ═══════════ */

describe("§6 — wired where it claims to be", () => {
  const PIPE = src("videoPipeline.ts");
  const MOD = src("youtubePrefetch.ts");

  it("THE RENDER WRITES THE LIST DOWN BEFORE THE DOWNLOAD LOOP DECIDES ANYTHING", () => {
    const enqueue = PIPE.indexOf("enqueueYoutubePrefetch(\n");
    const loop = PIPE.indexOf("for (const row of ordered.slice(0, 5)) {");
    expect(enqueue).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(enqueue);
  });

  it("and never waits for it", () => {
    expect(PIPE).not.toContain("await enqueueYoutubePrefetch");
  });

  it("no second downloader — every byte comes through downloadYouTubeCCClip", () => {
    expect(MOD).toContain("pipeline.downloadYouTubeCCClip(");
    expect(MOD).not.toMatch(/\bfetch\(/);
    expect(MOD).not.toContain("rapidapi.com");
  });

  it("no second archive door — every clip goes through the ingestion gates", () => {
    expect(MOD).toContain("ingestExternalClipToArchiveWithReason(filePath, metadata)");
    expect(MOD).not.toContain("createMediaArchiveAsset");
  });

  it("it asks both queues whether a render is running", () => {
    expect(MOD).toContain("workerLocalActiveJobs() === 0 && activeRenderJobCount() === 0");
  });

  it("the worker starts it", () => {
    expect(src("worker.ts")).toContain("startYoutubePrefetchWorker()");
  });

  it("the table exists, keyed once per video", () => {
    const sql = readFileSync(join(__dirname, "..", "drizzle", "0054_ronde640_youtube_prefetch_queue.sql"), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS `youtube_prefetch_queue`");
    expect(sql).toContain("UNIQUE(`videoId`)");
  });
});
