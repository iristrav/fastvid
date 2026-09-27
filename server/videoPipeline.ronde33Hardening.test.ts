import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

// RONDE 33 — the five remaining limitations the Ronde-32 review left open.
//
// 1 Wikimedia rescue had no exclusion state, so several rescue slots could all end up with the
//   same Commons file (and, because the output filename carried no slot, overwrite each other).
// 2 markCuratedAssetUsed was never given a storageUrl by any caller, so usedStorageUrls stayed
//   empty everywhere and two asset rows pointing at one storage file were both selectable.
// 3 Beat mapping leaned on clipBeatIndices alone; without it every beat looked uncovered.
// 4 ffmpeg wrote straight to scene_N_composed.mp4, so an abandoned attempt could truncate — or
//   race — the file another attempt had finished.
// 5 Every clip was probed twice per compose (montageClipPassesComposeGate + requireValidClip),
//   and the rescue retry repeated the whole set for the survivors it now keeps.

const REPO_PIPELINE = path.join(__dirname, "videoPipeline.ts");
const src = () => fs.readFileSync(REPO_PIPELINE, "utf8");

function writeTestVideo(filePath: string, durationSec: number): void {
  execFileSync(
    "ffmpeg",
    [
      "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=25",
      "-t", durationSec.toFixed(3),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an",
      filePath,
    ],
    { stdio: "ignore" }
  );
}

function writeTestJpeg(filePath: string): void {
  execFileSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "color=c=gray:s=640x480", "-frames:v", "1", filePath],
    { stdio: "ignore" }
  );
}

describe("RONDE 33 #1 — Wikimedia rescue dedup is batch-scoped", () => {
  let dir: string;
  const URL_A = "https://upload.wikimedia.org/a/Aaa.jpg";
  const URL_B = "https://upload.wikimedia.org/b/Bbb.jpg";
  const URL_C = "https://upload.wikimedia.org/c/Ccc.jpg";

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r33-wiki-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
    vi.doUnmock("./sceneCandidateCache");
    vi.doUnmock("./mediaCache");
  });

  async function loadWithMocks() {
    vi.resetModules();
    vi.doMock("./sceneCandidateCache", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./sceneCandidateCache")>();
      return {
        ...actual,
        getCandidatePool: vi.fn(async () =>
          [URL_A, URL_B, URL_C].map((url, i) => ({
            assetId: `File:Test${i}.jpg`,
            title: `File:Test${i}.jpg`,
            url,
            thumbnailUrl: null,
            contentType: "image/jpeg",
            durationSec: null,
            meta: {},
          }))
        ),
        putCandidatePool: vi.fn(async () => {}),
      };
    });
    vi.doMock("./mediaCache", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./mediaCache")>();
      return {
        ...actual,
        // Stand in for the download: put a real JPEG where the fetch would have put one, so the
        // rest of the function (stillImageToVideo, the size check) runs for real.
        tryRestoreFromMediaCache: vi.fn(async (_url: string, dest: string) => {
          writeTestJpeg(dest);
          return true;
        }),
        reportToMediaCache: vi.fn(() => {}),
      };
    });
    return import("./videoPipeline");
  }

  it("three slots in one batch get three different Commons files", async () => {
    const { fetchWikimediaImages } = await loadWithMocks();
    const batch = new Set<string>();
    const picked: string[] = [];

    for (let slot = 0; slot < 3; slot++) {
      const clips = await fetchWikimediaImages(
        "adolf hitler bunker", 3, dir, 0, 1, `guaranteed_wiki_s${slot}`, { excludeUrls: batch }
      );
      expect(clips).toHaveLength(1);
      picked.push(clips[0]!);
    }

    // The URLs, not the filenames, are what dedup is keyed on.
    expect([...batch]).toEqual([URL_A, URL_B, URL_C]);
    // And each slot wrote its own file — before the slot went into the file tag, slot 1 would
    // have overwritten slot 0's output at the same path.
    expect(new Set(picked).size).toBe(3);
    for (const p of picked) expect(fs.existsSync(p)).toBe(true);
  }, 180_000);

  it("a second scene's rescue batch may reuse the same file (batch-scoped, not render-wide)", async () => {
    const { fetchWikimediaImages } = await loadWithMocks();
    const batchScene1 = new Set<string>();
    const batchScene2 = new Set<string>();

    const first = await fetchWikimediaImages(
      "q", 3, dir, 1, 1, "guaranteed_wiki_s0", { excludeUrls: batchScene1 }
    );
    const second = await fetchWikimediaImages(
      "q", 3, dir, 2, 1, "guaranteed_wiki_s0", { excludeUrls: batchScene2 }
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // Same Commons file, deliberately: a render-wide exclusion would starve the rescue.
    expect([...batchScene1]).toEqual([URL_A]);
    expect([...batchScene2]).toEqual([URL_A]);
  }, 180_000);

  it("without excludeUrls the function behaves exactly as before", async () => {
    const { fetchWikimediaImages } = await loadWithMocks();
    const a = await fetchWikimediaImages("q", 3, dir, 3, 1, "plain");
    const b = await fetchWikimediaImages("q", 3, dir, 3, 1, "plain");
    expect(a).toHaveLength(1);
    // No exclusion state -> the same top candidate every time, same output path.
    expect(b).toEqual(a);
  }, 180_000);
});

