/**
 * RONDE 91 — final search-pipeline cleanup before the one-minute render.
 *
 * RONDE 90 made the invariant true: NO UNPROVEN CONTENT MAY REACH A SEARCH PROVIDER. This round
 * removes the last three ways around it and the two dead functions that were the obvious things
 * for a future call site to reach for:
 *
 *   · guardProviderQuery — a second, weaker gate with zero callers.
 *   · buildCombinedTypedQueries — a second combination engine with zero callers.
 *   · scenePool's eight provider searches and the Commons geosearch, which never passed the gate
 *     and structurally could not: videoPipeline imports both modules, so the gate had to move out
 *     of videoPipeline before they could reach it.
 *   · the visual-director plan, which was free to invent a subject and have it refused
 *     anonymously one round later.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import {
  buildPrioritisedQueries,
  emptyQueryContext,
  formatSearchQueryAudit,
  searchGateDecision,
  validateSearchQuery,
  withSearchProvenance,
} from "./searchQueryContract";
import {
  admitProviderQuery,
  buildVerifiedQueryContextForBeat,
  extractPersonNamesFromText,
  typedQueryPrefix,
} from "./videoPipeline";
import { directorSceneToIntent } from "./visualDirector";
import { directorSearchQueries } from "./scriptVisualKeywords";

const SERVER_DIR = __dirname;
const read = (f: string) => fs.readFileSync(path.join(SERVER_DIR, f), "utf8");
const PIPELINE_SRC = read("videoPipeline.ts");
const CONTRACT_SRC = read("searchQueryContract.ts");
const RESEARCH_SRC = read("mediaResearchEngine.ts");
const POOL_SRC = read("scenePool.ts");
const GEO_SRC = read("wikimediaGeoSearch.ts");

/** Every non-test source file in server/, for the repo-wide bypass scans. */
function serverSources(): Array<{ file: string; src: string }> {
  return fs
    .readdirSync(SERVER_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(SERVER_DIR, f), "utf8") }));
}

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

/* ═══════════ §1 — the dead guard is gone and stays gone ═══════════ */

