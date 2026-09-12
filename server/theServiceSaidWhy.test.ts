import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  classifyYoutubeServiceRefusal,
  sanitizeServiceDetail,
  youtubeServiceRefusalReason,
} from "./providerFailureClass";
import { formatYoutubeDownloadLine } from "./videoPipeline";

/**
 * THE SERVICE EXPLAINED ITSELF AND THE RENDER RECORDED A NUMBER.
 *
 * ── What render 578 could not say ───────────────────────────────────────────────────────────
 *
 * The last direct test of the yt-dlp service answered 502, and nothing in this repository could
 * say which 502 it was. `services/ytdlp-download/main.py` answers 502 in four unrelated
 * situations and puts the reason in the body every time:
 *
 *     yt-dlp's own message   "Sign in to confirm you're not a bot", "Video unavailable", …
 *     no file produced       the call returned without writing anything
 *     below the floor        under 10 000 bytes — an error page, not a clip
 *     over the ceiling       the range did not bind and the whole source arrived
 *
 * Those need three different responses from an operator — a network identity problem, a fact
 * about one video, and a failed cut — and `downloadYouTubeCCClip` collapsed all of them into
 * `http_502`. It even read the body first, printed a hundred characters of it to stdout, and then
 * recorded the number instead.
 *
 * The `[YouTubeDownload]` line made the same omission twice over: every attempt carries a
 * `detail`, and the line printed `route:status` and dropped it, so the one structured line a
 * render emits per download named no cause at all.
 *
 * ── What this does not do ───────────────────────────────────────────────────────────────────
 *
 * It does not change which videos are retried. `YOUTUBE_PERMANENT_DOWNLOAD_STATUSES` decides
 * that, it is deliberately conservative, and it is untouched here — this is about what the render
 * can SAY, not about what it does.
 */

