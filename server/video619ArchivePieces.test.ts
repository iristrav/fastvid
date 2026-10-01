/**
 * Video 619 — every archive video is cut into single shots of at most eleven seconds, clean
 * pieces are kept even when the clip had text somewhere, every YouTube download is archived, and
 * an archive asset carries at most two tags: the full name, then what or when.
 *
 * The split's outside world (storage, ffmpeg, the vision check, the database) is passed in, so the
 * decisions are tested here without a file ever being encoded.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  ARCHIVE_PIECE_MIN_SEC,
  isAlreadyOnePiece,
  pieceSourceUrl,
  shotPieceRanges,
  splitArchiveAssetIntoShots,
  splitEligibility,
  type PieceParent,
  type ShotPieceDeps,
  type TextVerdict,
} from "./archiveShotPieces";
import { ARCHIVE_PIECE_MAX_SEC } from "./archiveVideoSplitter";
import { archiveTagsAtMostTwo, looksLikeFullName } from "./archiveTagRule";
import { forgetYoutubeVideoDurationsForTests, isoDurationSec, youtubeVideoDurationSec } from "./youtubeVideoDuration";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

describe("Video 619 — where the pieces of a clip are", () => {
  it("the rule is eleven seconds, one shot", () => {
    expect(ARCHIVE_PIECE_MAX_SEC).toBe(11);
  });

  it("a 30-second clip with no cuts becomes three equal pieces inside the one scene", () => {
    expect(shotPieceRanges(30, [])).toEqual([
      { startSec: 0, endSec: 10 },
      { startSec: 10, endSec: 20 },
      { startSec: 20, endSec: 30 },
    ]);
  });

  it("pieces follow the cuts and stay clear of them; no piece crosses a cut", () => {
    const pieces = shotPieceRanges(30, [4, 18]);
    /** Scenes 0–4 (one piece), 4–18 (13.8s: two pieces), 18–30 (11.9s: two pieces). */
    expect(pieces).toEqual([
      { startSec: 0, endSec: 3.88 },
      { startSec: 4.12, endSec: 11 },
      { startSec: 11, endSec: 17.88 },
      { startSec: 18.12, endSec: 24.06 },
      { startSec: 24.06, endSec: 30 },
    ]);
    for (const p of pieces) {
      expect(p.endSec - p.startSec).toBeLessThanOrEqual(ARCHIVE_PIECE_MAX_SEC + 1e-9);
      for (const cut of [4, 18]) expect(p.startSec < cut && cut < p.endSec).toBe(false);
    }
  });

  it("the window of a dissolve (the span between its two edges) is too short to become a piece", () => {
    const pieces = shotPieceRanges(20, [9.4, 10.2]);
    expect(pieces.every((p) => p.endSec <= 9.4 || p.startSec >= 10.2)).toBe(true);
    expect(pieces.every((p) => p.endSec - p.startSec >= ARCHIVE_PIECE_MIN_SEC)).toBe(true);
  });

  it("a clip that already is one clean shot of at most eleven seconds is one piece — itself", () => {
    expect(isAlreadyOnePiece(8, shotPieceRanges(8, []))).toBe(true);
    expect(isAlreadyOnePiece(14, shotPieceRanges(14, []))).toBe(false);
    expect(isAlreadyOnePiece(8, shotPieceRanges(8, [4]))).toBe(false);
  });

  it("an unknown or empty length yields nothing", () => {
    expect(shotPieceRanges(0, [])).toEqual([]);
    expect(shotPieceRanges(Number.NaN, [])).toEqual([]);
  });
});

/* ═══════════════════════ the split, with fake outside world ═══════════════════════ */

const PARENT: PieceParent = {
  id: 7, archiveId: 3, mediaType: "video", title: "Kylie Jenner interview", tags: ["kylie jenner", "interview"],
  sourceNote: "youtube_cc:abc@30s", sourceUrl: "https://www.youtube.com/watch?v=abc&t=30s", sourcePlatform: "youtube_cc",
  isActive: 1, parentAssetId: null, splitIntoShotsAt: null,
};

