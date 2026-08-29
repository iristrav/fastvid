/**
 * RONDE 93/94 — closing the last provenance gaps, and reporting the asset lifecycle.
 *
 * The audit of a real render produced two numbers that needed explaining:
 *
 *     bypassAttempts=860     rejected=1006     sent=644     blocked=1866
 *
 * Neither came from an "old query builder". There is none: LEGACY_QUERY_BUILDER is minted in
 * exactly one place — legacyQueryTicket, called from exactly one branch of the gate — and it means
 * "this provider search ran with NO ambient provenance scope". The 860 were searches happening
 * above the beat loop, chiefly the scene candidate pool. The 1006 were searches INSIDE a scope
 * asking for words the beat never said, chiefly three builders that appended "interview",
 * "red carpet", "talk show" and "makeup brand" to every person the script names.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  PRODUCTION_VOCABULARY,
  emptyQueryContext,
  isProductionWord,
  legacyQueryTicket,
  searchGateDecision,
  validateSearchQuery,
  withSearchProvenance,
} from "./searchQueryContract";
import {
  formatAssetUsageSummary,
  formatUsageInconsistencies,
  type VisualSourceSummary,
} from "./visualSourceLineage";

const SERVER_DIR = __dirname;
const read = (f: string) => fs.readFileSync(path.join(SERVER_DIR, f), "utf8");
const PIPELINE_SRC = read("videoPipeline.ts");
const POOL_SRC = read("scenePool.ts");
const CONTRACT_SRC = read("searchQueryContract.ts");

function withStrict<T>(on: boolean, fn: () => T): T {
  const prev = process.env.SEARCH_GATE_STRICT;
  process.env.SEARCH_GATE_STRICT = on ? "true" : "false";
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SEARCH_GATE_STRICT;
    else process.env.SEARCH_GATE_STRICT = prev;
  }
}

/* ═══════════ §1 — what LEGACY_QUERY_BUILDER actually is ═══════════ */

