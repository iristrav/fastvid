/**
 * RONDE 254 — A CHOICE ASKED FOR AS A CHOICE.
 *
 * ── The third link in the chain 252 and 253 repaired ────────────────────────────────────────
 *
 * RONDE 252 (8df4422) fixed the SUPPLY: two adoption loops walked a list they already held and
 * handed `adoptClip` one path at a time. RONDE 253 fixed the RECORD: the first route to declare a
 * beat's vision review pool owned it, so a deliberately single-winner route running first froze the
 * beat at `reviewPool=1` however much every later route aggregated.
 *
 * Neither reaches the link above both. Every provider fetcher in this file declares its own
 * default — two on Wikimedia video and images, Openverse, SerpAPI, NASA, Internet Archive and
 * Pixabay, three on Pexels. That default is a decision: give the beat something to choose between.
 * Fifteen call sites whose result goes STRAIGHT into `adoptClip` — which ranks it, declares the
 * review pool from it, and walks it preferring a FIT — overrode that decision to ONE.
 *
 * So the ranking sorted a list of one, the pool declared a choice of one, and the FIT preference
 * had nothing to prefer. Render 585 measured it: `ranked/rankRuns ≤ 1.00` on fifteen of fifteen.
 *
 * ── The line this round drew, and why it is where it is ─────────────────────────────────────
 *
 * Forty `count=1` calls of these eight fetchers exist. Only fifteen were changed, and the test for
 * "which" is not "does an adoption happen somewhere below" — it is whether the VARIABLE the fetch
 * assigns is what `adoptClip` is handed:
 *
 *     const wikiVid = await fetchWikimediaVideos(…, 1, …);      ← changed: adoptClip gets exactly
 *     clip = await adoptClip(wikiVid.map((c) => c.path), …);      what this one fetch returned
 *
 *     const ovPaths = await fetchOpenverseImages(…, 1, …);      ← NOT changed: the pool spans
 *     addToPool(ovPaths, ovQ);                                    several sources and queries and
 *     const boundedPool = [...new Set(pool)].slice(0, 5);         is already capped at five
 *
 * On a pool route the cardinality reaching `adoptClip` was never one, and the per-source single is
 * the pool's own design. Sweeping those up would be the mass replacement this round forbids — and
 * it would raise downloads on the routes that needed it least.
 *
 * ── Not a budget ────────────────────────────────────────────────────────────────────────────
 *
 * Two is not a number invented here; it is what the fetchers themselves declare, so what changed is
 * that fifteen routes stop overriding a default downward. And it bounds nothing:
 * `MAX_BEAT_DOWNLOADS = 12` bounds the downloads, `maxShortlistPerBeatPerSource()` bounds what one
 * source may put on a beat, `MAX_BEAT_IMAGE_JUDGEMENTS_PER_BEAT` bounds the looks. This is the ASK.
 * Every ceiling that answers it is where it was.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { BUDGETS } from "./retrievalBudget";
import { maxShortlistPerBeat, maxShortlistPerBeatPerSource } from "./beatShortlist";
import { callSitesOf, lineOf, stripComments } from "./sourceScan.test.support";

const RAW = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const CODE = stripComments(RAW);

/** The eight fetchers that can feed an adoption directly. */
const FETCHERS = [
  "fetchWikimediaVideos",
  "fetchWikimediaImages",
  "fetchOpenverseImages",
  "fetchSerpAPIImages",
  "fetchNasaVideoClips",
  "fetchInternetArchiveClips",
  "fetchPexelsClips",
  "fetchPixabayClips",
] as const;

/**
 * THE CRITERION. A call is "direct" when the variable it assigns is the first argument to an
 * `adoptClip` below it — bare, or through the `.map((c) => c.path)` two routes use.
 */
