/**
 * YOUTUBE REACHES THE FILM — OR THE FILM SAYS IT DID NOT. RONDE 643.
 *
 *   §1  a file that arrived is asked whether it is a video before it is called one
 *   §2  the seconds of YouTube in the delivered film, direct and through the archive
 *   §3  a requirement blocks only when a deployment sets it, and says why
 *   §4  the background asks the route that measured delivering first; the render's order is untouched
 *   §5  wired where it claims to be
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { judgeAcquiredFile, minimumAcquiredDurationSec, validateAcquiredFile } from "./youtubeAcquisitionValidation";
import {
  formatYoutubeFootage,
  judgeYoutubeRequirement,
  requiredYoutubeSeconds,
  unmeasuredFootage,
  youtubeFootageInTimeline,
  youtubeIdFromUrl,
  type ArchiveOrigin,
} from "./youtubeFootageInFilm";
import { prefetchRouteOrder } from "./youtubePrefetch";
import type { TimelineVideoClip } from "./projectTimeline";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════ §1 ═══════════ */

describe("§1 — an acquired file is a video only when ffprobe and a decoded frame say so", () => {
  const meta = { width: 1280, height: 720, durationSec: 4 };

  it("a real 4s clip for a 4s request passes", () => {
    expect(judgeAcquiredFile({ meta, requestedSec: 4, frameDecoded: true })).toEqual({ ok: true, ...meta });
  });

  it("NO STREAM, NO DIMENSIONS, A STUB, A FILE THAT WILL NOT DECODE — each named", () => {
    expect(judgeAcquiredFile({ meta: null, requestedSec: 4, frameDecoded: true })).toMatchObject({ code: "NO_VIDEO_STREAM" });
    expect(judgeAcquiredFile({ meta: { ...meta, width: 0 }, requestedSec: 4, frameDecoded: true })).toMatchObject({
      code: "INVALID_DIMENSIONS",
    });
    expect(judgeAcquiredFile({ meta: { ...meta, durationSec: 0.4 }, requestedSec: 4, frameDecoded: true })).toMatchObject({
      code: "DURATION_TOO_SHORT",
    });
    expect(judgeAcquiredFile({ meta, requestedSec: 4, frameDecoded: false })).toMatchObject({ code: "CORRUPT_FILE" });
  });

  it("the length floor is half of the request, never under a second", () => {
    expect(minimumAcquiredDurationSec(30)).toBe(15);
    expect(minimumAcquiredDurationSec(1)).toBe(1);
    expect(minimumAcquiredDurationSec(Number.NaN)).toBe(1);
  });

  it("no frame is decoded from a file whose container already failed", async () => {
    let decoded = 0;
    const v = await validateAcquiredFile("/x.mp4", 4, {
      probe: async () => null,
      decodeFrame: async () => {
        decoded++;
        return true;
      },
    });
    expect(v.ok).toBe(false);
    expect(decoded).toBe(0);
  });

  it("the cloud route asks before it renames, and a refusal falls through to RapidAPI", () => {
    const ask = PIPE.indexOf("const cloudVerdict =");
    const refuse = PIPE.indexOf("} else if (cloudVerdict && !cloudVerdict.ok) {");
    const accept = PIPE.indexOf("fs.renameSync(cloudTmpPath, outPath);");
    expect(ask).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(ask);
    expect(accept).toBeGreaterThan(refuse);
    expect(PIPE.slice(refuse, accept)).toContain('note("cloud", "DOWNLOAD_INVALID_CONTENT"');
  });

  it("an unknown stream duration is measured again on the container, not read as a stub", () => {
    expect(PIPE).toContain("return { ...meta, durationSec: await probeVideoDurationSec(p) };");
  });
});

/* ═══════════ §2 ═══════════ */

const clip = (over: Partial<TimelineVideoClip> & { id: string }): TimelineVideoClip =>
  ({
    kind: "video",
    source: { provider: "archive" },
    timelineStart: 0,
    timelineEnd: 5,
    motion: "static",
    transitionIn: "cut",
    transitionOut: "cut",
    previewSource: "local",
    ...over,
  }) as unknown as TimelineVideoClip;