describe("RONDE 91 §1 — one gate, not two", () => {
  it("TEST 1 — guardProviderQuery no longer exists anywhere in server/", () => {
    for (const { file, src } of serverSources()) {
      const mentions = src.split("\n").filter((l) => l.includes("guardProviderQuery"));
      // The removal note names it; nothing else may.
      for (const line of mentions) {
        expect(line, `${file}: guardProviderQuery is back`).toMatch(/RONDE 91|^\s*\*/);
      }
    }
    expect(PIPELINE_SRC).not.toContain("export function guardProviderQuery(");
  });

  it("TEST 2 — there is exactly one gate decision, and it is exported from the contract", () => {
    expect((CONTRACT_SRC.match(/function searchGateDecision\(/g) ?? []).length).toBe(1);
    let definitions = 0;
    for (const { src } of serverSources()) {
      definitions += (src.match(/function searchGateDecision\(/g) ?? []).length;
    }
    expect(definitions).toBe(1);
  });

  it("TEST 3 — no module defines its own validate-then-send helper beside the gate", () => {
    // The shape guardProviderQuery had: validate, log, return the query or null. A second copy of
    // that is a second gate whatever it is called.
    for (const { file, src } of serverSources()) {
      if (file === "searchQueryContract.ts") continue;
      const copies = src.match(/validateSearchQuery\([^)]*\)[\s\S]{0,200}?return\s+query\s*;/g) ?? [];
      expect(copies, `${file} holds a second gate`).toHaveLength(0);
    }
  });
});

/* ═══════════ §2 — one combination engine ═══════════ */

describe("RONDE 91 §2 — one combination engine", () => {
  it("TEST 4 — buildCombinedTypedQueries is gone", () => {
    const live = RESEARCH_SRC.split("\n").filter(
      (l) => l.includes("buildCombinedTypedQueries") && !l.trim().startsWith("*")
    );
    expect(live).toHaveLength(0);
  });

  it("TEST 5 — the historical archival route still goes through the one builder", () => {
    expect(RESEARCH_SRC).toContain("export function centralTypedQueries(");
    expect(RESEARCH_SRC).toContain("buildPrioritisedQueries(q).map((x) => x.query)");
    const idx = RESEARCH_SRC.indexOf("export function buildHistoricalArchivalQueries(");
    expect(idx).toBeGreaterThan(-1);
    expect(RESEARCH_SRC.slice(idx, idx + 3000)).toContain("centralTypedQueries(");
  });

  it("TEST 6 — historical template terms are not marked proven, so strict mode blocks them", () => {
    // buildHistoricalArchivalQueries appends anchor phrasings the beat never states. They arrive
    // at the gate as bare strings and are judged against the beat, exactly like any other guess.
    const ctx = buildVerifiedQueryContextForBeat("The city was heavily bombed.");
    withStrict(true, () =>
      withSearchProvenance(ctx, () => {
        expect(admitProviderQuery("internet_archive", "wartime Europe archival footage", "hist")).toBeNull();
        expect(admitProviderQuery("internet_archive", "WWII soldiers", "hist")).toBeNull();
      })
    );
  });
});

/* ═══════════ §3 — the LLM may select, never add ═══════════ */

describe("RONDE 91 §3 — the director plan cannot introduce a subject", () => {
  const planFor = (spoken: string, searchQuery: string) =>
    directorSceneToIntent({
      source_sentence_index: 0,
      spoken_text: spoken,
      visual_description: searchQuery,
      camera_shot: "medium shot",
      emotion: "tension",
      search_query: searchQuery,
    });

  it("TEST 7 — a plan term the sentence states is kept", () => {
    const queries = directorSearchQueries(planFor("Hitler met Eva Braun in the bunker.", "Hitler Eva Braun bunker"));
    // sanitizeVisualKeyword lower-cases what the plan returns; the subject survives, its casing
    // is not the point.
    expect(queries.join(" | ").toLowerCase()).toContain("hitler");
    expect(queries.length).toBeGreaterThan(0);
  });

  it("TEST 8 — a plan term the sentence does NOT state is discarded", () => {
    // The brief's own example: the script says one thing, the model returns four more.
    const queries = directorSearchQueries(planFor("Hitler met Eva Braun.", "Hitler Eva Braun Berlin bunker Germany"));
    expect(queries).toEqual([]);
  });

  it("TEST 9 — the discard is logged as LLM_UNPROVEN_CONTENT, naming who guessed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      directorSearchQueries(planFor("Hitler met Eva Braun.", "Hitler Eva Braun Berlin bunker Germany"));
      const lines = warn.mock.calls.map((c) => String(c[0]));
      const audit = lines.find((l) => l.includes("LLM_UNPROVEN_CONTENT"));
      expect(audit, "no LLM_UNPROVEN_CONTENT line").toBeTruthy();
      expect(audit).toContain("status=BLOCKED");
      expect(audit).toContain("route=directorSearchQueries");
    } finally {
      warn.mockRestore();
    }
  });

  it("TEST 10 — a plan with no sentence to check against proves nothing", () => {
    expect(directorSearchQueries(planFor("", "Berlin bunker Germany"))).toEqual([]);
  });

  it("TEST 11 — the prompt no longer asks the model to infer", () => {
    const src = read("visualDirector.ts");
    expect(src).not.toContain("clearly implied by the sentence/subject");
    expect(src).toContain("EVERY content word in search_query must appear in THIS SENTENCE");
  });
});

/* ═══════════ §4 — every provider stays behind the one gate ═══════════ */

