/**
 * YOUTUBE LOOKS BEFORE IT SPENDS A DOWNLOAD — RONDE 602.
 *
 * ── What render 597 spent ten seconds on, twice ─────────────────────────────────────────────
 *
 *     18:07:56  DOWNLOAD_STARTED    youtube_cc:najx50IzqnU   query="Adolf Hitler Berlin"
 *     18:08:06  DOWNLOAD_SUCCEEDED
 *     18:08:14  BeatRelevance s0b2 does_not_fit
 *                 depicts="Taxidermied animals in a display setting with text about
 *                          taxidermied pigeons and a horse."
 *     18:08:38  BeatRelevance s0b3 does_not_fit   (the same file, fetched again)
 *
 * The TITLE matched "Adolf Hitler Berlin" well enough to pass the only pre-download filter the
 * cascade route had — a keyword score on title and description. Nobody looked at the PICTURE until
 * the bytes were on disk, and the beat's one download slot was gone.
 *
 * ── Why this needed no new capability ───────────────────────────────────────────────────────
 *
 * `rankCandidatesByThumbnailClip` has scored thumbnails against a beat since RONDE 103, and
 * `youtube_cc` has been a pool source WITH a thumbnail since RONDE 169. The pool route already
 * looks before it fetches. The cascade route simply never asked — the same shape of defect as the
 * two before it: the answer existed and was not carried to where the decision was made.
 *
 * ── The line this round does NOT cross ──────────────────────────────────────────────────────
 *
 * CLIP RANKS, IT DOES NOT REJECT. RONDE 103's rule, and this round keeps it: the look decides
 * which candidate is worth the slot, never whether the beat may have one. Refusing a download
 * outright would need a threshold separating "worth fetching" from "not", and no render has
 * measured that separation yet — the scores are logged here so the next one can.
 *
 * So these tests assert two things together, and the second matters as much as the first: the
 * order changes, and NOTHING IS EVER LOST.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  youtubeRowsRankedByThumbnail,
  withSceneFetchTimeout,
  remainingScopeMs,
  YOUTUBE_SEARCH_TIMEOUT_MS,
  type YoutubeSearchRow,
} from "./videoPipeline";
import { rankCandidatesByThumbnailClip } from "./scenePool";
import { youtubeRowToPoolCandidate } from "./youtubePoolSource";

const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/**
 * A search row. `thumb` is deliberately absent by default: a candidate with no thumbnail is the
 * one case the ranker can reach without a network, so every ordering claim below is measured
 * rather than mocked.
 */
const row = (videoId: string, title: string, over: Partial<YoutubeSearchRow> = {}): YoutubeSearchRow =>
  ({
    item: { id: { videoId }, snippet: { title, description: `${title} description` } },
    title,
    desc: `${title} description`,
    rel: 3,
    ...over,
  }) as YoutubeSearchRow;

const BEAT = {
  beatText: "Hitler's final hours in the Führerbunker beneath Berlin",
  beatIndex: 2,
  videoTitle: "The Last Days",
};

const ids = (rows: YoutubeSearchRow[]) => rows.map((r) => r.item.id?.videoId);

/* ═══════════ §1 — the look happens before the slot is spent ═══════════ */

describe("§1 — the download loop reads the ranked order, not the search order", () => {
  it("THE DEFECT, NAMED: the loop used to iterate the rows exactly as the search returned them", () => {
    /**
     * `items` is `searchYoutubeVideoCandidates`'s output. The loop must no longer walk it directly,
     * or the ranking is computed and then ignored — which is the defect class this codebase keeps
     * removing, arriving through a new door.
     */
    expect(PIPELINE, "the loop still walks the raw search order").not.toContain(
      "for (const row of items.slice(0, 5)) {"
    );
    expect(PIPELINE).toContain("for (const row of ordered.slice(0, 5)) {");
  });

  it("and the look is taken BEFORE the loop, not inside it", () => {
    const call = PIPELINE.indexOf("const ordered = await youtubeRowsRankedByThumbnail(");
    const loop = PIPELINE.indexOf("for (const row of ordered.slice(0, 5)) {");
    expect(call, "the ranking call is gone").toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(-1);
    expect(call, "a look taken inside the loop is a look taken after the first download").toBeLessThan(loop);
  });

  it("it reuses the mapper and the ranker that already existed", () => {
    /** A second implementation of either is the thing this round is explicitly not doing. */
    const at = PIPELINE.indexOf("export async function youtubeRowsRankedByThumbnail(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\nexport async function fetchYouTubeCCClips(", at));
    expect(body).toContain("youtubeRowToPoolCandidate(row, mode)");
    expect(body).toContain("rankCandidatesByThumbnailClip(");
    expect(body, "a second thumbnail fetcher").not.toContain("fetch(");
    expect(body, "a second CLIP embedder").not.toContain("embedImageFromPath");
  });
});

/* ═══════════ §2 — nothing is ever lost ═══════════ */

