/**
 * MASTER YOUTUBE BUILD — a YouTube video never disappears without a reason.
 *
 * ── The production silence this comes from ───────────────────────────────────────────────────
 *
 * The first real Railway render (Stauffenberg / Hitler / Berlin) produced this, and only this,
 * about YouTube in six and a half minutes of log:
 *
 *     [YouTubeLicense] video=GWam7jHmwPg … action=ALLOW_UNVERIFIED_YOUTUBE   (×12)
 *     [YouTubeUsage] used=0
 *
 * Twelve videos found, twelve licence-approved, none used, and not one line explaining the gap.
 * `downloadYouTubeCCClip` ended in a bare `return false`, so "there is no download route
 * configured" and "the route was there and failed" were the same observable event: nothing.
 *
 * ── Why the distinction is the whole point ──────────────────────────────────────────────────
 *
 * They need opposite responses. DOWNLOAD_UNAVAILABLE is a configuration gap — YouTube search
 * works, ingest was never set up, and no amount of debugging the pipeline will change it.
 * DOWNLOAD_FAILED means a configured service did not deliver, which is a real fault to chase.
 *
 * These tests assert on the SOURCE of the function rather than running it, deliberately: reaching
 * the final return requires every configured route to fail first, and faking that would mean
 * mocking the very fetch this round is forbidden from mocking. What can be checked without a
 * network is that the exit path exists, names both states, and prints presence and never a value.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";

const SRC = fs.readFileSync("server/videoPipeline.ts", "utf8");

/**
 * The downloader, so every claim below is about that code and nothing else.
 *
 * FINAL VALIDATION §4 widened the window: the log line is now built by
 * `formatYoutubeDownloadLine`, declared just above the function so the statuses can be classified
 * and unit-tested without a network. Both live between these two markers, and every assertion
 * below is unchanged — a claim about "the downloader" is still a claim about exactly this code.
 */
const BODY = (() => {
  const start = SRC.indexOf("export type YoutubeDownloadStatus =");
  expect(start, "the download status vocabulary has moved").toBeGreaterThan(-1);
  const fn = SRC.indexOf("export async function downloadYouTubeCCClip(", start);
  expect(fn, "downloadYouTubeCCClip has moved or no longer follows its status vocabulary")
    .toBeGreaterThan(start);
  const end = SRC.indexOf("export async function probeYouTubeCcPipeline(", fn);
  expect(end, "the end marker has moved").toBeGreaterThan(fn);
  return SRC.slice(start, end);
})();

