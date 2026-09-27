import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { markCuratedAssetUsed } from "./curatedMediaSourcing";

// RONDE 34 — the limitations the Ronde-32/33 audits left standing.
//
// Deliberately behavioural wherever the code can be reached without a database, an LLM or a TTS
// provider. Real ffmpeg/ffprobe is used only where the property under test is about actual media
// (the last-resort compose, the probe memo); those cases run sequentially inside one test to keep
// parallel encoder contention out of the result.

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

describe("RONDE 34 #1 — every curated adoption marks the storage URL, not only the id", () => {
  it("resolves the URL from the asset row this render already loaded, never from the path", async () => {
    const { curatedStorageUrlForClip } = await import("./videoPipeline");
    const dedup = {
      curatedStorageUrlById: new Map<number, string>(),
      archiveCandidatePool: [
        { asset: { id: 55988, storageUrl: "https://cdn/foo.mp4" } },
      ],
      archiveAssetsCache: new Map([[7, [{ id: 55990, storageUrl: "https://cdn/bar.mp4" }]]]),
    } as never as Parameters<typeof curatedStorageUrlForClip>[1];

    expect(curatedStorageUrlForClip("/w/scene_0_b0_curated_a55988.mp4", dedup)).toBe("https://cdn/foo.mp4");
    // Not in the pool, but in the per-video asset cache — same answer, no DB call.
    expect(curatedStorageUrlForClip("/w/scene_0_b1_curated_a55990.mp4", dedup)).toBe("https://cdn/bar.mp4");
    // Known nowhere: undefined, so the caller marks the id alone. Never a filename stand-in.
    expect(curatedStorageUrlForClip("/w/scene_0_b2_curated_a99999.mp4", dedup)).toBeUndefined();
    // Not a curated clip at all.
    expect(curatedStorageUrlForClip("/w/scene_0_b3_pool_pexels_1.mp4", dedup)).toBeUndefined();
  });

  it("memoises both hits and misses so repeated adoptions do not rescan the caches", async () => {
    const { curatedStorageUrlForClip } = await import("./videoPipeline");
    const memo = new Map<number, string>();
    const dedup = {
      curatedStorageUrlById: memo,
      archiveCandidatePool: [{ asset: { id: 1, storageUrl: "https://cdn/a.mp4" } }],
      archiveAssetsCache: new Map(),
    } as never as Parameters<typeof curatedStorageUrlForClip>[1];

    expect(curatedStorageUrlForClip("/w/x_curated_a1.mp4", dedup)).toBe("https://cdn/a.mp4");
    expect(curatedStorageUrlForClip("/w/x_curated_a2.mp4", dedup)).toBeUndefined();
    expect(memo.get(1)).toBe("https://cdn/a.mp4");
    expect(memo.get(2)).toBe(""); // negative result, remembered as "looked, not found"
    // A later hit must still answer undefined, not "".
    expect(curatedStorageUrlForClip("/w/x_curated_a2.mp4", dedup)).toBeUndefined();
  });

  it("the four dedup outcomes hold once the URL is actually marked", () => {
    const ids = new Set<number>();
    const urls = new Set<string>();

    markCuratedAssetUsed("/w/a_curated_a55988.mp4", ids, urls, "https://cdn/shared.mp4");
    expect(ids.has(55988)).toBe(true);
    expect(urls.has("https://cdn/shared.mp4")).toBe(true);

    // same assetId -> reject
    expect(ids.has(55988)).toBe(true);
    // different assetId + same storageUrl -> reject (this is what Ronde 33 left open outside
    // the rescue batch, and what point 1 closes for the remaining eight call sites)
    expect(urls.has("https://cdn/shared.mp4")).toBe(true);
    expect(ids.has(55989)).toBe(false);
    // different storageUrl -> allowed
    expect(urls.has("https://cdn/other.mp4")).toBe(false);
  });

  it("a caller with no URL available still marks the id, exactly as before", () => {
    const ids = new Set<number>();
    const urls = new Set<string>();
    markCuratedAssetUsed("/w/a_curated_a42.mp4", ids, urls, undefined);
    expect(ids.has(42)).toBe(true);
    expect(urls.size).toBe(0);
  });

  it("no call site marks the id without also offering the resolved URL", () => {
    const s = src();
    const bare = s.match(
      /markCuratedAssetUsed\((?:clipPath|extra), dedup\.usedCuratedAssetIds, dedup\.usedCuratedStorageUrls\)/g
    ) ?? [];
    expect(bare).toHaveLength(0);
    const wired = s.match(/curatedStorageUrlForClip\((?:clipPath|extra), dedup\)/g) ?? [];
    /** One — the others were in the deleted curated-only montage, adopter, strict refill, coverage and backfill routes. */
    expect(wired.length).toBe(1);
  });
});

