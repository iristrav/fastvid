import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  MAX_YOUTUBE_SEARCHES_PER_VIDEO,
  claimYoutubeSearch,
  memoryYoutubeSearchBudgetStore,
} from "./youtubeSearchBudget";
import {
  analyzeVideo,
  applyArchivalRule,
  planGapQuery,
  planVideoQuery,
  refuseQuery,
  type GateVerdict,
} from "./youtubeVideoSearchPlanner";
import {
  buildVideoYoutubePool,
  poolRowsForBeat,
  search2Reasons,
  youtubeVideoPoolEnabled,
  type PoolDeps,
  type SearchItem,
  type Triage,
} from "./youtubeVideoPool";

/**
 * RONDE 658 — "1 search normaal. 2 searches maximaal. 3 searches nooit."
 *
 * The dry run of 25–26 September (9 FastVid scripts, 13 searches): one search per video filled most
 * films; three needed a second, and the abstract one had no real footage on YouTube at all, after
 * which FastVid goes to stock. It also showed what the planner must not do — build the query on one
 * scene, put "archival" on a modern subject, use words the narration never says.
 */
const silent = () => {};

describe("the budget belongs to the video, and it holds two searches", () => {
  it("a third search cannot even be asked for", async () => {
    const store = memoryYoutubeSearchBudgetStore();
    expect(MAX_YOUTUBE_SEARCHES_PER_VIDEO).toBe(2);
    expect(await claimYoutubeSearch(store, 7, 3, silent)).toBe(false);
    expect(await claimYoutubeSearch(store, 7, 0, silent)).toBe(false);
    expect(await claimYoutubeSearch(store, 0, 1, silent)).toBe(false);
  });

  it("search #1 is granted once, #2 only after #1, and never twice — also when many ask at once", async () => {
    const store = memoryYoutubeSearchBudgetStore();
    expect(await claimYoutubeSearch(store, 8, 2, silent)).toBe(false);
    const firsts = await Promise.all(Array.from({ length: 10 }, () => claimYoutubeSearch(store, 8, 1, silent)));
    expect(firsts.filter(Boolean)).toHaveLength(1);
    const seconds = await Promise.all(Array.from({ length: 10 }, () => claimYoutubeSearch(store, 8, 2, silent)));
    expect(seconds.filter(Boolean)).toHaveLength(1);
    expect(store.rows.get(8)!.searchCount).toBe(2);
  });

  it("a store that cannot answer is a refusal, never a free search", async () => {
    const lines: string[] = [];
    const broken = { ...memoryYoutubeSearchBudgetStore(), claim: async () => { throw new Error("db down"); } };
    expect(await claimYoutubeSearch(broken, 9, 1, (l) => lines.push(l))).toBe(false);
    expect(lines[0]).toContain("REFUSED video=9 search=#1 reason=store_error:db down");
  });
});

/* ── a small Tesla script: the stock-exchange floor appears in ONE scene ── */
const tesla = {
  prompt: "How Tesla became the world's most valuable car company",
  title: "How Tesla Outpaced Giants",
  sceneTexts: [
    "In 2008, Tesla teetered on the brink of bankruptcy. Elon Musk bet everything on the Model S.",
    "At the Fremont factory, Tesla robots assembled the Model S. Elon Musk slept on the factory floor.",
    "In June 2020, traders on the NYSE trading floor watched Tesla overtake Toyota.",
    "Today the Gigafactory in Shanghai builds a Tesla every few seconds, and Elon Musk plans more.",
  ],
};
const allow = (): GateVerdict => ({ ok: true });

