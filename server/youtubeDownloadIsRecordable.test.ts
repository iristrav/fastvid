/**
 * THE OBSERVABILITY GATE — CAN THE NEXT RENDER ANSWER RENDER 571'S QUESTION?
 *
 * ── The question that could not be answered ─────────────────────────────────────────────────
 *
 *     YouTube results 55, download attempts 14, successful 0
 *
 * and nothing to say which of the seven download statuses those fourteen were. Render 571's logs
 * are gone, so the only useful move left is to guarantee the NEXT capture cannot end the same way.
 *
 * ── The distinction that actually matters ───────────────────────────────────────────────────
 *
 * Not the status. `claimDownloadSlot()` runs BEFORE the download, so an attempt is counted before
 * a single byte moves. "14 attempts, 0 successful" is equally consistent with:
 *
 *   · fourteen transfers that ran and failed          -> a downloader problem
 *   · fourteen refusals before any transfer began     -> a scene-budget problem
 *
 * Opposite causes, identical number. `transferStarted` is the field that separates them, and it
 * is what these tests exist to protect.
 *
 * ── What is NOT tested here ─────────────────────────────────────────────────────────────────
 *
 * Nothing about whether YouTube downloads succeed. This round changed no download behaviour: no
 * budget, no timeout, no route order, no ceiling. These tests only prove the render can SAY what
 * happened.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  beginReplayRecording,
  loadReplayBundle,
  recordReplayFact,
  resetReplayRecordingForTest,
  type ReplayDownloadFact,
} from "./renderReplay";
import { formatReplayReport, replayBundle } from "./renderReplayEngine";

/** The seven statuses the pipeline can end a YouTube download on. */
const STATUSES = [
  "DOWNLOAD_SUCCESS",
  "DOWNLOAD_UNAVAILABLE",
  "DOWNLOAD_TIMEOUT",
  "DOWNLOAD_EMPTY",
  "DOWNLOAD_INVALID_CONTENT",
  "DOWNLOAD_UNSUPPORTED",
  "DOWNLOAD_FAILED",
] as const;

const fact = (over: Partial<ReplayDownloadFact> = {}): ReplayDownloadFact => ({
  kind: "download",
  provider: "youtube_cc",
  videoId: "dQw4w9WgXcQ",
  scene: 1,
  route: "rapidapi",
  status: "DOWNLOAD_TIMEOUT",
  reason: "scene_budget_too_short_to_start",
  transferStarted: false,
  remainingMs: 4000,
  bytes: null,
  ...over,
});

const bundleWith = (downloads: ReplayDownloadFact[]) => ({
  meta: { kind: "meta" as const, formatVersion: 1 as const, videoId: 572, commit: "x", recordedAt: "t" },
  fetches: [],
  visions: [],
  adoptions: [],
  downloads,
});

/* ═════════ 1 — every status survives a real write-and-read cycle ═════════ */