function fakeDeps(opts: {
  parent?: Partial<PieceParent>;
  durationSec: number;
  cutsSec?: number[];
  incomplete?: string;
  verdicts?: (index: number) => TextVerdict;
}) {
  const stored: Array<{ startSec: number; endSec: number; verdict: TextVerdict }> = [];
  const marks: Array<{ id: number; deactivate: boolean }> = [];
  const extracted: Array<[number, number]> = [];
  let judged = 0;
  const deps: ShotPieceDeps = {
    getAsset: async () => ({ ...PARENT, ...opts.parent }),
    fetchAsset: async (_id, dest) => { fs.writeFileSync(dest, "x"); return true; },
    detect: async () => ({ durationSec: opts.durationSec, cutsSec: opts.cutsSec ?? [], ...(opts.incomplete ? { incomplete: opts.incomplete } : {}) }),
    extract: async (_in, out, a, b) => { extracted.push([a, b]); fs.writeFileSync(out, "piece"); },
    textVerdict: async () => (opts.verdicts ?? (() => "clean"))(judged++),
    storePiece: async (_p, _file, piece) => { stored.push({ startSec: piece.startSec, endSec: piece.endSec, verdict: piece.verdict }); return 100 + stored.length; },
    markParent: async (id, change) => { marks.push({ id, ...change }); },
    log: () => {},
  };
  return { deps, stored, marks, extracted };
}

