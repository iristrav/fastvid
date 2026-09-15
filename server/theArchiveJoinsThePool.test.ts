/**
 * THE POOL LISTED "archive" AS A SOURCE AND NOTHING EVER PRODUCED ONE.
 *
 * `PoolCandidateSource` has carried `"archive"` since the pool was written. No task pushed one, so
 * the union admitted a source the pool could not receive — a particularly quiet way for a gap to
 * survive, because every type-level search for "is the archive in the pool" answered yes.
 *
 * The consequence is the one RONDE 169 described for YouTube:
 *
 *     the CASCADE   first source that returns anything usable wins; POSITION IS THE RANKING.
 *     the POOL      gathers from every source and then chooses; quality can outrank source.
 *
 * While the archive sat outside the pool, an excellent archive clip and a poor YouTube one were
 * never compared — each won or lost on which route happened to run first, which is exactly the
 * arrangement this session spent a day proving unpredictable.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  archivePoolCandidates,
  archiveRowToPoolCandidate,
  type ArchiveRowLike,
} from "./archivePoolSource";

const row = (over: Partial<ArchiveRowLike> = {}): ArchiveRowLike => ({
  id: 57187,
  title: "Kris Jenner interview 2022",
  storageUrl: "https://cdn.example/assets/57187.mp4",
  mediaType: "video",
  tags: ["kris", "jenner"],
  durationSec: 42,
  width: 1920,
  height: 1080,
  ...over,
});

describe("1. an archive row becomes a pool candidate", () => {
  it("in the pool's own id shape, so dedup works across sources", () => {
    expect(archiveRowToPoolCandidate(row())!.id).toBe("archive:57187");
    expect(archiveRowToPoolCandidate(row())!.source).toBe("archive");
  });

  it("pointing at the stored file, which is what a downloader is handed", () => {
    expect(archiveRowToPoolCandidate(row())!.remoteUrl).toBe("https://cdn.example/assets/57187.mp4");
  });

  it("carrying what the row measured", () => {
    const c = archiveRowToPoolCandidate(row())!;
    expect(c.durationSec).toBe(42);
    expect(c.width).toBe(1920);
    expect(c.height).toBe(1080);
    expect(c.tags).toEqual(["kris", "jenner"]);
  });

  /** Tags come back as an array from one driver and a JSON string from another. */
  it("whatever shape the tags column arrives in", () => {
    expect(archiveRowToPoolCandidate(row({ tags: '["a","b"]' }))!.tags).toEqual(["a", "b"]);
    expect(archiveRowToPoolCandidate(row({ tags: "a, b" }))!.tags).toEqual(["a", "b"]);
    expect(archiveRowToPoolCandidate(row({ tags: null }))!.tags).toEqual([]);
  });
});

describe("2. what is not measured is null, never a plausible default", () => {
  /**
   * §7's rule. `rankCandidates` redistributes the weight of a signal a candidate carries no data
   * for, so a null costs nothing — while a fabricated 1920x1080 scores as "measured, and good" and
   * beats an honest candidate that said nothing.
   */
  it("an unmeasured dimension stays null", () => {
    const c = archiveRowToPoolCandidate(row({ width: null, height: null, durationSec: 0 }))!;
    expect(c.width).toBeNull();
    expect(c.height).toBeNull();
    expect(c.durationSec).toBeNull();
  });

  it("and so do the scores nobody has computed yet", () => {
    const c = archiveRowToPoolCandidate(row())!;
    expect(c.clipSimilarity).toBeNull();
    expect(c.rankingScore).toBeNull();
    expect(c.visionScore).toBeNull();
    expect(c.selectionScore).toBeNull();
  });

  /**
   * THE ONE THAT WOULD HAVE BEEN TEMPTING. YouTube's adapter passes its relevance through as
   * `embeddingSimilarity` because that IS a 0..1 overlap score. The curated scorer's number is an
   * unbounded tally on its own scale; putting it in a 0..1 slot would be a fiction that outranks
   * every real similarity in the pool.
   */
  it("the archive's own score is NOT passed off as a similarity", () => {
    const c = archiveRowToPoolCandidate(row(), { score: 47 })!;
    expect(c.embeddingSimilarity).toBeNull();
    expect(c.archive.archiveScore).toBe(47);
  });

  /** Attribution that IS in the row is mapped rather than dropped. */
  it("real attribution columns are carried", () => {
    const c = archiveRowToPoolCandidate(row({ sourceCreator: "NASA", licenseUrl: "https://x/l" }))!;
    expect(c.sourceCreator).toBe("NASA");
    expect(c.licenseUrl).toBe("https://x/l");
  });
});

describe("3. a row nothing could fetch is dropped, not patched", () => {
  it("no id", () => {
    expect(archiveRowToPoolCandidate(row({ id: 0 }))).toBeNull();
    expect(archiveRowToPoolCandidate(row({ id: NaN }))).toBeNull();
  });

  it("no file behind it", () => {
    expect(archiveRowToPoolCandidate(row({ storageUrl: null }))).toBeNull();
    expect(archiveRowToPoolCandidate(row({ storageUrl: "   " }))).toBeNull();
  });
});

