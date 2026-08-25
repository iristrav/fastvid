import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseYoutubeWatchPage,
  pickCaptionTrack,
  peekYoutubeVideoContext,
  fetchYoutubeVideoContext,
  _resetYoutubeVideoContextCache,
} from "./youtubeVideoContext";
import { pickLongVideoStartSec } from "./beatSegmentChoice";

/**
 * RONDE 60 — the YouTube half of "the right second of the right video".
 *
 * Render 531 planned 55 YouTube clips:
 *
 *     28 x  default  @12s
 *     27 x  metadata @8s
 *      0 x  transcript
 *
 * Every metadata plan landed on exactly 8, which is the `segments.length === 0` branch — proof,
 * not inference, that the caption fetch came back empty on all 55 attempts. So every YouTube
 * video was cut at second 8 or second 12 whether it ran four minutes or forty, which on YouTube
 * is the channel leader, the host introducing themselves and the subscribe card.
 */

afterEach(() => {
  _resetYoutubeVideoContextCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── A watch page, in the shape the real one has ───────────────────────────────────────────────
const watchPage = (opts: { lengthSeconds?: number; tracks?: unknown[] } = {}) => {
  const tracks = opts.tracks ?? [
    { baseUrl: "https://www.youtube.com/api/timedtext?v=X&sig=abc", languageCode: "en", kind: "asr" },
    { baseUrl: "https://www.youtube.com/api/timedtext?v=X&sig=def", languageCode: "en" },
  ];
  return (
    `<!DOCTYPE html><html><body><script>var ytInitialPlayerResponse = {"captions":` +
    `{"playerCaptionsTracklistRenderer":{"captionTracks":${JSON.stringify(tracks)}}},` +
    `"videoDetails":{"videoId":"X","lengthSeconds":"${opts.lengthSeconds ?? 2400}"}};</script></body></html>`
  );
};

describe("RONDE 60 #2 — the watch page is asked instead of the URL being guessed", () => {
  it("reads the source duration nothing on the YouTube path had", () => {
    expect(parseYoutubeWatchPage(watchPage({ lengthSeconds: 2400 })).durationSec).toBe(2400);
    expect(parseYoutubeWatchPage(watchPage({ lengthSeconds: 187 })).durationSec).toBe(187);
  });

  it("reads the real, signed caption-track URLs", () => {
    const ctx = parseYoutubeWatchPage(watchPage());
    expect(ctx.captionTracks).toHaveLength(2);
    expect(ctx.captionTracks[0]!.baseUrl).toContain("sig=abc");
    expect(ctx.captionTracks[0]!.kind).toBe("asr");
    expect(ctx.captionTracks[1]!.kind).toBeUndefined();
  });

  it("a bracket inside a caption name cannot cut the track list short", () => {
    const ctx = parseYoutubeWatchPage(
      watchPage({
        tracks: [
          { baseUrl: "https://x/1", languageCode: "en", name: 'English [CC] ] tricky "quoted"' },
          { baseUrl: "https://x/2", languageCode: "nl" },
        ],
      })
    );
    expect(ctx.captionTracks).toHaveLength(2);
    expect(ctx.captionTracks[1]!.languageCode).toBe("nl");
  });

  it("a page with no captions and no duration is empty, not an exception", () => {
    for (const html of ["", "<html></html>", '{"captionTracks":[broken', "not html at all"]) {
      const ctx = parseYoutubeWatchPage(html);
      expect(ctx.durationSec).toBe(0);
      expect(ctx.captionTracks).toEqual([]);
    }
  });

  it("tracks without a usable URL are dropped", () => {
    const ctx = parseYoutubeWatchPage(
      watchPage({ tracks: [{ languageCode: "en" }, { baseUrl: "", languageCode: "en" }] })
    );
    expect(ctx.captionTracks).toEqual([]);
  });
});

describe("RONDE 60 #2 — which caption track gets read", () => {
  const t = (languageCode: string, kind?: string, baseUrl = `https://x/${languageCode}${kind ?? ""}`) =>
    ({ baseUrl, languageCode, kind });

  it("a human-written English track beats an automatic one", () => {
    const picked = pickCaptionTrack([t("en", "asr"), t("en")]);
    expect(picked!.kind).toBeUndefined();
  });

  it("an automatic English track beats nothing — this is what the old code excluded entirely", () => {
    expect(pickCaptionTrack([t("en", "asr")])!.languageCode).toBe("en");
  });

  it("a foreign track beats nothing at all", () => {
    expect(pickCaptionTrack([t("de"), t("nl", "asr")])!.languageCode).toBe("de");
  });

  it("no tracks means no pick", () => {
    expect(pickCaptionTrack([])).toBeNull();
  });

  it("en-GB and en-US count as English", () => {
    expect(pickCaptionTrack([t("de"), t("en-GB")])!.languageCode).toBe("en-GB");
  });
});

/**
 * RONDE 65 put the InnerTube player API in front of the watch page. These tests are about the
 * page, so the mock declines the player call and the page route is exercised as before.
 */
const pageOnly = (impl: (url: string) => unknown) =>
  vi.fn(async (url: string) => {
    if (String(url).includes("youtubei")) return { ok: false, status: 404 };
    return impl(String(url));
  });

describe("RONDE 60 #2 — the fetch never throws and never blocks a render", () => {
  it("an unreachable page is an empty context, not an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));
    await expect(fetchYoutubeVideoContext("abc")).resolves.toEqual({
      durationSec: 0,
      captionTracks: [],
    });
  });

  it("a non-ok response is an empty context", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    expect((await fetchYoutubeVideoContext("abc")).durationSec).toBe(0);
  });

  it("the page is read once per video, then remembered", async () => {
    const f = pageOnly(() => ({ ok: true, text: async () => watchPage() }));
    vi.stubGlobal("fetch", f);
    await fetchYoutubeVideoContext("vid1");
    await fetchYoutubeVideoContext("vid1");
    await fetchYoutubeVideoContext("vid1");
    // One player attempt plus one page read — and nothing at all on the two repeats.
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("an empty answer is NOT cached — a transient failure must not poison the render", async () => {
    let firstPageRead = true;
    const f = pageOnly(() => {
      if (firstPageRead) {
        firstPageRead = false;
        return { ok: false, status: 500 };
      }
      return { ok: true, text: async () => watchPage({ lengthSeconds: 900 }) };
    });
    vi.stubGlobal("fetch", f);
    expect((await fetchYoutubeVideoContext("vid2")).durationSec).toBe(0);
    expect((await fetchYoutubeVideoContext("vid2")).durationSec).toBe(900);
  });

  it("it sends a real browser UA — the old Fastvid/1.0 gets a page with no tracks on it", async () => {
    const f = pageOnly(() => ({ ok: true, text: async () => watchPage() }));
    vi.stubGlobal("fetch", f);
    await fetchYoutubeVideoContext("vid3");
    const pageCall = f.mock.calls.find((c) => String(c[0]).includes("/watch"))!;
    const headers = pageCall[1].headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Mozilla/);
    // And skips the EU consent interstitial, which replaces the player response entirely.
    expect(headers.Cookie).toContain("CONSENT");
  });

  it("peek answers from what is known and never reaches the network", async () => {
    const f = pageOnly(() => ({ ok: true, text: async () => watchPage({ lengthSeconds: 611 }) }));
    vi.stubGlobal("fetch", f);
    expect(peekYoutubeVideoContext("vid4")).toBeNull();
    await fetchYoutubeVideoContext("vid4");
    expect(peekYoutubeVideoContext("vid4")!.durationSec).toBe(611);
    // The peeks that follow cost nothing: player attempt + page read, and no more.
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("can be switched off entirely", async () => {
    vi.stubEnv("ENABLE_YOUTUBE_VIDEO_CONTEXT", "false");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect((await fetchYoutubeVideoContext("vid5")).durationSec).toBe(0);
    expect(peekYoutubeVideoContext("vid5")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("RONDE 60 #1 — a long video is no longer cut at second 8", () => {
  const TAKE = 5;

  it("a forty-minute documentary starts in its body, not in its intro", () => {
    const start = pickLongVideoStartSec(2400, TAKE, "someVideoId");
    expect(start).toBeGreaterThan(60);
    expect(start).toBeLessThan(2400 - TAKE);
    // Specifically: nowhere near the 8 and 12 that render 531 used for everything.
    expect(start).toBeGreaterThan(12);
  });

  it("two different videos of the same length do not land on the same second", () => {
    const starts = new Set(
      ["aaa111", "bbb222", "ccc333", "ddd444", "eee555"].map((id) =>
        pickLongVideoStartSec(2400, TAKE, id).toFixed(1)
      )
    );
    expect(starts.size).toBe(5);
  });

  it("the same video always gets the same second — a re-run is reproducible", () => {
    for (const id of ["x", "someVideoId", "zzz"]) {
      expect(pickLongVideoStartSec(2400, TAKE, id)).toBe(pickLongVideoStartSec(2400, TAKE, id));
    }
  });

  it("it never asks for a second past the end, at any length", () => {
    for (const dur of [3, 6, 12, 45, 300, 2400, 14_400]) {
      for (const id of ["a", "bb", "ccc", "dddd"]) {
        for (const take of [3, 5, 8]) {
          const start = pickLongVideoStartSec(dur, take, id);
          expect(start).toBeGreaterThanOrEqual(0);
          expect(start).toBeLessThanOrEqual(Math.max(0, dur - take));
        }
      }
    }
  });

  it("a short video is left alone — there is no intro to skip", () => {
    expect(pickLongVideoStartSec(6, TAKE, "x")).toBe(0);
    expect(pickLongVideoStartSec(TAKE, TAKE, "x")).toBe(0);
  });

  it("it stays out of the outro as well as the intro", () => {
    // A 20-minute video: nothing should land in the last minute, where the end card lives.
    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      expect(pickLongVideoStartSec(1200, TAKE, id)).toBeLessThanOrEqual(1200 - 60 - TAKE);
    }
  });

  it("nonsense input starts at zero rather than at NaN", () => {
    expect(pickLongVideoStartSec(NaN, TAKE, "x")).toBe(0);
    expect(pickLongVideoStartSec(2400, NaN, "x")).toBe(0);
    expect(pickLongVideoStartSec(-1, TAKE, "x")).toBe(0);
    expect(pickLongVideoStartSec(2400, 0, "x")).toBe(0);
    expect(pickLongVideoStartSec(2400, TAKE, "")).toBeGreaterThanOrEqual(0);
  });

  it("switches off with the same flag as the pool-side choice", () => {
    vi.stubEnv("ENABLE_BEAT_SEGMENT_CHOICE", "false");
    expect(pickLongVideoStartSec(2400, TAKE, "x")).toBe(0);
  });
});

describe("RONDE 60 — the planner uses it", () => {
  const SRC = () => fs.readFileSync(path.join(__dirname, "scriptGuidedClipFinder.ts"), "utf8");

  it("the flat 8 / 10 / 12 fallbacks are gone from the ladder", () => {
    const src = SRC();
    const idx = src.indexOf("export async function planScriptGuidedClip(");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 4200);
    // Every non-transcript route now goes through the duration-aware fallback.
    expect(block).not.toContain("startSec: 12,");
    expect(block).not.toContain("Math.min(30, segments[0].startSec + 5) : 8");
    expect(block).not.toContain("transcriptHit?.startSec ?? 10");
    expect(block).toContain("startSec: fallbackStart(),");
    expect(block).toContain("transcriptHit?.startSec ?? fallbackStart()");
  });

  it("the fallback scales with the duration when one is known", () => {
    const src = SRC();
    expect(src).toContain("pickLongVideoStartSec(durationSec, take, candidate.videoId)");
  });

  it("a transcript hit still wins outright — the fallback is the last resort, not the first", () => {
    const src = SRC();
    const idx = src.indexOf("export async function planScriptGuidedClip(");
    const block = src.slice(idx, idx + 4200);
    expect(block).toContain('method: "transcript"');
    expect(block.indexOf('method: "transcript"')).toBeLessThan(block.indexOf('method: "metadata"'));
  });

  it("the transcript fetch asks the page for its tracks, and still tries kind=asr", () => {
    const src = SRC();
    expect(src).toContain("fetchYoutubeVideoContext(videoId, timeoutMs)");
    expect(src).toContain("pickCaptionTrack(ctx.captionTracks)");
    expect(src).toContain('const kinds = ["", "&kind=asr"];');
    // And that doubled loop is bounded, so a hanging endpoint cannot eat the planning budget.
    expect(src).toContain("const guessDeadline = Date.now() + timeoutMs * 2;");
    expect(src).toContain("if (Date.now() > guessDeadline) return [];");
  });

  it("the plan reports the duration it worked from, so a log line is diagnosable", () => {
    const src = SRC();
    expect(src).toContain("sourceDurationSec?: number;");
    const pipeline = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(pipeline).toContain("plan.sourceDurationSec");
  });
});

describe("RONDE 60 #1 — the pipeline's own flat 15 is gone", () => {
  const SRC = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("a candidate past the guided-attempt limit uses a known duration when there is one", () => {
    const src = SRC();
    // RONDE 62: the RapidAPI metadata call is now the primary source of the duration — it works
    // on Railway where the watch page did not — with the cached page kept as the backup.
    expect(src).toContain("peekYoutubeVideoContext(videoId)?.durationSec");
    expect(src).toContain("rapidApiYoutubeMetaDurationSec(");
    expect(src).toContain("pickLongVideoStartSec(sourceDurationSec, clipDur, videoId)");
    // The flat 15 survives only as the last resort, when nothing knows the length.
    expect(src).toMatch(/sourceDurationSec > 0\s*\n?\s*\?[\s\S]{0,120}:\s*15;/);
  });

  it("and peeks rather than fetches, so the attempt limit still bounds the time spent", () => {
    const src = SRC();
    // fetchYoutubeVideoContext is the blocking one; the pipeline must not call it directly.
    expect(src).not.toContain("fetchYoutubeVideoContext(");
  });

  it("the planner is told how much of the video will be taken", () => {
    const src = SRC();
    expect(src).toContain("clipDurationSec: clipDur,");
  });
});

describe("RONDE 60 #3 — YouTube finally reaches the beat-image gate", () => {
  const SRC = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("a downloaded YouTube clip is judged on what it shows", () => {
    const src = SRC();
    const idx = src.indexOf("async function youtubeClipPassesImageGate(");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2200);
    expect(block).toContain("JUDGEMENT_FRAME_FRACTIONS");
    expect(block).toContain("judgeBeatImage({");
    expect(block).toContain('return judgement.verdict !== "does_not_fit";');
  });

  it("it fails open in every direction, exactly like the funnel's copy", () => {
    const src = SRC();
    const idx = src.indexOf("async function youtubeClipPassesImageGate(");
    const block = src.slice(idx, idx + 2200);
    // No gate state, gate switched off, or no narration -> adopt, without spending a call.
    expect(block).toContain(
      'if (!gate || !beatImageRelevanceGateEnabled() || !scriptGuided?.beatText?.trim()) return true;'
    );
  });

  it("a rejected clip is deleted so a later beat cannot pick it up off disk", () => {
    const src = SRC();
    const idx = src.indexOf("youtubeClipPassesImageGate(outPath, workDir, sceneIndex, videoId, scriptGuided)");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 500);
    expect(block).toContain("fs.unlinkSync(outPath)");
    expect(block).toContain("continue;");
  });

  it("the frames it judges are cleaned up", () => {
    const src = SRC();
    const idx = src.indexOf("async function youtubeClipPassesImageGate(");
    const block = src.slice(idx, idx + 2200);
    expect(block).toMatch(/for \(const p of framePaths\)[\s\S]{0,80}fs\.unlinkSync\(p\)/);
  });

  it("every YouTube call site hands over the render's judgement budget", () => {
    const src = SRC();
    const callSites = [...src.matchAll(/fetchYouTubeCCClips\(/g)].length;
    const gated = [...src.matchAll(/imageGate: dedup\.beatImageGate/g)].length;
    // One definition line plus one call per site; every call must carry the gate.
    expect(gated).toBe(callSites - 1);
    expect(gated).toBeGreaterThanOrEqual(9);
  });

  it("the gate state stays render-scoped — it is never a module-level budget", () => {
    const src = SRC();
    expect(src).toContain("imageGate?: BeatImageGateState;");
    expect(src).toContain("state: gate,");
  });
});

describe("RONDE 60 #2 — the transcript route actually locates the subject now", () => {
  const CAPTIONS = {
    events: [
      { tStartMs: 0, segs: [{ utf8: "Welcome back to the channel, don't forget to subscribe." }] },
      { tStartMs: 12_000, segs: [{ utf8: "Today we look at the end of the Second World War." }] },
      { tStartMs: 900_000, segs: [{ utf8: "In the Fuhrerbunker, Hitler married Eva Braun." }] },
      { tStartMs: 915_000, segs: [{ utf8: "The next day, both of them were dead." }] },
      { tStartMs: 2_380_000, segs: [{ utf8: "Thanks for watching, see you next time." }] },
    ],
  };

  /** Serves the watch page, then the caption track, then nothing. */
  const serve = (opts: { captions?: unknown; lengthSeconds?: number } = {}) =>
    vi.fn(async (url: string) => {
      if (url.includes("/watch")) return { ok: true, text: async () => watchPage(opts) };
      if (url.includes("timedtext") && opts.captions !== null) {
        return { ok: true, text: async () => JSON.stringify(opts.captions ?? CAPTIONS) };
      }
      return { ok: false, status: 404 };
    });

  const plan = async (fetchImpl: ReturnType<typeof vi.fn>) => {
    vi.stubGlobal("fetch", fetchImpl);
    const { planScriptGuidedClip } = await import("./scriptGuidedClipFinder");
    return planScriptGuidedClip(
      { videoId: "someVideoId", title: "Unrelated title", metadataScore: 0 },
      {
        beatText: "In April 1945, Hitler married Eva Braun in the Fuhrerbunker.",
        keywords: ["hitler", "braun", "fuhrerbunker"],
        deadlineMs: Date.now() + 30_000,
        clipDurationSec: 5,
      }
    );
  };

  it("finds the minute where the narration's subject is discussed", async () => {
    const p = await plan(serve());
    expect(p.method).toBe("transcript");
    // The caption at 900s, minus the 1.5s lead-in — not second 8, and not second 12.
    expect(p.startSec).toBeCloseTo(898.5, 1);
    expect(p.skip).toBe(false);
  });

  it("it reads the track the page named, not a guessed URL", async () => {
    const f = serve();
    await plan(f);
    const timedtext = f.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("timedtext"));
    expect(timedtext[0]).toContain("sig=");
    expect(timedtext[0]).toContain("fmt=json3");
  });

  it("without captions it falls back on the duration, not on a flat second", async () => {
    const p = await plan(serve({ captions: null, lengthSeconds: 2400 }));
    expect(p.method).toBe("default");
    expect(p.sourceDurationSec).toBe(2400);
    // The two values render 531 used for all 55 clips.
    expect(p.startSec).not.toBe(8);
    expect(p.startSec).not.toBe(12);
    expect(p.startSec).toBeGreaterThan(60);
  });

  it("with neither captions nor a duration it is no worse than before", async () => {
    const p = await plan(vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(p.method).toBe("default");
    expect(p.startSec).toBe(12);
    expect(p.skip).toBe(false);
  });

  it("captions that never mention the subject do not invent a transcript hit", async () => {
    const p = await plan(
      serve({
        lengthSeconds: 2400,
        captions: {
          events: [
            { tStartMs: 0, segs: [{ utf8: "A completely unrelated cooking show." }] },
            { tStartMs: 60_000, segs: [{ utf8: "Add the butter and stir gently." }] },
          ],
        },
      })
    );
    expect(p.method).not.toBe("transcript");
    expect(p.startSec).toBeGreaterThan(60);
  });

  it("a caption-only video still yields a duration to scale against", async () => {
    // The page withholds lengthSeconds; the last caption states where the video ends.
    const f = vi.fn(async (url: string) => {
      if (url.includes("/watch")) {
        return {
          ok: true,
          text: async () =>
            '<html><script>{"captionTracks":[{"baseUrl":"https://x/t?sig=1","languageCode":"en"}]}</script></html>',
        };
      }
      return { ok: true, text: async () => JSON.stringify(CAPTIONS) };
    });
    vi.stubGlobal("fetch", f);
    const { planScriptGuidedClip } = await import("./scriptGuidedClipFinder");
    const p = await planScriptGuidedClip(
      { videoId: "noLenVideo", title: "x", metadataScore: 0 },
      {
        beatText: "a beat about nothing in these captions",
        keywords: ["zzzz"],
        deadlineMs: Date.now() + 30_000,
        clipDurationSec: 5,
      }
    );
    expect(p.sourceDurationSec).toBeCloseTo(2380, 0);
    expect(p.startSec).toBeGreaterThan(60);
  });
});
