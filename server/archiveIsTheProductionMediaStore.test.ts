/**
 * THE CENTRAL INVARIANT, ASKED OF THE REAL FUNCTIONS.
 *
 *     IF A MEDIA ASSET IS IN THE AUTHORITATIVE PRODUCTION TIMELINE, THE RENDERER MUST BE ABLE TO
 *     RENDER IT FROM FASTVID'S OWN ARCHIVE WITHOUT CONTACTING THE ORIGINAL PROVIDER.
 *
 * ── How that is proven here rather than asserted ────────────────────────────────────────────
 *
 * Every lifecycle test below wires `rehydrateAsset` with provider routes that THROW. `download`,
 * `providerResolver` and `youtubeResolver` are not stubs returning failure — they are tripwires. A
 * rehydration that reaches any of them fails the test with the provider's own name in the message,
 * so "it did not contact the provider" is a measured fact and not a reading of the code.
 *
 * The archive side is equally real: `storeForProduction` runs its actual order — validate,
 * deduplicate, ingest, record, read back, READY — over a temp directory standing in for R2. Only
 * the two edges that would need a network or a database are injected. Nothing mocks the decision.
 *
 * ── What render 592's class of failure looked like ──────────────────────────────────────────
 *
 *     ASSET_NOT_FOUND — provider=internet_archive providerAssetId=youtube-r6LB5toWr5I
 *                       has no fetchable URL
 *
 * `youtube-r6LB5toWr5I` is not a provider mix-up: archive.org mirrors YouTube material under
 * identifiers of exactly that form. The asset was real, FastVid had downloaded it, and it had kept
 * no handle of its own — so at render time the only route left was back out to a provider, and the
 * identity carried no URL to go back to. Test 12 reproduces that shape and proves an archived copy
 * renders through it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import {
  storeForProduction,
  archiveStoreSucceeded,
  type ProductionArchiveDeps,
  type ProductionArchiveMetadata,
  type MediaStatus,
} from "./productionMediaArchive";
import { rehydrateAsset, type RehydrateDeps } from "./assetRehydrator";
import type { AssetSourceIdentity } from "./projectTimeline";

/* ═══════════════════════ a real, tiny video ═══════════════════════ */

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

let root: string;
let storageDir: string;
let workDir: string;
let verifyDir: string;

/**
 * A genuine MP4, made by ffmpeg, because every gate in this path reads the FILE.
 *
 * `storeForProduction` probes it, `mediaIsUsable` judges the probe, and the rehydrator probes it
 * again after reading it back. A fixture of random bytes would pass none of that, and a test that
 * loosened those checks to accommodate one would be testing nothing.
 */
function makeRealVideo(dest: string, seconds = 4): void {
  execFileSync(
    FFMPEG,
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `testsrc=size=160x120:rate=10:duration=${seconds}`,
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
      dest,
    ],
    { stdio: "pipe" }
  );
}

let ffmpegAvailable = true;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-archive-"));
  storageDir = path.join(root, "storage");
  workDir = path.join(root, "work");
  verifyDir = path.join(root, "verify");
  for (const d of [storageDir, workDir, verifyDir]) fs.mkdirSync(d, { recursive: true });
});
afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* a temp directory that will not delete is not this suite's problem */
  }
});

/* ═══════════════════════ the archive, standing in for R2 ═══════════════════════ */

type Row = {
  id: number;
  storageUrl: string | null;
  storageKey: string;
  providerAssetId?: string;
  checksumSha256?: string;
  fileSizeBytes?: number;
  mediaStatus?: MediaStatus;
  sourcePlatform: string;
};

/**
 * The archive as a directory and a map.
 *
 * It behaves the way the real one does at the two edges `storeForProduction` touches: an ingest
 * copies the bytes somewhere durable and returns a row id, and a read-back copies them out again.
 * `ingestCalls` and `providerCalls` are what the assertions read — the first proves deduplication,
 * the second proves the provider was left alone.
 */