describe("4. the search is injected — this is not a second archive engine", () => {
  it("it runs whatever the caller passed, and translates the rows", async () => {
    const r = await archivePoolCandidates({
      sceneIndex: 2,
      search: async () => [{ asset: row(), score: 12, archiveName: "WWII" }],
    });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.archive.archiveName).toBe("WWII");
  });

  it("the same asset twice is one candidate", async () => {
    const r = await archivePoolCandidates({
      sceneIndex: 0,
      search: async () => [{ asset: row() }, { asset: row() }],
    });
    expect(r.candidates).toHaveLength(1);
    expect(r.log).toContain("deduped=1");
  });

  it("and it honours the caller's cap", async () => {
    const r = await archivePoolCandidates({
      sceneIndex: 0,
      maxResults: 2,
      search: async () => [1, 2, 3, 4].map((id) => ({ asset: row({ id }) })),
    });
    expect(r.candidates).toHaveLength(2);
  });

  /**
   * §8 — a source that FAILED and a source that found nothing are different facts, and a log that
   * cannot tell them apart cannot answer why the archive was not used for this beat.
   */
  it("a broken archive is reported, not silently empty", async () => {
    const r = await archivePoolCandidates({
      sceneIndex: 1,
      search: async () => { throw new Error("db connection lost"); },
    });
    expect(r.candidates).toHaveLength(0);
    expect(r.log).toContain("failed=1");
    expect(r.log).toContain("db connection lost");
  });

  it("an empty archive says so differently", async () => {
    const r = await archivePoolCandidates({ sceneIndex: 1, search: async () => [] });
    expect(r.log).toContain("candidates=0");
    expect(r.log).not.toContain("failed=");
  });
});

describe("5. the pool actually asks for it", () => {
  const POOL = readFileSync(join(__dirname, "scenePool.ts"), "utf8");

  it("there is a task, in the same list as every other provider", () => {
    expect(POOL).toContain("archivePoolCandidates({");
    expect(POOL).toContain("if (req.archiveSearch && !noteSkip(\"archive\", false, true))");
  });

  /** Injected, so this module gains no database access and no opinion about a good match. */
  it("through an injected search, not a query of its own", () => {
    expect(POOL).toContain("archiveSearch?: ArchivePoolSearch");
    expect(POOL, "the pool must not import the sourcing engine").not.toContain(
      'from "./curatedMediaSourcing"'
    );
  });

  /**
   * A render with no archive search wired must not look like an archive with nothing in it. That
   * distinction is what kept this gap invisible: `"archive"` in the union read as "supported".
   */
  it("an unwired archive is recorded as unwired", () => {
    expect(POOL).toContain('skipped["archive"] = "not_wired"');
  });
});

/**
 * RONDE 245 — AND A ROUTE ACTUALLY HANDS IT OVER.
 *
 * RONDE 244 built the adapter and wired the pool to accept one; no caller supplied it, so every
 * render still recorded `skipped["archive"]="not_wired"`. That is the same shape as the gap it
 * was meant to close — a source the type system says exists and the render never receives — which
 * is why it is pinned here rather than left to the next reader to notice.
 */
describe("6. the render hands the pool its archive search", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("the funnel's pool call passes archiveSearch", () => {
    const at = PIPE.indexOf("buildSceneCandidatePool({");
    expect(at).toBeGreaterThan(0);
    expect(PIPE.slice(at, at + 1600)).toContain("archiveSearch: scenePoolArchiveSearch(");
  });

  /**
   * THE WHOLE DESIGN, in one assertion. `listCuratedArchiveCandidates` IS the curated route's
   * selection — it resolves the archives, loads assets through the render's cache and scores each
   * with `scoreCuratedAsset`. Re-deriving "which archive asset suits this sentence" here would be
   * a second source-selection engine, which is the one thing this pipeline must not grow.
   */
  it("through the existing selection, not a second one", () => {
    const at = PIPE.indexOf("function scenePoolArchiveSearch(");
    expect(at).toBeGreaterThan(0);
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).toContain("listCuratedArchiveCandidates(");
    expect(body, "no scoring of its own").not.toContain("scoreCuratedAsset(");
    expect(body, "and no database call of its own").not.toContain("getAllMediaArchives(");
  });

  /**
   * The score-1 dump exists for a beat with nothing left to try. Fed to a RANKING it would drown
   * the pool in material nobody judged relevant — and relevance deciding is the pool's entire
   * purpose. The beat route still reaches that last resort on its own.
   */
  it("and never the last-resort dump of the whole archive", () => {
    const at = PIPE.indexOf("function scenePoolArchiveSearch(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).toContain("the score-1 dump belongs to a desperate beat, never to a ranking");
  });

  /** It respects what the render has already used, like every other route reading the archive. */
  it("it honours the render's exclusions", () => {
    const at = PIPE.indexOf("function scenePoolArchiveSearch(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).toContain("dedup.usedCuratedAssetIds");
    expect(body).toContain("dedup.usedCuratedStorageUrls");
    expect(body).toContain("dedup.crossVideoExcludeIds");
  });

  /** And reuses the render's asset cache rather than re-reading the archive per scene. */
  it("and reuses the render's asset cache", () => {
    const at = PIPE.indexOf("function scenePoolArchiveSearch(");
    expect(PIPE.slice(at, PIPE.indexOf("\n}\n", at))).toContain("dedup.archiveAssetsCache");
  });
});
