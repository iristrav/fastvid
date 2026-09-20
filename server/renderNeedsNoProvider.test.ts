/**
 * §5 — THE RENDER CHAIN ITSELF, WITH EVERY PROVIDER WIRED TO EXPLODE.
 *
 * ── Why this exists beside the unit suite ───────────────────────────────────────────────────
 *
 * `archiveIsTheProductionMediaStore.test.ts` proves the rehydrator's route selection. It does not
 * prove that a RENDER completes from it — a chain can have a correct first link and still not
 * reach the end. This one runs the real links:
 *
 *     rehydrateTimelineAssets   the real function, real identities, real ffprobe
 *     renderTimeline            real ffmpeg, real concat, a real MP4 on disk
 *     checkRenderedFile         the pipeline's own container check
 *     deliveryGate              the gate the render worker now calls
 *
 * Only two edges are injected: the archive's storage (a temp directory standing in for R2) and the
 * five provider routes — and those are not stubs returning failure. Every one of them THROWS with
 * its own name. A render that touches any of them fails this test with the provider named, so "no
 * provider was contacted during rendering" is a measured fact rather than a reading of the code.
 *
 * ── The asset ───────────────────────────────────────────────────────────────────────────────
 *
 * `internet_archive` / `youtube-r6LB5toWr5I`, which is the identity that ended render 592 on
 * `ASSET_NOT_FOUND … has no fetchable URL`. archive.org mirrors YouTube material under exactly that
 * identifier form, so the pair is correct; what was missing was a handle of FastVid's own.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { storeForProduction, archiveStoreSucceeded, type ProductionArchiveDeps } from "./productionMediaArchive";
import { rehydrateTimelineAssets, type RehydrateDeps } from "./assetRehydrator";
import { renderTimeline, checkRenderedFile } from "./timelineRenderer";
import { deliveryGate } from "./deliveryGate";
import type { AssetSourceIdentity, ProjectTimeline } from "./projectTimeline";
import { videoTrack, TIMELINE_SCHEMA_VERSION } from "./projectTimeline";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

let root: string;
let storageDir: string;
let workDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-render-noprovider-"));
  storageDir = path.join(root, "storage");
  workDir = path.join(root, "work");
  for (const d of [storageDir, workDir]) fs.mkdirSync(d, { recursive: true });
});
afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* a temp directory that will not delete is not this suite's problem */
  }
});

