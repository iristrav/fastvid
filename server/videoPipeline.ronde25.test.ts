import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  
  overlayChecksSpent,
  resetOverlayBudget,
} from "./archiveClipFilter";
import { beatClipTextFilterMaxChecks } from "./sourcingPolicy";

// RONDE 25 — repairs two risks introduced by RONDE 23/24 themselves.
//
// A) RONDE 23 put a vision-based text check in front of every externally sourced beat clip, with
//    no ceiling. Render 527 pushed 64 unique clips through that gate; the pre-existing valve for
//    exactly this (ARCHIVE_OVERLAY_MAX_CLIPS via shouldRunArchiveOverlayFilter) is unreachable
//    from this path because opts.clipCount is never passed. Without a cap, a render that has to
//    dig deep pays an unbounded number of ffprobe + 2×ffmpeg + vision round trips.
//
// B) RONDE 20 gave the watchdog's kill real teeth (cancel + mark failed). Its idle detector's
//    only activity signal is trackChild — verified repo-wide: sceneRetrieveStart/End,
//    sceneComposeStart/End and concatStart/End are called from nowhere. The idle limit equals the
//    whole render budget, so only a very long child-free phase is at risk; the final upload is
//    exactly that (no child process, hundreds of MB), which is why it gets the ping.
//
// The cap is deliberately fail-OPEN: past the ceiling a clip is allowed through unchecked. An
// exhausted budget turning into "reject everything" would starve the cascade far worse than the
// baked-in text it guards against.

const OVERLAY_OFF = "ENABLE_ARCHIVE_OVERLAY_FILTER";
const MAX_CHECKS = "BEAT_CLIP_TEXT_FILTER_MAX_CHECKS";

describe("RONDE 25 — beatClipTextFilterMaxChecks", () => {
  afterEach(() => {
    delete process.env[MAX_CHECKS];
  });

  it("defaults to 40 checks per render", () => {
    expect(beatClipTextFilterMaxChecks()).toBe(40);
  });

  it("honours an explicit budget", () => {
    process.env[MAX_CHECKS] = "12";
    expect(beatClipTextFilterMaxChecks()).toBe(12);
  });

  it("accepts 0 (turn the checks off without touching the feature flag)", () => {
    process.env[MAX_CHECKS] = "0";
    expect(beatClipTextFilterMaxChecks()).toBe(0);
  });

  it.each(["", "  ", "abc", "-1", "501", "40.5.1"])(
    "falls back to the default on junk value %j",
    (v) => {
      process.env[MAX_CHECKS] = v;
      expect(beatClipTextFilterMaxChecks()).toBe(40);
    },
  );
});

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const watchdogSrc = readFileSync(path.join(__dirname, "renderWatchdog.ts"), "utf8");
const ingestionSrc = readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");

describe("RONDE 25 — the cap is wired into both text-check callers", () => {

  /**
   * VIDEO 621 — no longer: the archive's own check runs outside the render's budget and is never
   * skipped for it (render 621 spent 185 checks, mostly the archive's, and then let clips through
   * unchecked). See `archiveClipTextVerdict`.
   */
  it("archive ingestion always checks, outside the render's budget", () => {
    expect(ingestionSrc).toContain("await judgeOnScreenText({ path: localPath, mimeType: metadata.mimeType, memoKey: overlayKey })");
    expect(ingestionSrc).not.toContain("beatClipTextFilterMaxChecks()");
  });

  it("the budget is reset once per render, right where the watchdog is created", () => {
    const at = pipelineSrc.indexOf("const watchdog = createRenderWatchdog(");
    expect(at).toBeGreaterThan(-1);
    expect(pipelineSrc.slice(at, at + 600)).toContain("resetOverlayBudget();");
  });
});

describe("RONDE 25 — the watchdog can be told the render is still alive", () => {
  it("exposes ping on the interface and implements it", () => {
    expect(watchdogSrc).toContain("ping(reason?: string): void;");
    expect(watchdogSrc).toContain("ping(reason?: string) {");
  });

  it("ping refreshes the idle clock", () => {
    const impl = watchdogSrc.slice(
      watchdogSrc.indexOf("ping(reason?: string) {"),
      watchdogSrc.indexOf("updateBudget(newBudgetMs: number) {"),
    );
    expect(impl).toContain("markActivity();");
  });

  it("ping is inert after stop(), like the other watchdog methods", () => {
    const impl = watchdogSrc.slice(
      watchdogSrc.indexOf("ping(reason?: string) {"),
      watchdogSrc.indexOf("updateBudget(newBudgetMs: number) {"),
    );
    expect(impl).toContain("if (stopped) return;");
  });
});