function directAdoptionSites(): Array<{ fetcher: string; line: number; asksForOne: boolean }> {
  const out: Array<{ fetcher: string; line: number; asksForOne: boolean }> = [];
  for (const fetcher of FETCHERS) {
    for (const at of callSitesOf(CODE, fetcher)) {
      const assign = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/.exec(
        CODE.slice(Math.max(0, at - 90), at)
      );
      if (!assign) continue;
      const variable = assign[1]!;
      const below = CODE.slice(at, at + 2200);
      const handedOver = new RegExp(
        `adoptClip\\(\\s*${variable}\\s*(?:,|\\.map\\(\\(c\\) => c\\.path\\))`
      ).test(below);
      if (!handedOver) continue;
      out.push({
        fetcher,
        line: lineOf(CODE, at),
        asksForOne: /sceneIndex,\s*1\s*[,)]/.test(CODE.slice(at, at + 420)),
      });
    }
  }
  return out;
}

describe("1. the constant that says how many a choosing route asks for", () => {
  it("is declared once, named, and explained", () => {
    expect([...CODE.matchAll(/const MULTI_CANDIDATE_FETCH_COUNT = \d+;/g)]).toHaveLength(1);
  });

  /**
   * Two, because two is what the fetchers themselves declare. Restoring a default is a smaller
   * claim than inventing a ceiling, and the signatures in this file are the whole justification.
   */
  it("and is the fetchers' own default, not a new number", () => {
    expect(Number(/const MULTI_CANDIDATE_FETCH_COUNT = (\d+);/.exec(CODE)![1])).toBe(2);
    for (const fetcher of FETCHERS) {
      const at = CODE.indexOf(`function ${fetcher}(`);
      expect(at, `${fetcher} declaration must be visible to the scanner`).toBeGreaterThan(-1);
      expect(CODE.slice(at, at + 700), `${fetcher}`).toMatch(/(count|maxResults): number = [23],/);
    }
  });

  it("and is smaller than every per-beat ceiling it spends against", () => {
    const count = Number(/const MULTI_CANDIDATE_FETCH_COUNT = (\d+);/.exec(CODE)![1]);
    expect(count).toBeLessThan(BUDGETS.downloads());
    expect(count).toBeLessThanOrEqual(maxShortlistPerBeatPerSource());
    expect(count).toBeLessThan(maxShortlistPerBeat());
  });
});

describe("2. every route that adopts what it fetched asks for a choice", () => {
  it("no direct adoption route is still handed a single candidate by its fetch", () => {
    const offenders = directAdoptionSites().filter((s) => s.asksForOne);
    expect(
      offenders,
      `still asking for one: ${offenders.map((o) => `${o.fetcher}@L${o.line}`).join(", ")}`
    ).toEqual([]);
  });

  /**
   * Counted as well as located, so a sixteenth direct route added later without the constant is a
   * failure rather than a silence.
   */
  /**
   * Seventeen direct routes, and the two the constant is NOT on are the last-resort stock pair:
   * they were already asking for two before this round, so leaving their literal alone keeps the
   * diff to what actually changed. Counted so that an eighteenth added later without a choice is a
   * failure rather than a silence.
   */
  it("and there are seventeen of them, fifteen of which needed the constant", () => {
    expect(directAdoptionSites()).toHaveLength(17);
    expect(
      [...CODE.matchAll(/MULTI_CANDIDATE_FETCH_COUNT/g)],
      "one declaration plus fifteen uses"
    ).toHaveLength(16);
  });

  it("the other two already asked for more than one, and still do", () => {
    const at = CODE.indexOf("const stockTryCap");
    expect(at).toBeGreaterThan(-1);
    const block = CODE.slice(at, at + 1400);
    expect([...block.matchAll(/sceneIndex,\s*2\s*,/g)]).toHaveLength(2);
  });
});