describe("all seven download statuses are recordable", () => {
  const roundTrip = (downloads: ReplayDownloadFact[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytobs-"));
    const file = path.join(dir, "b.jsonl");
    try {
      beginReplayRecording(572, "x", { RENDER_REPLAY_RECORD: "true", RENDER_REPLAY_BUNDLE: file });
      for (const d of downloads) recordReplayFact(d);
      return loadReplayBundle(file).bundle;
    } finally {
      resetReplayRecordingForTest();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it.each(STATUSES)("%s survives the round trip", (status) => {
    const b = roundTrip([fact({ status })]);
    expect(b.downloads).toHaveLength(1);
    expect(b.downloads[0]!.status).toBe(status);
  });

  it("all seven together are distinguishable afterwards", () => {
    const b = roundTrip(STATUSES.map((status) => fact({ status })));
    expect(new Set(b.downloads.map((d) => d.status)).size).toBe(7);
  });
});

/* ═════════ 2 — the decisive field: did any bytes move? ═════════ */

describe("a refusal before transfer is distinguishable from a failed transfer", () => {
  /** Render 571's shape under the budget hypothesis. */
  const budgetRefusals = () =>
    Array.from({ length: 14 }, (_, i) =>
      fact({ scene: i % 3, status: "DOWNLOAD_TIMEOUT", transferStarted: false, remainingMs: 3000 + i * 100 })
    );

  /** The same fourteen attempts under the downloader hypothesis. */
  const failedTransfers = () =>
    Array.from({ length: 14 }, (_, i) =>
      fact({
        scene: i % 3,
        status: "DOWNLOAD_FAILED",
        reason: "rapidapi=http_403",
        transferStarted: true,
        remainingMs: 45_000,
        bytes: 0,
      })
    );

  it("both look identical if you only count attempts", () => {
    expect(budgetRefusals()).toHaveLength(failedTransfers().length);
  });

  it("and are told apart by transferStarted", () => {
    expect(budgetRefusals().filter((d) => d.transferStarted)).toHaveLength(0);
    expect(failedTransfers().filter((d) => d.transferStarted)).toHaveLength(14);
  });

  it("the report states both numbers, never just attempts", () => {
    const b = bundleWith(budgetRefusals());
    const text = formatReplayReport(b, replayBundle(b));
    expect(text).toContain("attempts=14");
    expect(text).toContain("transferStarted=0");
    expect(text).toContain("DOWNLOAD_TIMEOUT");
  });

  it("and names the budget margin when the budget was the reason", () => {
    const b = bundleWith(budgetRefusals());
    const text = formatReplayReport(b, replayBundle(b));
    expect(text).toContain("blocked before transfer with budget left");
    expect(text).toContain("floor=12000ms");
  });

  it("the downloader hypothesis reads differently in the same report", () => {
    const b = bundleWith(failedTransfers());
    const text = formatReplayReport(b, replayBundle(b));
    expect(text).toContain("transferStarted=14");
    expect(text).toContain("DOWNLOAD_FAILED");
    expect(text, "no budget margin to report when the budget was not the reason").not.toContain(
      "blocked before transfer"
    );
  });

  /** A bundle with no YouTube attempts prints no YouTube section at all. */
  it("says nothing when there were no downloads", () => {
    const b = bundleWith([]);
    expect(formatReplayReport(b, replayBundle(b))).not.toContain("YouTube downloads");
  });
});

/* ═════════ 3 — §6: no secrets, by construction ═════════ */

describe("the download fact carries identity, never payload", () => {
  it("has exactly the declared fields and no more", () => {
    expect(Object.keys(fact()).sort()).toEqual(
      [
        "bytes",
        "kind",
        "provider",
        "reason",
        "remainingMs",
        "route",
        "scene",
        "status",
        "transferStarted",
        "videoId",
      ].sort()
    );
  });

  it.each(["http", "url", "token", "key=", "authorization", "cookie", "Referer", "User-Agent"])(
    "no %s anywhere in a recorded attempt",
    (needle) => {
      expect(JSON.stringify(fact()).toLowerCase()).not.toContain(needle.toLowerCase());
    }
  );
});

/* ═════════ 4 — the render actually writes these facts ═════════ */

describe("the downloader is wired to the recorder", () => {
  const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("records at the single exit point, so success and failure alike are captured", () => {
    const at = PIPE.indexOf("const reportDownload = (status: YoutubeDownloadStatus");
    expect(at).toBeGreaterThan(-1);
    const body = PIPE.slice(at, at + 1400);
    expect(body).toContain('kind: "download"');
    expect(body).toContain("transferStarted,");
  });

  it("marks the transfer at the line where bytes begin to move", () => {
    const at = PIPE.indexOf("transferStarted = true;");
    expect(at).toBeGreaterThan(-1);
    expect(PIPE.slice(at, at + 260)).toContain("downloadToFileStreaming");
  });

  it("captures the budget it was refused on", () => {
    expect(PIPE).toContain("remainingAtCheckMs = remainingMs;");
  });

  /** The floor itself is untouched — this round changed observability, not behaviour. */
  it("the 12s download window is unchanged", () => {
    expect(PIPE).toContain("const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = 12_000;");
    expect(PIPE).toContain("if (remainingMs < YOUTUBE_MIN_DOWNLOAD_WINDOW_MS) {");
  });
});
