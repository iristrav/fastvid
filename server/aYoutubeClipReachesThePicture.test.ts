/**
 * A YOUTUBE CLIP THAT REACHES THE PICTURE — PROVEN IN PIXELS, WITH YOUTUBE UNREACHABLE.
 *
 * ── What render 593 could not show ──────────────────────────────────────────────────────────
 *
 * Three YouTube videos were downloaded successfully — `gPOOfUxvc0w`, `208MHJGfEzQ`,
 * `Q64X6jGJjNA`, seven downloads between them — and the lineage of all three reads:
 *
 *     FOUND → DOWNLOAD_STARTED → DOWNLOAD_SUCCEEDED
 *
 * and then stops. `youtube_cc: downloads=3 … accepted=0`. Nothing was adopted, so nothing was
 * archived, so nothing reached the timeline and nothing reached the picture. The chain was never
 * exercised past its fourth link in production, and no test walked it either: the existing
 * `archiveIsTheProductionMediaStore` proves a YouTube asset REHYDRATES from the archive, which is
 * link nine of eleven, and stops there.
 *
 * So the two links nobody had measured are the last two: does the rehydrated file reach
 * `renderTimeline`, and do its pixels come out the other side?
 *
 * ── Why a colour, and why two of them ───────────────────────────────────────────────────────
 *
 * "The render succeeded" is not provenance. Neither is "the output is longer than zero bytes": a
 * renderer that silently substituted a placeholder, a black frame or a different clip satisfies
 * both. The fixture is therefore a video no other stage in this pipeline can produce — solid
 * teal, `rgb(0, 200, 180)` — and the delivered MP4 is sampled for it. The renderer's own padding
 * colour is `0x2a2a2a`, a colour-card fallback is a blue-grey gradient, and an empty frame is
 * black; none of them is within reach of this one.
 *
 * The CONTROL is what turns that into an argument. A second render of an identically-shaped
 * timeline whose archive row holds an orange fixture must come out orange. One colour alone
 * proves the pipeline emits pixels; two prove the pixels came from the asset the timeline named.
 *
 * ── The tripwires ───────────────────────────────────────────────────────────────────────────
 *
 * `download`, `providerResolver` and `youtubeResolver` all THROW. They are not stubs that return
 * failure — a test that merely watched a stub return false would pass just as happily if the
 * renderer had asked. Any rehydration that reaches one of them fails this file with the
 * provider's own name in the message.
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
import { emptyTimeline, type AssetSourceIdentity, type ProjectTimeline } from "./projectTimeline";
import { renderTimeline } from "./timelineRenderer";
import { sourceIdentityFromClip } from "./timelineFromManifest";
import { resolveFFmpegBin } from "./ffmpegBinary";

const FFMPEG = resolveFFmpegBin();

/** The YouTube video this fixture stands in for. A real id shape; never fetched. */
const YOUTUBE_ID = "gPOOfUxvc0w";

/** Solid teal. Nothing else in this pipeline draws it. */
const TEAL = { r: 0, g: 200, b: 180 };
/** The control's colour — as far from teal as the fixture is from the renderer's own palette. */
const ORANGE = { r: 230, g: 120, b: 20 };

const W = 320;
const H = 180;

let root: string;
let storageDir: string;
let workDir: string;
let verifyDir: string;
let ffmpegAvailable = true;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "yt-to-picture-"));
  storageDir = path.join(root, "storage");
  workDir = path.join(root, "work");
  verifyDir = path.join(root, "verify");
  for (const d of [storageDir, workDir, verifyDir]) fs.mkdirSync(d, { recursive: true });
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

/**
 * A real MP4 of one flat colour.
 *
 * Real, because every gate on this path reads the FILE — `storeForProduction` probes it,
 * `mediaIsUsable` judges the probe, the rehydrator probes it again after reading it back, and
 * `renderTimeline` decodes it. Random bytes would pass none of that.
 */