describe("3. the routes that pool were deliberately left alone", () => {
  /**
   * The other side of the same statement, so this file cannot be satisfied by a sweep. These
   * fetches ask for one and hand the result to a pool, not to an adoption — and the pool is
   * already bounded above one.
   */
  it("many count=1 calls remain, and none of them adopts what it fetched", () => {
    const direct = new Set(directAdoptionSites().map((s) => `${s.fetcher}@${s.line}`));
    let pooled = 0;
    for (const fetcher of FETCHERS) {
      for (const at of callSitesOf(CODE, fetcher)) {
        if (!/sceneIndex,\s*1\s*[,)]/.test(CODE.slice(at, at + 420))) continue;
        if (direct.has(`${fetcher}@${lineOf(CODE, at)}`)) continue;
        pooled += 1;
      }
    }
    expect(pooled, "a mass replacement would have taken these too").toBeGreaterThanOrEqual(20);
  });

  it("and the pools they fill are still bounded where they were", () => {
    expect(CODE).toContain("const boundedPool = [...new Set(pool)].slice(0, 5);");
    expect(CODE).toContain("const POOL_MAX = 5;");
    expect(CODE).toContain("const POOL_RAW_CANDIDATE_TARGET = 3;");
  });
});

describe("4. the intentional single-winner routes are untouched", () => {
  it("both still ask for one and still take the first", () => {
    const adoptions = [...CODE.matchAll(/adoptClip\(\s*\[winner\.path\]/g)];
    expect(adoptions).toHaveLength(2);
    for (const m of adoptions) {
      const before = CODE.slice(Math.max(0, m.index! - 700), m.index!);
      const fetcher = [...before.matchAll(/(fetchEuropeanaVideos|searchWebWideVideoClips)\(/g)].pop();
      expect(fetcher, "a single-winner adoption with no fetch above it").toBeTruthy();
      expect(before.slice(fetcher!.index!), `${fetcher![1]} asks for one`).toMatch(
        /sceneIndex,\s*1\s*[,)]/
      );
    }
    expect(CODE).toContain("const winner = euroHits[0]!;");
    expect(CODE).toContain("const winner = webWideCandidates[0]!;");
  });
});

describe("5. nothing that bounds the work was moved", () => {
  it("the per-beat download ceiling is the number it was", () => {
    expect(BUDGETS.downloads()).toBe(12);
  });

  it("the per-beat vision ceiling and shortlist caps are the numbers they were", () => {
    const gate = readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(gate).toContain('envInt("MAX_BEAT_IMAGE_JUDGEMENTS_PER_BEAT", 4, 1, 12)');
    expect(maxShortlistPerBeat()).toBe(8);
    expect(maxShortlistPerBeatPerSource()).toBe(4);
  });

  it("the preparation, query and rescue ceilings are the numbers they were", () => {
    expect(BUDGETS.preparations()).toBe(10);
    expect(BUDGETS.queries()).toBe(24);
    expect(BUDGETS.rescues()).toBe(3);
  });

  /**
   * THE BOUND THAT MAKES THIS SAFE. A route asking for two rather than one cannot multiply the
   * render's downloads, because every download is charged against a ceiling of twelve PER BEAT
   * that this change does not touch. The ask went up; the ceiling did not move.
   */
  it("and every retrieval still charges that ceiling", () => {
    const budget = readFileSync(path.join(__dirname, "retrievalBudget.ts"), "utf8");
    expect(budget).toContain('downloads: () => envInt("MAX_BEAT_DOWNLOADS", 12, 1, 100)');
    expect(CODE).toMatch(/chargeAmbientBudget\("downloads"\)|budgetAllows\([^)]*"downloads"\)/);
  });
});

describe("6. the scanner this file depends on can see the whole file", () => {
  /**
   * RONDE 254 found this the hard way. The naive comment strip every structural test in this repo
   * used treats a block-comment opener inside a STRING as a real opener, and this file has one in a
   * fetch header — swallowing 3748 characters, including the whole `fetchPexelsClips` declaration.
   * A guard with a hole that size is a guard a regression can sit inside, so the hole is asserted
   * shut here rather than trusted.
   */
  it("the naive strip loses a declaration that the scanner keeps", () => {
    const naive = RAW.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    expect(naive.includes("function fetchPexelsClips(")).toBe(false);
    expect(CODE.includes("function fetchPexelsClips(")).toBe(true);
  });

  it("and it removes comments rather than code", () => {
    expect(CODE, "a doc comment is gone").not.toContain("RONDE 254 — HOW MANY CANDIDATES");
    expect(CODE, "a string that merely looks like one is not").toContain("image/*");
  });
});