describe("RONDE 93 §1 — LEGACY_QUERY_BUILDER means 'no scope', not 'old builder'", () => {
  it("TEST 1 — it is minted in exactly one place, by one branch of the gate", () => {
    const mints = CONTRACT_SRC.split("\n").filter(
      (l) => l.includes('rejectReason: "LEGACY_QUERY_BUILDER"')
    );
    expect(mints).toHaveLength(1);
    const callers = CONTRACT_SRC.split("\n").filter(
      (l) => l.includes("legacyQueryTicket(") && !l.includes("export function")
    );
    expect(callers).toHaveLength(1);
    expect(callers[0]).toContain("ambient ?");
  });

  it("TEST 2 — it is produced by absence of a scope, and by nothing else", () => {
    expect(legacyQueryTicket("Winston Churchill", "t").rejectReason).toBe("LEGACY_QUERY_BUILDER");
    // The very same query inside a scope is minted, not legacied.
    withStrict(true, () => {
      const ctx = emptyQueryContext("Winston Churchill spoke to the Commons.");
      withSearchProvenance(ctx, () => {
        expect(searchGateDecision("wikimedia", "Winston Churchill", "t").admitted).toBe(true);
      });
      expect(searchGateDecision("wikimedia", "Winston Churchill", "t").admitted).toBe(false);
    });
  });

  it("TEST 3 — no module in server/ defines a QueryBuilder class or factory", () => {
    for (const file of fs.readdirSync(SERVER_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const src = fs.readFileSync(path.join(SERVER_DIR, file), "utf8");
      expect(src, `${file} defines a QueryBuilder`).not.toMatch(/class \w*QueryBuilder\b/);
      expect(src, `${file} defines a legacy builder`).not.toMatch(/function \w*LegacyQueryBuilder\b/);
    }
  });
});

/* ═══════════ §2 — the scene pool now has a scope ═══════════ */

describe("RONDE 93 §2 — the scene candidate pool searches inside a scope", () => {
  it("TEST 4 — buildSceneCandidatePool establishes one from its own scene text", () => {
    const idx = POOL_SRC.indexOf("export async function buildSceneCandidatePool(");
    expect(idx).toBeGreaterThan(-1);
    const body = POOL_SRC.slice(idx, POOL_SRC.indexOf("\n}", idx));
    expect(body).toContain("withSearchProvenance(");
    expect(body).toContain("emptyQueryContext(req.sceneText");
  });

  it("TEST 5 — an already-active beat scope wins: the pool never widens it", () => {
    const idx = POOL_SRC.indexOf("export async function buildSceneCandidatePool(");
    const body = POOL_SRC.slice(idx, POOL_SRC.indexOf("\n}", idx));
    // The more specific claim is checked first and returned unchanged.
    expect(body).toContain("if (getSearchProvenance()) return buildSceneCandidatePoolInner(req);");
  });

  it("TEST 6 — a pool query proven by the scene text is admitted", () => {
    withStrict(true, () =>
      withSearchProvenance(emptyQueryContext("The Berlin Wall fell in November 1989."), () => {
        expect(searchGateDecision("pexels", "Berlin Wall", "scenePool:searchPexelsCandidates").admitted).toBe(true);
        expect(searchGateDecision("pexels", "Berlin nightclub", "scenePool:searchPexelsCandidates").admitted).toBe(false);
      })
    );
  });
});

/* ═══════════ §3 — every bypass can name its caller ═══════════ */

describe("RONDE 93 §3 — a bypass is attributable", () => {
  it("TEST 7 — no provider search still uses the anonymous default route", () => {
    // Thirteen cachedProviderSearch call sites shared the default "provider_search", so the
    // per-route breakdown lumped thirteen providers into one row and no bypass could be traced
    // back to the function that made it.
    const anonymous = PIPELINE_SRC.split("\n").filter(
      (l) => l.includes('"provider_search"') && !l.trim().startsWith("*")
    );
    expect(anonymous).toHaveLength(1); // the parameter default itself
    expect(anonymous[0]).toContain("route =");
  });

  it("TEST 8 — every cachedProviderSearch call passes its own function name as the route", () => {
    for (const fn of [
      "fetchPexelsClips", "fetchPixabayClips", "fetchWikimediaVideos", "fetchFlickrCCVideos",
      "fetchSepiaSearchVideos", "fetchGdeltTvNewsClips", "fetchEuropeanaVideos", "fetchVimeoCCVideos",
      "fetchMediaCccVideos", "fetchNasaVideoClips", "fetchNaraClips", "fetchInternetArchiveClips",
      "searchYoutubeVideoCandidates",
    ]) {
      expect(PIPELINE_SRC, `${fn} has no route label`).toContain(`"${fn}"\n`);
    }
  });
});

/* ═══════════ §6 — no invented event terms ═══════════ */

describe("RONDE 93 §6 — the name is proven, the event was invented", () => {
  it("TEST 9 — no builder appends a media event to every person unconditionally", () => {
    const offenders = PIPELINE_SRC.split("\n").filter((line) => {
      if (line.trim().startsWith("*") || line.trim().startsWith("//")) return false;
      return /`\$\{\w+\} (interview|television|talk show|red carpet|makeup brand|celebrity news|paparazzi|met gala)/.test(line);
    });
    expect(offenders, `still appended unconditionally:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("TEST 10 — the measured absurdities cannot be built any more", () => {
    for (const phrase of [
      "Adolf Hitler red carpet", "Adolf Hitler makeup brand", "Adolf Hitler talk show",
      "Adolf Hitler television", "Adolf celebrity news",
    ]) {
      // Nowhere in the source is such a string constructible from a bare name plus a constant.
      const [, ...suffix] = phrase.split(" ");
      const tail = suffix.slice(1).join(" ");
      const built = PIPELINE_SRC.includes(`} ${tail}\``) && !PIPELINE_SRC.includes(`// ${tail}`);
      expect(built, `${phrase} is still constructible`).toBe(false);
    }
  });

  it("TEST 11 — the event terms survive, but only as the word the beat actually said", () => {
    /**
     * SUPERSEDED BY RONDE 100B, deliberately.
     *
     * RONDE 93 let this path map a trigger to a different word — a beat mentioning a premiere
     * asked providers for "red carpet" — on the grounds that the trigger was evidence. The
     * production render showed what that costs: the OUTPUT is what reaches the provider, and
     * "red carpet" appears nowhere in the script, so the SearchGate rejected it as
     * UNVERIFIED_TERM. The rule is now the stricter one: emit the alternative the narration
     * actually used, and drop the entries that had no spoken word to fall back on.
     */
    const idx = PIPELINE_SRC.indexOf("function scriptEventSearchQueries(");
    const body = PIPELINE_SRC.slice(idx, PIPELINE_SRC.indexOf("\n}", idx));

    // The evidence patterns are still here — a beat about a premiere still triggers a query.
    expect(body).toContain("red carpet|premiere|gala|awards");
    expect(body).toContain("protest|demonstration|rally");

    // But nothing may push a fixed string any more: the match itself is the query.
    expect(body).toContain("const said = m?.[1]?.trim();");
    expect(body).not.toMatch(/out\.push\(p\("/);

    // The two entries whose output named a topic nobody mentioned are gone entirely.
    expect(body).not.toContain("news conference");
    expect(body).not.toContain("business news");
    expect(body).not.toContain("scandal|controversy|backlash");
  });

  it("TEST 12 — a beat that mentions an interview still proves the word", () => {
    const ctx = emptyQueryContext("Churchill gave a rare interview that winter.");
    expect(validateSearchQuery("Churchill interview", ctx).ok).toBe(true);
    const silent = emptyQueryContext("Churchill stood at the window.");
    expect(validateSearchQuery("Churchill interview", silent).ok).toBe(false);
  });
});

/* ═══════════ §3b — archive field syntax is syntax, not content ═══════════ */

describe("RONDE 93 — a provider's query language is not a claim about the world", () => {
  it("TEST 13 — archive.org field keywords are technical vocabulary", () => {
    for (const word of ["title", "subject", "collection", "tvnews", "mediatype", "movies", "identifier"]) {
      expect(isProductionWord(word), word).toBe(true);
      expect(PRODUCTION_VOCABULARY.has(word), word).toBe(true);
    }
  });

  it("TEST 14 — a field query for a proven person is admitted", () => {
    const ctx = emptyQueryContext("Winston Churchill addressed the Commons in 1940.");
    expect(validateSearchQuery("title:(Winston Churchill) AND mediatype:movies", ctx).ok).toBe(true);
    expect(validateSearchQuery("collection:tvnews AND Winston Churchill", ctx).ok).toBe(true);
    expect(validateSearchQuery('subject:"Winston Churchill"', ctx).ok).toBe(true);
  });

  it("TEST 15 — but the field syntax cannot smuggle an unproven subject through", () => {
    const ctx = emptyQueryContext("Winston Churchill addressed the Commons in 1940.");
    expect(validateSearchQuery("title:(Adolf Hitler) AND mediatype:movies", ctx).ok).toBe(false);
    expect(validateSearchQuery("collection:tvnews AND Stalingrad", ctx).ok).toBe(false);
  });
});

/* ═══════════ RONDE 94 — the asset lifecycle report ═══════════ */

describe("RONDE 94 — found is not rendered, and the report says which is which", () => {
  const counts = (over: Partial<Record<string, number>> = {}) => ({
    searches: 0, results: 0, eligible: 0, ranked: 0, selected: 0,
    downloadStarted: 0, downloadSucceeded: 0, downloadFailed: 0, adopted: 0,
    transformed: 0, composed: 0, replaced: 0, removed: 0, finalVideo: 0,
    rejected: 0, fallback: 0, rescue: 0, backfill: 0,
    ...over,
  }) as never;

  const summaryOf = (byProvider: Record<string, unknown>, total: unknown): VisualSourceSummary =>
    ({ byProvider, total, failureReasons: {}, verifiedRecords: 0, unverifiedRecords: 0 } as never);

  it("TEST 16 — one line per provider, in found/validated/selected/downloaded/assigned/rendered", () => {
    const wikimedia = counts({ results: 235, eligible: 235, selected: 8, downloadSucceeded: 8, adopted: 8, finalVideo: 8 });
    const lines = formatAssetUsageSummary(summaryOf({ wikimedia }, wikimedia), true);
    expect(lines[0]).toBe(
      "[AssetUsageSummary] provider=wikimedia found=235 validated=235 selected=8 " +
        "downloaded=8 assigned=8 rendered=8 unused=227"
    );
  });

  it("TEST 17 — rendered is NOT_VERIFIED, never 0, when the render could not prove it", () => {
    const youtube = counts({ results: 42, eligible: 16, selected: 5, downloadSucceeded: 5, adopted: 5, finalVideo: 0 });
    const line = formatAssetUsageSummary(summaryOf({ youtube }, youtube), false)[0]!;
    expect(line).toContain("rendered=NOT_VERIFIED");
    expect(line).toContain("unused=NOT_VERIFIED");
    expect(line).not.toContain("rendered=0");
  });

  it("TEST 18 — found is not used: a provider with results and no final clips shows it", () => {
    const pexels = counts({ results: 120, eligible: 40, selected: 3, downloadSucceeded: 3, adopted: 0, finalVideo: 0 });
    const line = formatAssetUsageSummary(summaryOf({ pexels }, pexels), true)[0]!;
    expect(line).toContain("found=120");
    expect(line).toContain("assigned=0");
    expect(line).toContain("rendered=0");
    expect(line).toContain("unused=120");
  });

  it("TEST 19 — a funnel that widens is reported as an inconsistency", () => {
    const broken = counts({ results: 10, eligible: 4, selected: 6, downloadSucceeded: 6, adopted: 6, finalVideo: 6 });
    const problems = formatUsageInconsistencies(summaryOf({ nasa: broken }, broken), true);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.startsWith("[AssetUsageInconsistency]"))).toBe(true);
    /**
     * RONDE 159 reports the mandatory stages first and the two optional ones (selected,
     * downloaded — a curated clip is adopted without either) after them, so this finding is no
     * longer the first line. It is still reported, which is what the test is for; asserting
     * membership rather than position also stops the test breaking on the next ordering change.
     */
    expect(problems.some((p) => p.includes("selected=6 exceeds validated=4"))).toBe(true);
  });

  it("TEST 20 — a well-formed funnel reports nothing", () => {
    const ok = counts({ results: 50, eligible: 30, selected: 10, downloadSucceeded: 8, adopted: 6, finalVideo: 4 });
    expect(formatUsageInconsistencies(summaryOf({ europeana: ok }, ok), true)).toEqual([]);
  });

  it("TEST 21 — the render emits it, and an inconsistency is a warning not a log line", () => {
    expect(PIPELINE_SRC).toContain("formatAssetUsageSummary(summary, ledger.finalVideoWasVerified)");
    expect(PIPELINE_SRC).toContain('if (line.startsWith("[AssetUsageInconsistency]")) console.warn(line);');
  });
});