describe("the planner asks for the whole video, not one scene", () => {
  it("knows history from a modern subject", () => {
    expect(analyzeVideo({ prompt: "The fall of the Berlin Wall in 1989", title: "", sceneTexts: ["Crowds gathered in Berlin in 1989."] }).historical).toBe(true);
    expect(analyzeVideo(tesla).historical).toBe(false);
    expect(analyzeVideo({ prompt: "Why do we procrastinate?", title: "", sceneTexts: ["We delay tasks."] }).historical).toBe(false);
  });

  it("finds what recurs across scenes", () => {
    const a = analyzeVideo(tesla);
    const top = a.recurring.slice(0, 3).map((r) => r.term);
    expect(top).toContain("Tesla");
    expect(top).toContain("Elon Musk");
    expect(a.recurring.find((r) => r.term === "NYSE")!.scenes).toBe(1);
  });

  it("'archival' only on a historical subject", () => {
    expect(applyArchivalRule("AI cancer detection archival footage", false)).toBe("AI cancer detection footage");
    expect(applyArchivalRule("Berlin Wall 1989 archival footage", true)).toBe("Berlin Wall 1989 archival footage");
    const a = analyzeVideo(tesla);
    expect(refuseQuery("Tesla factory archival footage", { analysis: a, gate: allow })).toContain("'archival' on a modern subject");
  });

  it("refuses a query built on one scene, and one without the main subject", () => {
    const a = analyzeVideo(tesla);
    expect(refuseQuery("Tesla NYSE trading floor footage", { analysis: a, mainSubject: "Tesla", gate: allow })).toContain("built on one scene");
    expect(refuseQuery("Gigafactory Shanghai footage", { analysis: a, mainSubject: "Tesla", gate: allow })).toContain('main subject "Tesla"');
    expect(refuseQuery("Tesla Elon Musk factory footage", { analysis: a, mainSubject: "Tesla", gate: allow })).toBeNull();
  });

  it("the one-scene rule holds even when the model names no subject the script proves", async () => {
    const a = analyzeVideo(tesla);
    expect(refuseQuery("NYSE trading floor footage", { analysis: a, gate: allow })).toContain("built on one scene");
    /** And the planner falls back to the most recurring term as the main subject. */
    const answers = [
      { mainSubject: "stock markets", recurringSubjects: [], query: "NYSE trading floor footage" },
      { mainSubject: "stock markets", recurringSubjects: [], query: "Tesla Elon Musk factory footage" },
    ];
    const llm = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }));
    const plan = await planVideoQuery({ llm, gate: allow }, tesla);
    expect(plan!.query).toBe("Tesla Elon Musk factory footage");
    /** Search #2 may aim at one gap — that is its job. */
    expect(refuseQuery("NYSE trading floor footage", { analysis: a, gate: allow, allowSingleScene: true, mustDifferFrom: "Tesla footage" })).toBeNull();
  });

  it("what is searched is what the gate admits, and it must pass the same rules", async () => {
    const a = analyzeVideo(tesla);
    const narrowsToOneWord = (): GateVerdict => ({ ok: true, sentAs: "Tesla" });
    expect(refuseQuery("Tesla Elon Musk factory footage", { analysis: a, mainSubject: "Tesla", gate: narrowsToOneWord })).toContain(
      'the search gate narrows it to "Tesla"'
    );
    const narrows = (q: string): GateVerdict => ({ ok: true, sentAs: q.replace(" factory", "") });
    const llm = vi.fn(async () => ({
      choices: [{ message: { content: JSON.stringify({ mainSubject: "Tesla", recurringSubjects: [], query: "Tesla Elon Musk factory footage" }) } }],
    }));
    const plan = await planVideoQuery({ llm, gate: narrows }, tesla);
    expect(plan!.query).toBe("Tesla Elon Musk footage");
  });

  it("the search gate has the last word, and its reason goes back to the model in plain words", () => {
    const a = analyzeVideo(tesla);
    const gate = (q: string): GateVerdict =>
      /cybertruck/i.test(q) ? { ok: false, reason: "UNVERIFIED_TERM", offendingTerm: "Cybertruck" } : { ok: true };
    expect(refuseQuery("Tesla Cybertruck Elon Musk footage", { analysis: a, mainSubject: "Tesla", gate })).toContain(
      'the word "Cybertruck" does not occur in the narration'
    );
  });

  it("asks again with the refusal, and takes the first query that passes every rule", async () => {
    const answers = [
      { mainSubject: "Tesla", recurringSubjects: [], query: "Tesla NYSE trading floor 2020 archival footage" },
      { mainSubject: "Tesla", recurringSubjects: ["Elon Musk", "factory"], query: "Tesla Elon Musk factory footage" },
    ];
    const prompts: string[] = [];
    const llm = vi.fn(async (p: unknown) => {
      prompts.push(JSON.stringify(p));
      return { choices: [{ message: { content: JSON.stringify(answers.shift()) } }] };
    });
    const plan = await planVideoQuery({ llm, gate: allow }, tesla);
    expect(plan!.query).toBe("Tesla Elon Musk factory footage");
    expect(plan!.attempts).toBe(2);
    expect(prompts[1]).toContain("was refused");
  });

  it("search #2 must ask for something search #1 did not", async () => {
    const a = analyzeVideo(tesla);
    const llm = vi.fn(async () => ({
      choices: [{ message: { content: JSON.stringify({ mainSubject: "Tesla", recurringSubjects: [], query: "Tesla Elon Musk factory footage" }) } }],
    }));
    const gap = await planGapQuery({ llm, gate: allow }, tesla, a, { query1: "Tesla Elon Musk factory footage", uncovered: [5, 6] });
    expect(gap?.query ?? "").not.toBe("Tesla Elon Musk factory footage");
    expect(refuseQuery("Tesla Elon Musk footage", { analysis: a, mustDifferFrom: "Tesla Elon Musk factory footage", gate: allow })).toContain(
      "adds nothing to search #1"
    );
  });
});