function fakeArchive() {
  const rows = new Map<number, Row>();
  let nextId = 57000;
  const ingestCalls: string[] = [];

  const deps: ProductionArchiveDeps = {
    ingest: async (localPath, metadata: ProductionArchiveMetadata) => {
      ingestCalls.push(localPath);
      const id = nextId++;
      const key = `archive/${id}.mp4`;
      fs.copyFileSync(localPath, path.join(storageDir, `${id}.mp4`));
      rows.set(id, {
        id,
        storageUrl: `/local-storage/${id}.mp4`,
        storageKey: key,
        sourcePlatform: metadata.sourcePlatform ?? "unknown",
      });
      return { assetId: id, storageKey: key };
    },
    updateAsset: async (assetId, patch) => {
      const row = rows.get(assetId);
      if (row) Object.assign(row, patch);
    },
    readBack: async (assetId, destPath) => {
      const row = rows.get(assetId);
      if (!row?.storageUrl) return false;
      const src = path.join(storageDir, `${assetId}.mp4`);
      if (!fs.existsSync(src)) return false;
      fs.copyFileSync(src, destPath);
      return true;
    },
    findByChecksum: async (checksum) => {
      for (const row of rows.values()) {
        if (row.checksumSha256 === checksum && row.mediaStatus === "READY") {
          return { id: row.id, storageKey: row.storageKey, mediaStatus: row.mediaStatus };
        }
      }
      return null;
    },
    findByProviderAsset: async (provider, providerAssetId) => {
      for (const row of rows.values()) {
        if (
          row.sourcePlatform === provider &&
          row.providerAssetId === providerAssetId &&
          row.mediaStatus === "READY"
        ) {
          return { id: row.id, storageKey: row.storageKey, mediaStatus: row.mediaStatus };
        }
      }
      return null;
    },
  };
  return { deps, rows, ingestCalls };
}

const metadataFor = (provider: string, title: string): ProductionArchiveMetadata => ({
  title,
  tags: [],
  sourceNote: `${provider}:test`,
  mediaType: "video",
  mimeType: "video/mp4",
  sourcePlatform: provider,
});

/* ═══════════════════════ the renderer, with the providers wired to explode ═══════════════════════ */

/**
 * Rehydration dependencies in which every external route is a tripwire.
 *
 * `archiveReadable` is the one thing that varies: false makes the archive's own storage unreadable,
 * which is Test 7's whole subject. `calls` records what the rehydrator reached for.
 */
function renderDeps(
  rows: Map<number, Row>,
  opts: { archiveReadable?: boolean } = {}
): { deps: RehydrateDeps; calls: string[] } {
  const calls: string[] = [];
  const archiveReadable = opts.archiveReadable ?? true;
  const deps: RehydrateDeps = {
    download: async (url) => {
      calls.push(`download:${url}`);
      throw new Error(`THE RENDERER CONTACTED A PROVIDER: download(${url})`);
    },
    archiveAsset: async (id) => {
      calls.push(`archive:${id}`);
      const row = rows.get(id);
      if (!row) return null;
      return { storageUrl: row.storageUrl, storageKey: row.storageKey, mimeType: "video/mp4" };
    },
    readStorage: async (storageUrl, destPath) => {
      calls.push(`readStorage:${storageUrl}`);
      if (!archiveReadable) return false;
      const id = /\/(\d+)\.mp4$/.exec(storageUrl)?.[1];
      const src = id ? path.join(storageDir, `${id}.mp4`) : null;
      if (!src || !fs.existsSync(src)) return false;
      fs.copyFileSync(src, destPath);
      return true;
    },
    providerResolver: async (identity) => {
      calls.push(`providerResolver:${identity.provider}`);
      throw new Error(`THE RENDERER CONTACTED A PROVIDER: providerResolver(${identity.provider})`);
    },
    youtubeResolver: async (videoId) => {
      calls.push(`youtubeResolver:${videoId}`);
      throw new Error(`THE RENDERER CONTACTED YOUTUBE: youtubeResolver(${videoId})`);
    },
  };
  return { deps, calls };
}

/* ═══════════════════════ the lifecycle, once, for any provider ═══════════════════════ */

/**
 * candidate → download → validate → ARCHIVE → archiveAssetId → timeline identity → render.
 *
 * One helper for all five provider tests, because the point of the architecture is that the
 * provider stops mattering after the archive. A per-provider copy of this would be the renderer
 * knowing about providers, which §16 makes a hard boundary.
 */
