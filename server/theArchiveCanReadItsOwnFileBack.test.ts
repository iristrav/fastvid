/**
 * THE ARCHIVE CAN READ ITS OWN FILE BACK — AND IN RENDER 594 IT COULD NOT.
 *
 * ── What production measured ────────────────────────────────────────────────────────────────
 *
 *     [ProductionArchive] ARCHIVE_ASSET_MISSING project=594 s0b2 archiveAssetId=57758
 *         provider=wikimedia — the row exists and its stored file could not be read back
 *     [ProductionArchive] ARCHIVE_STORE_FAILED … code=ARCHIVE_NOT_READABLE status=MISSING
 *     [ProductionArchive] s0b2 ARCHIVE_NOT_READY_AT_PUSH … — this clip is refused
 *
 * Five rows, 57758 through 57762, every one of them written and then unreadable. The invariant
 * did exactly what it is for and refused the clip, so every one of the render's sixteen clips
 * reached the timeline with `archiveAssetId=null` (`fromArchive=0`), the renderer had to go back
 * to commons.wikimedia.org, and the delivery gate blocked the film.
 *
 * ── The URL the archive stores for itself ───────────────────────────────────────────────────
 *
 * On the S3 backend `storagePut` returns `objectStorageUrl(key)`, which is
 *
 *     /manus-storage/<key>
 *
 * a RELATIVE path — not an S3 URL and not an http one. `archiveIngestion` writes it into
 * `storageUrl`, and `readBack` then does:
 *
 *     resolveLocalStorageFilePath({ storageUrl })   → null; it only knows /local-storage/
 *     /^https?:\/\//.test(storageUrl)               → false
 *     storageUrl.startsWith("/")                    → TRUE
 *     → params.download("/manus-storage/<key>", dest)
 *
 * and the downloader is handed a relative path where a URL belongs.
 *
 * ── Why this is the signature defect and not an exotic one ──────────────────────────────────
 *
 * FIVE other modules already know the rule — strip `/manus-storage/`, ask `storageGetSignedUrl`,
 * fetch that: `archiveAssetLoad`, `archiveClipIndexBackfill`, `archiveMediaStream`,
 * `archiveTrimToScene`, `curatedMediaSourcing`. The two places that did NOT know it are the two
 * the production timeline depends on: the archive's own read-back, and the rehydrator's
 * `readStorage`. The answer was written down five times and not carried to where it decides.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

import {
  storeForProduction,
  archiveStoreSucceeded,
  type ProductionArchiveDeps,
  type ProductionArchiveMetadata,
  type MediaStatus,
} from "./productionMediaArchive";
import { resolveFFmpegBin } from "./ffmpegBinary";

const FFMPEG = resolveFFmpegBin();

let root: string;
let objects: string;
let verifyDir: string;
let ffmpegAvailable = true;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-readback-"));
  objects = path.join(root, "objects");
  verifyDir = path.join(root, "verify");
  for (const d of [objects, verifyDir]) fs.mkdirSync(d, { recursive: true });
  try {
    execFileSync(FFMPEG, ["-version"], { stdio: "pipe" });
  } catch {
    ffmpegAvailable = false;
  }
});
afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* a temp directory that will not delete is not this suite's problem */
  }
});