describe("Video 619 — cutting an archive clip", () => {
  it("a 30s clip with two cuts: every clean piece is kept, the long original is no longer offered", async () => {
    const { deps, stored, marks } = fakeDeps({ durationSec: 30, cutsSec: [4, 18] });
    const out = await splitArchiveAssetIntoShots(7, deps);
    expect(out).toMatchObject({ status: "split", pieces: [101, 102, 103, 104, 105], withText: 0 });
    expect(stored.every((p) => p.endSec - p.startSec <= 11)).toBe(true);
    expect(marks).toEqual([{ id: 7, deactivate: true }]);
  });

  it("the operator's case: text in the first seconds, clean after — only the clean pieces are kept", async () => {
    const { deps, stored, marks } = fakeDeps({ durationSec: 30, cutsSec: [5], verdicts: (i) => (i === 0 ? "has_text" : "clean") });
    const out = await splitArchiveAssetIntoShots(7, deps, { allowInactive: true });
    expect(out).toMatchObject({ status: "split", withText: 1 });
    expect(stored[0]!.startSec).toBeGreaterThanOrEqual(5);
    expect(marks[0]!.deactivate).toBe(true);
  });

  it("a clip that is one clean shot of eight seconds is left exactly as it is", async () => {
    const { deps, stored, marks, extracted } = fakeDeps({ durationSec: 8 });
    expect(await splitArchiveAssetIntoShots(7, deps)).toEqual({ status: "kept_whole", durationSec: 8 });
    expect(stored).toEqual([]);
    expect(extracted).toEqual([]);
    expect(marks).toEqual([{ id: 7, deactivate: false }]);
  });

  it("one shot of eight seconds WITH text is switched off, and nothing is stored", async () => {
    const { deps, stored, marks } = fakeDeps({ durationSec: 8, verdicts: () => "has_text" });
    expect(await splitArchiveAssetIntoShots(7, deps)).toMatchObject({ status: "split", pieces: [], withText: 1 });
    expect(stored).toEqual([]);
    expect(marks).toEqual([{ id: 7, deactivate: true }]);
  });

  /**
   * VIDEO 621 — no longer stored unjudged: a shot nobody could look at stops the cut, nothing is
   * stored, and the clip is given back uncut for a later sweep. Still never written as clean.
   */
  it("an unjudged shot stops the cut: nothing is stored, the clip is given back, never written as clean", async () => {
    const { deps, stored, marks } = fakeDeps({ durationSec: 20, verdicts: () => "not_asked" });
    const released: number[] = [];
    deps.release = async (id) => void released.push(id);
    expect(await splitArchiveAssetIntoShots(7, deps)).toMatchObject({ status: "skipped" });
    expect(stored).toEqual([]);
    expect(marks).toEqual([]);
    expect(released).toEqual([7]);
  });

  it("a clip is not even claimed while its shots cannot be judged", async () => {
    const { deps, stored } = fakeDeps({ durationSec: 20 });
    let claimed = false;
    deps.claim = async () => (claimed = true);
    deps.mayJudge = async () => false;
    expect(await splitArchiveAssetIntoShots(7, deps)).toMatchObject({ status: "skipped" });
    expect(claimed).toBe(false);
    expect(stored).toEqual([]);
  });

  it("a scan that did not finish leaves the clip whole — a cut it did not see could sit inside a piece", async () => {
    const { deps, stored, marks } = fakeDeps({ durationSec: 30, incomplete: "stopped at 12s" });
    expect(await splitArchiveAssetIntoShots(7, deps)).toMatchObject({ status: "skipped" });
    expect(stored).toEqual([]);
    expect(marks).toEqual([{ id: 7, deactivate: false }]);
  });

  it("never twice, never a piece, never stock, never a still, never a clip the operator switched off", async () => {
    expect(splitEligibility({ ...PARENT, splitIntoShotsAt: new Date() })).toContain("already cut");
    expect(splitEligibility({ ...PARENT, parentAssetId: 3 })).toContain("already a piece");
    expect(splitEligibility({ ...PARENT, mixKind: "stock" })).toContain("stock");
    expect(splitEligibility({ ...PARENT, mediaType: "image" })).toContain("not a video");
    const { deps } = fakeDeps({ parent: { isActive: 0 }, durationSec: 30 });
    expect(await splitArchiveAssetIntoShots(7, deps)).toEqual({ status: "skipped", reason: "switched off in the archive" });
  });

  it("each piece is its own source to the archive's duplicate check", () => {
    const a = pieceSourceUrl(PARENT.sourceUrl, 7, { startSec: 0, endSec: 10 });
    const b = pieceSourceUrl(PARENT.sourceUrl, 7, { startSec: 10, endSec: 20 });
    expect(a).not.toBe(b);
    expect(a).toContain("#shot=0.00-10.00");
    expect(pieceSourceUrl(null, 7, { startSec: 1, endSec: 2 })).toBe("fastvid-archive:7#shot=1.00-2.00");
  });
});

describe("Video 619 — the wiring", () => {
  it("a video is cut BEFORE it is stored; the long original never enters the archive", () => {
    const ingest = read("archiveIngestion.ts");
    expect(ingest).toContain("const asShots = await ingestAsSingleShots(localPath, metadata);");
    expect(ingest).not.toContain("cutForCleanPieces");
    /** Each shot passes its own text check: a shot with text is refused, its clean neighbours kept. */
    expect(ingest).toContain('if (overlay?.decision === "REJECT") {');
  });

  it("the clip a film is made with stays the film's record, switched off", () => {
    expect(read("productionMediaArchive.ts")).toContain("{ ...metadata, usedInFilm: true }");
    expect(read("archiveIngestion.ts")).toContain("...(metadata.storeSwitchedOff ? { isActive: 0 } : {}),");
    expect(read("archiveIngestion.ts")).toContain("queueArchiveShotSplit(assetId, { allowInactive: true });");
  });

  it("every YouTube download is archived, used in the film or not", () => {
    const pipe = read("videoPipeline.ts");
    const at = pipe.indexOf('reportDownload("DOWNLOAD_SUCCESS", "cloud_service");');
    expect(pipe.slice(at, at + 300)).toContain("archiveYoutubeDownloadInBackground(outPath,");
  });

  it("the archive stored before the rule is cut in the background, only while nothing renders", () => {
    const worker = read("worker.ts");
    /** VIDEO 621 — as background LLM work, within its share of the day's budget. */
    expect(worker).toContain("runAsBackgroundLlmWork(() =>\n      startArchiveShotSplitSweep(() => workerLocalActiveJobs() === 0 && activeRenderJobCount() === 0)");
  });

  it("uploaded videos are held to the same eleven seconds", () => {
    const splitter = read("archiveVideoSplitter.ts");
    expect(splitter).toContain("options?.maxPieceSec ?? ARCHIVE_PIECE_MAX_SEC");
  });
});

