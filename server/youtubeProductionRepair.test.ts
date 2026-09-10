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

describe("YT-REPAIR §1 — the order in which one scene budget is spent", () => {
  it("RENDER 576's SITUATION: 20s left is not enough for a 20s probe AND a download", () => {
    const d = shouldProbeYoutubeDuration({ remainingMs: 20_000, downloadFloorMs: FLOOR });
    expect(d.probe, "the probe would again leave 0s for the download").toBe(false);
    if (d.probe) throw new Error("unreachable");
    expect(d.reason).toBe("BUDGET_RESERVED_FOR_DOWNLOAD");
    expect(d.needMs).toBe(YOUTUBE_META_PROBE_TIMEOUT_MS + FLOOR);
  });

  it("A BUDGET THAT CAN PAY FOR BOTH STILL PROBES — nothing was taken away", () => {
    const d = shouldProbeYoutubeDuration({
      remainingMs: YOUTUBE_META_PROBE_TIMEOUT_MS + FLOOR,
      downloadFloorMs: FLOOR,
    });
    expect(d.probe).toBe(true);
  });

  it("THE BOUNDARY IS EXACT, and one millisecond under it refuses", () => {
    const need = YOUTUBE_META_PROBE_TIMEOUT_MS + FLOOR;
    expect(shouldProbeYoutubeDuration({ remainingMs: need, downloadFloorMs: FLOOR }).probe).toBe(true);
    expect(shouldProbeYoutubeDuration({ remainingMs: need - 1, downloadFloorMs: FLOOR }).probe).toBe(false);
  });

  it("NO SCOPE MEANS NO DEADLINE TO PROTECT — the prefetch case is unchanged", () => {
    /** `remainingScopeMs()` returns Infinity when nothing encloses the call. */
    expect(shouldProbeYoutubeDuration({ remainingMs: Infinity, downloadFloorMs: FLOOR }).probe).toBe(true);
    expect(shouldProbeYoutubeDuration({ remainingMs: Number.NaN, downloadFloorMs: FLOOR }).probe).toBe(true);
  });

  it("AN ALREADY-SPENT BUDGET REFUSES rather than going negative", () => {
    const d = shouldProbeYoutubeDuration({ remainingMs: 0, downloadFloorMs: FLOOR });
    expect(d.probe).toBe(false);
    if (d.probe) throw new Error("unreachable");
    expect(d.remainingMs).toBe(0);
  });

  it("THE PROBE FIX ITSELF RAISED NO BUDGET AND LOWERED NO FLOOR", () => {
    /**
     * The point of the probe change is that the same seconds are spent in a better ORDER, not that
     * there are more of them. These three numbers are still the ones render 576 ran with.
     *
     * The download CAP is deliberately not asserted here any more: a later round raised it from 20
     * to 60 as an explicit supply decision, and it has its own test below rather than being quietly
     * carried by a guard whose subject is the probe.
     */
    expect(FLOOR).toBe(12_000);
    expect(YOUTUBE_META_PROBE_TIMEOUT_MS).toBe(20_000);
    expect(youtubeDownloadTimeoutMs()).toBe(180_000);
    expect(PIPE).toContain("const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = 12_000;");
  });

  it("A SKIPPED PROBE IS NEVER SILENT — it says what it protected and what it cost", () => {
    const d = shouldProbeYoutubeDuration({ remainingMs: 6_000, downloadFloorMs: FLOOR });
    if (d.probe) throw new Error("unreachable");
    const line = formatYoutubeProbeSkip(2, "wFkJyj92uLo", d);
    expect(line).toContain("wFkJyj92uLo");
    expect(line).toContain("6s left");
    expect(line).toContain("32s");
    expect(line, "the reader is not told the start offset degraded").toContain("falls back");
  });

  it("the decision is one function with one definition, and the price is one constant", () => {
    expect((POLICY.match(/export function shouldProbeYoutubeDuration/g) ?? []).length).toBe(1);
    expect((POLICY.match(/export const YOUTUBE_META_PROBE_TIMEOUT_MS/g) ?? []).length).toBe(1);
    /** The probe's timeout and the price the decision pays are the same number, not two copies. */
    expect(PIPE).toContain("fetchWithTimeout(metaUrl, YOUTUBE_META_PROBE_TIMEOUT_MS,");
  });
});

/* ═══════════ 2. the pipeline actually asks, before it probes ═══════════ */

