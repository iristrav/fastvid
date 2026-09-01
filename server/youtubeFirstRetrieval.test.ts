/**
 * MASTER YOUTUBE BUILD — YouTube is searched, not merely consulted.
 *
 * ── The defect this file pins ────────────────────────────────────────────────────────────────
 *
 * `buildSceneCandidatePool` hands every provider the beat's whole `queries` array:
 *
 *     searchPexelsCandidates(queries, …)
 *     searchWikimediaCandidates(queries, …)
 *     searchInternetArchiveCandidates(queries, …)
 *
 * and handed YouTube `queries[0]`.
 *
 * So a beat with four good search angles — the event, the person, the place, the period — asked
 * YouTube about one of them, took whatever that single phrasing returned, and then ran the
 * thirteen-signal ranking engine over it. The ranking can only choose from what retrieval brought
 * back, so on a one-phrasing pool it was decorative: it ranked five results from one query and
 * called the best of them the winner.
 *
 * That is the difference between YouTube being A SOURCE and YouTube being A SOURCE WE SEARCH, and
 * it is invisible in every existing test, because they all pass a single query and assert that it
 * was used.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────────────────────
 *
 * No new query engine. The queries come from the pool's existing `primaryQuery + extraQueries`,
 * built by the callers that already build them, and the adapter only decides how many of them to
 * spend quota on. `generateDeterministicQueries` remains the place typed queries are produced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";

import { buildSceneCandidatePool } from "./scenePool";
import {
  MAX_YOUTUBE_QUERIES_PER_BEAT,
  youtubePoolCandidates,
  type YoutubeRowLike,
} from "./youtubePoolSource";

const POOL_SRC = fs.readFileSync("server/scenePool.ts", "utf8");
const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.SEARCH_GATE_STRICT = "false";
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL)) delete process.env[k];
  Object.assign(process.env, ORIGINAL);
});

function row(videoId: string, title = `title ${videoId}`): YoutubeRowLike {
  return {
    item: {
      id: { videoId },
      snippet: { title, description: "d", channelTitle: "c", publishedAt: "1946-01-01T00:00:00Z" },
    },
    title,
    desc: "d",
    rel: 0.8,
  };
}

/** A pool request with every network-backed source off except the injected YouTube. */
function poolRequest(youtubeSearch: unknown, extra: Record<string, unknown> = {}) {
  return {
    sceneIndex: 0,
    sceneText: "Berlin in the winter of 1945.",
    primaryQuery: "berlin 1945",
    skipPexels: true, skipPixabay: true, skipInternetArchive: true, skipEuropeana: true,
    skipOpenverse: true, skipNasa: true, skipNara: true, skipLoc: true,
    youtubeSearch,
    ...extra,
  } as never;
}

/* ═══════════════════════ the pool asks every query, not the first ═══════════════════════ */

describe("YOUTUBE-FIRST — a beat's whole query list reaches YouTube", () => {
  /**
   * The regression itself. Four queries in, four searches out — and the assertion is on the
   * QUERIES ASKED, not on the candidate count, because a source can return plenty from one
   * phrasing and still have been asked only one question.
   */
  it("issues one search per query the beat supplies", async () => {
    const search = vi.fn(async (q: string) => [row(`v-${q.replace(/\s/g, "")}`)]);
    await buildSceneCandidatePool(
      poolRequest(search, { extraQueries: ["berlin ruins", "brandenburg gate 1945", "red army berlin"] })
    );
    expect(search.mock.calls.map((c) => c[0]).sort()).toEqual([
      "berlin 1945",
      "berlin ruins",
      "brandenburg gate 1945",
      "red army berlin",
    ]);
  }, 30_000);

  /** And their results all land in the pool, so the ranking has something to choose between. */
  it("merges the results of every query into one pool", async () => {
    const search = vi.fn(async (q: string) => [row(`v-${q.replace(/\s/g, "")}`)]);
    const pool = await buildSceneCandidatePool(
      poolRequest(search, { extraQueries: ["berlin ruins", "red army berlin"] })
    );
    const yt = pool.candidates.filter((c) => c.source === "youtube_cc");
    expect(yt.length, "the pool kept only one query's results").toBeGreaterThanOrEqual(3);
  }, 30_000);

  /**
   * Structural, and aimed at the shape of the original bug rather than its symptom: the call site
   * must not go back to indexing the array. A future edit that reintroduces `queries[0]` fails
   * here even if the adapter still technically supports a list.
   */
  it("the pool does not hand YouTube a single element of the list", () => {
    const call = POOL_SRC.slice(
      POOL_SRC.indexOf("youtubePoolCandidates({"),
      POOL_SRC.indexOf("skipped.youtube_cc")
    );
    expect(call).not.toMatch(/query:\s*queries\[0\]/);
    expect(call).toContain("queries:");
  });

  /** Quota is real, so the fan-out is bounded — and the bound is a constant, not a magic number. */
  it("never issues more searches than the per-beat cap", async () => {
    const many = Array.from({ length: MAX_YOUTUBE_QUERIES_PER_BEAT + 5 }, (_, i) => `q${i}`);
    const search = vi.fn(async () => []);
    const { apiCalls } = await youtubePoolCandidates({
      queries: many, sceneIndex: 0, mode: "any", search: search as never,
    });
    expect(search.mock.calls.length).toBeLessThanOrEqual(MAX_YOUTUBE_QUERIES_PER_BEAT);
    expect(apiCalls).toBe(search.mock.calls.length);
  });

  /** A beat whose first query already fills the pool must not spend quota on the rest. */
  it("stops early once the pool is full", async () => {
    const search = vi.fn(async () => [row("a"), row("b"), row("c")]);
    await youtubePoolCandidates({
      queries: ["q1", "q2", "q3"], sceneIndex: 0, mode: "any", maxResults: 3, search: search as never,
    });
    expect(search.mock.calls.length).toBe(1);
  });
});