describe("RONDE 34 #3 — Wikimedia candidate budget adapts to the exclusions", () => {
  let dir: string;
  const URLS = ["u0", "u1", "u2", "u3", "u4"].map((u) => `https://upload.wikimedia.org/${u}.jpg`);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r34-wiki-"));
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
          URLS.map((url, i) => ({
            assetId: `File:T${i}.jpg`,
            title: `File:T${i}.jpg`,
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
        tryRestoreFromMediaCache: vi.fn(async (_url: string, dest: string) => {
          writeTestJpeg(dest);
          return true;
        }),
        reportToMediaCache: vi.fn(() => {}),
      };
    });
    return import("./videoPipeline");
  }

  it("four slots draw four distinct candidates when four are available", async () => {
    const { fetchWikimediaImages } = await loadWithMocks();
    const batch = new Set<string>();
    for (let slot = 0; slot < 4; slot++) {
      const clips = await fetchWikimediaImages("q", 3, dir, 0, 1, `g_s${slot}`, { excludeUrls: batch });
      expect(clips).toHaveLength(1);
    }
    expect([...batch]).toEqual(URLS.slice(0, 4));
  }, 180_000);

  it("exhausted candidates yield nothing rather than a repeat", async () => {
    const { fetchWikimediaImages } = await loadWithMocks();
    const batch = new Set<string>(URLS); // everything already taken
    const clips = await fetchWikimediaImages("q", 3, dir, 1, 1, "g_s9", { excludeUrls: batch });
    expect(clips).toEqual([]);
    expect(batch.size).toBe(URLS.length);
  }, 180_000);

  it("the scan is hard-bounded and only widens when exclusions are in play", () => {
    const s = src();
    expect(s).toContain("const WIKIMEDIA_MAX_CANDIDATE_SCAN = 25;");
    // One request either way — the deeper set is asked for in the same call, not paginated.
    expect(s).toContain("const searchLimit = excludeUrls ? WIKIMEDIA_MAX_CANDIDATE_SCAN : 10;");
    expect(s).toMatch(/excludeUrls\s*\n?\s*\? allTitles\.slice\(0, WIKIMEDIA_MAX_CANDIDATE_SCAN\)\s*\n?\s*: allTitles\.slice\(0, count \* 2\)/);
    // No loop that could keep fetching.
    expect(s).not.toMatch(/while\s*\([^)]*excludeUrls/);
  });
});

describe("RONDE 34 #5, #6, #10 — last-resort phase, survivor scan, probe identity", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r34-misc-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("#10 a file replaced at the same path with the same size and mtime is re-probed", async () => {
    const { probeVideoStreamMeta, isValidVideoFile } = await import("./videoPipeline");
    const clip = path.join(dir, "identity.mp4");

    // Two real clips of different length, padded to the exact same byte size.
    const shortSrc = path.join(dir, "identity_src_short.mp4");
    const longSrc = path.join(dir, "identity_src_long.mp4");
    writeTestVideo(shortSrc, 3);
    writeTestVideo(longSrc, 9);
    const shortBuf = fs.readFileSync(shortSrc);
    const longBuf = fs.readFileSync(longSrc);
    const size = Math.max(shortBuf.length, longBuf.length);
    const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(size - b.length)]);

    // Both writes get the SAME explicitly stamped mtime. utimesSync only carries millisecond
    // precision, so stamping both sides is what makes the collision exact rather than
    // approximate — under the Ronde-33 key (path + size + mtime) these two files were literally
    // the same cache entry.
    const stamp = new Date(1_700_000_000_000);
    fs.writeFileSync(clip, pad(shortBuf));
    fs.utimesSync(clip, stamp, stamp);
    const stampA = fs.statSync(clip);
    const first = await probeVideoStreamMeta(clip);
    expect(first?.durationSec).toBeGreaterThan(2.5);
    expect(first?.durationSec).toBeLessThan(4);
    expect(await isValidVideoFile(clip)).toBe(true);

    // Unlink + recreate: same path, same byte size, and the mtime forced back to the original.
    // Under the Ronde-33 key (path + size + mtime) this was indistinguishable from the old file;
    // the inode makes it a different file, which is the whole point of point 10.
    fs.unlinkSync(clip);
    fs.writeFileSync(clip, pad(longBuf));
    fs.utimesSync(clip, stamp, stamp);
    const stampB = fs.statSync(clip);
    expect(stampB.size).toBe(stampA.size);
    expect(stampB.mtimeMs).toBe(stampA.mtimeMs);
    // The inode is NOT a reliable discriminator: this filesystem hands the just-freed inode
    // straight back, which is exactly why the memo key cannot rest on dev+ino alone.
    // ctime is stamped on creation and cannot be moved back from userspace.
    expect(stampB.ctimeMs).toBeGreaterThan(stampA.ctimeMs);

    const second = await probeVideoStreamMeta(clip);
    expect(second?.durationSec).toBeGreaterThan(8);
  }, 180_000);

  it("#10 an unchanged file is still answered from the memo, and a deleted one is not", async () => {
    const { probeVideoStreamMeta, isValidVideoFile } = await import("./videoPipeline");
    const clip = path.join(dir, "stable.mp4");
    writeTestVideo(clip, 4);
    const a = await probeVideoStreamMeta(clip);
    const b = await probeVideoStreamMeta(clip);
    expect(b).toEqual(a);
    expect(await isValidVideoFile(clip)).toBe(true);

    fs.unlinkSync(clip);
    expect(await probeVideoStreamMeta(clip)).toBeNull();
    expect(await isValidVideoFile(clip)).toBe(false);
  }, 180_000);

  it("#10 the memo key carries device, inode and ctime, not just name, size and mtime", () => {
    expect(src()).toContain("return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${filePath}`;");
  });
});