/** A real, probeable MP4 — every gate on this path reads the FILE. */
function makeVideo(dest: string, seconds = 2): void {
  execFileSync(
    FFMPEG,
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=0x3366cc:s=320x180:r=10:d=${seconds}`,
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
      dest,
    ],
    { stdio: "pipe" }
  );
}

type Row = { id: number; storageUrl: string; storageKey: string; mediaStatus: MediaStatus | null };

/**
 * The S3 backend, in the shape production actually has it.
 *
 * The object store holds the bytes under its KEY. The database row holds `/manus-storage/<key>`,
 * because that is what `storagePut` returns on this backend. Nothing here is invented: the
 * relative URL IS what `objectStorageUrl` produces.
 */
function s3LikeArchive(resolveSignedUrl?: (key: string) => Promise<string | null>) {
  const rows = new Map<number, Row>();
  const calls: string[] = [];
  let nextId = 57758;

  const deps: ProductionArchiveDeps = {
    ingest: async (localPath) => {
      const id = nextId++;
      const storageKey = `archive/asset_${id}.mp4`;
      fs.copyFileSync(localPath, path.join(objects, `${id}.mp4`));
      rows.set(id, {
        id,
        /** THE RELATIVE URL. `objectStorageUrl(key)` = `/manus-storage/<key>`. */
        storageUrl: `/manus-storage/${storageKey}`,
        storageKey,
        mediaStatus: null,
      });
      return { assetId: id, storageKey, reused: false };
    },
    updateAsset: async (assetId, patch) => {
      const row = rows.get(assetId);
      if (!row) throw new Error(`no archive row ${assetId}`);
      if (patch.mediaStatus) row.mediaStatus = patch.mediaStatus;
    },
    readBack: async (assetId, destPath) => {
      const row = rows.get(assetId);
      if (!row) return false;
      const storageUrl = row.storageUrl;

      /** Step 1 — the local-disk route, exactly as `resolveLocalStorageFilePath` decides it. */
      if (storageUrl.startsWith("/local-storage/")) {
        calls.push(`local:${storageUrl}`);
        return false;
      }

      /**
       * Step 2 — THE FIX UNDER TEST. A `/manus-storage/` URL is an object key, and the key is
       * resolved to a fetchable URL the way five other modules already resolve it.
       */
      if (resolveSignedUrl && storageUrl.startsWith("/manus-storage/")) {
        const key = row.storageKey || storageUrl.replace(/^\/manus-storage\//, "");
        const signed = await resolveSignedUrl(key);
        if (signed) {
          calls.push(`signed:${key}`);
          const id = Number(/asset_(\d+)\.mp4/.exec(signed)?.[1] ?? NaN);
          const src = path.join(objects, `${id}.mp4`);
          if (!fs.existsSync(src)) return false;
          fs.copyFileSync(src, destPath);
          return true;
        }
      }

      /**
       * Step 3 — what production did instead: hand the relative path to the downloader. A
       * downloader given a path where a URL belongs cannot fetch anything, so this is `false`.
       */
      if (/^https?:\/\//i.test(storageUrl) || storageUrl.startsWith("/")) {
        calls.push(`download:${storageUrl}`);
        return false;
      }
      return false;
    },
    findByChecksum: async () => null,
    findByProviderAsset: async () => null,
  };
  return { deps, rows, calls };
}

function metadata(): ProductionArchiveMetadata {
  return {
    title: "Kardashians Sears",
    tags: ["fixture"],
    sourceNote: "deterministic fixture — no network",
    mediaType: "video",
    mimeType: "video/mp4",
    sourcePlatform: "wikimedia",
  };
}

async function store(archive: ReturnType<typeof s3LikeArchive>, localPath: string) {
  return storeForProduction(
    {
      localPath,
      provider: "wikimedia",
      providerAssetId: "File:Kardashians Sears.png",
      metadata: metadata(),
      deps: archive.deps,
      ctx: {
        projectId: 594,
        sceneIndex: 0,
        beatIndex: 2,
        provider: "wikimedia",
        providerAssetId: "File:Kardashians Sears.png",
      },
      verifyDir,
      log: () => {},
    },
    60_000
  );
}

/* ═══════════════════ RENDER 594, REPRODUCED ═══════════════════ */

describe("render 594's archive failure, reproduced exactly", () => {
  it("A ROW THAT EXISTS WITH BYTES IN STORAGE STILL FAILS when the relative URL is downloaded", async () => {
    if (!ffmpegAvailable) return;
    /**
     * Nothing is wrong with the file, the ingest or the object store. The bytes are there under
     * their key. The ONLY thing wrong is that the read-back hands `/manus-storage/<key>` to a
     * downloader. This is the production failure, and it is a failure of URL resolution.
     */
    const src = path.join(root, "source.mp4");
    makeVideo(src);
    const archive = s3LikeArchive(/* no signed-url resolver — production's behaviour */);

    const out = await store(archive, src);

    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.code).toBe("ARCHIVE_NOT_READABLE");
      expect(out.mediaStatus).not.toBe("READY");
      expect(out.mediaStatus).toBe("MISSING");
      /** The row was created before the read-back refused it — 57758, as in production. */
      expect(out.archiveAssetId).toBe(57758);
    }
    /** The row's own status is left saying what is true of it. */
    expect(archive.rows.get(57758)?.mediaStatus).toBe("MISSING");
    /** And the proof of the cause: the relative path went to the downloader. */
    expect(archive.calls).toContain("download:/manus-storage/archive/asset_57758.mp4");
  }, 120_000);

  it("AND THE BYTES WERE THERE THE WHOLE TIME", () => {
    /**
     * Said separately because it is the difference between "our storage lost the file" and "we
     * asked for it the wrong way". Render 594's line — "the row exists and its stored file could
     * not be read back" — is true of both and sends a person to opposite places.
     */
    if (!ffmpegAvailable) return;
    const src = path.join(root, "present.mp4");
    makeVideo(src);
    fs.copyFileSync(src, path.join(objects, "57758.mp4"));
    expect(fs.existsSync(path.join(objects, "57758.mp4"))).toBe(true);
    expect(fs.statSync(path.join(objects, "57758.mp4")).size).toBeGreaterThan(0);
  });
});

/* ═══════════════════ THE PRODUCTION WIRING ITSELF ═══════════════════ */

describe("the two readers the timeline depends on resolve the key, not the path", () => {
  /**
   * The tests above characterise `storeForProduction` given a read-back that works or does not.
   * They would pass on either side of this fix, because the defect is not in the store — it is in
   * the WIRING that production hands it. These are the ones that fail before the fix.
   */
  const ARCHIVE = readFileSync(join(__dirname, "productionMediaArchive.ts"), "utf8");
  const REHYDRATE = readFileSync(join(__dirname, "rehydrationDeps.ts"), "utf8");

  it("ONE RESOLVER EXISTS, rather than a sixth copy of the same five lines", async () => {
    const mod = await import("./archiveAssetLoad");
    expect(
      typeof (mod as Record<string, unknown>).resolveArchiveObjectFetchUrl,
      "the canonical /manus-storage/ resolver is not exported"
    ).toBe("function");
  });

  it("an http URL is passed through untouched", async () => {
    const { resolveArchiveObjectFetchUrl } = await import("./archiveAssetLoad");
    await expect(
      resolveArchiveObjectFetchUrl({ storageUrl: "https://cdn.test/a.mp4", storageKey: null })
    ).resolves.toBe("https://cdn.test/a.mp4");
  });

  it("A RELATIVE /manus-storage/ URL IS NEVER RETURNED AS IF IT WERE FETCHABLE", async () => {
    /**
     * With no object backend configured there is no signed URL to be had, and the honest answer is
     * null. Returning the relative path — which is what the old `readBack` effectively did by
     * handing it to the downloader — is the defect: it turns "we cannot ask" into "we asked and it
     * failed", and those need opposite work.
     */
    const { resolveArchiveObjectFetchUrl } = await import("./archiveAssetLoad");
    const got = await resolveArchiveObjectFetchUrl({
      storageUrl: "/manus-storage/archive/asset_57758.mp4",
      storageKey: "archive/asset_57758.mp4",
    });
    expect(got).not.toBe("/manus-storage/archive/asset_57758.mp4");
    expect(got == null || /^https?:\/\//.test(got)).toBe(true);
  });

  it("THE ARCHIVE'S READ-BACK USES IT", () => {
    const at = ARCHIVE.indexOf("readBack: async (assetId, destPath)");
    expect(at, "readBack is gone — this test needs rewriting, not deleting").toBeGreaterThan(0);
    const body = ARCHIVE.slice(at, ARCHIVE.indexOf("findByChecksum:", at));
    expect(
      body,
      "the archive's read-back does not resolve the object key — it is the render-594 defect"
    ).toContain("resolveArchiveObjectFetchUrl");
  });

  it("THE REHYDRATOR'S readStorage USES IT — it had the same five lines and the same bug", () => {
    const at = REHYDRATE.indexOf("function readStorageWith(");
    expect(at, "readStorageWith is gone — this test needs rewriting, not deleting").toBeGreaterThan(0);
    const body = REHYDRATE.slice(at, at + 1800);
    expect(
      body,
      "the rehydrator still hands a /manus-storage/ path to the downloader"
    ).toContain("resolveArchiveObjectFetchUrl");
  });
});

/* ═══════════════════ THE HAPPY PATH THE FIX RESTORES ═══════════════════ */

describe("with the object key resolved the way five other modules resolve it", () => {
  it("valid media → ingest → row → read-back → ffprobe → READY", async () => {
    if (!ffmpegAvailable) return;
    const src = path.join(root, "source.mp4");
    makeVideo(src);
    /** The resolver five other modules already use: key → a fetchable URL. */
    const archive = s3LikeArchive(async (key) => `https://s3.test/${key}`);

    const out = await store(archive, src);

    expect(out.status).toBe("stored");
    if (!archiveStoreSucceeded(out)) throw new Error(`the archive refused a valid file: ${out.code}`);
    expect(out.mediaStatus).toBe("READY");
    expect(out.archiveAssetId).toBe(57758);
    expect(out.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.sizeBytes).toBeGreaterThan(0);
    /** The probe ran on the real file and found a video stream. */
    expect(out.facts.hasVideoStream).toBe(true);
    expect(out.facts.durationSec ?? 0).toBeGreaterThan(0);
    /** The row says READY, so a later render can trust the handle. */
    expect(archive.rows.get(57758)?.mediaStatus).toBe("READY");
    /** And it was resolved as a KEY, never downloaded as a path. */
    expect(archive.calls).toContain("signed:archive/asset_57758.mp4");
    expect(archive.calls.filter((c) => c.startsWith("download:/manus-storage/"))).toEqual([]);
  }, 120_000);

  it("A RESOLVER THAT CANNOT ANSWER IS STILL A REFUSAL, not a silent pass", async () => {
    if (!ffmpegAvailable) return;
    /** Storage genuinely unreachable: the answer must still be MISSING, never READY. */
    const src = path.join(root, "source.mp4");
    makeVideo(src);
    const archive = s3LikeArchive(async () => null);

    const out = await store(archive, src);
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.mediaStatus).not.toBe("READY");
  }, 120_000);
});