describe("§2 — the seconds of YouTube in the film", () => {
  const origins = new Map<number, ArchiveOrigin>([
    [7, { sourcePlatform: "youtube_cc", sourceUrl: "https://www.youtube.com/watch?v=abcDEF12345&t=90s" }],
    [8, { sourcePlatform: "wikimedia", sourceUrl: "https://commons.wikimedia.org/x" }],
  ]);

  it("DIRECT AND THROUGH THE ARCHIVE BOTH COUNT — the prefetch is visible in the one number", () => {
    const f = youtubeFootageInTimeline(
      [
        clip({ id: "a", source: { provider: "youtube_cc", providerAssetId: "zzzzzzzzzzz" }, timelineStart: 0, timelineEnd: 4 }),
        clip({ id: "b", source: { provider: "archive", archiveAssetId: 7 }, timelineStart: 4, timelineEnd: 10 }),
        clip({ id: "c", source: { provider: "archive", archiveAssetId: 8 }, timelineStart: 10, timelineEnd: 20 }),
      ],
      origins,
      "rendered_timeline"
    );
    expect(f.filmSec).toBe(20);
    expect(f.youtubeSec).toBe(10);
    expect(f.directSec).toBe(4);
    expect(f.viaArchiveSec).toBe(6);
    expect(f.videoIds).toEqual(["zzzzzzzzzzz", "abcDEF12345"]);
  });

  it("an archive clip whose row could not be read is NOT counted — an unproven origin is not YouTube", () => {
    const f = youtubeFootageInTimeline([clip({ id: "b", source: { provider: "archive", archiveAssetId: 99 } })], origins, "rendered_timeline");
    expect(f.youtubeSec).toBe(0);
  });

  it("a disabled clip is not in the film", () => {
    const f = youtubeFootageInTimeline(
      [clip({ id: "a", source: { provider: "youtube_cc" }, disabled: true })],
      origins,
      "rendered_timeline"
    );
    expect(f.youtubeSec).toBe(0);
    expect(f.filmSec).toBe(0);
  });

  it("ZERO IS SAID OUT LOUD, WITH WHERE THE FUNNEL STOPPED", () => {
    const f = youtubeFootageInTimeline([clip({ id: "c" })], origins, "planned_timeline");
    const line = formatYoutubeFootage(603, f, { found: 49, downloaded: 0, adopted: 0 });
    expect(line).toContain("NO YOUTUBE FOOTAGE IN THIS FILM");
    expect(line).toContain("found=49 downloaded=0 adopted=0");
    expect(line).toContain("basis=planned_timeline");
  });

  it("a film with no readable timeline is 'unmeasured', never zero", () => {
    expect(formatYoutubeFootage(1, unmeasuredFootage())).toContain("basis=unmeasured");
  });

  it("video ids come from a watch URL or youtu.be, nothing else", () => {
    expect(youtubeIdFromUrl("https://www.youtube.com/watch?v=abcDEF12345&t=90s")).toBe("abcDEF12345");
    expect(youtubeIdFromUrl("https://youtu.be/abcDEF12345")).toBe("abcDEF12345");
    expect(youtubeIdFromUrl("not a url")).toBeNull();
  });
});

/* ═══════════ §3 ═══════════ */

describe("§3 — a requirement only when a deployment sets one", () => {
  const some = { ...unmeasuredFootage(), basis: "rendered_timeline" as const, youtubeSec: 6, filmSec: 60 };

  it("unset, blank, zero or nonsense is no requirement", () => {
    for (const v of [undefined, "", "0", "-3", "abc"]) {
      expect(requiredYoutubeSeconds({ REQUIRE_YOUTUBE_MIN_SECONDS: v } as never)).toBeNull();
    }
    expect(judgeYoutubeRequirement(unmeasuredFootage(), null)).toEqual({ ok: true });
  });

  it("below the requirement is blocked with the measured number", () => {
    const v = judgeYoutubeRequirement(some, 10);
    expect(v).toMatchObject({ ok: false, code: "YOUTUBE_FOOTAGE_BELOW_REQUIREMENT" });
  });

  it("at or above it passes", () => {
    expect(judgeYoutubeRequirement(some, 6)).toEqual({ ok: true });
  });

  it("an unmeasured film cannot satisfy a requirement", () => {
    expect(judgeYoutubeRequirement(unmeasuredFootage(), 5)).toMatchObject({ code: "YOUTUBE_FOOTAGE_UNMEASURED" });
  });

  it("the requirement is judged after the existing gate, and that gate's rules are untouched", () => {
    const gate = PIPE.indexOf("throw pipelineError(PIPELINE_ERROR.FFMPEG, formatDeliveryBlock(finalGate, videoId));");
    const yt = PIPE.indexOf("if (!youtubeFootageVerdict.ok) {");
    expect(gate).toBeGreaterThan(-1);
    expect(yt).toBeGreaterThan(gate);
  });
});

/* ═══════════ §4 ═══════════ */

describe("§4 — the background asks the route that measured delivering first", () => {
  it("CLOUD FIRST — RapidAPI's link was measured ip_locked on an HD video; it stays as fallback", () => {
    expect(prefetchRouteOrder({ RAPIDAPI_KEY: "k", YOUTUBE_CC_DL_SERVICE: "s" } as never)).toEqual(["cloud", "rapidapi"]);
    expect(prefetchRouteOrder({ RAPIDAPI_KEY: "k" } as never)).toEqual(["rapidapi"]);
    expect(prefetchRouteOrder({} as never)).toEqual([]);
  });

  it("an operator with an unlocked RapidAPI plan can swap them", () => {
    expect(
      prefetchRouteOrder({ RAPIDAPI_KEY: "k", YOUTUBE_CC_DL_SERVICE: "s", YOUTUBE_PREFETCH_ROUTE_ORDER: "rapidapi_first" } as never)
    ).toEqual(["rapidapi", "cloud"]);
  });

  it("the render's download call passes no route, so both run in their order as before", () => {
    const renderCalls = PIPE.match(/downloadYouTubeCCClip\([^)]*\)/g) ?? [];
    expect(renderCalls.length).toBeGreaterThan(0);
    for (const call of renderCalls) expect(call).not.toMatch(/"rapidapi"|"cloud"/);
  });
});

/* ═══════════ §5 ═══════════ */

describe("§5 — wired where it claims to be", () => {
  it("both delivery paths keep the timeline they delivered, and say which kind it is", () => {
    expect(PIPE).toContain('deliveredTimeline = { clips: videoTrack(outcome.timeline), basis: "planned_timeline" };');
    expect(PIPE).toContain('deliveredTimeline = { clips: videoTrack(outcome.timeline), basis: "rendered_timeline" };');
  });

  it("the line is printed before the last gate decides, whatever it decides", () => {
    const line = PIPE.indexOf("const line = formatYoutubeFootage(videoId, footage");
    const gate = PIPE.indexOf("const finalGate = deliveryGate({");
    expect(line).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(line);
  });
});
