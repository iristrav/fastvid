/**
 * A HELD SOURCE IS NOT DELETED BEFORE IT IS USED — RONDE 637.
 *
 * ── Render 602's YouTube funnel, measured ───────────────────────────────────────────────────
 *
 *     [SearchGate] provider=youtube_cc built=36 validated=34 sent=34 blocked=2
 *     …
 *     [YouTubeDownload] video=C6T9Mvn3TY0 status=DOWNLOAD_SUCCESS … reason=rapidapi    ×4
 *     [YouTubeDownload] video=fof6zEzfSlQ status=DOWNLOAD_SUCCESS … reason=rapidapi    ×3
 *     [YouTubeDownload] video=aZbpVsQzBeU status=DOWNLOAD_TIMEOUT
 *         attempts=cloud:DOWNLOAD_FAILED(cloud_egress_blocked:cloud_egress_other),
 *                  rapidapi:DOWNLOAD_TIMEOUT(scene_budget_0s_left)
 *         reason=scene_budget_too_short_to_start                                       ×20
 *
 * Two videos fetched seven times between them, always `reason=rapidapi` and NEVER `source_reuse`,
 * while twenty other candidates died holding `scene_budget_0s_left`. The transfers RONDE 261's
 * memo exists to prevent were spending the budget the rest of the beat needed.
 *
 * ── Why the memo never fired ────────────────────────────────────────────────────────────────
 *
 *     noteYoutubeSourceFile(videoId, tmpPath, rapidFileSize);   // "the file is here"
 *     …
 *     } finally {
 *       if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);     // and it is not
 *     }
 *
 * The `finally` ran on every path, success included. So `youtubeSourceFile` found its entry,
 * `fs.existsSync(heldSource.path)` said no, and the reuse fell through to a full re-download.
 *
 * One side recorded the answer; the other deleted the thing the answer pointed at; nothing
 * connected them. That is this codebase's signature defect, and RONDE 261 wrote the memo without
 * ever being able to observe that its own counter stayed at zero.
 *
 * ── What is NOT changed ─────────────────────────────────────────────────────────────────────
 *
 * The cut. `downloadYouTubeCCClip` takes its own `clipStart` and `duration`, and the reuse path
 * re-derives the trim against the same file — handing a beat another beat's clip would be the
 * silent substitution this codebase forbids, and it still cannot happen. Only the transfer is
 * skipped.
 *
 * ── And the new cost is bounded ─────────────────────────────────────────────────────────────
 *
 * Keeping sources turns a memo into disk. The per-file ceiling is 80 MB and a five-minute
 * documentary can ask for dozens of videos, so the memo stops accepting past a byte ceiling and
 * every caller then behaves exactly as it did before: the file is deleted and a later beat
 * re-fetches it. Degrading to the old behaviour is the only safe direction for a cache — and on
 * this runner a full disk fails writes while deletes still succeed, which is a far worse render
 * than a repeated download.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  noteYoutubeSourceFile,
  youtubeSourceFile,
  youtubeSourceHeldBytes,
  youtubeSourceHoldCeilingBytes,
  resetYoutubeSourceFiles,
} from "./providerFailureClass";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const CLASS = readFileSync(join(__dirname, "providerFailureClass.ts"), "utf8");

beforeEach(() => resetYoutubeSourceFiles());
afterEach(() => {
  delete process.env.YOUTUBE_SOURCE_HOLD_MB;
  resetYoutubeSourceFiles();
});

/* ═══════════ §1 — the memo says whether it stored ═══════════ */

describe("§1 — the caller is told which of the two cases it is in", () => {
  it("A FIRST SOURCE IS STORED, AND SAYS SO", () => {
    expect(noteYoutubeSourceFile("C6T9Mvn3TY0", "/w/a_rapid_tmp.mp4", 3_166_751)).toBe(true);
    expect(youtubeSourceFile("C6T9Mvn3TY0")?.path).toBe("/w/a_rapid_tmp.mp4");
  });

  it("A SECOND PATH FOR THE SAME VIDEO IS NOT STORED, AND SAYS SO", () => {
    /* First-writer-wins, so the second caller's file is its own to delete. */
    expect(noteYoutubeSourceFile("C6T9Mvn3TY0", "/w/a_rapid_tmp.mp4", 3_166_751)).toBe(true);
    expect(noteYoutubeSourceFile("C6T9Mvn3TY0", "/w/b_rapid_tmp.mp4", 3_166_751)).toBe(false);
    expect(youtubeSourceFile("C6T9Mvn3TY0")?.path).toBe("/w/a_rapid_tmp.mp4");
  });

  it("and rubbish is refused without storing anything", () => {
    expect(noteYoutubeSourceFile("", "/w/a.mp4", 10)).toBe(false);
    expect(noteYoutubeSourceFile("v", "", 10)).toBe(false);
    expect(noteYoutubeSourceFile("v", "/w/a.mp4", 0)).toBe(false);
    expect(youtubeSourceHeldBytes()).toBe(0);
  });

  it("different videos are held side by side", () => {
    expect(noteYoutubeSourceFile("C6T9Mvn3TY0", "/w/a.mp4", 3_166_751)).toBe(true);
    expect(noteYoutubeSourceFile("fof6zEzfSlQ", "/w/b.mp4", 2_137_883)).toBe(true);
    expect(youtubeSourceHeldBytes()).toBe(3_166_751 + 2_137_883);
  });
});