describe("RONDE 91 §4 — no provider search has an alternative route", () => {
  it("TEST 12 — the scene candidate pool consults the gate for every provider", () => {
    for (const fn of [
      "searchPexelsCandidates",
      "searchPixabayCandidates",
      "searchWikimediaCandidates",
      "searchInternetArchiveCandidates",
      "searchEuropeanaCandidates",
      "searchOpenverseCandidates",
      "searchNasaCandidates",
      "searchNaraCandidates",
    ]) {
      const idx = POOL_SRC.indexOf(`function ${fn}(`);
      expect(idx, `${fn} missing`).toBeGreaterThan(-1);
      expect(POOL_SRC.slice(idx, idx + 4000), `${fn} bypasses the gate`).toContain("searchGateDecision(");
    }
  });

  it("TEST 13 — the Commons geosearch is gated on the place it actually asks about", () => {
    expect(GEO_SRC).toContain('searchGateDecision("wikimedia"');
    const idx = GEO_SRC.indexOf("export async function fetchWikimediaGeoImageTitles(");
    const body = GEO_SRC.slice(idx, GEO_SRC.indexOf("\n}", idx));
    // Gated BEFORE the request is built, not after it comes back.
    expect(body.indexOf("searchGateDecision(")).toBeLessThan(body.indexOf("await fetch("));
  });

  it("TEST 14 — every provider-search function in server/ reaches the gate", () => {
    const HOSTS = [
      "api.pexels.com", "pixabay.com/api", "commons.wikimedia.org", "api.openverse.org",
      "api.unsplash.com", "googleapis.com/youtube", "serpapi.com", "SEPIA_SEARCH_API",
      "GDELT_TV_API", "api.europeana.eu", "api.vimeo.com", "api.media.ccc.de",
      "images-api.nasa.gov", "catalog.archives.gov", "archive.org/advancedsearch",
      "flickr.com/services",
    ];
    const urlish = /(new URL\(|searchUrl|apiUrl|fetchWithTimeout\(|await fetch\()/;
    const fnHead = /^(?:export )?(?:async )?function (\w+)/;
    const ungated: string[] = [];
    for (const { file, src } of serverSources()) {
      const lines = src.split("\n");
      let current: string | null = null;
      const seen = new Set<string>();
      for (const [i, line] of lines.entries()) {
        const head = fnHead.exec(line);
        if (head) current = head[1]!;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (!HOSTS.some((h) => line.includes(h)) || !urlish.test(line)) continue;
        if (!current || seen.has(current)) continue;
        seen.add(current);
        const body = src.slice(src.indexOf(`function ${current}(`), src.indexOf(`function ${current}(`) + 14000);
        const gated =
          body.includes("admitProviderQuery(") ||
          body.includes("cachedProviderSearch(") ||
          body.includes("searchGateDecision(");
        if (!gated) ungated.push(`${file}:${i + 1} ${current}`);
      }
    }
    expect(ungated, `direct provider calls outside the gate:\n${ungated.join("\n")}`).toEqual([]);
  });
});

/* ═══════════ §5 — one unproven term blocks the WHOLE query ═══════════ */

describe("RONDE 91 §5 — the query is rejected, not trimmed", () => {
  const ctx = buildVerifiedQueryContextForBeat("Hitler stood in Berlin as the city burned.");

  it("TEST 15 — \"Hitler Berlin Germany\" is blocked when Germany is not in the source", () => {
    withStrict(true, () =>
      withSearchProvenance(ctx, () => {
        expect(admitProviderQuery("wikimedia", "Hitler Berlin Germany", "r91")).toBeNull();
      })
    );
  });

  it("TEST 16 — the proven prefix is NOT quietly sent instead", () => {
    const sent: string[] = [];
    withStrict(true, () =>
      withSearchProvenance(ctx, () => {
        const out = admitProviderQuery("wikimedia", "Hitler Berlin Germany", "r91");
        if (out) sent.push(out);
      })
    );
    expect(sent).toEqual([]);
    expect(sent).not.toContain("Hitler Berlin");
  });

  it("TEST 17 — the unproven term is not re-labelled as context to smuggle it through", () => {
    const verdict = validateSearchQuery("Hitler Berlin Germany", ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.offendingTerm).toBe("Germany");
    // Nothing in the context claims Germany, under any type.
    const everyTerm = [
      ...ctx.persons, ...ctx.places, ...ctx.countries, ...ctx.events,
      ...ctx.actions, ...ctx.objects, ...ctx.time, ...ctx.years,
    ].map((t) => t.term.toLowerCase());
    expect(everyTerm.join(" ")).not.toContain("germany");
  });

  it("TEST 18 — an independently rebuilt query from proven tokens IS allowed", () => {
    withStrict(true, () =>
      withSearchProvenance(ctx, () => {
        expect(admitProviderQuery("wikimedia", "Hitler Berlin", "r91")).toBe("Hitler Berlin");
      })
    );
  });
});

/* ═══════════ §6/§7 — names survive, and lead ═══════════ */

describe("RONDE 91 §6/§7 — PERSON > PLACE/COUNTRY > the rest, every name kept", () => {
  it("TEST 19 — \"Hitler met Eva Braun shortly before the end of the war.\"", () => {
    const all = typedQueryPrefix("Hitler met Eva Braun shortly before the end of the war.").join(" | ");
    expect(all).toContain("Hitler");
    expect(all).toContain("Eva Braun");
  });

  it("TEST 20 — \"Churchill and Roosevelt met at Casablanca.\"", () => {
    const queries = typedQueryPrefix("Churchill and Roosevelt met at Casablanca.");
    expect(queries[0]).toBe("Churchill Roosevelt Casablanca");
    expect(queries.join(" | ")).toContain("Casablanca");
  });

  it("TEST 21 — \"Churchill, Roosevelt and Stalin met in Yalta.\" keeps all three", () => {
    const all = typedQueryPrefix("Churchill, Roosevelt and Stalin met in Yalta.").join(" | ");
    for (const name of ["Churchill", "Roosevelt", "Stalin", "Yalta"]) {
      expect(all, `${name} lost`).toContain(name);
    }
  });

  it("TEST 22 — no separator loses a name: comma, \"and\", \"&\" all coordinate", () => {
    for (const beat of [
      "Churchill, Roosevelt and Stalin met in Yalta.",
      "Churchill and Roosevelt and Stalin met in Yalta.",
      "Churchill & Roosevelt met in Yalta.",
    ]) {
      const names = extractPersonNamesFromText(beat);
      expect(names, beat).toContain("Churchill");
      expect(names, beat).toContain("Roosevelt");
    }
  });

  it("TEST 23 — a place never precedes a person in any emitted query", () => {
    const beat = "Churchill, Roosevelt and Stalin met in Yalta.";
    const ctx = buildVerifiedQueryContextForBeat(beat);
    const people = ctx.persons.filter((p) => p.verified).map((p) => p.term);
    for (const query of buildPrioritisedQueries(ctx).map((x) => x.query)) {
      if (!query.includes("Yalta")) continue;
      const named = people.filter((p) => query.includes(p));
      for (const person of named) {
        expect(query.indexOf(person), `${query}: place before person`).toBeLessThan(query.indexOf("Yalta"));
      }
    }
  });

  it("TEST 24 — \"She addressed the nation after the fall of France.\" has no person", () => {
    const beat = "She addressed the nation after the fall of France.";
    expect(buildVerifiedQueryContextForBeat(beat).persons.filter((p) => p.verified)).toEqual([]);
    for (const query of typedQueryPrefix(beat)) expect(query).not.toMatch(/\bShe\b/);
  });

  it("TEST 25 — only literally proven words survive on an object beat", () => {
    const ctx = buildVerifiedQueryContextForBeat("The bridges of Amsterdam were crowded with bicycles.");
    expect(validateSearchQuery("Amsterdam bridges bicycles", ctx).ok).toBe(true);
    expect(validateSearchQuery("Amsterdam canal boats", ctx).ok).toBe(false);
  });

  it("TEST 26 — and on a workplace beat", () => {
    const ctx = buildVerifiedQueryContextForBeat("The factory workers gathered in Rotterdam.");
    expect(validateSearchQuery("Rotterdam factory workers", ctx).ok).toBe(true);
    expect(validateSearchQuery("Rotterdam factory strike", ctx).ok).toBe(false);
  });
});

/* ═══════════ §8 — the title cannot leak into a beat ═══════════ */

describe("RONDE 91 §8 — a title is not evidence", () => {
  const TITLE_CASES: Array<[string, string]> = [
    ["Why Hitler Married Eva Braun", "The city was heavily bombed."],
    ["Why Hitler Married Eva Braun", "The final buildings were destroyed."],
    ["Inside The Final Hours Of Adolf Hitler", "Snow fell over the empty square."],
    ["The Untold Story Of Eva Braun", "The radio broadcast ended at midnight."],
  ];

  it("TEST 27 — a title person never enters a beat that does not name them", () => {
    for (const [title, beat] of TITLE_CASES) {
      const ctx = buildVerifiedQueryContextForBeat(beat, {
        scenePersons: extractPersonNamesFromText(title),
        sceneText: beat,
      });
      expect(ctx.persons.filter((p) => p.verified), `${title} leaked into "${beat}"`).toEqual([]);
      expect(ctx.evidence).not.toMatch(/Hitler|Eva Braun/);
    }
  });

  it("TEST 28 — and cannot reach a provider through the gate either", () => {
    const [title, beat] = TITLE_CASES[0]!;
    const ctx = buildVerifiedQueryContextForBeat(beat, {
      scenePersons: extractPersonNamesFromText(title),
      sceneText: beat,
    });
    withStrict(true, () =>
      withSearchProvenance(ctx, () => {
        expect(admitProviderQuery("wikimedia", "Hitler Eva Braun", "title-leak")).toBeNull();
        expect(admitProviderQuery("wikimedia", "Eva Braun", "title-leak")).toBeNull();
      })
    );
  });
});

/* ═══════════ §10 — topic anchors are system context, not source text ═══════════ */

describe("RONDE 91 §10 — a system rule cannot forge the script", () => {
  it("TEST 29 — no topic anchor is ever minted as a proven token", () => {
    // provenToken(..., "beat_text") is called in exactly two places, and both read a beat.
    const callers = [PIPELINE_SRC, RESEARCH_SRC]
      .flatMap((src) => src.split("\n").filter((l) => l.includes("provenToken(") && !l.trim().startsWith("*")));
    for (const line of callers) {
      expect(line, `topic anchor minted as proven: ${line}`).not.toMatch(/anchor|eventTerm|BEAT_TOPIC/i);
    }
  });

  it("TEST 30 — the wwii rule's anchors are blocked on a beat that only says \"nazi\"", () => {
    const ctx = buildVerifiedQueryContextForBeat("The nazi columns entered the square.");
    // "nazi" is in the beat and passes; the words the rule ADDS do not.
    expect(validateSearchQuery("nazi columns", ctx).ok).toBe(true);
    for (const anchor of ["World War II", "wartime Europe", "WWII soldiers"]) {
      expect(validateSearchQuery(anchor, ctx).ok, anchor).toBe(false);
    }
  });

  it("TEST 31 — and they are blocked at the provider gate, not merely unproven", () => {
    const ctx = buildVerifiedQueryContextForBeat("The nazi columns entered the square.");
    withStrict(true, () =>
      withSearchProvenance(ctx, () => {
        expect(admitProviderQuery("internet_archive", "wartime Europe", "anchor")).toBeNull();
      })
    );
  });
});

/* ═══════════ §11 — the audit answers "why was this allowed?" ═══════════ */

describe("RONDE 91 §11 — the log is the answer, not a hint", () => {
  it("TEST 32 — a BLOCKED line carries status, reason, terms and blockedTerms", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ctx = buildVerifiedQueryContextForBeat("Hitler stood in Berlin.");
      withStrict(true, () =>
        withSearchProvenance(ctx, () => admitProviderQuery("wikimedia", "Hitler Berlin Germany", "r91"))
      );
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[SearchQueryAudit]"));
      expect(line).toBeTruthy();
      expect(line).toContain("status=BLOCKED");
      expect(line).toContain("provider=wikimedia");
      expect(line).toContain("route=r91");
      expect(line).toContain('blockedTerms=["Germany"]');
      expect(line).toContain("reason=UNVERIFIED_TERM");
    } finally {
      warn.mockRestore();
    }
  });

  it("TEST 33 — an ALLOWED line names the proven terms it was allowed on", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const prev = process.env.SEARCH_QUERY_AUDIT_LOG;
    process.env.SEARCH_QUERY_AUDIT_LOG = "true";
    try {
      const ctx = buildVerifiedQueryContextForBeat("Hitler stood in Berlin.");
      withStrict(true, () =>
        withSearchProvenance(ctx, () => admitProviderQuery("wikimedia", "Hitler Berlin", "r91"))
      );
      const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[SearchQueryAudit]"));
      expect(line).toBeTruthy();
      expect(line).toContain("status=ALLOWED");
      expect(line).toContain("verified=true");
      expect(line).toMatch(/terms=\[.*Hitler.*\]/);
    } finally {
      log.mockRestore();
      if (prev === undefined) delete process.env.SEARCH_QUERY_AUDIT_LOG;
      else process.env.SEARCH_QUERY_AUDIT_LOG = prev;
    }
  });

  it("TEST 34 — status and verified are separate facts", () => {
    // An unverified query is BLOCKED under strict mode and ALLOWED without it. One field cannot
    // carry both answers, which is why RONDE 91 added the second one.
    const blocked = formatSearchQueryAudit({ query: "x", verified: false, status: "BLOCKED" });
    const allowed = formatSearchQueryAudit({ query: "x", verified: false, status: "ALLOWED" });
    expect(blocked).toContain("status=BLOCKED");
    expect(blocked).toContain("verified=false");
    expect(allowed).toContain("status=ALLOWED");
    expect(allowed).toContain("verified=false");
  });

  it("TEST 35 — no credential ever appears in an audit line", () => {
    const line = formatSearchQueryAudit({
      query: "Hitler Berlin", provider: "wikimedia", route: "r91", verified: true, status: "ALLOWED",
    });
    expect(line).not.toMatch(/api[_-]?key|access[_-]?token|secret|authorization/i);
  });
});

