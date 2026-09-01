/**
 * FINAL VALIDATION §4 — five different problems stop printing the same word.
 *
 * ── What the previous round left ────────────────────────────────────────────────────────────
 *
 * The MASTER YOUTUBE BUILD round gave `downloadYouTubeCCClip` one exit line that separated
 * DOWNLOAD_UNAVAILABLE (no route configured) from DOWNLOAD_FAILED (a route was there and did not
 * deliver). That was the distinction the first production log needed, and it is not enough to act
 * on: a service that 502s, a service that answers 200 with a stub, a transfer the scene budget
 * killed, a video no route offers an mp4 for, and a file that arrives and will not trim are five
 * problems with five different fixes — and all five printed DOWNLOAD_FAILED.
 *
 * Two paths were worse than that: the scene-budget guard and the cloud route's own size floor both
 * returned `false` with NO line at all.
 *
 * ── What is tested here, and what is not ────────────────────────────────────────────────────
 *
 * The classification and the line are pure functions, so they are driven directly — no network, no
 * mocked fetch, no fake provider response. Whether each branch of the downloader records the RIGHT
 * status is a claim about that function's source, and is asserted as such at the bottom: every
 * `return false` and every early exit must be preceded by a recorded attempt or a reported line.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { PIPELINE_ERROR, pipelineError } from "@shared/appErrors";
import {
  classifyYoutubeDownloadError,
  formatYoutubeDownloadLine,
  summariseYoutubeDownloadAttempts,
  type YoutubeDownloadAttempt,
  type YoutubeDownloadStatus,
} from "./videoPipeline";

const attempt = (
  route: YoutubeDownloadAttempt["route"],
  status: YoutubeDownloadStatus,
  detail = "d"
): YoutubeDownloadAttempt => ({ route, status, detail });

/* ═══════════════════════ classification ═══════════════════════ */

describe("§4 — a thrown failure is classified, not lumped in", () => {
  /**
   * A timeout and a broken service send an operator to completely different places: one to the
   * budget, one to the service. Reporting both as DOWNLOAD_FAILED sends everyone to the service.
   */
  it("a pipeline timeout is a timeout", () => {
    expect(classifyYoutubeDownloadError(pipelineError(PIPELINE_ERROR.TIMEOUT, "Timeout: x exceeded 5s")))
      .toBe("DOWNLOAD_TIMEOUT");
  });

  it("an aborted transfer is a timeout", () => {
    expect(classifyYoutubeDownloadError(new Error("The operation was aborted"))).toBe("DOWNLOAD_TIMEOUT");
  });

  /**
   * The scene budget standing a download aside is the most misread event in the whole log: it
   * looks exactly like a broken service. `isScopeAbortError` marks these with a private flag, and
   * the message alone ("Pool download s1b2 … exceeded 22s") would classify correctly anyway — so
   * this asserts the flag route specifically, with a message that would otherwise read as FAILED.
   */
  it("a scene-scope abort is a timeout even when its message says nothing about time", () => {
    const err = Object.assign(new Error("cancelled by the enclosing scene budget"), {
      __fastvidScopeAbort: true,
    });
    expect(classifyYoutubeDownloadError(err)).toBe("DOWNLOAD_TIMEOUT");
    /** Without the flag, that same message is not a timeout claim and must not become one. */
    expect(classifyYoutubeDownloadError(new Error("cancelled by the enclosing scene budget")))
      .toBe("DOWNLOAD_FAILED");
  });

  it("anything else stays FAILED rather than being guessed at", () => {
    expect(classifyYoutubeDownloadError(new Error("ECONNRESET"))).toBe("DOWNLOAD_FAILED");
    expect(classifyYoutubeDownloadError(undefined)).toBe("DOWNLOAD_FAILED");
  });
});

/* ═══════════════════════ the headline across several routes ═══════════════════════ */

describe("§4 — the headline names the most informative outcome", () => {
  it("success wins over anything that failed before it", () => {
    expect(summariseYoutubeDownloadAttempts(
      [attempt("cloud", "DOWNLOAD_EMPTY"), attempt("rapidapi", "DOWNLOAD_SUCCESS")], true
    )).toBe("DOWNLOAD_SUCCESS");
  });

  /**
   * Bytes that would not trim say more about the video than a route that refused to answer, so
   * INVALID_CONTENT outranks FAILED. Every attempt is still listed in the line — this only picks
   * the word to grep for.
   */
  it("bytes that would not trim outrank a route that never answered", () => {
    expect(summariseYoutubeDownloadAttempts(
      [attempt("cloud", "DOWNLOAD_FAILED"), attempt("rapidapi", "DOWNLOAD_INVALID_CONTENT")], true
    )).toBe("DOWNLOAD_INVALID_CONTENT");
  });

  it("a video no route can serve reads as UNSUPPORTED, not as a failure", () => {
    expect(summariseYoutubeDownloadAttempts(
      [attempt("rapidapi", "DOWNLOAD_UNSUPPORTED"), attempt("cloud", "DOWNLOAD_EMPTY")], true
    )).toBe("DOWNLOAD_UNSUPPORTED");
  });

  /** No route configured is a configuration gap, never a fault to chase. */
  it("no attempts and no routes is UNAVAILABLE", () => {
    expect(summariseYoutubeDownloadAttempts([], false)).toBe("DOWNLOAD_UNAVAILABLE");
  });

  /**
   * And the inverse must never happen: a configured route that produced no attempt record is still
   * a failure. Reporting UNAVAILABLE there would tell an operator to set a variable they have set.
   */
  it("a configured route that recorded nothing is still a failure", () => {
    expect(summariseYoutubeDownloadAttempts([], true)).toBe("DOWNLOAD_FAILED");
  });
});