/* ═══════════ §2 — the disk cost is bounded ═══════════ */

describe("§2 — a memo that became disk has a ceiling", () => {
  it("PAST THE CEILING NOTHING NEW IS HELD, AND THE CALLER DELETES AS BEFORE", () => {
    process.env.YOUTUBE_SOURCE_HOLD_MB = "10";
    expect(youtubeSourceHoldCeilingBytes()).toBe(10 * 1024 * 1024);
    expect(noteYoutubeSourceFile("a", "/w/a.mp4", 9 * 1024 * 1024)).toBe(true);
    /* 9 MB held, a 2 MB source would exceed 10 MB — refused, so its file is deleted. */
    expect(noteYoutubeSourceFile("b", "/w/b.mp4", 2 * 1024 * 1024)).toBe(false);
    expect(youtubeSourceFile("b")).toBeNull();
    /* And a source that still fits is still taken. */
    expect(noteYoutubeSourceFile("c", "/w/c.mp4", 512 * 1024)).toBe(true);
  });

  it("a ceiling of zero turns the hold off entirely, back to the old behaviour", () => {
    process.env.YOUTUBE_SOURCE_HOLD_MB = "0";
    expect(noteYoutubeSourceFile("a", "/w/a.mp4", 1)).toBe(false);
  });

  it("and the default is stated rather than unbounded", () => {
    expect(youtubeSourceHoldCeilingBytes()).toBe(512 * 1024 * 1024);
  });

  it("an unusable env value falls back to the default instead of disabling the bound", () => {
    process.env.YOUTUBE_SOURCE_HOLD_MB = "not-a-number";
    expect(youtubeSourceHoldCeilingBytes()).toBe(512 * 1024 * 1024);
  });
});

/* ═══════════ §3 — the wiring: the delete no longer undoes the memo ═══════════ */

describe("§3 — the file the render is holding is not deleted", () => {
  it("THE UNCONDITIONAL UNLINK IS GONE", () => {
    expect(PIPE).not.toContain(
      "    } finally {\n      try {\n        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);"
    );
  });

  it("and the delete is guarded by what the memo answered", () => {
    expect(PIPE).toContain("tmpPathIsRenderSource = noteYoutubeSourceFile(videoId, tmpPath, rapidFileSize);");
    expect(PIPE).toContain("if (!tmpPathIsRenderSource) {");
    const at = PIPE.indexOf("if (!tmpPathIsRenderSource) {");
    expect(PIPE.slice(at, at + 200)).toContain("fs.unlinkSync(tmpPath)");
  });

  it("the flag starts false, so nothing is kept by accident", () => {
    expect(PIPE).toContain("let tmpPathIsRenderSource = false;");
    const declared = PIPE.indexOf("let tmpPathIsRenderSource = false;");
    const assigned = PIPE.indexOf("tmpPathIsRenderSource = noteYoutubeSourceFile(");
    const read = PIPE.indexOf("if (!tmpPathIsRenderSource) {");
    expect(declared).toBeLessThan(assigned);
    expect(assigned).toBeLessThan(read);
  });

  it("A HELD SOURCE IS ANNOUNCED, SO A RENDER CAN SHOW THE MEMO WORKING", () => {
    expect(PIPE).toContain("holding ${videoId}'s source for this render");
  });

  it("and the reuse path that was never reached is still there, unchanged", () => {
    expect(PIPE).toContain("const heldSource = youtubeSourceFile(videoId);");
    expect(PIPE).toContain("if (heldSource && fs.existsSync(heldSource.path)) {");
    expect(PIPE).toContain('reportDownload("DOWNLOAD_SUCCESS", "source_reuse");');
  });
});

/* ═══════════ §4 — nothing about the CUT changed ═══════════ */

describe("§4 — only the transfer is skipped, never the cut", () => {
  it("THE REUSE PATH STILL DERIVES ITS OWN TRIM", () => {
    const at = PIPE.indexOf("const heldSource = youtubeSourceFile(videoId);");
    const block = PIPE.slice(at, PIPE.indexOf("const egressBlocked", at));
    /* Its own start, from the same file — not the previous beat's clip. */
    expect(block).toContain("await resolveTrimStartSec(");
    expect(block).toContain("clipStart, duration, videoId, startIsExact");
    expect(block).toContain("trimRemoteVideoToClip(");
  });

  it("and the memo still remembers the SOURCE rather than a clip", () => {
    expect(CLASS).toContain("videoId → the untrimmed source this render already fetched");
    expect(CLASS).toContain("The UNTRIMMED SOURCE, not the clip.");
  });
});