describe("the four 502s are told apart", () => {
  it("A BOT CHECK IS NAMED AS ONE — the answer is a proxy, not a retry", () => {
    expect(
      classifyYoutubeServiceRefusal(502, "ERROR: [youtube] abc: Sign in to confirm you're not a bot")
    ).toBe("bot_check");
  });

  it("a video that is gone is a fact about the video", () => {
    expect(classifyYoutubeServiceRefusal(502, "ERROR: [youtube] x: Video unavailable")).toBe(
      "unavailable"
    );
    expect(classifyYoutubeServiceRefusal(502, "This video has been removed by the uploader")).toBe(
      "unavailable"
    );
  });

  it("and the service's own three refusals keep their names", () => {
    expect(classifyYoutubeServiceRefusal(502, "yt-dlp produced no file")).toBe("no_file");
    expect(classifyYoutubeServiceRefusal(502, "file below floor (204 < 10000 bytes, salvage=none)"))
      .toBe("below_floor");
    expect(
      classifyYoutubeServiceRefusal(
        502,
        "file over ceiling (99000000 > 83886080 bytes, salvage=already_cut)"
      )
    ).toBe("over_ceiling");
  });

  it("the rest of the vocabulary answers the questions an operator actually has", () => {
    expect(classifyYoutubeServiceRefusal(502, "Private video. Sign in if you've been granted access"))
      .toBe("private");
    expect(classifyYoutubeServiceRefusal(502, "Join this channel to get access to members-only content"))
      .toBe("members_only");
    expect(classifyYoutubeServiceRefusal(502, "Requested format is not available")).toBe("no_format");
    expect(classifyYoutubeServiceRefusal(502, "HTTP Error 429: Too Many Requests")).toBe("rate_limited");
    expect(classifyYoutubeServiceRefusal(502, "The uploader has not made this video available in your country"))
      .toBe("geo_blocked");
  });

  it("A MISSING TOKEN IS NOT A YOUTUBE PROBLEM", () => {
    /** 401 is the pair being misconfigured — the one failure that is entirely ours. */
    expect(classifyYoutubeServiceRefusal(401, "bad or missing bearer token")).toBe("auth");
    expect(classifyYoutubeServiceRefusal(403, "")).toBe("auth");
  });

  it("A TRANSPORT FAILURE IS NAMED — this body came back from the real service", () => {
    /**
     * Captured from an actual `/download` call against `services/ytdlp-download/main.py` running
     * with the real yt-dlp, in an environment whose proxy refuses YouTube. Not composed by hand:
     * this is what the service sends when it cannot REACH the platform.
     *
     * It classified as `other` on the first run, which is honest for an unrecognised message and
     * wrong for one this specific — and it is the failure a PROXY deployment produces, which is
     * the configuration under consideration. `network` also says something `unavailable` does not:
     * the video is fine and the same id is worth asking for again.
     */
    const real =
      "ERROR: [youtube] dQw4w9WgXcQ: Unable to download API page: ('Unable to connect to proxy', " +
      "OSError('Tunnel connection failed: 403 Forbidden')) (caused by ProxyError(\"('Unable to " +
      "connect to proxy', OSError('Tunnel connection failed: 403 Forbidden'))\")); please report " +
      "this issue on  https://github.com/";
    expect(classifyYoutubeServiceRefusal(502, real)).toBe("network");
    expect(youtubeServiceRefusalReason(502, real)).toBe("http_502:network");
  });

  it("and the other shapes a transport failure takes", () => {
    for (const body of [
      "Connection reset by peer",
      "Connection refused",
      "Temporary failure in name resolution",
      "The read operation timed out",
      "Network is unreachable",
    ]) {
      expect(classifyYoutubeServiceRefusal(502, body), body).toBe("network");
    }
  });

  it("A TRANSPORT FAILURE IS NOT A VIDEO FAILURE — the two must never merge", () => {
    /**
     * `unavailable` says the video is gone and asking again is pointless; `network` says the route
     * was blocked and asking again is exactly right. Merging them would either blacklist working
     * videos or retry dead ones forever.
     */
    expect(classifyYoutubeServiceRefusal(502, "Video unavailable")).toBe("unavailable");
    expect(classifyYoutubeServiceRefusal(502, "Connection refused")).toBe("network");
  });

  it("an unrecognised message is 'other', never guessed at", () => {
    expect(classifyYoutubeServiceRefusal(502, "something nobody has seen before")).toBe("other");
  });

  it("a bodiless 5xx is the service itself, not the platform", () => {
    expect(classifyYoutubeServiceRefusal(500, "")).toBe("service_error");
    expect(classifyYoutubeServiceRefusal(502, undefined)).toBe("service_error");
  });
});

describe("the recorded reason groups, and carries the unknown case", () => {
  it("A KNOWN CLASS IS THE WHOLE REASON — so forty-four of them count as forty-four", () => {
    /**
     * Reasons are counted, and the useful signal in a render with forty-four failures is that
     * forty-four of them say the same thing. A raw yt-dlp message carries a video id, so pasting
     * it would turn the histogram into a list of ones.
     */
    const a = youtubeServiceRefusalReason(502, "ERROR: [youtube] aaa: Sign in to confirm you're not a bot");
    const b = youtubeServiceRefusalReason(502, "ERROR: [youtube] bbb: Sign in to confirm you're not a bot");
    expect(a).toBe("http_502:bot_check");
    expect(a).toBe(b);
  });

  it("and only the unknown case carries the words, because only it has to", () => {
    const r = youtubeServiceRefusalReason(502, "kernel panic in the flux capacitor");
    expect(r).toContain("http_502:other:");
    expect(r).toContain("kernel panic");
  });

  it("THE STATUS IS KEPT, so a 401 and a 502 never read alike", () => {
    expect(youtubeServiceRefusalReason(401, "bad or missing bearer token")).toBe("http_401:auth");
    expect(youtubeServiceRefusalReason(502, "Video unavailable")).toBe("http_502:unavailable");
  });
});