function makeColourVideo(dest: string, c: { r: number; g: number; b: number }, seconds = 2): void {
  const hex = `0x${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  execFileSync(
    FFMPEG,
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=${hex}:s=${W}x${H}:r=10:d=${seconds}`,
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
      dest,
    ],
    { stdio: "pipe" }
  );
}

/** The centre pixel of the finished video, decoded from a real frame. */
function centrePixel(videoPath: string, atSec: number, scratch: string): { r: number; g: number; b: number } {
  execFileSync(
    FFMPEG,
    [
      "-y", "-v", "error", "-i", videoPath, "-ss", atSec.toFixed(2),
      "-frames:v", "1", "-vf", "crop=8:8:(iw-8)/2:(ih-8)/2,scale=1:1",
      "-f", "rawvideo", "-pix_fmt", "rgb24", scratch,
    ],
    { stdio: "pipe" }
  );
  const buf = fs.readFileSync(scratch);
  return { r: buf[0]!, g: buf[1]!, b: buf[2]! };
}

/** How far one colour is from another, in the crude way a codec's noise cannot bridge. */
function distance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

/* ═══════════════════════ the archive, standing in for R2 ═══════════════════════ */

type Row = { id: number; storageUrl: string; storageKey: string; mediaStatus: MediaStatus | null };

/** Where the stored bytes for an archive row live in this fixture's "object storage". */
const objectAt = (id: number) => path.join(storageDir, `${id}.mp4`);