/** A real MP4 — every gate in this chain reads the file, and a fixture of noise passes none. */
function makeRealVideo(dest: string, seconds: number, hue = "testsrc"): void {
  execFileSync(
    FFMPEG,
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `${hue}=size=320x240:rate=25:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
      "-c:a", "aac", "-shortest",
      dest,
    ],
    { stdio: "pipe" }
  );
}

/* ═══════════════════════ the archive ═══════════════════════ */

type Row = { id: number; storageUrl: string; storageKey: string; mediaStatus?: string };

function fakeArchive() {
  const rows = new Map<number, Row>();
  let nextId = 58000;
  const deps: ProductionArchiveDeps = {
    ingest: async (localPath) => {
      const id = nextId++;
      fs.copyFileSync(localPath, path.join(storageDir, `${id}.mp4`));
      const row = { id, storageUrl: `/local-storage/${id}.mp4`, storageKey: `archive/${id}.mp4` };
      rows.set(id, row);
      return { assetId: id, storageKey: row.storageKey };
    },
    updateAsset: async (id, patch) => {
      const row = rows.get(id);
      if (row) Object.assign(row, patch);
    },
    readBack: async (id, destPath) => {
      const src = path.join(storageDir, `${id}.mp4`);
      if (!fs.existsSync(src)) return false;
      fs.copyFileSync(src, destPath);
      return true;
    },
  };
  return { deps, rows };
}

/* ═══════════════════════ every provider is a tripwire ═══════════════════════ */

/**
 * The five providers §5 names, each wired to throw with its own name.
 *
 * `download` covers Wikimedia, the Internet Archive and every stored-URL route; `providerResolver`
 * covers Pexels and Pixabay, whose CDN links expire and must be looked up; `youtubeResolver` covers
 * YouTube. Between them there is no way out to a network that does not land in this list.
 */
function tripwireDeps(rows: Map<number, Row>): { deps: RehydrateDeps; touched: string[] } {
  const touched: string[] = [];
  const boom = (who: string) => {
    touched.push(who);
    throw new Error(`A PROVIDER WAS CONTACTED DURING RENDERING: ${who}`);
  };
  const deps: RehydrateDeps = {
    download: async (url) => boom(`download(${new URL(url, "http://x").hostname || url})`),
    archiveAsset: async (id) => {
      const row = rows.get(id);
      return row ? { storageUrl: row.storageUrl, storageKey: row.storageKey, mimeType: "video/mp4" } : null;
    },
    readStorage: async (storageUrl, destPath) => {
      const id = /\/(\d+)\.mp4$/.exec(storageUrl)?.[1];
      const src = id ? path.join(storageDir, `${id}.mp4`) : null;
      if (!src || !fs.existsSync(src)) return false;
      fs.copyFileSync(src, destPath);
      return true;
    },
    providerResolver: async (identity) => boom(`providerResolver(${identity.provider})`),
    youtubeResolver: async (videoId) => boom(`youtubeResolver(${videoId})`),
  };
  return { deps, touched };
}

/* ═══════════════════════ the timeline ═══════════════════════ */

function timelineWith(clips: Array<{ id: string; source: AssetSourceIdentity; sec: number }>): ProjectTimeline {
  let at = 0;
  const videoClips = clips.map((c) => {
    const clip = {
      id: c.id,
      kind: "video" as const,
      source: c.source,
      sourceIn: 0,
      sourceOut: c.sec,
      timelineStart: at,
      timelineEnd: at + c.sec,
      motion: "none" as const,
    };
    at += c.sec;
    return clip;
  });
  /**
   * No cast. The first draft of this helper wrote `fps`/`width`/`height` at the top level and hid
   * the mistake behind `as unknown as ProjectTimeline`; the renderer then failed on a missing
   * `format.widthPx` at runtime, which is exactly the error the type would have caught for free.
   */
  const timeline: ProjectTimeline = {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    version: 1,
    videoId: 10108,
    durationSec: at,
    format: { widthPx: 320, heightPx: 240, fps: 25 },
    tracks: [{ kind: "VIDEO", clips: videoClips }],
    createdAt: new Date().toISOString(),
  };
  return timeline;
}

/* ═══════════════════════ the test ═══════════════════════ */

describe("§5 — a render completes from the archive with every provider throwing", () => {
  it("MEASURED: rehydrate → render → check → gate, and no provider is touched", async () => {
    /* 1. two external candidates, downloaded by an earlier render. */
    const archive = fakeArchive();
    const sources: AssetSourceIdentity[] = [];
    const specs: Array<[string, string, number]> = [
      ["internet_archive", "youtube-r6LB5toWr5I", 2],
      ["wikimedia", "File:Kris_Jenner.webm", 2],
    ];
    for (const [provider, providerAssetId, sec] of specs) {
      const downloaded = path.join(workDir, `${providerAssetId.replace(/[^\w]/g, "_")}.mp4`);
      makeRealVideo(downloaded, sec);
      const stored = await storeForProduction({
        localPath: downloaded,
        provider,
        providerAssetId,
        metadata: {
          title: providerAssetId,
          tags: [],
          sourceNote: `${provider}:${providerAssetId}`,
          mediaType: "video",
          mimeType: "video/mp4",
          sourcePlatform: provider,
        },
        deps: archive.deps,
        ctx: { projectId: 10108, provider, providerAssetId },
        verifyDir: path.join(workDir, "verify"),
        log: () => {},
      });
      expect(archiveStoreSucceeded(stored), `${provider} was not archived`).toBe(true);
      if (!archiveStoreSucceeded(stored)) return;
      sources.push({ provider, providerAssetId, archiveAssetId: stored.archiveAssetId });
      /** The render's own temp file is gone by the time anything renders from the timeline. */
      fs.rmSync(downloaded, { force: true });
    }

    /* 2. the authoritative timeline references the internal handles. */
    const timeline = timelineWith([
      { id: "c1", source: sources[0]!, sec: 2 },
      { id: "c2", source: sources[1]!, sec: 2 },
    ]);

    /* 3. rehydrate, with every provider armed to throw. */
    const { deps, touched } = tripwireDeps(archive.rows);
    const rehydration = await rehydrateTimelineAssets({
      timeline,
      workDir: path.join(workDir, "assets"),
      deps,
      failFast: true,
    });
    expect(
      rehydration.ok,
      `rehydration failed: ${rehydration.failures.map((f) => f.result.errorMessage).join("; ")}`
    ).toBe(true);
    expect(touched, "a provider was contacted while recovering archived media").toEqual([]);

    /* 4. render, for real. */
    const outputPath = path.join(workDir, "out.mp4");
    const rendered = await renderTimeline({
      timeline,
      workDir: path.join(workDir, "render"),
      outputPath,
      resolveMedia: async (clip) => rehydration.byClipId.get(clip.id) ?? null,
    });
    expect(rendered.clipsRendered, "the renderer consumed no clips").toBeGreaterThan(0);
    expect(fs.existsSync(outputPath)).toBe(true);

    /* 5. the pipeline's own container check on the produced file. */
    const check = await checkRenderedFile({ filePath: outputPath, timeline, expectAudio: false });
    expect(check.fileExists).toBe(true);
    expect(check.hasVideo, "the rendered file carries no video stream").toBe(true);
    expect(check.durationSec ?? 0).toBeGreaterThan(0);

    /* 6. the gate the render worker now calls. */
    const gate = deliveryGate({
      videoId: 10108,
      route: "cinematic_timeline",
      cinematicRefusal: null,
      timelineExists: true,
      clips: videoTrack(timeline).map((clip) => {
        const result = rehydration.results.find((r) => r.clipId === clip.id)?.result;
        return {
          clipId: clip.id,
          archiveAssetId: clip.source.archiveAssetId ?? null,
          provider: clip.source.provider,
          providerAssetId: clip.source.providerAssetId ?? null,
          resolved: rehydration.byClipId.has(clip.id),
          fromArchive: result?.status === "ok" && result.provenance.includes("archive"),
          isPlaceholder: false,
        };
      }),
      delivered: {
        exists: check.fileExists,
        readable: check.sizeBytes > 0,
        durationSec: check.durationSec,
        hasVideoStream: check.hasVideo,
        hasAudioStream: check.hasAudio,
        sizeBytes: check.sizeBytes,
      },
      voiceoverSec: null,
    });
    expect(
      gate.allow,
      gate.allow ? "" : gate.failures.map((f) => `${f.code}: ${f.detail}`).join(" | ")
    ).toBe(true);

    /* 7. and nothing, at any point in that chain, went out to a provider. */
    expect(touched, "a provider was contacted during the render chain").toEqual([]);
  }, 180_000);

  it("MEASURED: the same timeline WITHOUT archive handles cannot render at all", async () => {
    const archive = fakeArchive();
    const timeline = timelineWith([
      {
        id: "c1",
        /** The identity the old pipeline produced: a provider, an id, and nothing of ours. */
        source: { provider: "internet_archive", providerAssetId: "youtube-r6LB5toWr5I" },
        sec: 2,
      },
    ]);
    const { deps, touched } = tripwireDeps(archive.rows);
    const rehydration = await rehydrateTimelineAssets({
      timeline,
      workDir: path.join(workDir, "assets2"),
      deps,
      failFast: true,
    });
    expect(rehydration.ok).toBe(false);
    expect(rehydration.failures[0]?.result.errorCode).toBe("ASSET_NOT_FOUND");
    /**
     * The negative half matters: without it this suite could pass because the setup made a
     * provider call impossible rather than because the archive made it unnecessary.
     */
    expect(touched, "the identity with no handle should not have reached a provider either").toEqual([]);
  }, 60_000);

  it("MEASURED: the gate refuses a clip whose archive handle is missing", async () => {
    const gate = deliveryGate({
      videoId: 10108,
      route: "cinematic_timeline",
      cinematicRefusal: null,
      timelineExists: true,
      clips: [
        {
          clipId: "c1",
          archiveAssetId: null,
          provider: "internet_archive",
          providerAssetId: "youtube-r6LB5toWr5I",
          resolved: true,
          fromArchive: false,
          isPlaceholder: false,
        },
      ],
      delivered: {
        exists: true, readable: true, durationSec: 4,
        hasVideoStream: true, hasAudioStream: false, sizeBytes: 100_000,
      },
      voiceoverSec: null,
    });
    expect(gate.allow, "a provider-only clip was allowed into a delivery").toBe(false);
    if (gate.allow) return;
    expect(gate.failures.map((f) => f.code)).toContain("CLIP_WITHOUT_ARCHIVE_ASSET");
  });
});