/* ═══════════════════════ identity across queries ═══════════════════════ */

describe("YOUTUBE-FIRST — the same video found twice is one candidate", () => {
  /**
   * Searching several angles on one beat makes overlap the NORMAL case: "berlin 1945" and
   * "berlin ruins 1945" return many of the same videos. Without dedup by provider id the pool
   * fills with one video repeated, which looks like a healthy pool and ranks like a single result.
   */
  it("dedupes across queries by video id", async () => {
    const search = vi.fn(async () => [row("same"), row("other")]);
    const { candidates, log } = await youtubePoolCandidates({
      queries: ["q1", "q2", "q3"], sceneIndex: 0, mode: "any", search: search as never,
    });
    expect(candidates.map((c) => c.assetId).sort()).toEqual(["other", "same"]);
    expect(log).toContain("deduped=");
  });

  /** Two genuinely different videos stay two, whichever query found them. */
  it("keeps videos that are actually different", async () => {
    const search = vi.fn(async (q: string) => [row(q === "q1" ? "AAA" : "BBB")]);
    const { candidates } = await youtubePoolCandidates({
      queries: ["q1", "q2"], sceneIndex: 0, mode: "any", search: search as never,
    });
    expect(candidates.map((c) => c.assetId).sort()).toEqual(["AAA", "BBB"]);
  });

  it("ignores blank and repeated phrasings before they cost a search", async () => {
    const search = vi.fn(async () => []);
    await youtubePoolCandidates({
      queries: ["berlin", "  ", "berlin", ""], sceneIndex: 0, mode: "any", search: search as never,
    });
    expect(search.mock.calls.map((c) => c[0])).toEqual(["berlin"]);
  });
});

/* ═══════════════════════ one query failing is not the beat failing ═══════════════════════ */

describe("YOUTUBE-FIRST — a failed query does not lose the beat's other angles", () => {
  /**
   * Quota errors and transient 5xx are exactly what searching several angles is supposed to
   * survive. Before, one throw took the whole beat's YouTube search with it; now the remaining
   * queries still run and the failure is counted rather than swallowed.
   */
  it("continues past a throwing query and keeps what the others found", async () => {
    const search = vi.fn(async (q: string) => {
      if (q === "q2") throw new Error("quota exceeded");
      return [row(`v-${q}`)];
    });
    const { candidates, log } = await youtubePoolCandidates({
      queries: ["q1", "q2", "q3"], sceneIndex: 0, mode: "any", search: search as never,
    });
    expect(candidates.map((c) => c.assetId).sort()).toEqual(["v-q1", "v-q3"]);
    expect(log).toContain("failed=1");
    expect(log).toContain("quota");
  });

  it("reports every query as failed when they all fail, and returns nothing", async () => {
    const search = vi.fn(async () => { throw new Error("quota exceeded"); });
    const { candidates, log } = await youtubePoolCandidates({
      queries: ["q1", "q2"], sceneIndex: 0, mode: "any", search: search as never,
    });
    expect(candidates).toEqual([]);
    expect(log).toContain("failed=2");
  });
});

/* ═══════════════════════ the log answers what was asked ═══════════════════════ */

describe("YOUTUBE-FIRST — the production log says what this beat asked YouTube", () => {
  it("prints one [SearchQuery] line per query, with no credential in it", async () => {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      await youtubePoolCandidates({
        queries: ["berlin 1945", "brandenburg gate"], sceneIndex: 3, mode: "creative_common",
        search: async () => [],
      });
    } finally {
      console.log = realLog;
    }
    const q = lines.filter((l) => l.includes("[SearchQuery]") && l.includes("type=youtube"));
    expect(q).toHaveLength(2);
    expect(q[0]).toContain("beat=s3");
    expect(q[0]).toContain('query="berlin 1945"');
    expect(q[0]).toContain("reason=");
    /** A query is beat text; no key ever reaches this module, and the log must keep it that way. */
    for (const line of q) expect(line).not.toMatch(/key|token|secret/i);
  });

  /** The pool's per-provider accounting must reflect the searches actually issued. */
  it("counts every search against the provider, not a hardcoded one", async () => {
    const search = vi.fn(async () => []);
    const pool = await buildSceneCandidatePool(
      poolRequest(search, { extraQueries: ["b", "c"] })
    );
    expect(pool.metrics.apiCallsPerProvider.youtube_cc).toBe(3);
  }, 30_000);
});