describe("YT-REPAIR §2 — wired into the route that lost the downloads", () => {
  const site = () => {
    const at = PIPE.indexOf("const probe = shouldProbeYoutubeDuration({");
    expect(at, "the YouTube loop never asks").toBeGreaterThan(0);
    return PIPE.slice(at, at + 900);
  };

  it("IT ASKS WITH THE SCENE'S REAL REMAINING TIME AND THE DOWNLOAD'S REAL FLOOR", () => {
    expect(site()).toContain("remainingMs: remainingScopeMs(),");
    expect(site()).toContain("downloadFloorMs: YOUTUBE_MIN_DOWNLOAD_WINDOW_MS,");
  });

  it("THE DECISION REACHES THE FETCHER — a computed value that is not carried is the old defect", () => {
    expect(site()).toContain("onlyIfCached: !probe.probe,");
  });

  it("IT IS ASKED BEFORE THE PROBE, not after it", () => {
    const decide = PIPE.indexOf("const probe = shouldProbeYoutubeDuration({");
    const fetch = PIPE.indexOf("await fetchRapidApiYoutubeMeta(videoId, sceneIndex, sourcingCache, {", decide);
    expect(fetch).toBeGreaterThan(decide);
  });

  it("A CACHED ANSWER IS STILL FREE AND STILL USED", () => {
    const at = PIPE.indexOf("async function fetchRapidApiYoutubeMeta(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    const cacheHit = body.indexOf("metadataCacheHits++");
    const bail = body.indexOf("if (opts?.onlyIfCached) return null;");
    expect(cacheHit).toBeGreaterThan(0);
    expect(bail, "the cache is consulted after the bail-out, so hits are thrown away").toBeGreaterThan(cacheHit);
  });

  it("A SKIPPED MISS COUNTS NO METADATA CALL — a counter that says otherwise lies", () => {
    const at = PIPE.indexOf("async function fetchRapidApiYoutubeMeta(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body.indexOf("metadataCount++")).toBeGreaterThan(body.indexOf("if (opts?.onlyIfCached) return null;"));
  });

  it("A SKIPPED MISS IS NOT CACHED — the clock must not become a fact about the video", () => {
    const at = PIPE.indexOf("async function fetchRapidApiYoutubeMeta(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body.indexOf("if (opts?.onlyIfCached) return null;")).toBeLessThan(
      body.indexOf("putCachedProviderAsset")
    );
  });

  it("THE START OFFSET STILL HAS ITS EXISTING FALLBACK — nothing new was invented", () => {
    /** Exactly the path a video RapidAPI knows nothing about has always taken. */
    expect(PIPE).toContain("|| peekYoutubeVideoContext(videoId)?.durationSec || 0;");
    expect(PIPE).toContain("? pickLongVideoStartSec(sourceDurationSec, clipDur, videoId)");
  });

  it("THE DOWNLOAD ITSELF IS UNTOUCHED — its guard, its floor and its report all stand", () => {
    expect(PIPE).toContain("if (remainingMs < YOUTUBE_MIN_DOWNLOAD_WINDOW_MS) {");
    expect(PIPE).toContain('reportDownload("DOWNLOAD_TIMEOUT", "scene_budget_too_short_to_start");');
  });
});

/* ═══════════ 3. the preflight answers three questions, not one ═══════════ */

describe("YT-REPAIR §3 — primary, fallback and rights are separate answers", () => {
  const byId = (id: string) => CAPABILITIES.find((c) => c.id === id);

  it("ALL THREE CAPABILITIES EXIST", () => {
    for (const id of ["youtube_download_primary", "youtube_fallback_download", "youtube_cc_evidence"]) {
      expect(byId(id), `${id} is missing`).toBeDefined();
    }
  });

  it("THE PRIMARY IS THE CLOUD SERVICE, THE FALLBACK IS RAPIDAPI, and neither borrows the other", () => {
    expect(byId("youtube_download_primary")!.requires).toEqual(["YOUTUBE_CC_DL_SERVICE"]);
    expect(byId("youtube_fallback_download")!.requires).toEqual(["RAPIDAPI_KEY"]);
    expect(byId("youtube_download_primary")!.requiresAny ?? []).toEqual([]);
    expect(byId("youtube_fallback_download")!.requiresAny ?? []).toEqual([]);
  });

  it("RENDER 576's EXACT DEPLOYMENT IS NOW LEGIBLE — primary MISSING, fallback AVAILABLE", () => {
    const env = { RAPIDAPI_KEY: "present" } as NodeJS.ProcessEnv;
    const has = (c: { requires: readonly string[] }) => c.requires.every((k) => Boolean(env[k]));
    expect(has(byId("youtube_download_primary")!), "the missing primary reads as present again").toBe(false);
    expect(has(byId("youtube_fallback_download")!)).toBe(true);
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
      "youtube_fallback_download",
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

  it("THE SEARCH GATE AND THE VISION GATE ARE EXACTLY AS THEY WERE", () => {
    /** NOT_ASKED is still not a verdict — RONDE 89/230-A's rule. */
    expect(PIPE).toContain('gateVerdict !== "NOT_ASKED"');
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
    /** `downloadCount` — the usage summary's `downloaded` column — rises on `ok` and nowhere else. */
    expect(
      [...PIPE.matchAll(/providerMetrics\(sourcingCache, "youtube_cc"\)\.downloadCount\+\+/g)]
    ).toHaveLength(1);
    expect(PIPE).toContain('if (ok) providerMetrics(sourcingCache, "youtube_cc").downloadCount++;');
  });
});