/* ── the pool, with stand-in providers that count what they are asked ── */
function items(prefix: string, n: number): SearchItem[] {
  return Array.from({ length: n }, (_, i) => ({ videoId: `${prefix}${String(i).padStart(9, "0")}`.slice(0, 11), title: `${prefix} ${i}`, description: "", channel: "c", thumb: "t" }));
}
function deps(over: Partial<PoolDeps> & { usable?: (it: SearchItem) => number[] } = {}): PoolDeps & { searches: string[] } {
  const searches: string[] = [];
  const usable = over.usable ?? (() => [0, 1, 2]);
  let q = 0;
  const base: PoolDeps & { searches: string[] } = {
    searches,
    store: memoryYoutubeSearchBudgetStore(),
    llm: async () => ({
      choices: [{ message: { content: JSON.stringify({ mainSubject: "Tesla", recurringSubjects: [], query: ++q === 1 ? "Tesla Elon Musk factory footage" : "Gigafactory Shanghai Tesla footage" }) } }],
    }),
    gate: allow,
    search: async (query) => {
      searches.push(query);
      return { status: 200, items: items(searches.length === 1 ? "A" : "B", 50) };
    },
    details: async (ids) => new Map(ids.map((id) => [id, { durationSec: 300, embeddable: true, live: false }])),
    triage: async (it): Promise<Triage> => {
      const serves = usable(it);
      return { footageType: serves.length ? "real_footage" : "talking_head", servesBeats: serves, depicts: "" };
    },
    archive: async () => [],
    notFootage: () => null,
    log: silent,
    ...over,
  };
  return base;
}
const input = { videoId: 42, ...tesla };

