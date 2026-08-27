/**
 * RONDE 100B — the noodroutes stop going around the gate, and the builders stop inventing.
 *
 * Two separate failures showed up in one production render, and they are easy to confuse:
 *
 *   · 425 provider searches ran with NO provenance scope at all. The SearchGate calls that
 *     LEGACY_QUERY_BUILDER, which is minted in exactly one place and only when
 *     getSearchProvenance() returns undefined. Pexels 242, Wikimedia 64, Pixabay 62, SerpAPI 45,
 *     Unsplash 12 — every one of them reached through a fallback, rescue, refill, fill or
 *     scene-level ladder that RONDE 90/93 never wrapped, while the SAME fetchers behaved
 *     correctly when a primary ladder called them.
 *   · 390 queries had a scope and still failed it, because the builders were manufacturing
 *     words: "documentary" as a subject, "red carpet" from a beat that said "premiere",
 *     "Kylie Jenner makeup launch" from a beat that said only her name.
 *
 * A scope does not fix the second, and dropping invented terms does not fix the first. These
 * tests keep them apart.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  PRODUCTION_VOCABULARY,
  emptyQueryContext,
  validateSearchQuery,
} from "./searchQueryContract";
import { scriptStockSearchQueries } from "./videoPipeline";

const SERVER_DIR = __dirname;
const PIPELINE_SRC = fs.readFileSync(path.join(SERVER_DIR, "videoPipeline.ts"), "utf8");
const CONTRACT_SRC = fs.readFileSync(path.join(SERVER_DIR, "searchQueryContract.ts"), "utf8");

/**
 * Body of one top-level function, brace-matched.
 *
 * The opening brace has to be found AFTER the parameter list: several of these signatures carry
 * an inline object type (`opts?: { videoOnly?: boolean }`), and matching from the first `{` in
 * the declaration closes on that instead and returns a fragment.
 */
function bodyOf(src: string, fn: string): string {
  // `function NAME(` misses a generic like `function withBeatProvenance<T>(`.
  const decl = new RegExp(`function ${fn}\\s*[(<]`);
  const idx = src.search(decl);
  expect(idx, `${fn} not found`).toBeGreaterThan(-1);

  // Walk to the end of the parameter list.
  let i = src.indexOf("(", idx);
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")" && --parens === 0) break;
  }
  // The declaration line may carry an inline object RETURN TYPE, as searchGateDecision does:
  // `): { admitted: boolean; text: string } {`. The body's brace is the LAST one on that line.
  const eol = src.indexOf("\n", i);
  const declTail = src.slice(i, eol === -1 ? src.length : eol);
  const start = declTail.includes("{") ? i + declTail.lastIndexOf("{") : src.indexOf("{", i);

  let depth = 0;
  for (let j = start; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(idx, j + 1);
  }
  throw new Error(`unbalanced ${fn}`);
}

/** Every function that reaches a provider fetcher and must therefore carry the beat's proof. */
const SCOPED_LEAVES = [
  "fetchBeatAuthenticStills",
  "resolveBeatClipFast",
  "padShortClipWithNext",
  "fetchMuskGoldenStockBeat",
  "fetchBeatScriptImageClip",
  "fetchBeatScriptImageForced",
  "fetchPersonBeatClip",
  "fetchLastResortRealClip",
  "fetchBeatPersonStockVideo",
  "fetchBeatStockFallback",
  "resolveBeatClipTurbo",
  "adoptWikimediaBeatClip",
  "adoptStockBeatClipFallback",
  "adoptEmergencyGeoStockClip",
  // Found by the SECOND audit (RONDE 100B §15), not the first:
  "fetchBeatAuthenticVideo",   // → tryBeatRealYouTubeFootage → fetchYouTubeCCClips
  "rescueBeatVisualWhenEmpty", // → fetchWikimediaImages
];

/** Same contract, but this one carries only the beat's TEXT — see withBeatProvenance. */
const TEXT_ONLY_LEAVES = ["generateGuaranteedBeatClip"];