describe("nothing secret survives into a log line", () => {
  it("A BEARER VALUE IS REMOVED, not truncated", () => {
    const out = sanitizeServiceDetail("refused with Bearer sk-live-abcdefghijklmnop trailing", 200);
    expect(out).not.toContain("sk-live");
    expect(out).toContain("Bearer …");
  });

  it("and a signed URL loses its query string", () => {
    const out = sanitizeServiceDetail(
      "fetch failed https://rr3---sn-x.googlevideo.com/videoplayback?sig=SECRETVALUE&ip=1.2.3.4",
      200
    );
    expect(out).not.toContain("SECRETVALUE");
    expect(out).not.toContain("sig=");
    expect(out).toContain("?…");
  });

  it("the unknown-case detail is bounded", () => {
    expect(sanitizeServiceDetail("x".repeat(500)).length).toBeLessThanOrEqual(60);
  });

  it("an empty body produces nothing rather than an empty pair of quotes", () => {
    expect(sanitizeServiceDetail("")).toBe("");
    expect(youtubeServiceRefusalReason(502, "   ")).toBe("http_502:service_error");
  });
});

describe("the render's one line about a download says why", () => {
  const line = (detail: string) =>
    formatYoutubeDownloadLine({
      videoId: "abc123",
      sceneIndex: 1,
      status: "DOWNLOAD_FAILED",
      attempts: [{ route: "cloud", status: "DOWNLOAD_FAILED", detail }],
      hasCloudRoute: true,
      hasRapidRoute: false,
      reason: "every_configured_route_failed",
    });

  it("THE DETAIL IS IN THE LINE — it was written and never read", () => {
    expect(line("http_502:bot_check")).toContain("cloud:DOWNLOAD_FAILED(http_502:bot_check)");
  });

  it("an attempt with no detail still reads cleanly", () => {
    expect(line("")).toContain("attempts=cloud:DOWNLOAD_FAILED ");
  });

  it("and a render with no attempt at all still says so", () => {
    const none = formatYoutubeDownloadLine({
      videoId: "abc123",
      sceneIndex: 0,
      status: "DOWNLOAD_UNAVAILABLE",
      attempts: [],
      hasCloudRoute: false,
      hasRapidRoute: false,
      reason: "no_download_route_configured",
    });
    expect(none).toContain("attempts=none");
  });

  it("the service URL and the token are still never printed", () => {
    /** Presence only, the same rule the preflight follows. */
    expect(line("http_401:auth")).toContain("cloudService=SET");
    expect(line("http_401:auth")).not.toMatch(/https?:\/\//);
  });
});

describe("the client records what the service is documented to send", () => {
  const SERVICE = readFileSync(
    join(__dirname, "..", "services", "ytdlp-download", "main.py"),
    "utf8"
  );

  it("EVERY 502 THE SERVICE CAN SEND HAS A CLASS ON THIS SIDE", () => {
    /**
     * The two halves are different languages, deployed separately — the seam
     * `ytdlpServiceContract` exists for. A refusal the service can produce and the client cannot
     * name would land in `other`, which is exactly the silence this change removes.
     */
    expect(SERVICE).toContain("yt-dlp produced no file");
    expect(SERVICE).toContain("file below floor");
    expect(SERVICE).toContain("file over ceiling");
    for (const body of ["yt-dlp produced no file", "file below floor (1 < 10000 bytes)"]) {
      expect(classifyYoutubeServiceRefusal(502, body)).not.toBe("other");
    }
  });

  it("and the client no longer records the bare status", () => {
    const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    const code = PIPE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code, "the body is read and thrown away again").not.toContain(
      'note("cloud", "DOWNLOAD_FAILED", `http_${dlResp.status}`)'
    );
    expect(code).toContain("youtubeServiceRefusalReason(dlResp.status, errText)");
  });
});
