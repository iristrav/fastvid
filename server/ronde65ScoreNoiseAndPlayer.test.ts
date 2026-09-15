import { afterEach, describe, expect, it, vi } from "vitest";
import { pickBestFunnelCandidate } from "./retrievalFunnel";
import { clipSimToScore } from "./localClipVision";
import { fetchYoutubeVideoContext, _resetYoutubeVideoContextCache } from "./youtubeVideoContext";

/**
 * RONDE 65 — the ranking was noise, and the page was the wrong door.
 *
 * "CLIP is inverted for this material" was the wrong diagnosis. worstScore10 is
 * Math.round(similarity * 40) — an INTEGER 0-10 — and render 531's four measured candidates
 * collapse into two values:
 *
 *     white-lives-matter-montana-sticker   0.2226  ->  9
 *     faces-of-ancient-europe-1-500-a.d    0.2225  ->  9
 *     Signed Photograph of Adolf Hitler    0.2116  ->  8
 *     Bundesarchiv Bild 183-1989-0322      0.2077  ->  8
 *
 * The sticker did not beat the photograph of the subject because CLIP preferred it. It beat it
 * because 8.90 rounds up and 8.46 rounds down. Obviously-right and obviously-wrong material sat
 * 0.0149 apart — the model had no opinion, and the pipeline read one into the rounding.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetYoutubeVideoContextCache();
});

const cand = (id: string, source: string, score: number) =>
  ({
    candidate: { id, source, title: id },
    clipPath: `/tmp/${id}.mp4`,
    visionResult: { pass: true, worstScore10: score },
  }) as unknown as Parameters<typeof pickBestFunnelCandidate>[0][number];

describe("RONDE 65 — the measurement that started it", () => {
  it("render 531's four similarities really do collapse to two scores", () => {
    expect(clipSimToScore(0.2226)).toBe(9); // sticker      — wrong
    expect(clipSimToScore(0.2225)).toBe(9); // ancient europe — wrong
    expect(clipSimToScore(0.2116)).toBe(8); // Hitler photo  — right
    expect(clipSimToScore(0.2077)).toBe(8); // Bundesarchiv  — right
    // One point of ranking, out of 0.0149 of similarity.
    expect(clipSimToScore(0.2226) - clipSimToScore(0.2077)).toBe(1);
  });
});

describe("RONDE 65 — a flat field is not a ranking", () => {
  it("the exact render-531 beat no longer hands the win to the sticker", () => {
    const scored = [
      // In funnel ranking order: the archive material the funnel itself ranked first.
      cand("signed-photograph-of-adolf-hitler", "wikimedia", 8),
      cand("bundesarchiv-183", "wikimedia", 8),
      cand("white-lives-matter-montana", "internet_archive", 9),
      cand("faces-of-ancient-europe", "internet_archive", 9),
    ];
    // One point across the whole field is noise, so the funnel's own order stands.
    expect(pickBestFunnelCandidate(scored)?.candidate.id).toBe("signed-photograph-of-adolf-hitler");
  });

  it("a real difference is still respected", () => {
    const scored = [cand("a", "archive", 4), cand("b", "archive", 9)];
    expect(pickBestFunnelCandidate(scored)?.candidate.id).toBe("b");
  });

  it("exactly one point apart is noise; two points is a signal", () => {
    expect(pickBestFunnelCandidate([cand("a", "archive", 8), cand("b", "archive", 9)])?.candidate.id)
      .toBe("a");
    expect(pickBestFunnelCandidate([cand("a", "archive", 8), cand("b", "archive", 10)])?.candidate.id)
      .toBe("b");
  });

  it("a single candidate is unaffected", () => {
    expect(pickBestFunnelCandidate([cand("only", "archive", 3)])?.candidate.id).toBe("only");
  });

  it("the non-stock tier still wins on a flat field — provenance is a real signal", () => {
    const scored = [cand("stockish", "pexels", 9), cand("archival", "archive", 8)];
    expect(pickBestFunnelCandidate(scored)?.candidate.id).toBe("archival");
  });

  it("and stock can still win when the gap is genuinely large", () => {
    const scored = [cand("archival", "archive", 3), cand("stockish", "pexels", 10)];
    expect(pickBestFunnelCandidate(scored)?.candidate.id).toBe("stockish");
  });

  it("the refusal set and the used set still do their jobs on a flat field", () => {
    const scored = [cand("a", "archive", 8), cand("b", "archive", 9)];
    expect(pickBestFunnelCandidate(scored, new Set(["a"]))?.candidate.id).toBe("b");
    expect(pickBestFunnelCandidate(scored, new Set(), new Set(["a"]))?.candidate.id).toBe("b");
    expect(pickBestFunnelCandidate(scored, new Set(), new Set(["a", "b"]))).toBeNull();
  });

  it("the threshold is tunable, and a 0 restores the old ranking exactly", async () => {
    vi.resetModules();
    vi.stubEnv("NON_DISCRIMINATING_SCORE_SPREAD", "0");
    const { pickBestFunnelCandidate: pick } = await import("./retrievalFunnel");
    const scored = [cand("a", "archive", 8), cand("b", "archive", 9)];
    expect(pick(scored)?.candidate.id).toBe("b");
  });
});

describe("RONDE 65 — the player API, tried before the page", () => {
  const playerResponse = (lengthSeconds = 2400, tracks = 1) =>
    JSON.stringify({
      videoDetails: { videoId: "X", lengthSeconds: String(lengthSeconds) },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: Array.from({ length: tracks }, (_, i) => ({
            baseUrl: `https://www.youtube.com/api/timedtext?v=X&sig=${i}`,
            languageCode: "en",
          })),
        },
      },
    });

  it("reads the duration and the tracks from JSON, without touching the watch page", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("youtubei/v1/player")) {
        return { ok: true, json: async () => JSON.parse(playerResponse()) };
      }
      throw new Error("watch page should not have been reached");
    });
    vi.stubGlobal("fetch", f);
    const ctx = await fetchYoutubeVideoContext("vid1", 5_000);
    expect(ctx.durationSec).toBe(2400);
    expect(ctx.captionTracks).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![1].method).toBe("POST");
  });

  it("identifies itself as the Android client, and sends no API key", async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => JSON.parse(playerResponse()) }));
    vi.stubGlobal("fetch", f);
    await fetchYoutubeVideoContext("vid2", 5_000);
    const [url, init] = f.mock.calls[0]! as [string, { body: string; headers: Record<string, string> }];
    expect(url).not.toContain("key=");
    expect(JSON.parse(init.body).context.client.clientName).toBe("ANDROID");
    expect(init.headers["User-Agent"]).toContain("com.google.android.youtube");
  });

  it("falls through to the watch page when the player refuses", async () => {
    const html =
      '<html><script>{"captionTracks":[{"baseUrl":"https://x/1","languageCode":"en"}]}' +
      ',"videoDetails":{"lengthSeconds":"611"}</script></html>';
    const f = vi.fn(async (url: string) => {
      if (url.includes("youtubei")) return { ok: false, status: 403 };
      return { ok: true, text: async () => html };
    });
    vi.stubGlobal("fetch", f);
    const ctx = await fetchYoutubeVideoContext("vid3", 5_000);
    expect(ctx.durationSec).toBe(611);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a player answer with neither fact is not taken as an answer", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("youtubei")) return { ok: true, json: async () => ({}) };
      return { ok: false, status: 404 };
    });
    vi.stubGlobal("fetch", f);
    expect((await fetchYoutubeVideoContext("vid4", 5_000)).durationSec).toBe(0);
    // It tried the page too rather than accepting the empty player response.
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a player error is not an error — the page still gets its turn", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("youtubei")) throw new Error("ECONNRESET");
      return { ok: true, text: async () => '"lengthSeconds":"90"' };
    });
    vi.stubGlobal("fetch", f);
    await expect(fetchYoutubeVideoContext("vid5", 5_000)).resolves.toMatchObject({ durationSec: 90 });
  });

  it("the log says which route answered, so the next render is diagnosable", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => JSON.parse(playerResponse()) })));
    await fetchYoutubeVideoContext("vid6", 5_000);
    expect(log.mock.calls.flat().join(" ")).toContain("via=innertube");
    log.mockRestore();
  });

  it("a player answer is cached like any other, so it is read once per video", async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => JSON.parse(playerResponse()) }));
    vi.stubGlobal("fetch", f);
    await fetchYoutubeVideoContext("vid7", 5_000);
    await fetchYoutubeVideoContext("vid7", 5_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("the whole thing still switches off with one flag", async () => {
    vi.stubEnv("ENABLE_YOUTUBE_VIDEO_CONTEXT", "false");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect((await fetchYoutubeVideoContext("vid8", 5_000)).durationSec).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });
});

/**
 * RONDE 235 — AND WHEN IT DOES NOT ANSWER, IT SAYS SO.
 *
 * Every test above proves the player route FALLS THROUGH correctly on each kind of failure. Not
 * one of them proved it said anything, and it did not: every exit was a bare `return null`, so a
 * refusal, a timeout, a changed response shape and a dropped connection were one silence.
 *
 * That matters most in exactly the case this repo has been chasing. On a datacentre address a
 * refusal is the EXPECTED answer, and the only line a render printed came from the watch page —
 * so "the player was never tried" and "the player was refused" read identically, and the route in
 * front of the one that was already suspect was the one nobody could see.
 *
 * These drive each failure at the transport, the way every test above does, and assert the line.
 */