describe("one search fills the pool; a second only for a real gap; never a third", () => {
  it("enough after search #1: one search, and every beat can draw on it", async () => {
    const d = deps();
    const pool = await buildVideoYoutubePool(d, input);
    expect(d.searches).toEqual(["Tesla Elon Musk factory footage"]);
    expect(pool.searches).toBe(1);
    expect(pool.search2Needed).toBe(false);
    expect(pool.candidates.filter((c) => c.usable)).toHaveLength(50);
  });

  it("not enough: search #2 is a different question, and after it YouTube stops", async () => {
    const d = deps({ usable: () => [] });
    const pool = await buildVideoYoutubePool(d, input);
    expect(d.searches).toHaveLength(2);
    expect(d.searches[1]).not.toBe(d.searches[0]);
    expect(pool.searches).toBe(2);
    expect(pool.search2Reason).toContain("coverage");
    /** Still nothing usable — and still no third search. */
    const again = await buildVideoYoutubePool(d, input);
    expect(d.searches).toHaveLength(2);
    expect(again.searches).toBe(2);
  });

  it("a restarted render reuses the stored pool and searches nothing", async () => {
    const d = deps();
    await buildVideoYoutubePool(d, input);
    const second = deps({ store: d.store });
    const pool = await buildVideoYoutubePool(second, input);
    expect(second.searches).toEqual([]);
    expect(pool.candidates.length).toBe(50);
  });

  it("a render that died right after claiming search #1 does not get it back", async () => {
    const d = deps({ usable: () => [] });
    await d.store.claim(42, 1);
    const pool = await buildVideoYoutubePool(d, input);
    expect(d.searches).toHaveLength(1);
    expect(pool.searches).toBe(2);
  });

  it("the archive joins the pool — it never replaces search #1", async () => {
    const d = deps({ archive: async () => items("R", 10) });
    const pool = await buildVideoYoutubePool(d, input);
    expect(d.searches).toHaveLength(1);
    expect(pool.candidates.filter((c) => c.from === 0)).toHaveLength(10);
    expect(pool.archiveUsable).toBe(10);
  });

  it("the agreed thresholds, exactly", () => {
    const sentences = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const c = (id: string, serves: number[]) => ({ videoId: id, title: "", description: "", thumb: "", durationSec: 60, footageType: "real_footage" as const, serves, from: 1 as const, usable: true, why: "ok" });
    expect(search2Reasons({ sentences, candidates: Array.from({ length: 6 }, (_, i) => c(`v${i}`, [i])) })).toEqual([]);
    expect(search2Reasons({ sentences, candidates: Array.from({ length: 5 }, (_, i) => c(`v${i}`, [i, i + 5])) })[0]).toContain("usable candidates 5 < max(6, beats/2)=6");
    expect(search2Reasons({ sentences, candidates: Array.from({ length: 8 }, (_, i) => c(`v${i}`, [0])) })).toEqual(["coverage 1/12 < 50%"]);
  });

  it("a quota cooldown spends no search", async () => {
    const d = deps({ inCooldown: () => true });
    const pool = await buildVideoYoutubePool(d, input);
    expect(d.searches).toEqual([]);
    expect(pool.searches).toBe(0);
  });

  it("a misread person lock ('Hitler Took', video 608) does not empty the pool", async () => {
    const d = deps({ usable: () => [0, 1, 2] });
    const pool = await buildVideoYoutubePool(d, input);
    const beat = tesla.sceneTexts[0]!.split(". ")[0]! + ".";
    /** Judged to serve this beat: kept whatever the name string says. */
    expect(poolRowsForBeat(pool, beat, [], "Hitler Took").length).toBe(50);
    /** Not judged for this beat: a real part of the name must appear — "hitler", never "took". */
    const other = poolRowsForBeat(pool, "An unrelated sentence about nothing here.", [], "Hitler Took");
    expect(other).toEqual([]);
    const withName = { ...pool, candidates: pool.candidates.map((c, i) => (i === 0 ? { ...c, title: "Hitler in Berlin", serves: [9] } : c)) };
    expect(poolRowsForBeat(withName, "An unrelated sentence about nothing here.", [], "Hitler Took").map((r) => r.title)).toEqual(["Hitler in Berlin"]);
  });

  it("a beat gets the videos judged to serve it first", async () => {
    const d = deps({ usable: (it) => (it.videoId.endsWith("1") ? [2] : [0]) });
    const pool = await buildVideoYoutubePool(d, input);
    const rows = poolRowsForBeat(pool, tesla.sceneTexts[1]!.split(". ")[0]! + ".", ["factory"]);
    expect(rows[0]!.rel).toBeGreaterThanOrEqual(3);
    expect(pool.candidates.find((c) => c.videoId === rows[0]!.item.id.videoId)!.serves).toContain(2);
  });
});