/* ═══════════ §13 — mutation tests M1–M8 ═══════════ */

describe("RONDE 91 §13 — M1–M8: each mutation must turn something red", () => {
  it("M1 — central gate bypass: a search that skips the decision is caught", () => {
    // Both pipeline entry points, and every out-of-file provider search, must reach it.
    expect((PIPELINE_SRC.match(/searchGateDecision\(provider, query, route\)/g) ?? []).length).toBe(2);
    expect((POOL_SRC.match(/searchGateDecision\(/g) ?? []).length).toBe(8);
    expect(GEO_SRC).toContain("searchGateDecision(");
  });

  it("M2 — combined builder bypass: a second combination engine is caught", () => {
    let engines = 0;
    for (const { src } of serverSources()) {
      engines += (src.match(/export function buildPrioritisedQueries\(/g) ?? []).length;
    }
    expect(engines).toBe(1);
    expect(RESEARCH_SRC).not.toMatch(/^function buildCombinedTypedQueries\(/m);
  });

  it("M3 — an LLM term marked as verified is caught", () => {
    const ctx = emptyQueryContext("Hitler met Eva Braun.");
    ctx.objects.push({ term: "bunker", type: "object", source: "llm_generated", verified: false });
    expect(validateSearchQuery("Hitler bunker", ctx).reason).toBe("LLM_GENERATED_TERM");
    // And the director route cannot hand one through either.
    expect(
      directorSearchQueries(
        directorSceneToIntent({
          source_sentence_index: 0,
          spoken_text: "Hitler met Eva Braun.",
          visual_description: "Berlin bunker Germany",
          camera_shot: "wide",
          emotion: "tension",
          search_query: "Berlin bunker Germany",
        })
      )
    ).toEqual([]);
  });

  it("M4 — a topic anchor marked as beat_text is caught", () => {
    const ctx = buildVerifiedQueryContextForBeat("The nazi columns entered the square.");
    const proven = [...ctx.persons, ...ctx.places, ...ctx.countries, ...ctx.events, ...ctx.objects]
      .filter((t) => t.verified)
      .map((t) => t.term.toLowerCase())
      .join(" ");
    expect(proven).not.toContain("world war");
    expect(proven).not.toContain("wartime europe");
  });

  it("M5 — dropping the third person is caught", () => {
    const all = typedQueryPrefix("Churchill, Roosevelt and Stalin met in Yalta.").join(" | ");
    expect(all).toContain("Stalin");
  });

  it("M6 — injecting a title person into a beat is caught", () => {
    const ctx = buildVerifiedQueryContextForBeat("The final buildings were destroyed.", {
      scenePersons: ["Adolf Hitler", "Eva Braun"],
      sceneText: "The final buildings were destroyed.",
    });
    expect(ctx.persons.filter((p) => p.verified)).toEqual([]);
  });

  it("M7 — accepting a pronoun as a person is caught", () => {
    expect(extractPersonNamesFromText("She addressed the nation after the fall of France.")).not.toContain("She");
    expect(validateSearchQuery("She France").reason).toBe("FORBIDDEN_PRONOUN");
  });

  it("M8 — restoring a direct provider call is caught", () => {
    // The same repo-wide scan TEST 14 runs, stated here as the mutation it guards: adding a
    // provider search that does not consult the gate turns this red.
    const idx = POOL_SRC.indexOf("function searchPexelsCandidates(");
    const body = POOL_SRC.slice(idx, POOL_SRC.indexOf("\n}", idx));
    expect(body.indexOf("searchGateDecision(")).toBeGreaterThan(-1);
    expect(body.indexOf("searchGateDecision(")).toBeLessThan(body.indexOf("api.pexels.com"));
  });
});

/* ═══════════ §14 — RONDE 87–90 still stand ═══════════ */

describe("RONDE 91 §14 — nothing from the earlier rounds was traded away", () => {
  it("TEST 36 — lineage, final-video proof and provider tagging", () => {
    for (const anchor of [
      "markFinalVideo", "formatFunnelReport", "formatSourceSummary",
      "recordProviderDownloadOutcome", "tagPathWithProviderAsset", "UNVERIFIED_PROVIDER",
    ]) {
      expect(PIPELINE_SRC, anchor).toContain(anchor);
    }
  });

  it("TEST 37 — global budget, concurrency and the render-scoped caches", () => {
    for (const anchor of [
      "withGlobalMediaFetch(", "withGlobalVisionGate(", "formatGlobalBudget(",
      "providerQueryCacheKey(", "queryCacheHits", "usedContentKeys",
    ]) {
      expect(PIPELINE_SRC, anchor).toContain(anchor);
    }
  });

  it("TEST 38 — strict provenance is still the default", () => {
    expect(CONTRACT_SRC).toContain('return process.env.SEARCH_GATE_STRICT !== "false";');
  });

  it("TEST 39 — the beat entry points still put the beat's proof in scope", () => {
    for (const fn of [
      "beatPrimaryFetch", "tryBeatTopicRealFootage", "fetchHistoricalBeatVideo",
      "researchBeatClipUnified", "fetchBeatClip", "adoptInternetArchiveBeatClip",
      "adoptEuropeanaBeatClip", "fetchPersonCelebrityVideoClips", "fetchUniqueStockForBeat",
      "fetchBeatInternetStillsFirst",
    ]) {
      const idx = PIPELINE_SRC.indexOf(`function ${fn}(`);
      expect(idx, `${fn} missing`).toBeGreaterThan(-1);
      expect(
        PIPELINE_SRC.slice(idx, PIPELINE_SRC.indexOf("\n}", idx)),
        `${fn} lost its provenance scope`
      ).toContain("withSearchProvenance(");
    }
  });

  it("TEST 40 — the gate still counts what it did", () => {
    const decision = withStrict(false, () => searchGateDecision("pexels", "anything at all", "r91-count"));
    expect(decision.admitted).toBe(true);
    expect(withStrict(true, () => searchGateDecision("pexels", "anything at all", "r91-count")).admitted).toBe(false);
  });
});
