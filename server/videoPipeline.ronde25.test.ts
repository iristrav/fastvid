import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cachedClipHasBakedEditText,
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

describe("RONDE 25 — the overlay budget is spent on misses only", () => {
  // With the overlay filter switched off the detector short-circuits before any ffprobe/ffmpeg or
  // vision call, so these exercise the real caching/accounting code without needing a media file.
  let prevOverlay: string | undefined;

  beforeEach(() => {
    prevOverlay = process.env[OVERLAY_OFF];
    process.env[OVERLAY_OFF] = "false";
    resetOverlayBudget();
  });

  afterEach(() => {
    if (prevOverlay === undefined) delete process.env[OVERLAY_OFF];
    else process.env[OVERLAY_OFF] = prevOverlay;
    resetOverlayBudget();
  });

  it("charges one check per distinct clip", async () => {
    for (const key of ["a", "b", "c"]) {
      await cachedClipHasBakedEditText("/tmp/x.mp4", "video/mp4", key, 10);
    }
    expect(overlayChecksSpent()).toBe(3);
  });

  it("charges nothing for a clip already judged — re-offering an asset is free", async () => {
    for (let i = 0; i < 5; i++) {
      await cachedClipHasBakedEditText("/tmp/x.mp4", "video/mp4", "same-clip", 10);
    }
    expect(overlayChecksSpent()).toBe(1);
  });

  it("stops spending once the ceiling is reached", async () => {
    for (const key of ["a", "b", "c", "d", "e"]) {
      await cachedClipHasBakedEditText("/tmp/x.mp4", "video/mp4", key, 2);
    }
    expect(overlayChecksSpent()).toBe(2);
  });

  it("lets clips past the ceiling through rather than rejecting them", async () => {
    await cachedClipHasBakedEditText("/tmp/x.mp4", "video/mp4", "a", 1);
    const overBudget = await cachedClipHasBakedEditText("/tmp/x.mp4", "video/mp4", "b", 1);
    expect(overBudget).toBe(false);
  });

  it("does not memoise a skipped check, so a later render still judges the clip", async () => {
    await cachedClipHasBakedEditText("/tmp/x.mp4", "video/mp4", "a", 1);
    await cachedClipHasBakedEditText("/tmp/x.mp4", "video/mp4", "skipped", 1);
    expect(overlayChecksSpent()).toBe(1);

    // Same key, room in the budget: if the skip had been cached as "clean" this would be a hit
    // and cost nothing. It costs a check, which proves the skip left no verdict behind.
    await cachedClipHasBakedEditText("/tmp/x.mp4", "video/mp4", "skipped", 10);
    expect(overlayChecksSpent()).toBe(2);
  });

  it("treats an omitted ceiling as unlimited (ingestion-style callers keep working)", async () => {
    for (const key of ["a", "b", "c", "d"]) {
      await cachedClipHasBakedEditText("/tmp/x.mp4", "video/mp4", key);
    }
    expect(overlayChecksSpent()).toBe(4);
  });

  it("spends nothing at all when the ceiling is 0", async () => {
    const verdict = await cachedClipHasBakedEditText("/tmp/x.mp4", "video/mp4", "a", 0);
    expect(verdict).toBe(false);
    expect(overlayChecksSpent()).toBe(0);
  });

  it("resetOverlayBudget clears both the counter and the memo", async () => {
    await cachedClipHasBakedEditText("/tmp/x.mp4", "video/mp4", "a", 10);
    expect(overlayChecksSpent()).toBe(1);

    resetOverlayBudget();
    expect(overlayChecksSpent()).toBe(0);

    // A cleared memo means the same clip is judged again instead of inheriting last render's
    // verdict — which is what keeps the map from growing without bound in a long-lived worker.
    await cachedClipHasBakedEditText("/tmp/x.mp4", "video/mp4", "a", 10);
    expect(overlayChecksSpent()).toBe(1);
  });
});

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const watchdogSrc = readFileSync(path.join(__dirname, "renderWatchdog.ts"), "utf8");
const ingestionSrc = readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");

describe("RONDE 25 — the cap is wired into both text-check callers", () => {
  it("the beat gate passes the per-render ceiling", () => {
    const helper = pipelineSrc.slice(
      pipelineSrc.indexOf("async function beatClipHasBakedText("),
      pipelineSrc.indexOf("async function beatClipHasBakedText(") + 600,
    );
    expect(helper).toContain("beatClipTextFilterMaxChecks()");
  });

  it("archive ingestion passes it too", () => {
    expect(ingestionSrc).toContain("beatClipTextFilterMaxChecks()");
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

  it("brackets EVERY final-upload branch, not just one", () => {
    // There are two: the async-QA branch (upload racing the spot check) and the sequential one.
    // Missing either leaves a multi-GB, child-free upload looking idle to a watchdog that now
    // kills for real.
    const needle = "storagePutFromFile(`videos/${videoId}/final.mp4`";
    const sites: number[] = [];
    for (let at = pipelineSrc.indexOf(needle); at !== -1; at = pipelineSrc.indexOf(needle, at + 1)) {
      sites.push(at);
    }
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const at of sites) {
      const around = pipelineSrc.slice(at - 900, at + 900);
      expect(around).toContain("watchdog.ping(");
      expect(around).toContain('watchdog.ping("final video uploaded")');
    }
  });
});
