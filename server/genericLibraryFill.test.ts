/**
 * VIDEO 656 — the generic library fills itself from Pexels and Pixabay (`genericLibraryFill`).
 *
 * The rung above the colour field held nothing in 655. These tests pin what may go in (neutral,
 * landscape, HD, one moving shot of at least 6 s, tag `generic` only), where it goes (the
 * Generieke beelden archive, active, marked stock, never offered as a sentence's own footage), and
 * when (idle, a few per round, until the target is reached). The ingestion runs for real on a real
 * clip; the database and storage are faked at their module boundary, as in everyShotIsInOurArchive.
 */
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMediaArchiveAssetMock = vi.fn();
const findBySourceUrlHashMock = vi.fn();
const ensureStockMediaArchiveMock = vi.fn();
const ensureAutoMediaArchiveMock = vi.fn();
const storagePutMock = vi.fn();

vi.mock("./db", () => ({
  createMediaArchiveAsset: (...a: unknown[]) => createMediaArchiveAssetMock(...a),
  findMediaArchiveAssetBySourceUrlHash: (...a: unknown[]) => findBySourceUrlHashMock(...a),
  ensureStockMediaArchive: (...a: unknown[]) => ensureStockMediaArchiveMock(...a),
  ensureAutoMediaArchive: (...a: unknown[]) => ensureAutoMediaArchiveMock(...a),
}));
vi.mock("./storage", () => ({ storagePut: (...a: unknown[]) => storagePutMock(...a) }));
vi.mock("./archiveEmbeddingIndex", () => ({ indexArchiveAssetEmbedding: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./visualSearchMemory", () => ({ recordVisualSearchMemory: vi.fn().mockResolvedValue(undefined) }));

import { ingestExternalClipToArchiveWithReason } from "./archiveIngestion";
import {
  GENERIC_LIBRARY_TARGET,
  GENERIC_MIN_SHOT_SEC,
  GENERIC_PER_ROUND,
  GENERIC_QUERIES,
  fillGenericLibraryRound,
  genericClipMetadata,
  longestShot,
  pexelsCandidates,
  pixabayCandidates,
  roundQueries,
  type GenericFillDeps,
  type GenericStockCandidate,
} from "./genericLibraryFill";

const candidate = (id: string, query = "ocean waves"): GenericStockCandidate => ({
  provider: "pexels",
  id,
  pageUrl: `https://www.pexels.com/video/${id}/`,
  downloadUrl: `https://videos.pexels.com/${id}.mp4`,
  width: 1920,
  height: 1080,
  durationSec: 15,
  query,
});

describe("1. what the searches may bring back", () => {
  it("Pexels: landscape, HD, 8–40 s, the mp4 closest to 1920 wide", () => {
    const got = pexelsCandidates(
      {
        videos: [
          { id: 1, url: "u1", duration: 15, width: 3840, height: 2160, video_files: [
            { width: 3840, height: 2160, link: "4k", file_type: "video/mp4" },
            { width: 1920, height: 1080, link: "hd", file_type: "video/mp4" },
            { width: 640, height: 360, link: "sd", file_type: "video/mp4" },
          ] },
          { id: 2, url: "u2", duration: 15, width: 1080, height: 1920, video_files: [{ width: 1080, height: 1920, link: "p" }] },
          { id: 3, url: "u3", duration: 5, width: 1920, height: 1080, video_files: [{ width: 1920, height: 1080, link: "s" }] },
          { id: 4, url: "u4", duration: 90, width: 1920, height: 1080, video_files: [{ width: 1920, height: 1080, link: "l" }] },
          { id: 5, url: "u5", duration: 12, width: 1920, height: 1080, video_files: [{ width: 640, height: 360, link: "lo" }] },
        ],
      },
      "ocean waves"
    );
    expect(got.map((c) => [c.id, c.downloadUrl])).toEqual([["1", "hd"]]);
  });

  it("Pixabay: the large file when it is HD and landscape, else the medium one", () => {
    const got = pixabayCandidates(
      {
        hits: [
          { id: 7, pageURL: "p7", duration: 20, user: "someone", videos: { large: { url: "L", width: 1920, height: 1080 }, medium: { url: "M", width: 1280, height: 720 } } },
          { id: 8, pageURL: "p8", duration: 20, videos: { large: { url: "L4k", width: 3840, height: 2160 }, medium: { url: "M8", width: 1280, height: 720 } } },
          { id: 9, pageURL: "p9", duration: 20, videos: { medium: { url: "tall", width: 720, height: 1280 } } },
        ],
      },
      "fog landscape"
    );
    expect(got.map((c) => [c.id, c.downloadUrl])).toEqual([["7", "L"], ["8", "M8"]]);
    expect(got[0]!.creator).toBe("someone");
  });

  it("the searches name no person, place, brand or year", () => {
    for (const q of GENERIC_QUERIES) {
      expect(q, q).toBe(q.toLowerCase());
      expect(q, q).not.toMatch(/\d/);
    }
    expect(new Set(roundQueries(5, 3)).size).toBe(3);
    expect(roundQueries(5, 3)).not.toEqual(roundQueries(6, 3));
  });
});

describe("2. one shot of the download", () => {
  it("the longest stretch between cuts, a quarter second clear of each, at most 11 s", () => {
    expect(longestShot(20, [3, 9])).toEqual({ startSec: 9.25, endSec: 20 });
    expect(longestShot(30, [])).toEqual({ startSec: 0, endSec: 11 });
    expect(longestShot(10, [2, 4, 6, 8])!.endSec - longestShot(10, [2, 4, 6, 8])!.startSec).toBeCloseTo(1.75, 5);
    expect(longestShot(0, [])).toBeNull();
  });
});

describe("3. the archive row: tag `generic` only, licence kept", () => {
  it("genericClipMetadata", () => {
    const m = genericClipMetadata({ ...candidate("42"), creator: "A. Maker" }, 9.5);
    expect(m.tags).toEqual(["generic"]);
    expect(m.genericArchive).toBe(true);
    expect(m.alreadyOneShot).toBe(true);
    expect(m.sourcePlatform).toBe("pexels");
    expect(m.sourceNote).toBe("pexels:42");
    expect(m.licenseNote).toContain("Pexels License");
    expect(m.licenseUrl).toBe("https://www.pexels.com/license/");
    expect(m.durationSec).toBe(9.5);
  });
});

describe("4. a round", () => {
  function deps(over: Partial<GenericFillDeps> = {}) {
    const stored: string[] = [];
    const d: GenericFillDeps = {
      providers: ["pexels"],
      isIdle: () => true,
      countLibrary: async () => 0,
      known: async () => false,
      search: async (_p, q) => Array.from({ length: 6 }, (_, i) => candidate(`${q}-${i}`, q)),
      download: async (_u, dest) => {
        fs.writeFileSync(dest, "x");
        return true;
      },
      bestShot: async (_i, out) => {
        fs.writeFileSync(out, "x");
        return { sec: 9 };
      },
      moving: async () => true,
      store: async (_f, c) => {
        stored.push(c.id);
        return { assetId: 100 + stored.length };
      },
      log: () => {},
      ...over,
    };
    return { d, stored };
  }

  it("adds at most a few per round", async () => {
    const { d, stored } = deps();
    expect(await fillGenericLibraryRound(d, 0)).toBe(GENERIC_PER_ROUND);
    expect(stored).toHaveLength(GENERIC_PER_ROUND);
  });

  it("stops at the target, and a full library costs one count and nothing else", async () => {
    const search = vi.fn(async () => [candidate("x")]);
    const { d } = deps({ countLibrary: async () => GENERIC_LIBRARY_TARGET, search });
    expect(await fillGenericLibraryRound(d, 0)).toBe(0);
    expect(search).not.toHaveBeenCalled();
    const near = deps({ countLibrary: async () => GENERIC_LIBRARY_TARGET - 1 });
    expect(await fillGenericLibraryRound(near.d, 0)).toBe(1);
  });

  it("skips what is known, what does not move, what has no long shot, and what the archive refuses", async () => {
    let n = 0;
    const { d, stored } = deps({
      known: async (_p, id) => id.endsWith("-0"),
      moving: async () => ++n !== 1,
      bestShot: async (_i, out, min) => {
        if (n === 1) return { refused: `no single shot of ${min}s` };
        fs.writeFileSync(out, "x");
        return { sec: GENERIC_MIN_SHOT_SEC + 1 };
      },
      store: async (_f, c) => (c.id.endsWith("-3") ? { assetId: null, reason: "BAKED_EDIT_TEXT" } : (stored.push(c.id), { assetId: 1 })),
    });
    const added = await fillGenericLibraryRound(d, 0);
    expect(added).toBe(stored.length);
    expect(stored.every((id) => !id.endsWith("-0") && !id.endsWith("-3"))).toBe(true);
  });

  it("never while a film renders, and not without a provider key", async () => {
    const count = vi.fn(async () => 0);
    const busy = deps({ isIdle: () => false, countLibrary: count });
    expect(await fillGenericLibraryRound(busy.d, 0)).toBe(0);
    /** not even the count: a render has the database to itself */
    expect(count).not.toHaveBeenCalled();
    const none = deps({ providers: [] });
    expect(await fillGenericLibraryRound(none.d, 0)).toBe(0);
  });
});

describe("5. the intake: stock for the generic library goes there, active, marked stock", () => {
  let dir = "";
  let clip = "";
  beforeEach(() => {
    createMediaArchiveAssetMock.mockReset().mockResolvedValue(9101);
    findBySourceUrlHashMock.mockReset().mockResolvedValue(null);
    ensureStockMediaArchiveMock.mockReset().mockResolvedValue(77);
    ensureAutoMediaArchiveMock.mockReset().mockImplementation(async (kind: string) => ({ generic: 50, youtube: 5, other: 6 })[kind] ?? null);
    storagePutMock.mockReset().mockImplementation(async (key: string) => ({ key, url: `https://cdn.example/${key}` }));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "v656-generic-"));
    clip = path.join(dir, "clip.mp4");
    execSync(`ffmpeg -y -f lavfi -i "testsrc=size=640x480:rate=25:duration=4" -c:v libx264 -pix_fmt yuv420p -b:v 1200k "${clip}" 2>/dev/null`);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("lands in the Generieke beelden archive, active, mixKind stock, tagged generic only", async () => {
    const out = await ingestExternalClipToArchiveWithReason(clip, genericClipMetadata(candidate("777"), 4));
    expect(out.status).toBe("ingested");
    const row = createMediaArchiveAssetMock.mock.calls[0]![0] as {
      archiveId: number; mixKind: string; tags: string[]; isActive: number; licenseNote: string;
    };
    expect(row.archiveId).toBe(50);
    expect(row.mixKind).toBe("stock");
    expect(row.tags).toEqual(["generic"]);
    expect(row.isActive).toBe(1);
    expect(row.licenseNote).toContain("Pexels License");
    expect(ensureStockMediaArchiveMock).not.toHaveBeenCalled();
  }, 120_000);

  it("RONDE 9 still holds: stock without either flag is refused", async () => {
    const { genericArchive: _g, ...plain } = genericClipMetadata(candidate("778"), 4);
    const out = await ingestExternalClipToArchiveWithReason(clip, plain);
    expect(out.status).toBe("refused");
    expect((out as { reasonCode: string }).reasonCode).toBe("EXEMPT_SOURCE");
  }, 120_000);

  it("the curated sourcing never reads the generic archive", () => {
    const src = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    const filters = src.match(/a\.slug !== STOCK_ARCHIVE_SLUG && a\.slug !== GENERIC_ARCHIVE_SLUG/g) ?? [];
    expect(filters).toHaveLength(2);
  });

  it("the worker starts the fill while idle", () => {
    const w = fs.readFileSync(path.join(__dirname, "worker.ts"), "utf8");
    expect(w).toContain("startGenericLibraryFill(() => workerLocalActiveJobs() === 0 && activeRenderJobCount() === 0)");
  });
});