describe("§2 — a ranking pass returns every row it was given", () => {
  it("rows with no thumbnail are all still there, in their original order", async () => {
    const rows = [row("aaa", "Berlin 1945"), row("bbb", "Bunker"), row("ccc", "Eva Braun")];
    const out = await youtubeRowsRankedByThumbnail(rows, "any", BEAT, 0);
    expect(ids(out), "a row was dropped or reordered with nothing to rank on").toEqual([
      "aaa",
      "bbb",
      "ccc",
    ]);
  });

  it("a row the mapper cannot represent survives — it is not patched and not deleted", async () => {
    /** `youtubeRowToPoolCandidate` returns null without a videoId: no id, nothing to refetch. */
    const orphan = { ...row("", "no id at all"), item: { snippet: { title: "no id at all" } } } as YoutubeSearchRow;
    const rows = [row("aaa", "Berlin 1945"), orphan, row("ccc", "Eva Braun")];
    expect(youtubeRowToPoolCandidate(orphan, "any")).toBeNull();

    const out = await youtubeRowsRankedByThumbnail(rows, "any", BEAT, 0);
    expect(out, "the orphan row was lost").toHaveLength(3);
    expect(out).toContain(orphan);
  });

  it("RONDE 103 INTACT: the ranker itself still scores without filtering", async () => {
    const candidates = [
      youtubeRowToPoolCandidate(row("aaa", "one"), "any")!,
      youtubeRowToPoolCandidate(row("bbb", "two"), "any")!,
      youtubeRowToPoolCandidate(row("ccc", "three"), "any")!,
    ];
    const ranked = await rankCandidatesByThumbnailClip(
      candidates,
      BEAT.beatText,
      undefined,
      BEAT.videoTitle,
      0,
      2
    );
    expect(ranked, "a ranking pass shrank the pool").toHaveLength(candidates.length);
    expect(ranked.map((c) => c.assetId).sort()).toEqual(["aaa", "bbb", "ccc"]);
  });
});

/* ═══════════ §3 — the look cannot spend the download's budget ═══════════ */

describe("§3 — the download keeps its floor", () => {
  it("a scope with no room above the floor is not looked at, and the rows come back untouched", async () => {
    const rows = [row("aaa", "one"), row("bbb", "two")];
    await withSceneFetchTimeout(
      async () => {
        /** Well under RONDE 68's twelve-second download floor. */
        expect(remainingScopeMs()).toBeLessThan(12_000);
        const out = await youtubeRowsRankedByThumbnail(rows, "any", BEAT, 0);
        expect(ids(out)).toEqual(["aaa", "bbb"]);
      },
      4_000,
      "a window with nothing to spare"
    );
  });

  it("the skip is never silent — it says which budget refused it", async () => {
    const said: string[] = [];
    (console.log as unknown as { mockImplementation: (f: (m?: unknown) => void) => void })
      .mockImplementation((m?: unknown) => { said.push(String(m)); });
    await withSceneFetchTimeout(
      async () => { await youtubeRowsRankedByThumbnail([row("a", "1"), row("b", "2")], "any", BEAT, 0); },
      4_000,
      "a window with nothing to spare"
    );
    const line = said.find((l) => l.includes("[YouTubeThumbRank]"));
    expect(line, "a skipped step with no line is a step nobody can find").toBeDefined();
    expect(line).toContain("SKIPPED");
    expect(line).toContain("BUDGET_RESERVED_FOR_DOWNLOAD");
  });

  it("the budget is derived from constants that already governed this path", () => {
    const at = PIPELINE.indexOf("export async function youtubeRowsRankedByThumbnail(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\nexport async function fetchYouTubeCCClips(", at));
    /** The download's own floor is what is protected, and a search is the cap. No new number. */
    expect(body).toContain("remaining - YOUTUBE_MIN_DOWNLOAD_WINDOW_MS");
    expect(body).toContain("Math.min(YOUTUBE_SEARCH_TIMEOUT_MS, spare)");
    expect(YOUTUBE_SEARCH_TIMEOUT_MS).toBe(12_000);
  });

  it("outside a scope there is no deadline to protect and the look proceeds", async () => {
    expect(remainingScopeMs()).toBe(Number.POSITIVE_INFINITY);
    const rows = [row("aaa", "one"), row("bbb", "two")];
    const out = await youtubeRowsRankedByThumbnail(rows, "any", BEAT, 0);
    expect(out).toHaveLength(2);
  });
});

/* ═══════════ §4 — the cases where there is nothing to look at ═══════════ */

describe("§4 — a look with no question is not taken", () => {
  it("no beat text means nothing to compare a picture against", async () => {
    const rows = [row("aaa", "one"), row("bbb", "two")];
    expect(ids(await youtubeRowsRankedByThumbnail(rows, "any", undefined, 0))).toEqual(["aaa", "bbb"]);
    expect(
      ids(await youtubeRowsRankedByThumbnail(rows, "any", { ...BEAT, beatText: "   " }, 0))
    ).toEqual(["aaa", "bbb"]);
  });

  it("one row has no order to put it in", async () => {
    const one = [row("only", "single")];
    expect(await youtubeRowsRankedByThumbnail(one, "any", BEAT, 0)).toBe(one);
  });
});

/* ═══════════ §5 — the scores reach the log, because the next round needs them ═══════════ */

describe("§5 — the measurement a refusal threshold would have to be built on", () => {
  it("every candidate's score is logged, including the ones that got none", () => {
    const at = PIPELINE.indexOf("export async function youtubeRowsRankedByThumbnail(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\nexport async function fetchYouTubeCCClips(", at));
    expect(body).toContain("[YouTubeThumbRank]");
    expect(body).toContain('c.clipSimilarity == null ? "none" : c.clipSimilarity.toFixed(4)');
    expect(body, "the per-candidate id is what correlates a score with its lineage").toContain(
      "${c.assetId}="
    );
  });

  it("and this round did NOT add a refusal", () => {
    const at = PIPELINE.indexOf("export async function youtubeRowsRankedByThumbnail(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\nexport async function fetchYouTubeCCClips(", at));
    /**
     * A floor, a threshold or a filter here would be a gate nobody has measured. The function may
     * reorder and it may hand the rows back; it may not shorten them.
     */
    expect(body).not.toMatch(/clipSimilarity\s*[<>]/);
    expect(body).not.toContain(".filter((c) => c.clipSimilarity");
    expect(body).not.toContain("MIN_THUMBNAIL");
  });
});