describe("RONDE 33 #2 — curated rescue marks the storage URL, not just the asset id", () => {
  let dir: string;
  const SHARED_URL = "/local-storage/foo.mp4";
  let clipA: string;
  let clipB: string;
  let clipC: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r33-storage-"));
    clipA = path.join(dir, "scene_0_b0_curated_a55988.mp4");
    clipB = path.join(dir, "scene_0_b0_curated_a55989.mp4");
    clipC = path.join(dir, "scene_0_b0_curated_a55990.mp4");
    for (const p of [clipA, clipB, clipC]) writeTestVideo(p, 3);
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
    vi.doUnmock("./curatedMediaSourcing");
  });

  it("a second row sharing one storage file is not adopted into the same rescue batch", async () => {
    vi.resetModules();
    // Assets A and B share a storage file; C is distinct. The mock mirrors the real ranker:
    // it filters on BOTH sets and reports the winner through pickedOut.
    const assets = [
      { id: 55988, storageUrl: SHARED_URL, clip: clipA },
      { id: 55989, storageUrl: SHARED_URL, clip: clipB },
      { id: 55990, storageUrl: "/local-storage/bar.mp4", clip: clipC },
    ];
    vi.doMock("./curatedMediaSourcing", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./curatedMediaSourcing")>();
      return {
        ...actual,
        fetchCuratedArchiveBeatClip: vi.fn(async (
          _beat: unknown, _scene: unknown, _workDir: string, _sceneIndex: number, _holdSec: number,
          usedAssetIds: Set<number>, usedStorageUrls: Set<string>,
          _title?: string, _ib?: unknown, _imb?: unknown, _mgb?: unknown,
          options?: { pickedOut?: { assetId?: number; storageUrl?: string } }
        ) => {
          const hit = assets.find(
            (a) => !usedAssetIds.has(a.id) && !usedStorageUrls.has(a.storageUrl)
          );
          if (!hit) return null;
          if (options?.pickedOut) {
            options.pickedOut.assetId = hit.id;
            options.pickedOut.storageUrl = hit.storageUrl;
          }
          return hit.clip;
        }),
      };
    });

    const { generateGuaranteedBeatClip } = await import("./videoPipeline");
    const usedAssetIds = new Set<number>();
    const usedStorageUrls = new Set<string>();

    const slot0 = await generateGuaranteedBeatClip(
      0, 0, 3, dir, "the bunker in Berlin in 1945", usedAssetIds, usedStorageUrls
    );
    expect(slot0).toBe(clipA);
    expect(usedAssetIds.has(55988)).toBe(true);
    // The point of this round: the storage URL is marked too.
    expect(usedStorageUrls.has(SHARED_URL)).toBe(true);

    const slot1 = await generateGuaranteedBeatClip(
      0, 1, 3, dir, "the bunker in Berlin in 1945", usedAssetIds, usedStorageUrls
    );
    // 55989 was skipped because it points at the same storage file as 55988.
    expect(slot1).toBe(clipC);
    expect(usedAssetIds.has(55989)).toBe(false);
    expect(usedAssetIds.has(55990)).toBe(true);
  }, 120_000);

  it("the storage URL comes from the picked asset, never from the filename", () => {
    const s = src();
    expect(s).toContain("markCuratedAssetUsed(topicalClip, excludeAssetIds, excludeStorageUrls, pickedOut.storageUrl)");
    expect(s).toContain("{ relaxed: true, pickedOut }");
  });
});

describe("RONDE 33 #5 — repeated clip probes are memoised, never stale", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r33-probe-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the same verdict on repeat and re-probes when the file changes", async () => {
    const { probeVideoStreamMeta, isValidVideoFile } = await import("./videoPipeline");
    const clip = path.join(dir, "clip.mp4");
    writeTestVideo(clip, 4);

    const first = await probeVideoStreamMeta(clip);
    const second = await probeVideoStreamMeta(clip);
    expect(first?.durationSec).toBeGreaterThan(3.5);
    expect(second?.durationSec).toBe(first?.durationSec);
    expect(await isValidVideoFile(clip)).toBe(true);
    expect(await isValidVideoFile(clip)).toBe(true);

    // Same path, different content: the memo key carries size + mtime, so a rewritten file must
    // be probed again rather than answered from the previous verdict.
    writeTestVideo(clip, 8);
    const afterRewrite = await probeVideoStreamMeta(clip);
    expect(afterRewrite?.durationSec).toBeGreaterThan(7.5);
  }, 120_000);

  it("a missing or unreadable file is never answered from the memo", async () => {
    const { probeVideoStreamMeta, isValidVideoFile } = await import("./videoPipeline");
    const clip = path.join(dir, "gone.mp4");
    writeTestVideo(clip, 3);
    expect(await isValidVideoFile(clip)).toBe(true);

    fs.unlinkSync(clip);
    expect(await isValidVideoFile(clip)).toBe(false);
    expect(await probeVideoStreamMeta(clip)).toBeNull();

    // Garbage at the same path decodes to nothing, memo or not.
    fs.writeFileSync(clip, Buffer.alloc(8192, 0x41));
    expect(await isValidVideoFile(clip)).toBe(false);
  }, 120_000);
});
