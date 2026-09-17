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

import {
  identityHasRehydrationRoute,
  rehydrateAsset,
  rehydrationSucceeded,
  type RehydrateDeps,
} from "./assetRehydrator";

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

  it("AN ARCHIVE ROW THAT IS GONE FALLS THROUGH TO THE PROVIDER, AND THE ASSET COMES BACK", async () => {
    const dl = countingDownloader(REAL_MP4);
    const result = await rehydrateAsset({
      identity: TWO_ROUTE_IDENTITY,
      workDir: path.join(ROOT, "s1a"),
      deps: {
        /** The row is gone from media_archive_assets — the production shape. */
        archiveAsset: async () => null,
        download: dl.download,
      } as RehydrateDeps,
    });
    expect(rehydrationSucceeded(result), `rehydration failed: ${JSON.stringify(result)}`).toBe(true);
    if (!rehydrationSucceeded(result)) return;
    /** Real bytes, measured from the file by the rehydrator itself — not taken from metadata. */
    expect(result.hasVideoStream).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.sourceUrl).toBe(TWO_ROUTE_IDENTITY.mediaUrl);
    expect(dl.urls).toEqual([TWO_ROUTE_IDENTITY.mediaUrl]);
  }, 120_000);

  it("AND SO DOES AN ARCHIVE STORAGE URL THAT WILL NOT SERVE", async () => {
    /**
     * The harder case: the row exists and names a storage URL, and that URL is dead. Before this
     * round the function stopped there — with a provider route sitting unused on the same
     * identity.
     */
    const dl = {
      urls: [] as string[],
      download: async (url: string, dest: string) => {
        dl.urls.push(url);
        if (url.includes("storage.internal")) return false;
        fs.copyFileSync(REAL_MP4, dest);
        return true;
      },
    };
    const result = await rehydrateAsset({
      identity: TWO_ROUTE_IDENTITY,
      workDir: path.join(ROOT, "s1b"),
      deps: {
        archiveAsset: async () => ({
          storageUrl: "https://storage.internal/dead/91821.mp4",
          storageKey: "dead/91821.mp4",
        }),
        download: dl.download,
      } as RehydrateDeps,
    });
    expect(rehydrationSucceeded(result)).toBe(true);
    /** BOTH routes were tried, in that order. The archive is still preferred; it is no longer final. */
    expect(dl.urls[0]).toContain("storage.internal");
    expect(dl.urls[1]).toBe(TWO_ROUTE_IDENTITY.mediaUrl);
  }, 120_000);

  it("a row with NO storage url at all also falls through", async () => {
    const dl = countingDownloader(REAL_MP4);
    const result = await rehydrateAsset({
      identity: TWO_ROUTE_IDENTITY,
      workDir: path.join(ROOT, "s1c"),
      deps: {
        archiveAsset: async () => ({ storageUrl: null, storageKey: null }),
        download: dl.download,
      } as RehydrateDeps,
    });
    expect(rehydrationSucceeded(result)).toBe(true);
    expect(dl.urls).toEqual([TWO_ROUTE_IDENTITY.mediaUrl]);
  }, 120_000);
});

/* ═══════════ 2. and the archive is still preferred, and still wins ═══════════ */

describe("P0-4 §2 — nothing that succeeded before succeeds differently now", () => {
  it("THE ARCHIVE IS STILL TRIED FIRST, FROM OUR OWN STORAGE, WITH NO EXTERNAL FETCH", async () => {
    let external = 0;
    const result = await rehydrateAsset({
      identity: TWO_ROUTE_IDENTITY,
      workDir: path.join(ROOT, "s2a"),
      deps: {
        archiveAsset: async () => ({
          storageUrl: "https://storage.internal/live/91821.mp4",
          storageKey: "live/91821.mp4",
        }),
        readStorage: async (_url: string, dest: string) => {
          fs.copyFileSync(REAL_MP4, dest);
          return true;
        },
        download: async () => {
          external++;
          return false;
        },
      } as RehydrateDeps,
    });
    expect(rehydrationSucceeded(result)).toBe(true);
    if (!rehydrationSucceeded(result)) return;
    expect(external, "an external fetch happened although our own storage served the file").toBe(0);
    expect(result.downloaded).toBe(false);
    expect(result.provenance).toContain("this system's own archive storage");
    expect(result.storagePath).toBe("live/91821.mp4");
  }, 120_000);

  it("and the storage URL is still preferred over the provider's when it works", async () => {
    const dl = countingDownloader(REAL_MP4);
    const result = await rehydrateAsset({
      identity: TWO_ROUTE_IDENTITY,
      workDir: path.join(ROOT, "s2b"),
      deps: {
        archiveAsset: async () => ({
          storageUrl: "https://storage.internal/live/91821.mp4",
          storageKey: "live/91821.mp4",
        }),
        download: dl.download,
      } as RehydrateDeps,
    });
    expect(rehydrationSucceeded(result)).toBe(true);
    expect(dl.urls).toEqual(["https://storage.internal/live/91821.mp4"]);
  }, 120_000);
});

/* ═══════════ 3. a route that was never tried is not a route that failed ═══════════ */

