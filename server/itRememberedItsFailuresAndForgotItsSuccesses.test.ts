/**
 * RONDE 261 — IT REMEMBERED ITS FAILURES AND FORGOT ITS SUCCESSES.
 *
 * ── What the render after RONDE 260 measured ────────────────────────────────────────────────
 *
 *     ODx7fCL6BHw   3 405 471 bytes   downloaded SIX times, scene 2
 *     each preceded by:  "Cloud DL failed … exceeded 21s — falling back to RapidAPI"
 *
 * Six identical transfers of one file, each paying the cloud route its full twenty-second share
 * first. Two minutes and seventeen megabytes for a file that was on disk after the first one.
 *
 * ── Why it appeared only now ────────────────────────────────────────────────────────────────
 *
 * `noteYoutubeDownloadRefusal` remembers what FAILED. Nothing remembered what worked. While the
 * downloads were failing that asymmetry was invisible — the refusal memo skipped the repeats and
 * did a dedup's job by accident. RONDE 260 made the transfers succeed, the refusal memo stopped
 * firing, and there was nothing underneath it.
 *
 * It also explains render 586's strangest line: a video downloaded successfully at 16:47:53 and
 * then skipped three times as "already refused this render". The only memory of that video was of
 * its failed cloud leg.
 *
 * ── The one thing this must not do ──────────────────────────────────────────────────────────
 *
 * Reuse the CLIP. Two beats asking for the same video ask for different seconds of it, so handing
 * the second beat the first beat's cut would be a silent substitution — §2 is the whole reason
 * this remembers the untrimmed SOURCE and re-cuts per request. The render's content does not
 * change by a frame; only the transfer is skipped.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  formatYoutubeSourceReuse,
  resetPermanentDownloadRefusals,
  noteYoutubeDownloadRefusal,
  noteYoutubeSourceFile,
  resetYoutubeSourceFiles,
  youtubeDownloadRefusal,
  youtubeSourceFile,
  youtubeSourceReuseStats,
} from "./providerFailureClass";
import { stripComments } from "./sourceScan.test.support";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const CODE = stripComments(PIPE);

beforeEach(() => {
  resetYoutubeSourceFiles();
  resetPermanentDownloadRefusals();
});
afterEach(() => {
  resetYoutubeSourceFiles();
  resetPermanentDownloadRefusals();
});

/* ═══════════ 1. the asymmetry itself ═══════════ */

describe("R261 §1 — a success is now remembered the way a failure always was", () => {
  it("THE ASYMMETRY: a refusal was remembered and a delivery was not", () => {
    /**
     * Stated as the pair, because the pair is the finding. Both halves exist now and sit in the
     * same module, so a later round cannot add a third memory somewhere else.
     */
    noteYoutubeDownloadRefusal("dead", "DOWNLOAD_UNSUPPORTED");
    expect(youtubeDownloadRefusal("dead")).toContain("DOWNLOAD_UNSUPPORTED");
    noteYoutubeSourceFile("alive", "/tmp/alive.mp4", 3_405_471);
    expect(youtubeSourceFile("alive")).toEqual({ path: "/tmp/alive.mp4", bytes: 3_405_471 });
  });

  it("a video nobody fetched is not remembered as fetched", () => {
    expect(youtubeSourceFile("ODx7fCL6BHw")).toBeNull();
    expect(youtubeSourceFile("")).toBeNull();
  });

  it("nothing useful is remembered from nothing", () => {
    noteYoutubeSourceFile("", "/tmp/x.mp4", 10);
    noteYoutubeSourceFile("v", "", 10);
    noteYoutubeSourceFile("v", "/tmp/x.mp4", 0);
    expect(youtubeSourceReuseStats().held).toBe(0);
  });

  it("the first path wins, because a second download is the thing this prevents", () => {
    noteYoutubeSourceFile("v", "/tmp/first.mp4", 100);
    noteYoutubeSourceFile("v", "/tmp/second.mp4", 200);
    expect(youtubeSourceFile("v")?.path).toBe("/tmp/first.mp4");
  });

  it("and it is render-scoped, like the refusal memo beside it", () => {
    noteYoutubeSourceFile("v", "/tmp/a.mp4", 100);
    resetYoutubeSourceFiles();
    expect(youtubeSourceFile("v")).toBeNull();
    expect(CODE, "the reset is not wired into the render").toContain("resetYoutubeSourceFiles();");
  });
});

/* ═══════════ 2. the source, never the cut ═══════════ */