describe("YOUTUBE — a clip that cannot be fetched says why", () => {
  /**
   * The regression itself. A bare `return false` at the end of this function is the defect: it is
   * what made twelve videos vanish in production with nothing to grep for.
   */
  it("does not end in a silent return", () => {
    const tail = BODY.slice(BODY.lastIndexOf("return false"));
    expect(tail.length, "return false is the last statement, with no log before it").toBeGreaterThan(0);
    const beforeReturn = BODY.slice(0, BODY.lastIndexOf("return false"));
    expect(
      beforeReturn.includes("[YouTubeDownload]"),
      "the function can still return false without logging anything"
    ).toBe(true);
  });

  it("distinguishes no-route-configured from route-failed", () => {
    expect(BODY).toContain("DOWNLOAD_UNAVAILABLE");
    expect(BODY).toContain("DOWNLOAD_FAILED");
  });

  /** The reason has to name the fix, because the fix is a configuration change, not a code one. */
  it("names the variables an operator would have to set", () => {
    expect(BODY).toContain("no_download_route_configured");
    expect(BODY).toContain("YOUTUBE_CC_DL_SERVICE");
    expect(BODY).toContain("RAPIDAPI_KEY");
  });

  /**
   * §4 narrowed this to the formatter's own body rather than "everything after the first
   * [YouTubeDownload]". The old window ran to the end of the function and happened to exclude the
   * download URL only because that URL is built above the log line — a coincidence of ordering,
   * not a property. Checking the line's actual builder is the stricter test, and the second half
   * below now covers every OTHER log statement in the downloader too, which the old one never did.
   */
  const FORMATTER = (() => {
    const start = BODY.indexOf("export function formatYoutubeDownloadLine(");
    expect(start, "the download line formatter is gone").toBeGreaterThan(-1);
    const end = BODY.indexOf("export async function downloadYouTubeCCClip(", start);
    expect(end, "the formatter no longer sits directly above the downloader").toBeGreaterThan(start);
    return BODY.slice(start, end);
  })();

  it("reports the two routes as presence, never as a value", () => {
    expect(FORMATTER).toContain('"SET" : "MISSING"');
    /** The service URL and the key must not be interpolated into the log. */
    expect(FORMATTER).not.toMatch(/\$\{\s*(params\.)?cloudDlService\s*\}/);
    expect(FORMATTER).not.toMatch(/\$\{\s*(params\.)?RAPIDAPI_KEY\s*\}/);
  });

  /**
   * No secret may reach ANY log statement in the downloader — not just the one status line.
   *
   * Checked from the secret outwards rather than from the console call inwards: each place a
   * secret is interpolated, look back to the start of its statement and require that statement not
   * to be a log. Interpolating the service URL into the DOWNLOAD URL is correct and must stay
   * allowed; interpolating it into a message is the leak.
   */
  it("never logs a service URL, key or token from anywhere in the downloader", () => {
    for (const secret of ["cloudDlService", "cloudDlToken", "RAPIDAPI_KEY", "YOUTUBE_CC_DL_TOKEN"]) {
      for (const use of BODY.matchAll(new RegExp(`\\$\\{\\s*${secret}\\b`, "g"))) {
        const statementStart = Math.max(
          BODY.lastIndexOf(";", use.index!),
          BODY.lastIndexOf("{", use.index!)
        );
        const statement = BODY.slice(statementStart + 1, use.index!);
        expect(statement, `${secret} is interpolated into a log statement`).not.toMatch(/console\./);
      }
    }
  });

  /**
   * The video and the scene are in the line, so a beat can be traced back to its failed fetch.
   *
   * §4 moved the formatting into `formatYoutubeDownloadLine`, whose fields arrive on a `params`
   * object — hence the optional prefix. The claim is unchanged: both identifiers are interpolated
   * into the line, neither is a constant.
   */
  it("names the video and the scene it was for", () => {
    const line = BODY.slice(BODY.indexOf("[YouTubeDownload]"));
    expect(line).toMatch(/video=\$\{(params\.)?videoId\}/);
    expect(line).toMatch(/scene=\$\{(params\.)?sceneIndex\}/);
  });
});

/* ═══════════ the capability the preflight already knows about ═══════════ */

describe("YOUTUBE — search and download are separate capabilities", () => {
  /**
   * The preflight has said this since R191, and the production render proved it was right: a key
   * that finds candidates with no way to fetch them produces a render where YouTube is ranked and
   * never used. This pins that the two stay separate entries rather than collapsing into one
   * "youtube" capability that could report OK on half a chain.
   */
  it("the preflight reports them as two capabilities", async () => {
    const { CAPABILITIES } = await import("./productionPreflight");
    const search = CAPABILITIES.find((c) => c.id === "youtube_search");
    const download = CAPABILITIES.find((c) => c.id === "youtube_download");
    expect(search, "youtube_search capability is gone").toBeTruthy();
    expect(download, "youtube_download capability is gone").toBeTruthy();
    expect(search!.requires).toContain("YOUTUBE_API_KEY");
    expect(download!.requiresAny).toEqual(
      expect.arrayContaining(["YOUTUBE_CC_DL_SERVICE", "RAPIDAPI_KEY"])
    );
  });

  /** Neither may be fatal: a render without YouTube is a valid render of the other sources. */
  it("neither blocks a render on its own", async () => {
    const { CAPABILITIES } = await import("./productionPreflight");
    for (const id of ["youtube_search", "youtube_download"]) {
      expect(CAPABILITIES.find((c) => c.id === id)!.fatal, `${id} became fatal`).toBe(false);
    }
  });
});