/* ═══════════════════════ the line ═══════════════════════ */

describe("§4 — the line carries the whole trail", () => {
  const line = formatYoutubeDownloadLine({
    videoId: "dQw4w9WgXcQ",
    sceneIndex: 3,
    status: "DOWNLOAD_INVALID_CONTENT",
    attempts: [attempt("cloud", "DOWNLOAD_EMPTY"), attempt("rapidapi", "DOWNLOAD_INVALID_CONTENT")],
    hasCloudRoute: true,
    hasRapidRoute: true,
    reason: "trim_produced_no_clip",
  });

  it("names the video, the scene, the status and the reason", () => {
    expect(line).toContain("video=dQw4w9WgXcQ");
    expect(line).toContain("scene=3");
    expect(line).toContain("status=DOWNLOAD_INVALID_CONTENT");
    expect(line).toContain("reason=trim_produced_no_clip");
  });

  /** Both routes' outcomes survive, so "the cloud service is empty" is visible even when RapidAPI answered. */
  it("lists every route that was tried", () => {
    expect(line).toContain("attempts=cloud:DOWNLOAD_EMPTY,rapidapi:DOWNLOAD_INVALID_CONTENT");
  });

  it("reports configuration as presence only", () => {
    expect(line).toContain("cloudService=SET");
    expect(formatYoutubeDownloadLine({
      videoId: "x", sceneIndex: 0, status: "DOWNLOAD_UNAVAILABLE", attempts: [],
      hasCloudRoute: false, hasRapidRoute: false, reason: "no_download_route_configured",
    })).toContain("cloudService=MISSING rapidApi=MISSING");
  });

  it("says attempts=none rather than leaving the field empty", () => {
    expect(formatYoutubeDownloadLine({
      videoId: "x", sceneIndex: 0, status: "DOWNLOAD_UNAVAILABLE", attempts: [],
      hasCloudRoute: false, hasRapidRoute: false, reason: "r",
    })).toContain("attempts=none");
  });
});

/* ═══════════════════════ every exit reports ═══════════════════════ */

describe("§4 — the downloader has no silent exit left", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const BODY = (() => {
    const start = SRC.indexOf("export async function downloadYouTubeCCClip(");
    const end = SRC.indexOf("export async function probeYouTubeCcPipeline(", start);
    return SRC.slice(start, end);
  })();

  /**
   * The defect this section exists for. Two paths returned a bare `false`: the scene-budget guard
   * and the cloud size floor. Every `return` in this function must now be preceded by a
   * `reportDownload(...)`, which is the only thing that prints the line.
   */
  it("every return is preceded by a reported line", () => {
    const returns = [...BODY.matchAll(/\n\s*return (true|false);/g)];
    expect(returns.length, "the downloader stopped returning").toBeGreaterThanOrEqual(3);
    for (const r of returns) {
      const before = BODY.slice(Math.max(0, r.index! - 900), r.index!);
      expect(before, `a return with no reported status:\n…${before.slice(-160)}`)
        .toMatch(/reportDownload\(/);
    }
  });

  /** Both success paths report too — a success nobody can grep for is the same blindness. */
  it("both success routes report DOWNLOAD_SUCCESS", () => {
    expect([...BODY.matchAll(/reportDownload\("DOWNLOAD_SUCCESS"/g)]).toHaveLength(2);
  });

  /** And every status in the vocabulary is actually reachable from a real branch. */
  it.each([
    "DOWNLOAD_EMPTY",
    "DOWNLOAD_TIMEOUT",
    "DOWNLOAD_UNSUPPORTED",
    "DOWNLOAD_INVALID_CONTENT",
    "DOWNLOAD_FAILED",
  ] as const)("%s is recorded by at least one branch", (status) => {
    expect(BODY, `${status} is in the vocabulary but no branch produces it`).toContain(`"${status}"`);
  });
});