describe("RONDE 235 — the player route reports its own failures", () => {
  const capture = () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    return () => warn.mock.calls.flat().join(" ");
  };
  /** Player fails the way the test asks; the page then fails too, so only the player line is new. */
  const playerFails = (fail: () => never | Promise<unknown>) =>
    vi.fn(async (url: string) => (url.includes("youtubei") ? fail() : { ok: false, status: 404 }));

  it("names the status when the player refuses", async () => {
    const said = capture();
    vi.stubGlobal("fetch", playerFails(async () => ({ ok: false, status: 403 })));
    await fetchYoutubeVideoContext("ref1", 5_000);
    expect(said()).toContain("via=innertube http=403");
  });

  /** A 200 carrying neither fact: a changed shape, or a playabilityStatus refusal. */
  it("says so when the answer carries neither fact", async () => {
    const said = capture();
    vi.stubGlobal("fetch", playerFails(async () => ({ ok: true, json: async () => ({}) })));
    await fetchYoutubeVideoContext("ref2", 5_000);
    expect(said()).toContain("via=innertube unreadable");
  });

  it("says so when the connection drops", async () => {
    const said = capture();
    vi.stubGlobal("fetch", playerFails(() => { throw new Error("ECONNRESET"); }));
    await fetchYoutubeVideoContext("ref3", 5_000);
    expect(said()).toMatch(/via=innertube failed: .*ECONNRESET/);
  });

  it("distinguishes a timeout from a refusal, since the fixes differ", async () => {
    const said = capture();
    vi.stubGlobal("fetch", playerFails(() => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }));
    await fetchYoutubeVideoContext("ref4", 5_000);
    expect(said()).toContain("via=innertube timeout after 5000ms");
  });

  /** Both routes log, and a reader must be able to tell which line came from which. */
  it("the line names its route", async () => {
    const said = capture();
    vi.stubGlobal("fetch", playerFails(async () => ({ ok: false, status: 429 })));
    await fetchYoutubeVideoContext("ref5", 5_000);
    expect(said()).toContain("via=innertube");
    expect(said(), "and it says the page is still to come").toContain("trying watch page");
  });

  /**
   * THE LINE IS A LINE, NOT A SECOND VOTE.
   *
   * The breaker counts one failure per video, charged at the watch page — the last route tried.
   * Charging the player route as well would trip the ten-minute stand-down after three videos
   * instead of six, which is a real behaviour change nobody asked for and which a new log line
   * must not smuggle in. Six videos where BOTH routes fail must still be what it takes.
   */
  it("does not make the breaker trip twice as fast", async () => {
    const said = capture();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 })));
    for (let i = 0; i < 5; i++) await fetchYoutubeVideoContext(`brk${i}`, 5_000);
    expect(said(), "five videos must not be enough").not.toContain("standing down");
    await fetchYoutubeVideoContext("brk5", 5_000);
    expect(said(), "the sixth is").toContain("standing down");
  });
});