describe("the wiring: inside a render only the pool searches", () => {
  const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const PROD = fs.readFileSync(path.join(__dirname, "youtubeVideoPoolProduction.ts"), "utf8");
  const PREFETCH = fs.readFileSync(path.join(__dirname, "youtubePrefetch.ts"), "utf8");

  it("is on unless the operator asks for the old per-beat searches", () => {
    expect(youtubeVideoPoolEnabled({})).toBe(true);
    expect(youtubeVideoPoolEnabled({ YOUTUBE_SEARCH_MODE: "per_beat" })).toBe(false);
  });

  it("every other search inside a render is refused before it reaches Google", async () => {
    const { runWithActiveVideoId } = await import("./videoGenerationCancel");
    const { searchYoutubeVideoCandidates } = await import("./videoPipeline");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const prev = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = "test-key-not-used";
    try {
      const rows = await runWithActiveVideoId(4242, () => searchYoutubeVideoCandidates("Tesla factory", 0, "any", [], 1, "", 50));
      expect(rows).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      process.env.YOUTUBE_API_KEY = prev;
      fetchSpy.mockRestore();
    }
  }, 120_000);

  it("the pool starts after the scenes exist, the fetcher reads it, and it ends with the render", () => {
    const at = PIPE.indexOf("RONDE 658 — ONE YOUTUBE POOL FOR THE WHOLE VIDEO");
    expect(at).toBeGreaterThan(PIPE.indexOf("Stage 1 (parse)"));
    expect(PIPE.slice(at, at + 1600)).toContain("registerVideoYoutubePool(");
    expect(PIPE).toContain("const items = poolMode ? await rowsFromPool() : await searchYoutubeVideoCandidates(");
    expect(PIPE).toContain("if (poolMode && queryIndex > 0) break;");
    expect(PIPE).toContain("if (poolMode && passIndex > 0) break;");
    expect(PIPE).toContain("releaseVideoYoutubePool(videoId);");
    expect(PIPE).toContain("[YouTubeSearchOutcome] video=");
  });

  it("the pool goes through the full SEARCH_GATE_STRICT decision, with the whole video as its proof", () => {
    expect(PROD).toContain('contract.searchGateDecision("youtube", query, "video_pool")');
    expect(PROD).toContain("contract.withSearchProvenance(ctx, () => {");
    expect(PROD).toContain("pipeline.buildVerifiedQueryContextForBeat(narration, { sceneText: narration, topic: input.prompt })");
  });

  it("a refused call is the search, spent: no second key, no retry", () => {
    expect(PROD).not.toContain("markYoutubeKeySpent");
    expect(PROD).toContain("if (resp.status === 429) pipeline.markYoutubeRateLimited();");
    expect(PROD).toContain('url.searchParams.set("maxResults", "50")');
  });

  it("no background search in this mode", () => {
    expect(PREFETCH).toContain("takeDailySlot: () => !youtubeVideoPoolEnabled() && !pipeline.isYoutubeInCooldown() && takeDailyAltSlot()");
  });

  it("the budget and the record live in the database", () => {
    const sql = fs.readFileSync(path.join(__dirname, "../drizzle/0060_ronde658_youtube_video_searches.sql"), "utf8");
    expect(sql).toContain("CONSTRAINT `youtube_video_searches_videoId_unique` UNIQUE(`videoId`)");
    for (const col of ["search1Query", "search1Candidates", "search1Usable", "search1Coverage", "search2Needed", "search2Reason", "search2Query", "search2Candidates", "finalCoverage", "downloads", "downloadsOk", "timelineClips", "fallbackUsed"]) {
      expect(sql).toContain(`\`${col}\``);
    }
    const DB = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");
    const claim = DB.slice(DB.indexOf("export const dbYoutubeSearchBudgetStore"));
    expect(claim).toContain("eq(youtubeVideoSearches.searchCount, n - 1)");
    expect(claim).toContain("if (!db) return false;");
  });
});