describe("P0-4 §3 — the failure says which failure it was", () => {
  /** An operator's own archive slug: no provider route exists behind it, by design. */
  const ARCHIVE_ONLY = { provider: "wwii_archive", archiveAssetId: 57618 } as const;

  it("NOTHING TO READ IS `ASSET_NOT_FOUND`, NOT A FAILED DOWNLOAD", async () => {
    const dl = refusingDownloader();
    const result = await rehydrateAsset({
      identity: ARCHIVE_ONLY,
      workDir: path.join(ROOT, "s3a"),
      deps: { archiveAsset: async () => null, download: dl.download } as RehydrateDeps,
    });
    expect(rehydrationSucceeded(result)).toBe(false);
    if (rehydrationSucceeded(result)) return;
    expect(result.errorCode).toBe("ASSET_NOT_FOUND");
    expect(dl.urls, "a download was attempted although there was no URL to attempt").toEqual([]);
  }, 120_000);

  it("AND A STORAGE URL THAT WAS TRIED AND REFUSED IS `REHYDRATION_DOWNLOAD_FAILED`", async () => {
    const dl = refusingDownloader();
    const result = await rehydrateAsset({
      identity: ARCHIVE_ONLY,
      workDir: path.join(ROOT, "s3b"),
      deps: {
        archiveAsset: async () => ({
          storageUrl: "https://storage.internal/dead/57618.mp4",
          storageKey: "dead/57618.mp4",
        }),
        download: dl.download,
      } as RehydrateDeps,
    });
    expect(rehydrationSucceeded(result)).toBe(false);
    if (rehydrationSucceeded(result)) return;
    expect(result.errorCode).toBe("REHYDRATION_DOWNLOAD_FAILED");
    expect(dl.urls).toHaveLength(1);
  }, 120_000);

  it("the message NAMES WHAT WAS TRIED, so an operator is not left to guess", async () => {
    const result = await rehydrateAsset({
      identity: ARCHIVE_ONLY,
      workDir: path.join(ROOT, "s3c"),
      deps: {
        archiveAsset: async () => ({ storageUrl: null, storageKey: null }),
        download: refusingDownloader().download,
      } as RehydrateDeps,
    });
    expect(rehydrationSucceeded(result)).toBe(false);
    if (rehydrationSucceeded(result)) return;
    expect(result.errorMessage).toContain("archive:57618");
    expect(result.errorMessage).toContain("no storage URL");
    expect(result.errorMessage).toContain("no further route");
  }, 120_000);

  it("AND AN ARCHIVE MISS FOLLOWED BY A PROVIDER MISS REPORTS BOTH", async () => {
    /**
     * The one a single-route failure message could never say. Without the archive attempt in it,
     * this reads as a plain provider failure, and the fact that this system once held the file
     * itself — the more serious finding — disappears.
     */
    const result = await rehydrateAsset({
      identity: TWO_ROUTE_IDENTITY,
      workDir: path.join(ROOT, "s3d"),
      deps: {
        archiveAsset: async () => ({
          storageUrl: "https://storage.internal/dead/91821.mp4",
          storageKey: null,
        }),
        download: refusingDownloader().download,
      } as RehydrateDeps,
    });
    expect(rehydrationSucceeded(result)).toBe(false);
    if (rehydrationSucceeded(result)) return;
    expect(result.errorCode).toBe("REHYDRATION_DOWNLOAD_FAILED");
    expect(result.errorMessage).toContain("archive:91821");
    expect(result.errorMessage).toContain("archive.org");
  }, 120_000);
});

/* ═══════════ 4. nothing is substituted, ever ═══════════ */

describe("P0-4 §4 — a fall-through is not a substitution", () => {
  it("THE FALL-THROUGH USES THIS IDENTITY'S OWN OTHER HANDLE, NEVER ANOTHER ASSET'S", async () => {
    /**
     * RONDE 147 TEST 12's rule, restated for the route this round opened: if asset A cannot be
     * recovered, asset B is never quietly used in its place. The new path fetches the URL THIS
     * identity records, and a failure is still a failure.
     */
    const dl = countingDownloader(REAL_MP4);
    const result = await rehydrateAsset({
      identity: TWO_ROUTE_IDENTITY,
      workDir: path.join(ROOT, "s4a"),
      deps: { archiveAsset: async () => null, download: dl.download } as RehydrateDeps,
    });
    expect(rehydrationSucceeded(result)).toBe(true);
    for (const url of dl.urls) {
      expect(url, "a URL was fetched that this identity does not name").toBe(
        TWO_ROUTE_IDENTITY.mediaUrl
      );
    }
  }, 120_000);

  it("and an unrehydratable provider behind a dead archive id still FAILS", async () => {
    /**
     * The fall-through must not become a way for an unknown provider to be attempted. The branch
     * asks `providerIsRehydratable`, so a slug nobody has characterised ends the attempt here —
     * with the archive's own account of what it tried, which is the improvement.
     */
    const dl = refusingDownloader();
    const result = await rehydrateAsset({
      identity: { provider: "an_operator_slug_nobody_declared", archiveAssetId: 4242 },
      workDir: path.join(ROOT, "s4b"),
      deps: { archiveAsset: async () => null, download: dl.download } as RehydrateDeps,
    });
    expect(rehydrationSucceeded(result)).toBe(false);
    if (rehydrationSucceeded(result)) return;
    expect(result.errorMessage).toContain("no further route");
    expect(dl.urls).toEqual([]);
  }, 120_000);

  it("AND AN IDENTITY WITH NO ARCHIVE ID IS COMPLETELY UNAFFECTED", async () => {
    const dl = countingDownloader(REAL_MP4);
    const result = await rehydrateAsset({
      identity: {
        provider: "internet_archive",
        providerAssetId: "plain_item",
        mediaUrl: "https://archive.org/download/plain_item/plain_item.mp4",
      },
      workDir: path.join(ROOT, "s4c"),
      deps: { download: dl.download } as RehydrateDeps,
    });
    expect(rehydrationSucceeded(result)).toBe(true);
    if (!rehydrationSucceeded(result)) return;
    /** No archive attempt happened, so the message the round added must not appear. */
    expect(result.provenance).not.toContain("archive storage");
    expect(dl.urls).toHaveLength(1);
  }, 120_000);
});
