/**
 * P0-4 — MORE IDENTIFIABLE MUST NOT MEAN LESS RECOVERABLE.
 *
 * ── The defect, in one sentence ─────────────────────────────────────────────────────────────
 *
 * `rehydrateAsset`'s archive branch was a DEAD END. `identityHasRehydrationRoute` answers true on
 * an `archiveAssetId` alone, so the render is told the asset is recoverable — and the branch then
 * committed the entire attempt to that one route and returned a failure if it did not work. An
 * identity that ALSO carried `provider: "internet_archive"` with a stable `mediaUrl`, which the
 * very same function would have fetched twenty lines further down, was abandoned because an
 * archive id happened to be present too.
 *
 * So an asset that carried TWO ways home was recoverable by neither, while the same asset carrying
 * only the second was recovered without difficulty. That is the shape of `archiveAssetId →
 * REHYDRATION_DOWNLOAD_FAILED` in production.
 *
 * ── And a failure that misnamed itself ──────────────────────────────────────────────────────
 *
 * When the archive row held no storage URL and the identity had no canonical one, both attempts
 * were skipped and the function returned REHYDRATION_DOWNLOAD_FAILED — a download that never
 * happened, reported as a download that failed. This programme has removed that exact confusion
 * from the picture editor twice (RONDE 105, RONDE 115): "we could not ask" and "we asked and it
 * failed" need opposite work, and §3 is that distinction here.
 *
 * ── Real media, no mocks ────────────────────────────────────────────────────────────────────
 *
 * Every fixture is a real MP4 made with ffmpeg, every "download" copies real bytes, and every
 * recovered file is measured with ffprobe by the rehydrator's own `probeMediaFacts`. The seams
 * stood in for are the ones needing credentials this environment does not have, exactly as
 * RONDE 147 set out — and each is exercised for its failure path too.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ffmpegStatic from "ffmpeg-static";

import { identityHasRehydrationRoute, rehydrateAsset, type RehydrateDeps } from "./assetRehydrator";

const execFileAsync = promisify(execFile);
const FFMPEG = (ffmpegStatic as unknown as string) || "ffmpeg";

let ROOT = "";
let REAL_MP4 = "";

beforeAll(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "p04rh-"));
  REAL_MP4 = path.join(ROOT, "real.mp4");
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", REAL_MP4,
  ]);
}, 120_000);

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* a temp directory that is already gone needs no cleaning up */
  }
});

/** Copies real bytes, and counts how many times it was asked to. */
function countingDownloader(src: string) {
  const urls: string[] = [];
  return {
    urls,
    download: async (url: string, dest: string) => {
      urls.push(url);
      fs.copyFileSync(src, dest);
      return true;
    },
  };
}

/** Refuses everything, so a route that is tried can be told from a route that is not. */
function refusingDownloader() {
  const urls: string[] = [];
  return {
    urls,
    download: async (url: string, _dest: string) => {
      urls.push(url);
      return false;
    },
  };
}

/**
 * The identity a curated-archive clip actually carries.
 *
 * Both handles at once, which is the whole subject: the archive id because this system ingested
 * the file, AND the provider it originally came from, because the lineage ledger records the
 * proven origin rather than the storage location.
 */
const TWO_ROUTE_IDENTITY = {
  provider: "internet_archive",
  archiveAssetId: 91821,
  providerAssetId: "some_archive_item",
  mediaUrl: "https://archive.org/download/some_archive_item/some_archive_item.mp4",
} as const;

/* ═══════════ 1. the dead end ═══════════ */

describe("P0-4 §1 — an archive miss no longer ends the attempt", () => {
  it("THE CALLER IS TOLD THIS ASSET IS RECOVERABLE — on the archive id alone", () => {
    /** The promise the old branch could not keep, and the reason the dead end mattered. */
    expect(identityHasRehydrationRoute(TWO_ROUTE_IDENTITY)).toBe(true);
    expect(identityHasRehydrationRoute({ provider: "some_operator_slug", archiveAssetId: 1 })).toBe(true);
  });
});
