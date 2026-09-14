/**
 * ONE VIDEO, FOUR ATTEMPTS, AND THE ANSWER WAS THERE ON THE FOURTH.
 *
 * ── What render 581 measured ────────────────────────────────────────────────────────────────
 *
 *     Scene 0: not probing ynJoy1OCeVQ's duration — 2s left and the probe plus the download floor
 *              need 32s. The start offset falls back; the download keeps the budget
 *     Scene 0: Cloud DL failed for ynJoy1OCeVQ: Aborted: … cancelled by the enclosing scene budget
 *              before its own 55s timeout — the request itself did not time out
 *     Scene 0: skipping YouTube download of ynJoy1OCeVQ — 0s left in the scene budget
 *     … three times …
 *     Scene 0: Cloud DL service error 502 for ynJoy1OCeVQ:
 *              {"detail":"ERROR: [youtube] ynJoy1OCeVQ: Sign in to confirm you're not a bot…
 *
 *     [YouTubeDownload] video=ynJoy1OCeVQ status=DOWNLOAD_TIMEOUT
 *                       attempts=cloud:DOWNLOAD_FAILED(http_502:bot_check),
 *                                rapidapi:DOWNLOAD_TIMEOUT(scene_budget_1s_left)
 *
 * Two defects, stacked, and neither is the bot check itself:
 *
 *   B  The budget guard existed only on the FALLBACK. The pipeline states it has two seconds and
 *      needs thirty-two, declines the duration probe to save the budget, and then spends that
 *      budget on a cloud call the enclosing scope cancels mid-flight. Three of the four attempts
 *      never reached the service at all.
 *
 *   C  The service's verdict never reached the refusal memo. `bot_check` was classified, printed,
 *      and then outranked: the headline status is `DOWNLOAD_TIMEOUT`, because the fallback's
 *      budget stand-aside ranks above the cloud branch's `DOWNLOAD_FAILED`. YouTube does not
 *      change its mind about a bot check in fifty seconds, and the video was asked for four times.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  YOUTUBE_DURABLE_SERVICE_REFUSALS,
  YOUTUBE_PERMANENT_DOWNLOAD_STATUSES,
  isDurableYoutubeServiceRefusal,
  noteYoutubeDownloadRefusal,
  youtubeDownloadRefusal,
  resetPermanentDownloadRefusals,
  youtubeServiceRefusalReason,
} from "./providerFailureClass";

describe("B. the budget is checked before the cloud call, not only before the fallback", () => {
  const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const FETCH = SRC.slice(
    SRC.indexOf("  // F3-41: cloud/yt-dlp service tried FIRST"),
    SRC.indexOf("/** Live probe: YouTube CC search + RapidAPI metadata")
  );

  it("the guard runs before the cloud branch is entered", () => {
    const guard = FETCH.indexOf("not calling the yt-dlp cloud service");
    const call = FETCH.indexOf("const dlUrl = `${cloudDlService}/download");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(call);
  });

  it("it uses the same floor the fallback already used — one number, not two", () => {
    const before = FETCH.slice(0, FETCH.indexOf("const dlUrl = `${cloudDlService}/download"));
    expect(before).toContain("remainingScopeMs()");
    expect(before).toContain("YOUTUBE_MIN_DOWNLOAD_WINDOW_MS");
    /** The fallback's own guard is untouched and still there. */
    expect(FETCH).toContain("scene_budget_too_short_to_start");
    expect((FETCH.match(/YOUTUBE_MIN_DOWNLOAD_WINDOW_MS/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  /**
   * Standing aside is not a timeout: nothing was contacted and nothing timed out. It shares the
   * fallback's reason string on purpose, so the two read as one decision in the log.
   */
  it("the stand-aside is reported under its own reason and says what it saved", () => {
    const before = FETCH.slice(0, FETCH.indexOf("const dlUrl = `${cloudDlService}/download"));
    expect(before).toContain('reportDownload("DOWNLOAD_TIMEOUT", "scene_budget_too_short_to_start")');
    expect(before).toContain("would be cancelled");
  });

  it("no timeout value was raised to paper over the shortage", () => {
    expect(SRC).toContain("const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = 12_000;");
  });
});

describe("C. a refusal that cannot change within a render is remembered", () => {
  const reset = () => resetPermanentDownloadRefusals();

  it("the bot check render 581 hit is durable", () => {
    reset();
    expect(noteYoutubeDownloadRefusal("ynJoy1OCeVQ", "DOWNLOAD_FAILED", "http_502:bot_check")).toBe(true);
    expect(youtubeDownloadRefusal("ynJoy1OCeVQ")).toContain("bot_check");
  });

  it.each(["private", "members_only", "unavailable", "geo_blocked", "no_format"])(
    "%s is a fact about the video and is remembered",
    (cls) => {
      reset();
      expect(noteYoutubeDownloadRefusal("vid", "DOWNLOAD_FAILED", `http_502:${cls}`)).toBe(true);
    }
  );

  /**
   * The one refusal that lifts on its own. This is the whole reason the list is explicit rather
   * than "everything the classifier named".
   */
  it("rate_limited is NOT remembered — it lifts on its own", () => {
    reset();
    expect(noteYoutubeDownloadRefusal("vid", "DOWNLOAD_FAILED", "http_429:rate_limited")).toBe(false);
    expect(youtubeDownloadRefusal("vid")).toBeNull();
    expect(YOUTUBE_DURABLE_SERVICE_REFUSALS.has("rate_limited")).toBe(false);
  });

  it.each(["auth", "proxy", "other", "no_file", "below_floor"])(
    "%s is about the deployment or the cut, not this video, and is not remembered",
    (cls) => {
      reset();
      expect(noteYoutubeDownloadRefusal("vid", "DOWNLOAD_FAILED", `http_502:${cls}`)).toBe(false);
    }
  );

  /** RONDE 223's status rule is untouched: a bare DOWNLOAD_FAILED is still ambiguous. */
  it("DOWNLOAD_FAILED with no classified reason is still not remembered", () => {
    reset();
    expect(noteYoutubeDownloadRefusal("vid", "DOWNLOAD_FAILED", "http_500")).toBe(false);
    expect(noteYoutubeDownloadRefusal("vid", "DOWNLOAD_FAILED", undefined)).toBe(false);
    expect(YOUTUBE_PERMANENT_DOWNLOAD_STATUSES.has("DOWNLOAD_FAILED")).toBe(false);
  });

  /**
   * A timeout is the scene budget standing a fetch aside — 75 of render 576's 79 refusals came at
   * literally 0s left, and a later scene with room may fetch the same video perfectly well.
   */
  it("a budget timeout is still not remembered", () => {
    reset();
    expect(
      noteYoutubeDownloadRefusal("vid", "DOWNLOAD_TIMEOUT", "scene_budget_too_short_to_start")
    ).toBe(false);
  });

  it("the three status-based refusals still work exactly as before", () => {
    for (const status of YOUTUBE_PERMANENT_DOWNLOAD_STATUSES) {
      reset();
      expect(noteYoutubeDownloadRefusal("vid", status, "whatever")).toBe(true);
    }
  });

  it("the reason parser reads the class off the end, whatever the code was", () => {
    expect(isDurableYoutubeServiceRefusal("http_502:bot_check")).toBe(true);
    expect(isDurableYoutubeServiceRefusal("http_403:bot_check")).toBe(true);
    expect(isDurableYoutubeServiceRefusal("bot_check")).toBe(true);
    expect(isDurableYoutubeServiceRefusal("http_502:rate_limited")).toBe(false);
    expect(isDurableYoutubeServiceRefusal(undefined)).toBe(false);
    expect(isDurableYoutubeServiceRefusal("")).toBe(false);
  });

  it("the classifier and the memo agree on the real 502 body", () => {
    const reason = youtubeServiceRefusalReason(
      502,
      '{"detail":"ERROR: [youtube] ynJoy1OCeVQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser"}'
    );
    expect(reason).toContain("bot_check");
    expect(isDurableYoutubeServiceRefusal(reason)).toBe(true);
  });
});

describe("C. the cloud branch is what tells the memo, because nothing else can", () => {
  const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  /**
   * The memo is written at the end of the fetch from the OVERALL status, and
   * `summariseYoutubeDownloadAttempts` ranks the fallback's DOWNLOAD_TIMEOUT above this branch's
   * DOWNLOAD_FAILED. The verdict would be outranked before it ever arrived.
   */
  it("the 502 handler notes the refusal itself", () => {
    const at = SRC.indexOf("const cloudReason = youtubeServiceRefusalReason(dlResp.status, errText)");
    expect(at).toBeGreaterThan(0);
    const block = SRC.slice(at, at + 2200);
    expect(block).toContain("noteYoutubeDownloadRefusal(videoId, \"DOWNLOAD_FAILED\", cloudReason)");
    expect(block).toContain("written off for this render");
  });

  /** One named writer decides; the call site does not get its own opinion about durability. */
  it("the call site does not reimplement the rule", () => {
    const at = SRC.indexOf("const cloudReason = youtubeServiceRefusalReason(dlResp.status, errText)");
    const block = SRC.slice(at, at + 2200);
    expect(block).not.toContain("notePermanentDownloadRefusal(");
    expect(block).not.toContain("YOUTUBE_DURABLE_SERVICE_REFUSALS");
  });

  /** The report ranking is untouched — this round changed what is remembered, not what is said. */
  it("summariseYoutubeDownloadAttempts still ranks by its own priority", () => {
    const at = SRC.indexOf("export function summariseYoutubeDownloadAttempts(");
    const body = SRC.slice(at, SRC.indexOf("\n}", at));
    expect(body).toContain("YOUTUBE_DOWNLOAD_STATUS_PRIORITY");
    expect(body).toContain('attempts.some((a) => a.status === "DOWNLOAD_SUCCESS")');
  });
});
