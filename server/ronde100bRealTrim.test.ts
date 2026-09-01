/**
 * RONDE 100B §5 — the manual trim, run for real.
 *
 * No mocked ffmpeg, no mocked storage. A real 20s mp4 is encoded, handed to trimArchiveAsset as a
 * genuine archive asset, cut with a real ffmpeg, written through the real storagePut (local
 * backend, since no forge/S3 credentials exist here), and probed again with a real ffprobe.
 * Only the database write is captured, because there is no database in this session.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { describe, expect, it, vi, beforeAll } from "vitest";

const hoisted = vi.hoisted(() => {
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "r100-uploads-"));
  // storageLocal resolves LOCAL_UPLOADS_DIR at module load, and ESM imports are hoisted above
  // ordinary statements — so this has to be set from inside the hoisted block.
  process.env.UPLOADS_DIR = dir;
  return { UPLOADS: dir, dbWrites: [] as Array<{ id: number; patch: Record<string, unknown> }> };
});

vi.mock("./db", () => ({
  updateMediaArchiveAsset: async (id: number, patch: Record<string, unknown>) => {
    hoisted.dbWrites.push({ id, patch });
    return true;
  },
}));

import { trimArchiveAsset, validateTrimRange } from "./archiveTrimToScene";
import { probeVideoDurationSec } from "./archiveVideoSplitter";
import { resolveLocalStorageFilePath } from "./storageLocal";

const SRC_KEY = "archive/r100-source.mp4";
let sourcePath = "";

beforeAll(() => {
  sourcePath = path.join(hoisted.UPLOADS, SRC_KEY.replace(/\//g, "_"));
  // 20 seconds, visible counter so a wrong offset is obvious, keyframe every second.
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=25:duration=20 ` +
      `-c:v libx264 -g 25 -pix_fmt yuv420p "${sourcePath}" 2>/dev/null`
  );
});

function asset() {
  return {
    id: 90100,
    archiveId: 1,
    title: "R100 trim source",
    mediaType: "video" as const,
    mimeType: "video/mp4",
    storageUrl: `/local-storage/${SRC_KEY.replace(/\//g, "_")}`,
    storageKey: SRC_KEY,
    durationSec: 20,
  };
}

describe("RONDE 100B §5 — trimArchiveAsset against a real file", () => {
  it("source fixture is a real 20s video", async () => {
    expect(fs.existsSync(sourcePath)).toBe(true);
    const dur = await probeVideoDurationSec(sourcePath);
    console.log(`[R100] source duration = ${dur.toFixed(2)}s, ${fs.statSync(sourcePath).size} bytes`);
    expect(dur).toBeGreaterThan(19.5);
  });

  it("cuts a middle range 6.0s–14.5s and keeps exactly that", async () => {
    hoisted.dbWrites.length = 0;
    const result = await trimArchiveAsset(asset() as never, { startSec: 6, endSec: 14.5 });
    console.log(`[R100] result = ${JSON.stringify(result)}`);
    console.log(`[R100] db write = ${JSON.stringify(hoisted.dbWrites)}`);

    expect(result.startSec).toBe(6);
    expect(result.endSec).toBe(14.5);
    // 3. new duration is the requested 8.5s
    expect(result.newDurationSec).toBeGreaterThan(8.3);
    expect(result.newDurationSec).toBeLessThan(8.7);

    // 5. a real new file exists on disk
    const onDisk = resolveLocalStorageFilePath({ storageUrl: result.storageUrl, storageKey: result.storageKey });
    expect(onDisk, "trimmed file not found on disk").toBeTruthy();
    const realDur = await probeVideoDurationSec(onDisk!);
    console.log(`[R100] file on disk = ${onDisk} (${fs.statSync(onDisk!).size} bytes, ${realDur.toFixed(2)}s)`);
    expect(realDur).toBeGreaterThan(8.3);

    // 6. BOTH columns point at the new file — this is the RONDE 98 bug
    expect(hoisted.dbWrites).toHaveLength(1);
    const patch = hoisted.dbWrites[0]!.patch;
    expect(patch.storageKey).toBe(result.storageKey);
    expect(patch.storageUrl).toBe(result.storageUrl);
    expect(patch.storageKey).not.toBe(SRC_KEY);
    expect(Number(patch.durationSec)).toBeGreaterThan(8);

    // the source is untouched — the trim is not destructive to the original bytes
    expect(await probeVideoDurationSec(sourcePath)).toBeGreaterThan(19.5);
  }, 120_000);

  it("8. the trimmed asset is still loadable as an archive asset afterwards", async () => {
    const patch = hoisted.dbWrites[0]!.patch as { storageUrl: string; storageKey: string };
    const trimmedAsset = { ...asset(), storageUrl: patch.storageUrl, storageKey: patch.storageKey };
    const resolved = resolveLocalStorageFilePath(trimmedAsset);
    expect(resolved, "renderer cannot resolve the trimmed asset").toBeTruthy();
    const dur = await probeVideoDurationSec(resolved!);
    console.log(`[R100] post-trim asset resolves to ${resolved} (${dur.toFixed(2)}s)`);
    expect(dur).toBeLessThan(9);
  }, 60_000);

  it("refuses the ranges an operator gets wrong", () => {
    expect(validateTrimRange({ startSec: 5, endSec: 3 }, 20).ok).toBe(false);
    expect(validateTrimRange({ startSec: 5, endSec: 5.2 }, 20).ok).toBe(false);
    expect(validateTrimRange({ startSec: 25 }, 20).ok).toBe(false);
    expect(validateTrimRange({ startSec: 0, endSec: 20 }, 20).ok).toBe(false);
    expect(validateTrimRange({ startSec: 6, endSec: 14.5 }, 20).ok).toBe(true);
  });
});
