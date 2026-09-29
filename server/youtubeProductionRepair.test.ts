/**
 * FASTVID — YOUTUBE PRODUCTION REPAIR.
 *
 * Render 576 asked YouTube 27 questions, got 80 candidates back, started 10 downloads and finished
 * none. The reasons were never a gate, a licence or a ranking:
 *
 *     [SearchGate] provider=youtube_cc built=27 validated=27 rejected=0 sent=27 blocked=0
 *     [YouTubeLicense] action=ALLOW_UNVERIFIED_YOUTUBE          ← allowed, not refused
 *     [SourcingMetrics] youtube_cc: metadata=13 ... downloads=0
 *     downloadOutcomes DOWNLOAD_TIMEOUT=14 DOWNLOAD_FAILED=4 DOWNLOAD_UNSUPPORTED=2
 *     [YouTubeUsage] used=0
 *
 * Two facts explain it, and only one of them is code.
 *
 * The deployment fact: `cloudService=MISSING rapidApi=SET` on every attempt, and across every
 * production log kept for this project the line "YouTube CC via cloud service" has never been
 * printed once. The route built to fetch only the seconds a beat needs has never run in production.
 *
 * The code fact, which is what this file tests: the surviving route spends the scene budget in the
 * wrong order. It probes RapidAPI for the source duration — detached from the scene scope, so
 * un-abortable, up to twenty seconds — and only THEN asks to download, at which point RONDE 68
 * refuses to start a whole-video transfer with under twelve seconds left. Across the logs, 79
 * downloads were refused for a spent budget and 75 of those said `0s left`.
 *
 * The probe is an optimisation on WHERE to cut. The download is the clip. When the budget cannot
 * pay for both, the download is what the budget is for.
 *
 * WHAT THIS FILE CANNOT PROVE, stated here so no reader mistakes green for production: no test in
 * this repository can show a YouTube clip reaching a film. That needs the primary service, real
 * credentials and reachable YouTube, and this environment has none of the three. A mock downloader
 * would produce a passing test and zero evidence.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  YOUTUBE_META_PROBE_TIMEOUT_MS,
  formatYoutubeProbeSkip,
  shouldProbeYoutubeDuration,
  youtubeDownloadTimeoutMs,
  youtubeMaxDownloadsPerRender,
  youtubeOperatorAuthorized,
} from "./sourcingPolicy";
import { allowUnverifiedYoutube } from "./youtubeLicenseStatus";
import { CAPABILITIES } from "./productionPreflight";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const POLICY = fs.readFileSync(path.join(__dirname, "sourcingPolicy.ts"), "utf8");

/** RONDE 68's floor, read from the pipeline rather than restated, so a change here is caught. */
const FLOOR = (() => {
  const m = /const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = ([0-9_]+);/.exec(PIPE);
  expect(m, "the download floor is gone").not.toBeNull();
  return Number(m![1]!.replace(/_/g, ""));
})();

/* ═══════════ 1. the probe no longer spends what the download needs ═══════════ */


/* ═══════════ 2. the pipeline actually asks, before it probes ═══════════ */

describe("YT-REPAIR §2 — wired into the route that lost the downloads", () => {
  const site = () => {
    const at = PIPE.indexOf("const probe = shouldProbeYoutubeDuration({");
    expect(at, "the YouTube loop never asks").toBeGreaterThan(0);
    return PIPE.slice(at, at + 900);
  };







  it("THE START OFFSET STILL HAS ITS EXISTING FALLBACK — nothing new was invented", () => {
    /** Exactly the path a video RapidAPI knows nothing about has always taken. */
    expect(PIPE).toContain("|| peekYoutubeVideoContext(videoId)?.durationSec || 0;");
    expect(PIPE).toContain("? pickLongVideoStartSec(sourceDurationSec, clipDur, videoId)");
  });

});

/* ═══════════ 3. the preflight answers three questions, not one ═══════════ */

