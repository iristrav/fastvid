/**
 * A GREEN PROBE THAT MEANT NOTHING.
 *
 * `/api/health/youtube-probe` exists so an operator can answer "is YouTube going to work" without
 * spending a sixteen-minute render on the question. It does real work — a live YouTube CC search
 * and a live RapidAPI metadata call — and its verdict was wrong in two directions at once.
 *
 * ── It could say OK for a deployment that never touches YouTube ─────────────────────────────
 *
 * The verdict was built from `youtubeCcReady()`, which asks only about KEYS. `ENABLE_YOUTUBE_
 * SOURCING` is the very first guard `fetchYouTubeCCClips` checks, before any key is read — so a
 * deployment with perfect keys and the flag off got a 200 here and zero YouTube in every render.
 *
 * That is render 562 exactly. Had this probe been run then, it would have said the pipeline was
 * fine and sent the search somewhere else.
 *
 * ── And 503 for a deployment that works ─────────────────────────────────────────────────────
 *
 * It required `rapidApiStatus === 200`. `downloadYouTubeCCClip` tries the cloud yt-dlp service
 * FIRST and only falls back to RapidAPI, so an operator running route A alone — no RapidAPI
 * subscription at all — was told their working configuration was broken.
 *
 * ── What these tests hold ───────────────────────────────────────────────────────────────────
 *
 * The flag is part of the verdict, and either download route satisfies it. The probe reports
 * which one answered, so "it works" and "it works via the fallback" stay distinguishable.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const CORE = fs.readFileSync(path.join(__dirname, "_core", "index.ts"), "utf8");

/** The probe body, from its signature to its final return. */
function probeBody(): string {
  const at = PIPE.indexOf("export async function probeYouTubeCcPipeline(");
  expect(at, "the probe has moved").toBeGreaterThan(-1);
  const end = PIPE.indexOf("\n}", PIPE.indexOf("    sampleVideoId,\n    message,\n  };", at));
  expect(end).toBeGreaterThan(at);
  return PIPE.slice(at, end);
}

/* ═══════════════════════ the flag is part of the answer ═══════════════════════ */

describe("the probe knows the flag exists", () => {
  /**
   * The single most misleading thing the old verdict could do: report a healthy pipeline for a
   * deployment whose renders skip YouTube before reading a key.
   */
  it("reports ENABLE_YOUTUBE_SOURCING", () => {
    expect(probeBody(), "the probe never reads the flag that gates the whole branch").toContain(
      "const sourcingEnabled = youtubeSourcingEnabled();"
    );
    expect(probeBody()).toContain("sourcingEnabled,");
  });

  /** Every exit returns it, including the two early ones — an absent field reads as false. */
  it("every return carries it", () => {
    const body = probeBody();
    const returns = [...body.matchAll(/return \{/g)].length;
    const carried = [...body.matchAll(/sourcingEnabled,?\n/g)].length;
    expect(returns, "the probe has no returns to check").toBeGreaterThanOrEqual(3);
    expect(carried, "an exit omits the flag, so a caller reads it as false").toBeGreaterThanOrEqual(
      returns
    );
  });

  /** It outranks the key checks in the message, because it outranks them in the pipeline. */
  it("says the flag first, before blaming a key", () => {
    const body = probeBody();
    const flagMsg = body.indexOf("ENABLE_YOUTUBE_SOURCING is not true");
    const keyMsg = body.indexOf("YouTube API key invalid");
    expect(flagMsg, "the flag is not mentioned in the message at all").toBeGreaterThan(-1);
    expect(
      flagMsg,
      "a key is blamed before the flag that stops the render from reaching it"
    ).toBeLessThan(keyMsg);
  });

  /** And the endpoint's 200/503 verdict actually uses it. */
  it("the endpoint's verdict includes the flag", () => {
    const at = CORE.indexOf('app.get("/api/health/youtube-probe"');
    expect(at, "the probe endpoint has moved").toBeGreaterThan(-1);
    const handler = CORE.slice(at, at + 1400);
    expect(handler, "the endpoint answers 200 for a deployment that skips YouTube").toContain(
      "probe.sourcingEnabled"
    );
  });
});

/* ═══════════════════════ either download route counts ═══════════════════════ */

describe("the probe tries both download routes, in the pipeline's own order", () => {
  /** Route A is tried first by downloadYouTubeCCClip, so the probe checks it first too. */
  it("probes the cloud service", () => {
    const body = probeBody();
    expect(body, "route A cannot be verified by the probe at all").toContain(
      "process.env.YOUTUBE_CC_DL_SERVICE"
    );
    expect(body, "the cloud probe does not call the service's health endpoint").toContain(
      "/health"
    );
    expect(body, "the cloud probe drops the bearer token the service may require").toContain(
      "Authorization: `Bearer ${token}`"
    );
  });

  /** Either is enough. The pipeline falls through cloud to RapidAPI on every single download. */
  it("passes when either route answers", () => {
    const body = probeBody();
    expect(body).toContain('const downloadRoute: "cloud" | "rapidapi" | null =');
    expect(body, "the verdict still demands RapidAPI specifically").toMatch(
      /cloudOk \? "cloud" : rapidOk \? "rapidapi" : null/
    );
  });

  /** Which one answered is reported, so a fallback is not mistaken for the primary route. */
  it("names the route that answered", () => {
    expect(probeBody()).toContain("downloadRoute,");
    const at = CORE.indexOf('app.get("/api/health/youtube-probe"');
    expect(CORE.slice(at, at + 1400)).toContain("probe.downloadRoute !== null");
  });

  /** The old rule, gone: requiring RapidAPI failed a working route-A-only deployment. */
  it("no longer requires RapidAPI specifically", () => {
    const at = CORE.indexOf('app.get("/api/health/youtube-probe"');
    const handler = CORE.slice(at, at + 1400);
    expect(
      handler,
      "a deployment running only the cloud service is still told it is broken"
    ).not.toContain("probe.rapidApiHasFormat;");
  });
});

/* ═══════════════════════ it still does real work ═══════════════════════ */

describe("nothing was replaced by a guess", () => {
  /** The probe's value is that it actually calls YouTube. A config-only check would prove nothing. */
  it("still performs a live YouTube CC search", () => {
    const body = probeBody();
    expect(body).toContain("googleapis.com/youtube/v3/search");
    expect(body).toContain('searchUrl.searchParams.set("videoLicense", "creativeCommon")');
  });

  /** And a live RapidAPI metadata call that checks for a usable MP4, not merely a 200. */
  it("still checks RapidAPI returns a real MP4 format", () => {
    const body = probeBody();
    expect(body).toContain("rapidApiHasFormat");
    expect(body).toMatch(/mimeType\?\.includes\("mp4"\)/);
  });

  /** Every network call is bounded — a probe that hangs is worse than one that fails. */
  it("bounds every call it makes", () => {
    const body = probeBody();
    const calls = [...body.matchAll(/fetchWithTimeout\(/g)];
    expect(calls.length, "a network call in the probe is unbounded").toBeGreaterThanOrEqual(3);
  });
});