/** The whole provider surface. The first audit asked about five of these and came back clean. */
const PROVIDER_FETCHERS = [
  "fetchPexelsClips", "fetchPixabayClips", "fetchWikimediaVideos", "fetchWikimediaImages",
  "fetchSerpAPIImages", "fetchUnsplashImages", "fetchInternetArchiveClips",
  "fetchEuropeanaVideos", "fetchOpenverseImages", "fetchNasaVideoClips", "fetchNaraClips",
  "fetchGdeltTvNewsClips", "fetchSepiaSearchVideos", "fetchFlickrCCVideos",
  "fetchVimeoCCVideos", "fetchMediaCccVideos", "fetchYouTubeCCClips",
  "searchYoutubeVideoCandidates", "searchWebWideVideoClips",
];

/* ═══════════ §3/§4 — every provider route now has provenance ═══════════ */

describe("RONDE 100B §4 — the fallback ladders cannot reach a provider unproven", () => {
  it("TEST 1 — withBeatProvenance reuses an existing scope instead of replacing it", () => {
    const body = bodyOf(PIPELINE_SRC, "withBeatProvenance");
    // The guard, in the same shape scenePool.buildSceneCandidatePool uses.
    expect(body).toContain("if (getSearchProvenance()) return fn();");
    expect(body).toContain("withSearchProvenance(");
    expect(body).toContain("beatSearchProvenance(");
  });

  it("TEST 2 — every provider-reaching leaf opens a scope before its body runs", () => {
    for (const fn of SCOPED_LEAVES) {
      const wrapper = bodyOf(PIPELINE_SRC, fn);
      expect(wrapper, `${fn} has no provenance wrapper`).toContain("withBeatProvenance(beat, scene");
      expect(wrapper, `${fn} does not delegate to its body`).toContain(`${fn}Inner(`);
      // A wrapper that does anything else is a place for a search to escape.
      expect(PIPELINE_SRC, `${fn}Inner is missing`).toContain(`async function ${fn}Inner(`);
    }
  });

  it("TEST 3 — the wrapper is a wrapper: no provider call inside it", () => {
    const providers = [
      "fetchPexelsClips(", "fetchPixabayClips(", "fetchWikimediaVideos(",
      "fetchSerpAPIImages(", "fetchUnsplashImages(", "fetchWikimediaImages(",
      "fetchYouTubeCCClips(", "cachedProviderSearch(",
    ];
    for (const fn of SCOPED_LEAVES) {
      const wrapper = bodyOf(PIPELINE_SRC, fn);
      for (const p of providers) {
        expect(wrapper, `${fn}'s wrapper calls ${p} outside the scope`).not.toContain(p);
      }
    }
  });

  it("TEST 4 — Wikimedia now matches the two neighbours it was measured against", () => {
    // internet_archive and europeana reported bypassAttempts=0 in the same render that reported
    // wikimedia=64, and the only difference between the three adopters was this wrapper.
    for (const fn of ["adoptWikimediaBeatClip", "adoptInternetArchiveBeatClip", "adoptEuropeanaBeatClip"]) {
      const wrapper = bodyOf(PIPELINE_SRC, fn);
      expect(wrapper, `${fn} lost its scope`).toMatch(/withBeatProvenance|withSearchProvenance/);
    }
  });

  it("TEST 5 — Unsplash and SerpAPI are reached only through scoped leaves", () => {
    // Both routes reported 100%/most bypass in production. Their direct callers are these.
    for (const [fetcher, callers] of [
      ["fetchUnsplashImages", ["fetchBeatScriptImageForcedInner", "researchBeatClipUnifiedInner"]],
      ["fetchSerpAPIImages", ["fetchBeatAuthenticStillsInner", "fetchBeatScriptImageClipInner",
                              "fetchBeatScriptImageForcedInner", "fetchPersonBeatClipInner",
                              "tryBeatTopicRealFootageInner", "researchBeatClipUnifiedInner"]],
    ] as const) {
      for (const caller of callers) {
        expect(PIPELINE_SRC, `${caller} is gone — ${fetcher}'s scope chain changed`).toContain(
          `function ${caller}(`
        );
      }
    }
  });

  it("TEST 5a — the text-only leaf is scoped from the narration it does have", () => {
    for (const fn of TEXT_ONLY_LEAVES) {
      const wrapper = bodyOf(PIPELINE_SRC, fn);
      expect(wrapper, `${fn} has no provenance wrapper`).toContain("withBeatProvenance(");
      expect(wrapper).toContain(`${fn}Inner(`);
      // No beat/scene objects here — the proof comes from beatText.
      expect(wrapper).toContain("{ text: beatText");
    }
  });

  it("TEST 5b — every direct provider call now sits inside a scoped body", () => {
    /**
     * The structural check behind the whole round: find each call to a provider fetcher and name
     * the function it sits in. After this round every one of them is inside a `...Inner`, which
     * by TEST 2 can only be entered through a wrapper that opens the scope.
     *
     * fetchBrollClips is the single exception and cannot be wrapped the same way — it takes a
     * sceneIndex and a query list, not a beat and a scene, so there is no beat to prove. It is
     * covered by its callers instead, and those are pinned here rather than assumed, because
     * "surely it is always reached from a scoped path" is exactly the assumption that left 425
     * searches unproven in production.
     */
    const decls: Array<[number, string]> = [];
    PIPELINE_SRC.split("\n").forEach((l, i) => {
      const m = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/.exec(l);
      if (m) decls.push([i + 1, m[1]!]);
    });
    const enclosing = (line: number) => {
      let best = "(top level)";
      for (const [ln, name] of decls) {
        if (ln <= line) best = name;
        else break;
      }
      return best;
    };

    const offenders: string[] = [];
    /**
     * The FIRST audit listed five fetchers and came back clean. The second audit widened the list
     * and immediately found three more routes — fetchWikimediaImages was not on the original list
     * at all, and fetchYouTubeCCClips was reachable through fetchBeatAuthenticVideo. The list is
     * the whole provider surface now, so a new fetcher cannot hide by not being asked about.
     */
    for (const fetcher of PROVIDER_FETCHERS) {
      void [
      "fetchPexelsClips", "fetchPixabayClips", "fetchWikimediaVideos", "fetchWikimediaImages",
      "fetchSerpAPIImages", "fetchUnsplashImages", "fetchInternetArchiveClips",
      "fetchEuropeanaVideos", "fetchOpenverseImages", "fetchNasaVideoClips", "fetchNaraClips",
      "fetchGdeltTvNewsClips", "fetchSepiaSearchVideos", "fetchFlickrCCVideos",
      "fetchVimeoCCVideos", "fetchMediaCccVideos", "fetchYouTubeCCClips",
      "searchYoutubeVideoCandidates", "searchWebWideVideoClips",
      ];
      const re = new RegExp(`(?<![\\w.])${fetcher}\\s*\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(PIPELINE_SRC))) {
        const line = PIPELINE_SRC.slice(0, m.index).split("\n").length;
        const host = enclosing(line);
        // A helper is safe when every one of ITS callers is a scoped body — pinned below.
        const safeHelpers = new Set([
          "fetchBrollClips", "fetchBeatClipFromScript", "fetchBeatYoutubeThenPexels",
          "fetchBeatArchivalThenPexels", "fetchBeatYoutubeOnly", "tryBeatRealYouTubeFootage",
        ]);
        // One provider fetcher calling another (fetchYouTubeCCClips → searchYoutubeVideoCandidates)
        // says nothing about scope: what matters is how the OUTER one is reached, and every
        // fetcher in this list is checked for exactly that.
        if (host === fetcher || host.endsWith("Inner") || safeHelpers.has(host)) continue;
        if (PROVIDER_FETCHERS.includes(host)) continue;
        offenders.push(`${fetcher} called from ${host} (line ${line})`);
      }
    }
    expect(offenders, `unscoped provider callers:\n${offenders.join("\n")}`).toEqual([]);

    // And every safe helper's own callers must themselves be scoped bodies. This is the check
    // that turns "surely it is always reached from a scoped path" into something enforced.
    for (const helper of [
      "fetchBrollClips", "fetchBeatClipFromScript", "fetchBeatYoutubeThenPexels",
      "fetchBeatArchivalThenPexels", "fetchBeatYoutubeOnly", "tryBeatRealYouTubeFootage",
    ]) {
      const re = new RegExp(`(?<![\\w.])${helper}\\s*\\(`, "g");
      let m: RegExpExecArray | null;
      const hosts = new Set<string>();
      while ((m = re.exec(PIPELINE_SRC))) {
        const line = PIPELINE_SRC.slice(0, m.index).split("\n").length;
        const h = enclosing(line);
        if (h !== helper) hosts.add(h);
      }
      const helpers = new Set([
        "fetchBrollClips", "fetchBeatClipFromScript", "fetchBeatYoutubeThenPexels",
        "fetchBeatArchivalThenPexels", "fetchBeatYoutubeOnly", "tryBeatRealYouTubeFootage",
      ]);
      const unscoped = [...hosts].filter((h) => !h.endsWith("Inner") && !helpers.has(h));
      expect(unscoped, `${helper} is reachable unscoped from ${unscoped.join(", ")}`).toEqual([]);
    }
    expect(bodyOf(PIPELINE_SRC, "fetchBeatClipFromScript")).not.toContain("withBeatProvenance");
    expect(bodyOf(PIPELINE_SRC, "fetchBeatClipInner")).toContain("fetchBeatClipFromScript(");
  });

  it("TEST 6 — LEGACY_QUERY_BUILDER still means exactly one thing", () => {
    // If this ever gets minted somewhere else, the whole trace in RONDE 100A stops holding.
    const mints = CONTRACT_SRC.split("\n").filter((l) => l.includes('"LEGACY_QUERY_BUILDER"'));
    expect(mints.filter((l) => l.includes("rejectReason:"))).toHaveLength(1);
    expect(bodyOf(CONTRACT_SRC, "searchGateDecision")).toContain(
      "(ambient ? mintVerifiedQuery(text, ambient, { route }) : legacyQueryTicket(text, route))"
    );
  });
});

/* ═══════════ §5 — the reason is counted once ═══════════ */

describe("RONDE 100B §5 — one scope-less query, one tally", () => {
  it("TEST 7 — queriesBlocked no longer repeats the bypass reason", () => {
    const body = bodyOf(CONTRACT_SRC, "searchGateDecision");
    expect(body).toContain('searchGateAudit.record("bypassAttempts", provider, ticket.route, ticket.rejectReason)');
    expect(body).toContain('searchGateAudit.record("queriesBlocked", provider, ticket.route);');
    expect(body).not.toContain('record("queriesBlocked", provider, ticket.route, ticket.rejectReason)');
  });

  it("TEST 8 — the validator branch is unchanged, and the two branches now agree", () => {
    const body = bodyOf(CONTRACT_SRC, "searchGateDecision");
    expect(body).toContain('searchGateAudit.record("queriesRejected", provider, ticket.route, verdict.reason)');
    expect(body).toContain('searchGateAudit.record("queriesBlocked", provider, ticket.route);');
  });
});

/* ═══════════ §6 — no invented search terms ═══════════ */

describe("RONDE 100B §6 — a query says what the beat said", () => {
  it("TEST 9 — an empty context produces no query at all", () => {
    expect(scriptStockSearchQueries("", [], "", undefined)).toEqual([]);
  });

  it("TEST 10 — real content still produces a real query", () => {
    const q = scriptStockSearchQueries("Soviet forces closed in on Berlin in 1945", []);
    expect(q.length).toBeGreaterThan(0);
    expect(q.join(" ").toLowerCase()).toContain("berlin");
  });

  it("TEST 11 — a person still anchors the query", () => {
    expect(scriptStockSearchQueries("", ["Elon Musk"], "", undefined)).toEqual(["Elon Musk"]);
  });

  it("TEST 12 — 'premiere' no longer asks for a red carpet", () => {
    const body = bodyOf(PIPELINE_SRC, "scriptEventSearchQueries");
    // The word that goes out is the one the narration used.
    expect(body).toContain("const said = m?.[1]?.trim();");
    expect(body).not.toMatch(/out\.push\(p\("red carpet"\)\)/);
    expect(body).not.toContain('p("interview")');
  });

  it("TEST 13 — the two entries with no spoken word to fall back on are gone", () => {
    const body = bodyOf(PIPELINE_SRC, "scriptEventSearchQueries");
    expect(body).not.toContain("news conference");
    expect(body).not.toContain("business news");
    expect(body).not.toContain("scandal|controversy|backlash");
    expect(body).not.toContain("billion|million");
  });

  it("TEST 14 — a celebrity's name does not prove a red carpet, a makeup launch or fashion", () => {
    const idx = PIPELINE_SRC.indexOf("const REAL_ENTITY_RULES: RealEntityRule[] = [");
    const table = PIPELINE_SRC.slice(idx, PIPELINE_SRC.indexOf("\n];", idx));
    for (const invented of [
      "red carpet", "makeup launch", "interview", "keynote", "presentation",
      "unveiling", "production line", "archival footage", "documentary", "tour",
      '"celebrity"', '"fashion"', '"car"', '"brain"', '"technology"', '"satellite"', '"factory"',
    ]) {
      expect(table, `REAL_ENTITY_RULES still invents ${invented}`).not.toContain(invented);
    }
    // The names themselves survive — those ARE the entity.
    expect(table).toContain('"Kylie Jenner"');
    expect(table).toContain('"RMS Titanic"');
    expect(table).toContain('"Falcon 9"');
  });

  it("TEST 15 — 'truly' is in the beat and still is never chosen as the subject", () => {
    /**
     * The gate cannot help here and should not: the word IS in the beat, so it is properly
     * proven, and validateSearchQuery says ok. What "truly" is not is a subject — nothing it
     * names can appear in a shot. So the fix belongs where the subject is picked.
     */
    const ctx = emptyQueryContext("But here's what truly followed the aftermath.");
    expect(validateSearchQuery("truly", ctx).ok).toBe(true);

    const queries = scriptStockSearchQueries("But here's what truly followed the aftermath.", []);
    expect(queries.join(" ").toLowerCase()).not.toContain("truly");
  });

  it("TEST 16 — a query made only of production vocabulary has no anchor", () => {
    const ctx = emptyQueryContext("But here's what truly followed the aftermath.");
    const verdict = validateSearchQuery("documentary", ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("NO_CONTENT_ANCHOR");
  });

  it("TEST 17 — a word the beat really is about still passes", () => {
    const ctx = emptyQueryContext("Soviet forces closed in on Berlin in 1945.");
    expect(validateSearchQuery("Berlin 1945", ctx).ok).toBe(true);
    expect(validateSearchQuery("deutschland", ctx).ok).toBe(false);
  });
});

/* ═══════════ §8 — GDELT's own query language ═══════════ */

describe("RONDE 100B §8 — a station names a channel, not a subject", () => {
  it("TEST 17 — the GDELT field syntax is admitted like archive.org's", () => {
    for (const word of ["station", "cnn", "foxnews", "msnbc", "bbcnews"]) {
      expect(PRODUCTION_VOCABULARY.has(word), `${word} missing`).toBe(true);
    }
    // The precedent it follows.
    for (const word of ["title", "subject", "collection", "tvnews", "mediatype"]) {
      expect(PRODUCTION_VOCABULARY.has(word)).toBe(true);
    }
  });

  it("TEST 18 — a real GDELT query now passes when its person is proven", () => {
    const ctx = emptyQueryContext("Adolf Hitler spent his final days in the Führerbunker.");
    expect(validateSearchQuery('"Adolf Hitler" station:CNN', ctx).ok).toBe(true);
  });

  it("TEST 19 — the station does not smuggle an unproven subject through with it", () => {
    const ctx = emptyQueryContext("Adolf Hitler spent his final days in the Führerbunker.");
    const verdict = validateSearchQuery('"Winston Churchill" station:CNN', ctx);
    expect(verdict.ok).toBe(false);
  });

  it("TEST 20 — subject words are still NOT production vocabulary", () => {
    for (const word of ["city", "street", "skyline", "protest", "factory", "canal", "transport"]) {
      expect(PRODUCTION_VOCABULARY.has(word), `${word} was let in`).toBe(false);
    }
  });
});