async function liveThroughTheLifecycle(provider: string, providerAssetId: string) {
  const downloaded = path.join(workDir, `${provider}_download.mp4`);
  makeRealVideo(downloaded);

  const archive = fakeArchive();
  const stored = await storeForProduction({
    localPath: downloaded,
    provider,
    providerAssetId,
    metadata: metadataFor(provider, `${provider} test asset`),
    deps: archive.deps,
    ctx: { projectId: 10108, sceneIndex: 2, beatIndex: 0, provider, providerAssetId },
    verifyDir,
    log: () => {},
  }, 60_000);

  /** The timeline references the INTERNAL handle. The provider stays as lineage. */
  const identity: AssetSourceIdentity = archiveStoreSucceeded(stored)
    ? { provider, providerAssetId, archiveAssetId: stored.archiveAssetId }
    : { provider, providerAssetId };

  /** Whatever the render had on disk is gone by render time — a later job, a fresh container. */
  fs.rmSync(downloaded, { force: true });

  const { deps, calls } = renderDeps(archive.rows);
  const rehydrated = await rehydrateAsset({
    identity,
    workDir: path.join(workDir, "render"),
    deps,
  });
  return { stored, identity, rehydrated, calls, archive };
}

/* ═════════════ Tests 1–5: every provider, the same lifecycle ═════════════ */

const PROVIDERS: Array<[string, string, string]> = [
  ["Test 1 — YouTube", "youtube_cc", "r6LB5toWr5I"],
  ["Test 2 — Wikimedia", "wikimedia", "File:Kris_Jenner_2013.webm"],
  ["Test 3 — Pexels", "pexels", "3163534"],
  ["Test 4 — Pixabay", "pixabay", "28020"],
  ["Test 5 — Internet Archive", "internet_archive", "youtube-r6LB5toWr5I"],
];

