/**
 * THE NARRATION IS AN OBJECT KEY, AND THE RENDER WORKER ASKS FOR IT AS ONE — RONDE 648.
 *
 * Render 604, job 23 (2026-09-24 11:00):
 *
 *   [Voice] video=604 narration on the timeline duration=81.11s source=measured_file words=0
 *   [RenderJob] job=23 audio clip voice_c3ba5ecb50 could not be fetched
 *   [RenderJob] job=23 not carried: audio voice_c3ba5ecb50: could not be recovered
 *   [RenderJob] video=604 job=23 DELIVERED_BY=cinematic_timeline duration=81.10s
 *
 * RONDE 647 put the narration on the timeline; the render worker then could not read it. On S3,
 * `storagePutFromFile` returns `/manus-storage/<key>` — a relative path — and the worker's
 * downloader handed it to `fetch`. The archive's read-back had the same defect in render 594.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { join } from "path";

import { resolveArchiveObjectFetchUrl } from "./archiveAssetLoad";
import { voiceoverStorageKey } from "./renderPersistence";
import { objectStorageUrl } from "./storageBackend";
import { defaultRenderWorkerDeps } from "./renderJobWorker";

const S3_VARS = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT", "S3_REGION", "S3_KEY_PREFIX"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(S3_VARS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of S3_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("what the pipeline stores and what the worker is handed", () => {
  it("the stored narration is a relative /manus-storage/ path, which fetch cannot read", () => {
    const url = objectStorageUrl(voiceoverStorageKey(604));
    expect(url).toBe("/manus-storage/videos/604/voiceover.mp3");
    expect(() => new URL(url)).toThrow();
  });

  it("on S3 the one resolver turns that path into a signed URL for the same object", async () => {
    process.env.S3_BUCKET = "fastvid-videos";
    process.env.S3_ACCESS_KEY_ID = "test-key-id";
    process.env.S3_SECRET_ACCESS_KEY = "test-secret";
    process.env.S3_REGION = "us-east-1";
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_KEY_PREFIX;
    const signed = await resolveArchiveObjectFetchUrl({
      storageUrl: "/manus-storage/videos/604/voiceover.mp3",
      storageKey: null,
    });
    expect(signed).toMatch(/^https:\/\//);
    const u = new URL(signed!);
    expect(u.pathname).toContain("videos/604/voiceover.mp3");
    expect(u.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });
});

describe("the render worker's downloader", () => {
  it("with no object store to ask, a /manus-storage/ path is an honest false — not a thrown invalid URL", async () => {
    for (const k of S3_VARS) delete process.env[k];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r648-voice-"));
    try {
      const got = await defaultRenderWorkerDeps().download(
        "/manus-storage/videos/604/voiceover.mp3",
        path.join(dir, "voice.mp3")
      );
      expect(got).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the object key before it downloads", () => {
    const SRC = readFileSync(join(__dirname, "renderJobWorker.ts"), "utf8");
    const at = SRC.indexOf("download: async (url, destPath) => {");
    expect(at, "the worker's download dep is gone — this test needs rewriting, not deleting").toBeGreaterThan(0);
    const body = SRC.slice(at, SRC.indexOf("workRoot:", at));
    const resolve = body.indexOf('if (url.startsWith("/manus-storage/"))');
    const fetchAt = body.indexOf("downloadToFileStreaming(url");
    expect(resolve).toBeGreaterThan(0);
    expect(body).toContain("resolveArchiveObjectFetchUrl({ storageUrl: url, storageKey: null })");
    expect(resolve).toBeLessThan(fetchAt);
  });
});