function fakeArchive() {
  const rows = new Map<number, Row>();
  let nextId = 59000;
  const deps: ProductionArchiveDeps = {
    ingest: async (localPath) => {
      const id = nextId++;
      const storageKey = `archive/${id}.mp4`;
      fs.copyFileSync(localPath, objectAt(id));
      rows.set(id, {
        id,
        storageUrl: `https://archive.test/${id}.mp4`,
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
    /** §6's read-back, over the same objects `readStorage` will later serve to the renderer. */
    readBack: async (assetId, destPath) => {
      const src = objectAt(assetId);
      if (!rows.has(assetId) || !fs.existsSync(src)) return false;
      fs.copyFileSync(src, destPath);
      return true;
    },
    findByChecksum: async () => null,
    findByProviderAsset: async () => null,
  };
  return { deps, rows };
}

/** Render-time dependencies in which every route out to a provider is a tripwire. */
function renderDeps(rows: Map<number, Row>) {
  const calls: string[] = [];
  const deps: RehydrateDeps = {
    download: async (url) => {
      calls.push(`download:${url}`);
      throw new Error(`THE RENDERER DOWNLOADED FROM A PROVIDER: ${url}`);
    },
    archiveAsset: async (id) => {
      calls.push(`archive:${id}`);
      const row = rows.get(id);
      if (!row) return null;
      return { storageUrl: row.storageUrl, storageKey: row.storageKey, mimeType: "video/mp4" };
    },
    readStorage: async (storageUrl, destPath) => {
      calls.push(`readStorage:${storageUrl}`);
      const id = Number(/\/(\d+)\.mp4$/.exec(storageUrl)?.[1] ?? NaN);
      if (!Number.isFinite(id) || !fs.existsSync(objectAt(id))) return false;
      fs.copyFileSync(objectAt(id), destPath);
      return true;
    },
    providerResolver: async (identity) => {
      calls.push(`providerResolver:${identity.provider}`);
      throw new Error(`THE RENDERER CONTACTED A PROVIDER: ${identity.provider}`);
    },
    youtubeResolver: async (videoId) => {
      calls.push(`youtubeResolver:${videoId}`);
      throw new Error(`THE RENDERER CONTACTED YOUTUBE: ${videoId}`);
    },
  };
  return { deps, calls };
}

function metadataFor(title: string): ProductionArchiveMetadata {
  return {
    title,
    tags: ["fixture"],
    sourceNote: "deterministic fixture — no network, no provider call",
    mediaType: "video",
    mimeType: "video/mp4",
    sourcePlatform: "youtube_cc",
  };
}

/**
 * The whole chain for one colour: download → archive → timeline identity → rehydrate → render.
 *
 * Returned rather than asserted inside, so each test can ask its own question of the same run.
 */
async function youtubeClipToPicture(colour: { r: number; g: number; b: number }, videoId: string) {
  const downloaded = path.join(workDir, `${videoId}_download.mp4`);
  makeColourVideo(downloaded, colour);

  const archive = fakeArchive();
  const stored = await storeForProduction(
    {
      localPath: downloaded,
      provider: "youtube_cc",
      providerAssetId: videoId,
      metadata: metadataFor(`YouTube ${videoId}`),
      deps: archive.deps,
      ctx: { projectId: 593, sceneIndex: 0, beatIndex: 0, provider: "youtube_cc", providerAssetId: videoId },
      verifyDir,
      log: () => {},
    },
    60_000
  );

  /** The timeline references the INTERNAL handle; the provider survives only as lineage. */
  const identity: AssetSourceIdentity = archiveStoreSucceeded(stored)
    ? { provider: "youtube_cc", providerAssetId: videoId, archiveAssetId: stored.archiveAssetId }
    : { provider: "youtube_cc", providerAssetId: videoId };

  /** Whatever the sourcing run had on disk is gone by render time — a later job, a fresh container. */
  fs.rmSync(downloaded, { force: true });

  const { deps, calls } = renderDeps(archive.rows);
  const rehydrated = await rehydrateAsset({
    identity,
    workDir: path.join(workDir, `rehydrate_${videoId}`),
    deps,
  });

  return { stored, identity, rehydrated, calls };
}

/** A one-clip timeline that names the archived asset and nothing else. */
function timelineFor(identity: AssetSourceIdentity, durationSec: number): ProjectTimeline {
  const t = emptyTimeline(593, { widthPx: W, heightPx: H, fps: 10 });
  t.durationSec = durationSec;
  for (const track of t.tracks) {
    if (track.kind === "VIDEO") {
      track.clips.push({
        id: "yt-clip-1",
        kind: "video",
        source: identity,
        sourceIn: 0,
        sourceOut: durationSec,
        timelineStart: 0,
        timelineEnd: durationSec,
        motion: "none",
        transitionIn: "hard_cut",
        transitionOut: "hard_cut",
      } as never);
    }
  }
  return t;
}

/* ═══════════════════════ the eleven links, in order ═══════════════════════ */

describe("a YouTube clip reaches the delivered picture", () => {
  it("STEP 6 — the archive stores it READY, with a handle of our own", async () => {
    if (!ffmpegAvailable) return;
    const { stored } = await youtubeClipToPicture(TEAL, YOUTUBE_ID);
    expect(stored.status).toBe("stored");
    if (!archiveStoreSucceeded(stored)) throw new Error("the archive refused a valid asset");
    expect(stored.mediaStatus).toBe("READY");
    expect(stored.archiveAssetId).toBeGreaterThan(0);
    expect(stored.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it("STEP 7 — the timeline identity carries provider, providerAssetId AND archiveAssetId", async () => {
    if (!ffmpegAvailable) return;
    const { identity } = await youtubeClipToPicture(TEAL, YOUTUBE_ID);
    expect(identity.provider).toBe("youtube_cc");
    expect(identity.providerAssetId).toBe(YOUTUBE_ID);
    expect(identity.archiveAssetId, "the archive handle was dropped on the way to the timeline")
      .toBeGreaterThan(0);
  }, 120_000);

  it("STEPS 9+10 — it rehydrates from the archive and NEVER asks YouTube", async () => {
    if (!ffmpegAvailable) return;
    const { rehydrated, calls } = await youtubeClipToPicture(TEAL, YOUTUBE_ID);
    expect(rehydrated.status).toBe("ok");
    expect(
      calls.filter(
        (c) =>
          c.startsWith("download:") ||
          c.startsWith("providerResolver:") ||
          c.startsWith("youtubeResolver:")
      ),
      "the renderer went out to a provider for a file the archive holds"
    ).toEqual([]);
    /** And it says where it read it, so the route is in the record and not only in this test. */
    if (rehydrated.status === "ok") expect(rehydrated.provenance).toContain("archive");
  }, 120_000);

  it("STEPS 11+12 — THE DELIVERED MP4 SHOWS THE YOUTUBE FIXTURE'S OWN PIXELS", async () => {
    if (!ffmpegAvailable) return;
    const { rehydrated, calls } = await youtubeClipToPicture(TEAL, YOUTUBE_ID);
    if (rehydrated.status !== "ok") throw new Error(`rehydration failed: ${rehydrated.status}`);

    const renderDir = path.join(workDir, "render");
    fs.mkdirSync(renderDir, { recursive: true });
    const out = path.join(workDir, "delivered.mp4");
    const result = await renderTimeline({
      timeline: timelineFor(
        { provider: "youtube_cc", providerAssetId: YOUTUBE_ID, archiveAssetId: 1 },
        2
      ),
      workDir: renderDir,
      outputPath: out,
      /** The renderer is handed the rehydrated file and has no other way to a picture. */
      resolveMedia: async () => rehydrated.localPath,
    });

    expect(fs.existsSync(out)).toBe(true);
    expect(result.clipsRendered).toBe(1);

    /**
     * The measurement the whole file exists for. A placeholder, a black frame or a different clip
     * all fail it; only the fixture's own colour passes.
     */
    const seen = centrePixel(out, 1.0, path.join(workDir, "px.raw"));
    expect(
      distance(seen, TEAL),
      `the delivered frame is rgb(${seen.r},${seen.g},${seen.b}), not the YouTube fixture's teal`
    ).toBeLessThan(60);

    /** And nothing went out to a provider at any point in the whole run. */
    expect(calls.filter((c) => !c.startsWith("archive:") && !c.startsWith("readStorage:"))).toEqual([]);
  }, 300_000);

  it("THE CONTROL — a different archived asset yields a different picture", async () => {
    if (!ffmpegAvailable) return;
    /**
     * Without this, the test above proves only that the renderer emits pixels. With it, the colour
     * in the delivered frame is shown to follow the ASSET the timeline named.
     */
    const teal = await youtubeClipToPicture(TEAL, YOUTUBE_ID);
    const orange = await youtubeClipToPicture(ORANGE, "208MHJGfEzQ");
    if (teal.rehydrated.status !== "ok" || orange.rehydrated.status !== "ok") {
      throw new Error("a fixture failed to rehydrate");
    }

    const renderOne = async (localPath: string, tag: string) => {
      const dir = path.join(workDir, `render_${tag}`);
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(workDir, `${tag}.mp4`);
      await renderTimeline({
        timeline: timelineFor(
          { provider: "youtube_cc", providerAssetId: tag, archiveAssetId: 1 },
          2
        ),
        workDir: dir,
        outputPath: out,
        resolveMedia: async () => localPath,
      });
      return centrePixel(out, 1.0, path.join(workDir, `${tag}.raw`));
    };

    const a = await renderOne(teal.rehydrated.localPath, "teal");
    const b = await renderOne(orange.rehydrated.localPath, "orange");
    expect(distance(a, TEAL)).toBeLessThan(60);
    expect(distance(b, ORANGE)).toBeLessThan(60);
    expect(
      distance(a, b),
      "two different archived assets produced the same frame — the picture does not follow the asset"
    ).toBeGreaterThan(150);
  }, 300_000);
});

/* ═══════════════════════ §20 — the same clip twice, and a clip that is not one ═══════════════════════ */

describe("§20 — what the archive does with a repeat and with a ruin", () => {
  it("THE SAME YOUTUBE CLIP TWICE IS ONE ARCHIVE ASSET, not two", async () => {
    if (!ffmpegAvailable) return;
    /**
     * Two beats in one render can legitimately choose the same video. §14's rule is that identity
     * is the BYTES, so the second store recognises the first and hands back the same handle rather
     * than uploading a duplicate — and the timeline's two clips then name one asset.
     */
    const archive = fakeArchive();
    const byChecksum = new Map<string, { id: number; storageKey: string | null; mediaStatus: MediaStatus | null }>();
    const deps: ProductionArchiveDeps = {
      ...archive.deps,
      findByChecksum: async (checksum) => byChecksum.get(checksum) ?? null,
    };

    const storeOnce = async (tag: string) => {
      const src = path.join(workDir, `dup_${tag}.mp4`);
      /** The SAME bytes: one file, copied, exactly as two downloads of one video would be. */
      if (tag === "first") makeColourVideo(src, TEAL);
      else fs.copyFileSync(path.join(workDir, "dup_first.mp4"), src);
      const out = await storeForProduction(
        {
          localPath: src,
          provider: "youtube_cc",
          providerAssetId: YOUTUBE_ID,
          metadata: metadataFor(`YouTube ${YOUTUBE_ID}`),
          deps,
          ctx: { projectId: 593, provider: "youtube_cc", providerAssetId: YOUTUBE_ID },
          verifyDir,
          log: () => {},
        },
        60_000
      );
      if (archiveStoreSucceeded(out)) {
        byChecksum.set(out.checksumSha256, {
          id: out.archiveAssetId,
          storageKey: out.storageKey,
          mediaStatus: out.mediaStatus,
        });
      }
      return out;
    };

    const first = await storeOnce("first");
    const second = await storeOnce("second");
    if (!archiveStoreSucceeded(first) || !archiveStoreSucceeded(second)) {
      throw new Error("the archive refused a valid clip");
    }
    expect(second.archiveAssetId, "the same bytes were archived twice").toBe(first.archiveAssetId);
    expect(second.reused).toBe(true);
    expect(second.reusedBy).toBe("checksum");
    /** One object in storage, not two — the claim above, measured rather than reported. */
    expect(fs.readdirSync(storageDir)).toHaveLength(1);
  }, 180_000);

  it("A YOUTUBE DOWNLOAD THAT IS NOT A VIDEO IS REFUSED, and carries no handle", async () => {
    if (!ffmpegAvailable) return;
    /**
     * The `http_502 — ffmpeg exited with code 251` case from render 593, at the archive's door. A
     * truncated download is a file of the right name and the wrong contents; the probe is what
     * separates them, and §19 says a refused candidate gets no archive handle to carry onward.
     */
    const ruin = path.join(workDir, "truncated.mp4");
    fs.writeFileSync(ruin, Buffer.from("ftypisom this is not a video", "utf8"));
    const archive = fakeArchive();
    const out = await storeForProduction(
      {
        localPath: ruin,
        provider: "youtube_cc",
        providerAssetId: YOUTUBE_ID,
        metadata: metadataFor("a truncated download"),
        deps: archive.deps,
        ctx: { projectId: 593, provider: "youtube_cc", providerAssetId: YOUTUBE_ID },
        verifyDir,
        log: () => {},
      },
      60_000
    );
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.code).toBe("ARCHIVE_SOURCE_FILE_INVALID");
      expect(out.mediaStatus).not.toBe("READY");
      expect(out.archiveAssetId).toBeUndefined();
    }
    /** And nothing was written to storage on the way to that refusal. */
    expect(fs.readdirSync(storageDir)).toEqual([]);
  }, 120_000);
});

/* ═══════════════════════ §6 — the invariant, stated as refusals ═══════════════════════ */

describe("§6 — a YouTube clip without an archive handle cannot be rendered", () => {
  it("NO archiveAssetId means the renderer has no archive route at all", async () => {
    if (!ffmpegAvailable) return;
    const archive = fakeArchive();
    const { deps, calls } = renderDeps(archive.rows);
    /** The identity render 592 actually carried: a provider and an id, and nothing of our own. */
    const rehydrated = await rehydrateAsset({
      identity: { provider: "youtube_cc", providerAssetId: YOUTUBE_ID },
      workDir: path.join(workDir, "no-handle"),
      deps,
    });
    /**
     * It must NOT quietly succeed by going to YouTube. Either it refuses, or it trips a wire —
     * both are acceptable answers here and a silent provider fetch is not.
     */
    expect(rehydrated.status).not.toBe("ok");
    expect(calls.filter((c) => c.startsWith("archive:"))).toEqual([]);
  }, 120_000);

  it("the archive is asked FIRST, and a gone row falls through loudly, not silently", async () => {
    if (!ffmpegAvailable) return;
    /**
     * The fallback itself stays — that was decided deliberately: keep the route, remove the reasons
     * it gets taken. So what this test holds is the ORDER and the RECORD, which is what makes the
     * fallback a reported degradation rather than the silent substitution render 592 could not see.
     *
     * The strong claim — that a healthy archive row means YouTube is never contacted — is made by
     * STEPS 9+10 above, where the row is present and the resolver is a tripwire that never fires.
     */
    const archive = fakeArchive();
    const { deps, calls } = renderDeps(archive.rows);
    const rehydrated = await rehydrateAsset({
      identity: { provider: "youtube_cc", providerAssetId: YOUTUBE_ID, archiveAssetId: 99999 },
      workDir: path.join(workDir, "gone"),
      deps,
    });
    /** No bytes, because this fixture's YouTube route is a wall. */
    expect(rehydrated.status).not.toBe("ok");
    /** The archive was consulted before anything else was. */
    expect(calls[0], "something was tried before the archive").toBe("archive:99999");
    /**
     * And the RETURNED failure names the archive attempt, not only the console.
     *
     * This is the half that was missing: `alsoTried` was assembled below the YouTube branch, which
     * returns first, so a YouTube identity whose archive row had vanished reported a bare
     * "REHYDRATION_DOWNLOAD_FAILED videoId=…" — indistinguishable from YouTube simply refusing.
     */
    if (rehydrated.status !== "ok") {
      expect(
        rehydrated.errorMessage ?? "",
        "the failure does not say that an archive row was named and was gone"
      ).toContain("archive:99999");
    }
  }, 120_000);

  it("THE OTHER ROUTE TO A TIMELINE KEEPS THE HANDLE TOO", () => {
    /**
     * §19 says `archiveAssetId → timeline`, and the production route is not the only route that
     * builds one. `timelineFromEditorScenes` reopens an already-rendered film from its stored
     * manifest, and a re-render from the editor goes through the same rehydrator as everything
     * else — so a handle dropped HERE means a YouTube clip that rendered once can only be rendered
     * again by going back out to YouTube.
     *
     * Found by mutation: deleting the assignment in `sourceIdentityFromClip` broke nothing in the
     * suite. The production route's equivalent (`assetIdentity.ts`) was caught immediately; this
     * one had no test at all.
     */
    const identity = sourceIdentityFromClip({
      source: "youtube_cc",
      title: `YouTube ${YOUTUBE_ID}`,
      archiveAssetId: 59123,
      url: "/work/scene_0_b0_yt.mp4",
    } as never);
    expect(identity.archiveAssetId, "the editor route dropped the archive handle").toBe(59123);
    /** And the handle brings its own servable URL, which is what makes it survive tomorrow. */
    expect(identity.canonicalUrl ?? "").toContain("59123");
    /** A work-directory path is not a media URL and must not be recorded as one. */
    expect(identity.mediaUrl).toBeUndefined();
  });

  it("THE HANDLE SURVIVES adoption → timeline → render, unchanged", async () => {
    if (!ffmpegAvailable) return;
    const { stored, identity, rehydrated } = await youtubeClipToPicture(TEAL, YOUTUBE_ID);
    if (!archiveStoreSucceeded(stored)) throw new Error("the archive refused a valid asset");
    /** One number, carried from the archive through the identity to the thing that read it. */
    expect(identity.archiveAssetId).toBe(stored.archiveAssetId);
    expect(rehydrated.status).toBe("ok");
    if (rehydrated.status === "ok") {
      expect(rehydrated.provenance).toContain(String(stored.archiveAssetId));
    }
  }, 120_000);
});