describe.each(PROVIDERS)("%s", (_label, provider, providerAssetId) => {
  it("MEASURED: the asset is stored READY and the timeline gets an internal handle", async () => {
    if (!ffmpegAvailable) return;
    const { stored } = await liveThroughTheLifecycle(provider, providerAssetId);
    expect(stored.status).toBe("stored");
    if (!archiveStoreSucceeded(stored)) return;
    expect(stored.mediaStatus).toBe("READY");
    expect(stored.archiveAssetId).toBeGreaterThan(0);
    expect(stored.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("MEASURED: it renders from the archive WITHOUT contacting the provider", async () => {
    if (!ffmpegAvailable) return;
    const { rehydrated, calls } = await liveThroughTheLifecycle(provider, providerAssetId);
    expect(rehydrated.status).toBe("ok");
    expect(
      calls.filter((c) => c.startsWith("download:") || c.startsWith("providerResolver:") || c.startsWith("youtubeResolver:")),
      "the renderer went out to the provider for a file the archive holds"
    ).toEqual([]);
  }, 60_000);

  it("MEASURED: the provider id survives as lineage, and is not what resolves the file", async () => {
    if (!ffmpegAvailable) return;
    const { identity, rehydrated } = await liveThroughTheLifecycle(provider, providerAssetId);
    expect(identity.providerAssetId).toBe(providerAssetId);
    expect(identity.archiveAssetId).toBeGreaterThan(0);
    if (rehydrated.status !== "ok") return;
    expect(rehydrated.provenance).toContain("archive");
  });
});

/* ═════════════ Test 6 — no provider URL at all ═════════════ */

describe("Test 6 — an asset with no fetchable provider URL", () => {
  it("MEASURED: it still renders, because the archived file exists", async () => {
    if (!ffmpegAvailable) return;
    const { rehydrated, identity, calls } = await liveThroughTheLifecycle(
      "internet_archive", "youtube-r6LB5toWr5I"
    );
    /** No canonicalUrl, no mediaUrl — the exact identity shape render 592 could not resolve. */
    expect(identity.canonicalUrl).toBeUndefined();
    expect(identity.mediaUrl).toBeUndefined();
    expect(rehydrated.status).toBe("ok");
    expect(calls.some((c) => c.startsWith("download:"))).toBe(false);
  });
});

/* ═════════════ Test 7 — the archived file is gone ═════════════ */

describe("Test 7 — a missing archive file must fail, not fall back", () => {
  it("MEASURED: rehydration fails and names the archive", async () => {
    if (!ffmpegAvailable) return;
    const downloaded = path.join(workDir, "gone.mp4");
    makeRealVideo(downloaded);
    const archive = fakeArchive();
    const stored = await storeForProduction({
      localPath: downloaded,
      provider: "wikimedia",
      providerAssetId: "File:Gone.webm",
      metadata: metadataFor("wikimedia", "gone"),
      deps: archive.deps,
      ctx: { projectId: 1, provider: "wikimedia", providerAssetId: "File:Gone.webm" },
      verifyDir,
      log: () => {},
    });
    expect(archiveStoreSucceeded(stored)).toBe(true);
    if (!archiveStoreSucceeded(stored)) return;

    /** The bytes disappear from storage after the timeline was written. */
    fs.rmSync(path.join(storageDir, `${stored.archiveAssetId}.mp4`), { force: true });
    fs.rmSync(downloaded, { force: true });

    const { deps } = renderDeps(archive.rows, { archiveReadable: false });
    const rehydrated = await rehydrateAsset({
      identity: {
        provider: "wikimedia",
        providerAssetId: "File:Gone.webm",
        archiveAssetId: stored.archiveAssetId,
      },
      workDir: path.join(workDir, "render7"),
      deps,
    });
    expect(rehydrated.status, "a missing archive file was quietly tolerated").toBe("failed");
  });
});

/* ═════════════ Test 8 — an invalid asset never becomes a handle ═════════════ */

describe("Test 8 — an invalid asset never enters the production timeline", () => {
  it("MEASURED: a file that is not media is refused, with no archive id to reference", async () => {
    const junk = path.join(workDir, "not-a-video.mp4");
    fs.writeFileSync(junk, Buffer.alloc(200_000, 7));
    const archive = fakeArchive();
    const stored = await storeForProduction({
      localPath: junk,
      provider: "pexels",
      providerAssetId: "999",
      metadata: metadataFor("pexels", "junk"),
      deps: archive.deps,
      ctx: { projectId: 1, provider: "pexels", providerAssetId: "999" },
      verifyDir,
      log: () => {},
    });
    expect(stored.status).toBe("failed");
    if (stored.status !== "failed") return;
    expect(stored.code).toBe("ARCHIVE_SOURCE_FILE_INVALID");
    expect(stored.mediaStatus).toBe("REJECTED");
    expect(archive.ingestCalls, "an unplayable file was uploaded to the archive").toEqual([]);
  }, 60_000);

  it("MEASURED: an empty file is refused before anything is probed or uploaded", async () => {
    const empty = path.join(workDir, "empty.mp4");
    fs.writeFileSync(empty, "");
    const archive = fakeArchive();
    const stored = await storeForProduction({
      localPath: empty,
      provider: "nara",
      providerAssetId: "1",
      metadata: metadataFor("nara", "empty"),
      deps: archive.deps,
      ctx: { projectId: 1, provider: "nara", providerAssetId: "1" },
      verifyDir,
      log: () => {},
    });
    expect(stored.status).toBe("failed");
    expect(archive.ingestCalls).toEqual([]);
  }, 60_000);

  it("MEASURED: a row whose stored file cannot be read back never reaches READY", async () => {
    if (!ffmpegAvailable) return;
    const clip = path.join(workDir, "unreadable.mp4");
    makeRealVideo(clip);
    const archive = fakeArchive();
    /** The upload "succeeds" and the bytes are not there — the half-success a row cannot detect. */
    const brokenDeps: ProductionArchiveDeps = {
      ...archive.deps,
      readBack: async () => false,
    };
    const stored = await storeForProduction({
      localPath: clip,
      provider: "loc",
      providerAssetId: "abc",
      metadata: metadataFor("loc", "unreadable"),
      deps: brokenDeps,
      ctx: { projectId: 1, provider: "loc", providerAssetId: "abc" },
      verifyDir,
      log: () => {},
    });
    expect(stored.status).toBe("failed");
    if (stored.status !== "failed") return;
    expect(stored.code).toBe("ARCHIVE_NOT_READABLE");
    expect(stored.mediaStatus).toBe("MISSING");
    const row = [...archive.rows.values()][0];
    expect(row?.mediaStatus, "a row nobody could read was left claiming to be usable").toBe("MISSING");
  });
});

/* ═════════════ Test 9 — rehydration survives a restart ═════════════ */

describe("Test 9 — the timeline still resolves after a restart", () => {
  it("MEASURED: an identity serialised to JSON and read back resolves from the archive", async () => {
    if (!ffmpegAvailable) return;
    const { identity, archive } = await liveThroughTheLifecycle("europeana", "2059209/data_sounds");

    /** Everything in memory is gone; the stored timeline is a string on disk. */
    const onDisk = path.join(root, "timeline.json");
    fs.writeFileSync(onDisk, JSON.stringify({ source: identity }));
    const revived = JSON.parse(fs.readFileSync(onDisk, "utf8")).source as AssetSourceIdentity;

    const { deps, calls } = renderDeps(archive.rows);
    const rehydrated = await rehydrateAsset({
      identity: revived,
      workDir: path.join(workDir, "render9"),
      deps,
    });
    expect(rehydrated.status).toBe("ok");
    expect(calls.some((c) => c.startsWith("download:"))).toBe(false);
  });
});

/* ═════════════ Test 10 — the same media twice ═════════════ */

describe("Test 10 — deduplication", () => {
  it("MEASURED: identical bytes are stored once, and the second call reuses the row", async () => {
    if (!ffmpegAvailable) return;
    const first = path.join(workDir, "dup1.mp4");
    makeRealVideo(first);
    const second = path.join(workDir, "dup2.mp4");
    fs.copyFileSync(first, second);

    const archive = fakeArchive();
    const run = (localPath: string, id: string) =>
      storeForProduction({
        localPath,
        provider: "internet_archive",
        providerAssetId: id,
        metadata: metadataFor("internet_archive", "dup"),
        deps: archive.deps,
        ctx: { projectId: 1, provider: "internet_archive", providerAssetId: id },
        verifyDir,
        log: () => {},
      });

    const a = await run(first, "item-a");
    const b = await run(second, "item-b");
    expect(archiveStoreSucceeded(a) && archiveStoreSucceeded(b)).toBe(true);
    if (!archiveStoreSucceeded(a) || !archiveStoreSucceeded(b)) return;

    expect(archive.ingestCalls, "the same bytes were uploaded twice").toHaveLength(1);
    expect(b.reused).toBe(true);
    expect(b.reusedBy).toBe("checksum");
    expect(b.archiveAssetId).toBe(a.archiveAssetId);
  }, 60_000);

  it("MEASURED: different bytes are NOT deduplicated onto one row", async () => {
    if (!ffmpegAvailable) return;
    const first = path.join(workDir, "a.mp4");
    const second = path.join(workDir, "b.mp4");
    makeRealVideo(first, 4);
    makeRealVideo(second, 6);
    const archive = fakeArchive();
    const run = (localPath: string, id: string) =>
      storeForProduction({
        localPath, provider: "nasa", providerAssetId: id,
        metadata: metadataFor("nasa", "distinct"),
        deps: archive.deps,
        ctx: { projectId: 1, provider: "nasa", providerAssetId: id },
        verifyDir, log: () => {},
      });
    const a = await run(first, "one");
    const b = await run(second, "two");
    expect(archive.ingestCalls).toHaveLength(2);
    if (archiveStoreSucceeded(a) && archiveStoreSucceeded(b)) {
      expect(a.archiveAssetId).not.toBe(b.archiveAssetId);
    }
  });
});

/* ═════════════ Test 12 — the actual regression ═════════════ */

describe("Test 12 — render 592's asset, with the provider unavailable", () => {
  it("MEASURED: internet_archive/youtube-r6LB5toWr5I renders from the archive", async () => {
    if (!ffmpegAvailable) return;
    const downloaded = path.join(workDir, "r6LB5toWr5I.mp4");
    makeRealVideo(downloaded);
    const archive = fakeArchive();
    const stored = await storeForProduction({
      localPath: downloaded,
      provider: "internet_archive",
      providerAssetId: "youtube-r6LB5toWr5I",
      metadata: metadataFor("internet_archive", "Kris Jenner interview"),
      deps: archive.deps,
      ctx: {
        projectId: 10108, sceneIndex: 2, beatIndex: 0,
        provider: "internet_archive", providerAssetId: "youtube-r6LB5toWr5I",
      },
      verifyDir,
      log: () => {},
    });
    expect(archiveStoreSucceeded(stored)).toBe(true);
    if (!archiveStoreSucceeded(stored)) return;

    /** Everything external is unavailable, and the render's own temp files are gone. */
    fs.rmSync(downloaded, { force: true });
    const { deps, calls } = renderDeps(archive.rows);

    const rehydrated = await rehydrateAsset({
      identity: {
        provider: "internet_archive",
        providerAssetId: "youtube-r6LB5toWr5I",
        archiveAssetId: stored.archiveAssetId,
      },
      workDir: path.join(workDir, "render12"),
      deps,
    });

    expect(
      rehydrated.status,
      "the asset that ended render 592 on ASSET_NOT_FOUND still cannot be rendered"
    ).toBe("ok");
    expect(calls.filter((c) => !c.startsWith("archive:") && !c.startsWith("readStorage:"))).toEqual([]);
    if (rehydrated.status !== "ok") return;
    expect(fs.existsSync(rehydrated.localPath)).toBe(true);
    expect(rehydrated.hasVideoStream).toBe(true);
    expect(rehydrated.durationSec ?? 0).toBeGreaterThan(0);
  }, 60_000);

  it("MEASURED: and WITHOUT the archive handle it fails exactly as render 592 did", async () => {
    const archive = fakeArchive();
    const { deps } = renderDeps(archive.rows);
    const rehydrated = await rehydrateAsset({
      /** The identity the old pipeline produced: a provider, an id, and nothing of ours. */
      identity: { provider: "internet_archive", providerAssetId: "youtube-r6LB5toWr5I" },
      workDir: path.join(workDir, "render12b"),
      deps,
    });
    expect(rehydrated.status).toBe("failed");
    if (rehydrated.status !== "failed") return;
    expect(rehydrated.errorCode).toBe("ASSET_NOT_FOUND");
    expect(rehydrated.errorMessage).toContain("has no fetchable URL");
  });
});

/* ═════════════ the store's own contract ═════════════ */

describe("the store refuses to claim more than it did", () => {
  it("MEASURED: a source file that is not on disk is MISSING, not FAILED", async () => {
    const archive = fakeArchive();
    const stored = await storeForProduction({
      localPath: path.join(workDir, "never-existed.mp4"),
      provider: "flickr",
      providerAssetId: "1",
      metadata: metadataFor("flickr", "absent"),
      deps: archive.deps,
      ctx: { projectId: 1, provider: "flickr", providerAssetId: "1" },
      verifyDir,
      log: () => {},
    });
    expect(stored.status).toBe("failed");
    if (stored.status !== "failed") return;
    expect(stored.code).toBe("ARCHIVE_SOURCE_FILE_MISSING");
    expect(stored.mediaStatus).toBe("MISSING");
  }, 60_000);

  it("MEASURED: an ingestion the archive refuses is reported, never treated as stored", async () => {
    if (!ffmpegAvailable) return;
    const clip = path.join(workDir, "refused.mp4");
    makeRealVideo(clip);
    const archive = fakeArchive();
    const stored = await storeForProduction({
      localPath: clip,
      provider: "openverse",
      providerAssetId: "x",
      metadata: metadataFor("openverse", "refused"),
      deps: { ...archive.deps, ingest: async () => null },
      ctx: { projectId: 1, provider: "openverse", providerAssetId: "x" },
      verifyDir,
      log: () => {},
    });
    expect(stored.status).toBe("failed");
    if (stored.status !== "failed") return;
    expect(stored.code).toBe("ARCHIVE_INGEST_REFUSED");
  }, 60_000);

  it("MEASURED: the log names project, scene, beat, archive id and provider — and no URL", async () => {
    if (!ffmpegAvailable) return;
    const clip = path.join(workDir, "logged.mp4");
    makeRealVideo(clip);
    const archive = fakeArchive();
    const lines: string[] = [];
    await storeForProduction({
      localPath: clip,
      provider: "wikimedia",
      providerAssetId: "File:Logged.webm",
      metadata: { ...metadataFor("wikimedia", "logged"), sourceUrl: "https://example.org/secret?token=abc" },
      deps: archive.deps,
      ctx: {
        projectId: 10108, sceneIndex: 2, beatIndex: 0,
        provider: "wikimedia", providerAssetId: "File:Logged.webm",
      },
      verifyDir,
      log: (l) => lines.push(l),
    });
    const all = lines.join("\n");
    expect(all).toContain("ARCHIVE_STORE_START");
    expect(all).toContain("ARCHIVE_STORE_SUCCESS");
    expect(all).toContain("ARCHIVE_ASSET_READY");
    expect(all).toContain("project=10108");
    expect(all).toContain("s2b0");
    expect(all).toContain("provider=wikimedia");
    expect(all, "a URL with a token in it reached a log line").not.toContain("token=abc");
    expect(all).not.toContain("https://");
  });
});

/** ffmpeg is what makes these tests real; a runner without it must say so, not quietly pass. */
describe("the fixture is a real video", () => {
  it("ffmpeg is available to this suite", () => {
    try {
      const probe = path.join(root, "probe.mp4");
      makeRealVideo(probe, 1);
      expect(fs.statSync(probe).size).toBeGreaterThan(0);
    } catch (err) {
      ffmpegAvailable = false;
      throw new Error(
        `ffmpeg is required for the archive lifecycle suite and is not usable: ${(err as Error).message}`
      );
    }
  });
});