describe("Video 619 — at most two tags: the full name, then what or when", () => {
  it("the operator's example", () => {
    expect(archiveTagsAtMostTwo(["kylie jenner", "interview"])).toEqual(["kylie jenner", "interview"]);
  });

  it("a dozen words from a title become the name and the kind of footage", () => {
    expect(
      archiveTagsAtMostTwo(["kardashians", "kylie jenner", "kylie", "footage", "hd", "red carpet", "met gala", "2019"])
    ).toEqual(["kylie jenner", "2019"]);
    expect(archiveTagsAtMostTwo(["Kylie Jenner", "Red Carpet", "HD video"])).toEqual(["kylie jenner", "red carpet"]);
  });

  it("a name recognised in the picture beats a tag", () => {
    expect(archiveTagsAtMostTwo(["some channel", "speech"], "", ["Barack Obama"])).toEqual(["barack obama", "speech"]);
  });

  it("a single word is never promoted to a name, and nothing is invented", () => {
    expect(archiveTagsAtMostTwo(["kardashian", "interview", "vogue"])).toEqual(["interview", "kardashian"]);
    expect(archiveTagsAtMostTwo([])).toEqual([]);
    expect(archiveTagsAtMostTwo(["footage", "hd"])).toEqual([]);
  });

  it("a word inside the name is not repeated as the second tag", () => {
    expect(archiveTagsAtMostTwo(["adolf hitler", "hitler", "berlin"])).toEqual(["adolf hitler", "berlin"]);
  });

  it("what counts as a full name", () => {
    expect(looksLikeFullName("kylie jenner")).toBe(true);
    expect(looksLikeFullName("red carpet")).toBe(false);
    expect(looksLikeFullName("kylie")).toBe(false);
    expect(looksLikeFullName("world war 2")).toBe(false);
  });

  it("the rule is applied on every write of an archive row", () => {
    const db = read("db.ts");
    expect(db).toContain("await db.insert(mediaArchiveAssets).values(withArchiveTagRule(data));");
    expect(db).toContain("const patch = archiveUpdateRespectingHandTags(data, rowTagsSetByHand);");
    expect(db).toContain("await db.update(mediaArchiveAssets).set(patch)");
  });
});

describe("Video 619 — a YouTube video's length, without RapidAPI", () => {
  it("reads the ISO 8601 length YouTube gives", () => {
    expect(isoDurationSec("PT4M13S")).toBe(253);
    expect(isoDurationSec("PT1H2M")).toBe(3720);
    expect(isoDurationSec(undefined)).toBe(0);
  });

  it("asks YouTube once per video, and says 0 when it cannot know", async () => {
    forgetYoutubeVideoDurationsForTests();
    let calls = 0;
    const ok = (async () => {
      calls += 1;
      return { ok: true, json: async () => ({ items: [{ contentDetails: { duration: "PT3M" } }] }) };
    }) as unknown as typeof fetch;
    expect(await youtubeVideoDurationSec("v1", { fetch: ok, apiKey: "k" })).toBe(180);
    expect(await youtubeVideoDurationSec("v1", { fetch: ok, apiKey: "k" })).toBe(180);
    expect(calls).toBe(1);
    expect(await youtubeVideoDurationSec("v2", { fetch: ok, apiKey: "" })).toBe(0);
    const down = (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    expect(await youtubeVideoDurationSec("v3", { fetch: down, apiKey: "k" })).toBe(0);
  });

});