describe("YT-REPAIR §3 — primary, fallback and rights are separate answers", () => {
  const byId = (id: string) => CAPABILITIES.find((c) => c.id === id);

  it("THE PRIMARY AND RIGHTS CAPABILITIES EXIST; the RapidAPI fallback is gone (switched off, video 619)", () => {
    expect(byId("youtube_fallback_download")).toBeUndefined();
    for (const id of ["youtube_download_primary", "youtube_cc_evidence"]) {
      expect(byId(id), `${id} is missing`).toBeDefined();
    }
  });

  it("THE PRIMARY IS THE CLOUD SERVICE and borrows nothing", () => {
    expect(byId("youtube_download_primary")!.requires).toEqual(["YOUTUBE_CC_DL_SERVICE"]);
    expect(byId("youtube_download_primary")!.requiresAny ?? []).toEqual([]);
  });

  it("RENDER 576's EXACT DEPLOYMENT IS NOW LEGIBLE — a RapidAPI key alone is no download route", () => {
    const env = { RAPIDAPI_KEY: "present" } as NodeJS.ProcessEnv;
    const has = (c: { requires: readonly string[] }) => c.requires.every((k) => Boolean(env[k]));
    expect(has(byId("youtube_download_primary")!), "the missing primary reads as present again").toBe(false);
  });

  it("THE RIGHTS QUESTION MIRRORS PRODUCTION'S OWN RULES, defaults included", () => {
    const rights = byId("youtube_cc_evidence")!;
    expect(rights.satisfiedBy).toBeDefined();
    /**
     * The preflight restates two rules that live in the sourcing layer. These assertions are what
     * stops the restatement from drifting: the operator flag defaults ON, the unverified flag
     * defaults OFF, and the production functions are the reference.
     */
    expect(rights.satisfiedBy!({} as NodeJS.ProcessEnv).available).toBe(youtubeOperatorAuthorized());
    expect(allowUnverifiedYoutube()).toBe(false);
    const off = { ALLOW_OPERATOR_LICENSED_YOUTUBE: "false" } as NodeJS.ProcessEnv;
    expect(rights.satisfiedBy!(off).available).toBe(false);
    expect(
      rights.satisfiedBy!({ ...off, ALLOW_UNVERIFIED_YOUTUBE: "true" } as NodeJS.ProcessEnv).available
    ).toBe(true);
  });

  it("AN OPERATOR AUTHORISATION NEVER REPORTS ITSELF AS A PROVEN LICENCE", () => {
    /** RONDE 124/147's distinction: VERIFIED is a claim only the verification flow may make. */
    const detail = byId("youtube_cc_evidence")!.satisfiedBy!({} as NodeJS.ProcessEnv).detail;
    expect(detail).toContain("OPERATOR_AUTHORIZED");
    expect(detail).toContain("never VERIFIED");
    const unverified = byId("youtube_cc_evidence")!.satisfiedBy!({
      ALLOW_OPERATOR_LICENSED_YOUTUBE: "false",
      ALLOW_UNVERIFIED_YOUTUBE: "true",
    } as NodeJS.ProcessEnv).detail;
    expect(unverified).toContain("rights are NOT proven");
  });

  it("NO YOUTUBE CAPABILITY IS FATAL — a render without YouTube is a render", () => {
    for (const id of [
      "youtube_search",
      "youtube_download",
      "youtube_download_primary",
      "youtube_cc_evidence",
    ]) {
      expect(byId(id)!.fatal, `${id} would block a render`).toBe(false);
    }
  });

  it("every capability id is still unique", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ═══════════ 4. the rights gate was not touched ═══════════ */

describe("YT-REPAIR §4 — nothing was loosened to make YouTube work", () => {
  it("THE UNVERIFIED FLAG STILL DEFAULTS TO OFF", () => {
    expect(allowUnverifiedYoutube()).toBe(false);
  });

  it("THE DOWNLOAD CAP WAS RAISED ON PURPOSE, and only the cap", () => {
    /**
     * 20 → 60. Not a gate, not a threshold, not a quality bar: a supply budget, raised because the
     * production logs show what the old number costs. Attempts against clips delivered:
     *
     *     24 aug   103 → 17     25 aug    97 → 44     (ceiling not yet binding)
     *     31 aug    20 →  2     10 sept   20 →  0     (ceiling binding)
     *
     * 60 stays under the ~100 those two renders spent without harm. Asserted here as its own
     * statement so the change can never be mistaken for drift, and so the next reader sees the
     * evidence rather than a number.
     */
    expect(youtubeMaxDownloadsPerRender()).toBe(60);
    /** Still bounded, still overridable in both directions, still refusing nonsense. */
    expect(youtubeMaxDownloadsPerRender()).toBeLessThan(134);
    expect(PIPE).toContain("if (m.downloadSlotsClaimed >= maxDownloads) return false;");
  });

  it("A REFUSED VIDEO STILL COSTS NO SECOND SLOT — the R235 memo is still consulted first", () => {
    const consult = PIPE.indexOf("const alreadyRefused = youtubeDownloadRefusal(videoId);");
    const claim = PIPE.indexOf("if (!claimDownloadSlot()) {");
    expect(consult).toBeGreaterThan(0);
    expect(claim).toBeGreaterThan(consult);
  });

  it("AND A DOWNLOAD THAT FAILED IS STILL NOT A DOWNLOAD THAT SUCCEEDED", () => {
    /**
     * The `downloaded` column rises on `ok` and nowhere else — now through the lineage event,
     * which is also what files the failure with its own status.
     *
     * This used to require exactly one `downloadCount++`. That bump ran alongside the event and
     * the end-of-render fold adds the two channels, so the column rose TWICE per arrival: 88
     * printed for forty-four downloads, out of a ceiling of 60 attempts. See `aCounterCountsOnce`.
     */
    expect(
      [...PIPE.matchAll(/providerMetrics\(sourcingCache, "youtube_cc"\)\.downloadCount\+\+/g)]
    ).toHaveLength(0);
    const at = PIPE.indexOf("if (!claimDownloadSlot()) {");
    const block = PIPE.slice(at, PIPE.indexOf("results.push(outPath);", at));
    expect(block).toContain("recordProviderDownloadOutcome(");
    expect(block).toContain("youtube_download_failed");
  });
});