describe("R261 §2 — the transfer is reused, the clip is not", () => {
  it("THE REUSE PATH RE-CUTS AT THIS REQUEST'S OWN START AND DURATION", () => {
    const at = CODE.indexOf("const heldSource = youtubeSourceFile(videoId);");
    expect(at, "no reuse path").toBeGreaterThan(-1);
    const block = CODE.slice(at, at + 1200);
    expect(block, "it hands back a clip cut for another beat").toContain(
      "resolveTrimStartSec(\n      heldSource.path, clipStart, duration, videoId, startIsExact\n    )"
    );
    expect(block).toContain("trimRemoteVideoToClip(\n        heldSource.path, outPath, duration, reuseStart,");
  });

  it("and what is remembered is the UNTRIMMED source, written before the trim", () => {
    const write = CODE.indexOf("noteYoutubeSourceFile(videoId, tmpPath, rapidFileSize);");
    const trim = CODE.indexOf("trimRemoteVideoToClip(\n                  tmpPath,");
    expect(write).toBeGreaterThan(-1);
    expect(trim).toBeGreaterThan(-1);
    expect(write, "the memo points at a clip, not at a source").toBeLessThan(trim);
  });

  it("a remembered file that is gone falls through to the routes, it does not fail", () => {
    const at = CODE.indexOf("const heldSource = youtubeSourceFile(videoId);");
    const block = CODE.slice(at, at + 1200);
    expect(block).toContain("fs.existsSync(heldSource.path)");
    expect(
      block,
      "a missing file would have to become a refusal rather than a miss"
    ).not.toContain("return false;");
  });

  it("A TRIM THAT WILL NOT CUT IS ALSO A MISS — the routes below still run", () => {
    /**
     * The reuse returns true only inside the successful-trim branch. Anything else leaves the
     * function to continue into the cloud and RapidAPI routes exactly as before, so this round can
     * save a download and can never be the reason one does not happen.
     */
    const at = CODE.indexOf("const heldSource = youtubeSourceFile(videoId);");
    const block = CODE.slice(at, at + 1200);
    const ret = block.indexOf("return true;");
    const close = block.indexOf("const egressBlocked = cloudEgressRefusal();");
    expect(ret).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(ret);
  });
});

/* ═══════════ 3. before every route, not after the expensive one ═══════════ */

describe("R261 §3 — asked before the cloud route spends its share", () => {
  it("THE READ STANDS IN FRONT OF THE EGRESS LATCH AND BOTH ROUTES", () => {
    const fn = CODE.slice(
      CODE.indexOf("export async function downloadYouTubeCCClip("),
      CODE.indexOf("export async function fetchYouTubeCCClips(")
    );
    const reuse = fn.indexOf("const heldSource = youtubeSourceFile(videoId);");
    const latch = fn.indexOf("const egressBlocked = cloudEgressRefusal();");
    const cloud = fn.indexOf("if (cloudDlService && !egressBlocked) {");
    expect(reuse).toBeGreaterThan(-1);
    expect(reuse, "the six repeats each paid the cloud route first").toBeLessThan(latch);
    expect(reuse).toBeLessThan(cloud);
  });

  it("the reuse is reported as a success with a reason of its own", () => {
    expect(CODE).toContain('reportDownload("DOWNLOAD_SUCCESS", "source_reuse");');
    expect(CODE).toContain("_bytes_source_reused");
  });

  it("it is not silent — a saved transfer says so, per clip and in the summary", () => {
    expect(CODE).toContain("re-cut from the source this render ");
    expect(CODE).toContain("const reuseLine = formatYoutubeSourceReuse();");
  });
});

/* ═══════════ 4. the saving is measured, not believed ═══════════ */

describe("R261 §4 — how much work did this save", () => {
  it("every hit is counted, exactly as the refusal memo counts its own", () => {
    noteYoutubeSourceFile("ODx7fCL6BHw", "/tmp/o.mp4", 3_405_471);
    for (let i = 0; i < 5; i++) youtubeSourceFile("ODx7fCL6BHw");
    expect(youtubeSourceReuseStats()).toEqual({ held: 1, reused: 5 });
  });

  it("and render 587's own shape reads back out of it", () => {
    noteYoutubeSourceFile("ODx7fCL6BHw", "/tmp/o.mp4", 3_405_471);
    for (let i = 0; i < 5; i++) youtubeSourceFile("ODx7fCL6BHw");
    expect(formatYoutubeSourceReuse()).toBe(
      "[YouTubeSourceReuse] 1 source file(s) kept this render, 5 transfer(s) not repeated"
    );
  });

  it("a render that fetched nothing twice says nothing at all", () => {
    expect(formatYoutubeSourceReuse()).toBeNull();
  });
});

/* ═══════════ 5. nothing else moved ═══════════ */

describe("R261 §5 — the rest of the download path is untouched", () => {
  it("RONDE 260's share still caps the cloud route", () => {
    expect(CODE).toContain("Math.min(youtubeDownloadTimeoutMs(budgetMs), cloudWindowMs)");
  });

  it("RONDE 260's door check still stands in front of the search", () => {
    expect(CODE).toContain("if (!canAffordYoutubeTurn(YOUTUBE_MIN_TURN_MS)) {");
  });

  it("RONDE 68's two floors still stand", () => {
    expect(CODE).toContain("const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = 12_000;");
    expect(CODE).toContain("if (remainingForCloud < YOUTUBE_MIN_DOWNLOAD_WINDOW_MS) {");
    expect(CODE).toContain("if (remainingMs < YOUTUBE_MIN_DOWNLOAD_WINDOW_MS) {");
  });

  it("and RONDE 223's refusal memo is neither replaced nor bypassed", () => {
    expect(CODE).toContain("const alreadyRefused = youtubeDownloadRefusal(videoId);");
    expect(CODE).toContain("if (!ok && noteYoutubeDownloadRefusal(videoId, dl.status, dl.reason)) {");
  });
});
