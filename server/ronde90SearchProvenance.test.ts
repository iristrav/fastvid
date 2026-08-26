/**
 * RONDE 90 — strict search provenance / zero-guess enforcement.
 *
 * RONDE 88 built a query builder that only combines proven terms. RONDE 89 put every provider
 * search behind one gate. Neither closed the hole, and the RONDE 89 report said so: the gate had
 * to be left permissive because NOTHING in the pipeline minted a verified query, so turning strict
 * mode on would have blocked every search there is.
 *
 * This round removes that excuse rather than the flag. The beat's proven context is ambient —
 * withSearchProvenance — so a bare string arriving at the gate is checked against what the script
 * actually says, which means strict mode can be the default and the invariant can BLOCK:
 *
 *     NO UNPROVEN CONTENT MAY REACH A SEARCH PROVIDER.
 *
 * Not "is logged". Not "is counted". Does not reach it.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";

import {
  PRODUCTION_VOCABULARY,
  buildPrioritisedQueries,
  emptyQueryContext,
  evidenceStem,
  formatSearchQueryAudit,
  isProductionWord,
  legacyQueryTicket,
  mintVerifiedQuery,
  provenToken,
  queryProper,
  rebuildFromVerifiedTokens,
  searchGateStrict,
  tokenEvidenceHolds,
  validateSearchQuery,
  type VerifiedQueryContext,
} from "./searchQueryContract";
import {
  admitProviderQuery,
  buildVerifiedQueryContextForBeat,
  cachedProviderSearch,
  getSearchProvenance,
  withSearchProvenance,
} from "./videoPipeline";

const PIPELINE_SRC = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const CONTRACT_SRC = readFileSync(path.join(__dirname, "searchQueryContract.ts"), "utf8");

/** Run `fn` with strict mode forced to a known state, then restore whatever was there. */
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

/* ═══════════ §1/§2 — strict is the default, and it blocks ═══════════ */

describe("RONDE 90 §1/§2 — the gate is closed unless somebody opens it", () => {
  it("TEST 1 — strict mode is on with no environment variable set at all", () => {
    const prev = process.env.SEARCH_GATE_STRICT;
    try {
      delete process.env.SEARCH_GATE_STRICT;
      expect(searchGateStrict()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SEARCH_GATE_STRICT;
      else process.env.SEARCH_GATE_STRICT = prev;
    }
  });

  it("TEST 2 — only the exact string \"false\" opens it", () => {
    for (const value of ["true", "", "0", "no", "FALSE", "off"]) {
      const prev = process.env.SEARCH_GATE_STRICT;
      process.env.SEARCH_GATE_STRICT = value;
      try {
        expect(searchGateStrict(), `SEARCH_GATE_STRICT=${JSON.stringify(value)}`).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.SEARCH_GATE_STRICT;
        else process.env.SEARCH_GATE_STRICT = prev;
      }
    }
  });

  it("TEST 3 — a bare string with no beat scope never reaches a provider", () => {
    withStrict(true, () => {
      expect(getSearchProvenance()).toBeUndefined();
      expect(admitProviderQuery("pexels", "moon landing", "test")).toBeNull();
    });
  });

  it("TEST 4 — a legacy ticket is unverified by construction, whatever it contains", () => {
    const ticket = legacyQueryTicket("Winston Churchill London 1940", "test");
    expect(ticket.verified).toBe(false);
    expect(ticket.rejectReason).toBe("LEGACY_QUERY_BUILDER");
    withStrict(true, () => {
      expect(admitProviderQuery("wikimedia", ticket, "test")).toBeNull();
    });
  });

  it("TEST 5 — inside a beat scope the SAME bare string is admitted, because the beat proves it", () => {
    const ctx = buildVerifiedQueryContextForBeat("Apollo 11 achieved the first moon landing.");
    withStrict(true, () => {
      withSearchProvenance(ctx, () => {
        expect(admitProviderQuery("pexels", "moon landing", "test")).toBe("moon landing");
      });
    });
  });

  it("TEST 6 — a word the beat does NOT contain is refused inside that same scope", () => {
    const ctx = buildVerifiedQueryContextForBeat("Apollo 11 achieved the first moon landing.");
    withStrict(true, () => {
      withSearchProvenance(ctx, () => {
        expect(admitProviderQuery("pexels", "moon landing conspiracy", "test")).toBeNull();
      });
    });
  });

  it("TEST 7 — the scope is per-call, not global: it does not leak to the next search", () => {
    const ctx = buildVerifiedQueryContextForBeat("Apollo 11 achieved the first moon landing.");
    withStrict(true, () => {
      withSearchProvenance(ctx, () => {
        expect(admitProviderQuery("pexels", "moon landing", "test")).toBe("moon landing");
      });
      expect(admitProviderQuery("pexels", "moon landing", "test")).toBeNull();
    });
  });

  it("TEST 8 — two concurrent beats cannot validate each other's queries", async () => {
    const berlin = buildVerifiedQueryContextForBeat("The Berlin Wall fell in 1989.");
    const apollo = buildVerifiedQueryContextForBeat("Apollo 11 achieved the first moon landing.");
    await withStrict(true, async () => {
      const [a, b] = await Promise.all([
        withSearchProvenance(berlin, async () => {
          await new Promise((r) => setTimeout(r, 5));
          return admitProviderQuery("pexels", "moon landing", "test");
        }),
        withSearchProvenance(apollo, async () => admitProviderQuery("pexels", "moon landing", "test")),
      ]);
      // The Berlin beat says nothing about a moon landing, and being interleaved with a beat that
      // does is not evidence. This is the cross-contamination a mutable per-render slot would
      // have allowed and AsyncLocalStorage does not.
      expect(a).toBeNull();
      expect(b).toBe("moon landing");
    });
  });
});

/* ═══════════ §3 — every content term is traceable ═══════════ */

describe("RONDE 90 §3 — a term carries its evidence, or it is not proven", () => {
  it("TEST 9 — a proven token records the text it came from and where in it", () => {
    const beat = "Churchill addressed the Commons in 1940.";
    const token = provenToken("Churchill", "person", "beat_text", beat);
    expect(token.evidence).toBe(beat);
    expect(token.start).toBe(0);
    expect(token.end).toBe("Churchill".length);
    expect(beat.slice(token.start!, token.end!)).toBe("Churchill");
  });

  it("TEST 10 — offsets are located in the evidence, never asserted by the caller", () => {
    const token = provenToken("Commons", "object", "beat_text", "Churchill addressed the Commons in 1940.");
    expect(tokenEvidenceHolds(token)).toBe(true);
    // A token whose offsets do not slice back to its own term is a claim that does not hold.
    expect(tokenEvidenceHolds({ ...token, start: 0, end: 7 })).toBe(false);
  });

  it("TEST 11 — the beat context carries the beat and scene text as its evidence", () => {
    const ctx = buildVerifiedQueryContextForBeat("Churchill addressed the Commons.", {
      sceneText: "It was the darkest hour of the war.",
    });
    expect(ctx.evidence).toContain("Churchill addressed the Commons.");
    expect(ctx.evidence).toContain("darkest hour");
  });

  it("TEST 12 — the video TITLE is deliberately not evidence", () => {
    const ctx = buildVerifiedQueryContextForBeat("She addressed the nation.", {
      scenePersons: ["Adolf Hitler"],
      sceneText: "The broadcast went out that evening.",
    });
    expect(ctx.evidence).not.toContain("Adolf");
    expect(validateSearchQuery("Adolf Hitler", ctx).ok).toBe(false);
  });

  it("TEST 13 — a word standing in the script proves itself even when no extractor typed it", () => {
    const ctx = buildVerifiedQueryContextForBeat("Amsterdam filled its canals with cyclists.");
    // "canal" is not a person, place, event or year — no extractor claims it. The script does.
    expect(validateSearchQuery("Amsterdam canal", ctx).ok).toBe(true);
    expect(validateSearchQuery("Amsterdam cyclist", ctx).ok).toBe(true);
  });

  it("TEST 13b — a word the script does NOT say is refused, however plausible it sounds", () => {
    const ctx = buildVerifiedQueryContextForBeat("Amsterdam filled its canals with cyclists.");
    // The relation between "cyclists" and "cycling" is derivational, not inflectional. A builder
    // that appends "cycling" to this beat is inferring, and the point of the round is that an
    // inference which happens to be right is still an inference.
    expect(validateSearchQuery("Amsterdam cycling", ctx).ok).toBe(false);
    expect(validateSearchQuery("Amsterdam bicycle lane", ctx).ok).toBe(false);
  });

  it("TEST 14 — matching is symmetric: singular proves plural and plural proves singular", () => {
    const plural = buildVerifiedQueryContextForBeat("The city rebuilt its bridges after the war.");
    expect(validateSearchQuery("bridge", plural).ok).toBe(true);
    const singular = buildVerifiedQueryContextForBeat("The city rebuilt its bridge after the war.");
    expect(validateSearchQuery("bridges", singular).ok).toBe(true);
  });

  it("TEST 14b — stemming is shallow enough that two different words never collapse", () => {
    expect(evidenceStem("canals")).toBe("canal");
    expect(evidenceStem("bus")).toBe("bus");
    expect(evidenceStem("gas")).toBe("gas");
    expect(evidenceStem("planes")).not.toBe(evidenceStem("plants"));
    expect(evidenceStem("cycling")).not.toBe(evidenceStem("cyclists"));
  });
});

/* ═══════════ §4/§5 — priority, and no name is ever lost ═══════════ */

describe("RONDE 90 §4/§5 — PERSON > PLACE/COUNTRY > the rest, and every name kept", () => {
  const leadQuery = (beat: string) => buildPrioritisedQueries(buildVerifiedQueryContextForBeat(beat))[0]?.query ?? "";

  it("TEST 15 — two persons and a place: all three survive, person first", () => {
    const q = leadQuery("Churchill and Roosevelt met at Casablanca.");
    expect(q).toContain("Churchill");
    expect(q).toContain("Roosevelt");
    expect(q.indexOf("Churchill")).toBeLessThan(q.indexOf("Casablanca"));
  });

  it("TEST 16 — three persons and a place: no name is silently dropped from the whole set", () => {
    const ctx = buildVerifiedQueryContextForBeat("Churchill, Roosevelt and Stalin met at Yalta.");
    const all = buildPrioritisedQueries(ctx).map((q) => q.query).join(" | ");
    for (const name of ["Churchill", "Roosevelt", "Stalin"]) {
      expect(all, `${name} lost`).toContain(name);
    }
  });

  it("TEST 17 — two persons, no place: the beat still produces queries", () => {
    const queries = buildPrioritisedQueries(
      buildVerifiedQueryContextForBeat("Hitler met Eva Braun shortly before the end.")
    );
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.map((q) => q.query).join(" | ")).toContain("Eva Braun");
  });

  it("TEST 18 — person + person + event keeps the event behind the names", () => {
    const q = leadQuery("Churchill and Roosevelt signed the Atlantic Charter.");
    expect(q.startsWith("Churchill")).toBe(true);
  });

  it("TEST 19 — person + place + year: the year never outranks the place", () => {
    const ctx = buildVerifiedQueryContextForBeat("Churchill visited Berlin in 1945.");
    const q = buildPrioritisedQueries(ctx)[0]?.query ?? "";
    expect(q.indexOf("Berlin")).toBeGreaterThan(-1);
    if (q.includes("1945")) expect(q.indexOf("Berlin")).toBeLessThan(q.indexOf("1945"));
  });

  it("TEST 20 — a place before a person is refused outright by the validator", () => {
    const ctx = buildVerifiedQueryContextForBeat("Churchill visited Berlin in 1945.");
    expect(validateSearchQuery("Berlin Churchill", ctx).reason).toBe("PERSON_AFTER_PLACE");
  });
});

/* ═══════════ §6/§7/§8 — no title persons, no pronouns, no LLM content ═══════════ */

describe("RONDE 90 §6/§7/§8 — the three sources a term may never come from", () => {
  it("TEST 21 — a title-inferred person is refused, and named as such", () => {
    const ctx = emptyQueryContext("The broadcast went out that evening.");
    ctx.persons.push({ term: "Adolf Hitler", type: "person", source: "title_inference", verified: false });
    const verdict = validateSearchQuery("Adolf Hitler France", ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("TITLE_INFERENCE_NOT_ALLOWED");
  });

  it("TEST 22 — an LLM-generated content term is refused, and named as such", () => {
    const ctx = emptyQueryContext("The city rebuilt after the war.");
    ctx.objects.push({ term: "phoenix", type: "object", source: "llm_generated", verified: false });
    expect(validateSearchQuery("phoenix", ctx).reason).toBe("LLM_GENERATED_TERM");
  });

  it("TEST 23 — a capitalised pronoun is refused with or without a context", () => {
    expect(validateSearchQuery("She France").reason).toBe("FORBIDDEN_PRONOUN");
    const ctx = buildVerifiedQueryContextForBeat("She addressed the nation after the fall of France.");
    expect(validateSearchQuery("She France", ctx).reason).toBe("FORBIDDEN_PRONOUN");
  });

  it("TEST 24 — the LLM cannot introduce a subject through the beat context either", () => {
    const ctx = buildVerifiedQueryContextForBeat("The city rebuilt after the war.");
    withStrict(true, () => {
      withSearchProvenance(ctx, () => {
        expect(admitProviderQuery("pexels", "phoenix rising metaphor", "llm")).toBeNull();
      });
    });
  });
});

/* ═══════════ §11 — the validator's full check set ═══════════ */

describe("RONDE 90 §11 — checks A through H, not just empty and pronoun", () => {
  const beatCtx = buildVerifiedQueryContextForBeat("Churchill visited Berlin in 1945.");

  it("TEST 25 — A: an empty query is refused", () => {
    expect(validateSearchQuery("").reason).toBe("EMPTY_QUERY");
    expect(validateSearchQuery("   ").reason).toBe("EMPTY_QUERY");
  });

  it("TEST 26 — C: an unprovable content word is refused and NAMED", () => {
    const verdict = validateSearchQuery("Churchill Berlin bunker", beatCtx);
    expect(verdict.reason).toBe("UNVERIFIED_TERM");
    expect(verdict.offendingTerm).toBe("bunker");
  });

  it("TEST 27 — G: a person token whose evidence does not contain it is refused", () => {
    const ctx = emptyQueryContext("Churchill visited Berlin in 1945.");
    ctx.persons.push({
      term: "Churchill", type: "person", source: "beat_text", verified: true,
      evidence: "Churchill visited Berlin in 1945.", start: 0, end: 4,
    });
    expect(validateSearchQuery("Churchill", ctx).reason).toBe("PERSON_WITHOUT_EVIDENCE");
  });

  it("TEST 28 — H: a query made only of camera vocabulary has no subject", () => {
    expect(validateSearchQuery("archival footage", beatCtx).reason).toBe("NO_CONTENT_ANCHOR");
    expect(validateSearchQuery("wide establishing aerial", beatCtx).reason).toBe("NO_CONTENT_ANCHOR");
  });

  it("TEST 29 — every blocked term is reported, not only the first one", () => {
    const verdict = validateSearchQuery("Churchill bunker submarine", beatCtx);
    expect(verdict.blockedTerms).toEqual(["bunker", "submarine"]);
  });

  it("TEST 30 — production vocabulary describes the footage and needs no proof", () => {
    for (const word of ["aerial", "archival", "footage", "timelapse", "historical", "restored"]) {
      expect(isProductionWord(word), word).toBe(true);
    }
    // …but a word that names a SUBJECT is not production vocabulary, however often a builder
    // appends it. This is the line the whole round turns on.
    for (const word of ["canal", "protest", "factory", "skyline", "bridge", "soldier"]) {
      expect(isProductionWord(word), word).toBe(false);
      expect(PRODUCTION_VOCABULARY.has(word), word).toBe(false);
    }
  });

  it("TEST 31 — a cache-key suffix is not content and is not judged as content", () => {
    expect(queryProper("Golden Gate archival footage#creative_common#n5")).toBe("Golden Gate archival footage");
    const ctx = buildVerifiedQueryContextForBeat("The Golden Gate Bridge opened in 1937.");
    expect(validateSearchQuery("Golden Gate#n12", ctx).ok).toBe(true);
  });
});

/* ═══════════ §12 — no silent repair ═══════════ */

describe("RONDE 90 §12 — a refused query is discarded, never trimmed and re-sent", () => {
  it("TEST 32 — the gate returns null and hands back nothing else", () => {
    const ctx = buildVerifiedQueryContextForBeat("Churchill visited Berlin in 1945.");
    withStrict(true, () => {
      withSearchProvenance(ctx, () => {
        expect(admitProviderQuery("wikimedia", "Churchill Berlin bunker", "test")).toBeNull();
      });
    });
  });

  it("TEST 33 — a rebuild is a NEW query from proven tokens, with its own provenance", () => {
    const ctx = buildVerifiedQueryContextForBeat("Churchill visited Berlin in 1945.");
    const rebuilt = rebuildFromVerifiedTokens(ctx, { route: "rebuild" });
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.verified).toBe(true);
    expect(rebuilt!.route).toBe("rebuild");
    expect(rebuilt!.query).not.toContain("bunker");
    expect(rebuilt!.tokens.length).toBeGreaterThan(0);
  });

  it("TEST 34 — a context that proves nothing rebuilds to null, not to a generic query", () => {
    expect(rebuildFromVerifiedTokens(emptyQueryContext(""), { route: "rebuild" })).toBeNull();
    expect(rebuildFromVerifiedTokens(undefined, { route: "rebuild" })).toBeNull();
  });

  it("TEST 35 — no call site quietly retries with a widened query after a refusal", () => {
    // MUTATION GUARD: `if (admit(...) === null) { query = something-else }` is the shape of the
    // silent repair this section forbids.
    expect(PIPELINE_SRC).not.toMatch(/admitProviderQuery\([^)]*\) === null\)[^;]*\{[^}]*\bquery\s*=/);
    expect(PIPELINE_SRC).not.toMatch(/searchGateDecision\([^)]*\)[^;]*\n[^}]*text\s*=\s*[^S]/);
  });
});

/* ═══════════ §13 — the audit line ═══════════ */

describe("RONDE 90 §13 — the log says which terms were proven and which were not", () => {
  it("TEST 36 — the audit line carries terms, blockedTerms and a reason", () => {
    const line = formatSearchQueryAudit({
      query: "Churchill Berlin bunker",
      provider: "wikimedia",
      route: "test",
      verified: false,
      terms: ["Churchill", "Berlin"],
      blockedTerms: ["bunker"],
      reason: "UNVERIFIED_TERM",
    });
    expect(line).toContain("[SearchQueryAudit]");
    expect(line).toContain('terms=["Churchill","Berlin"]');
    expect(line).toContain('blockedTerms=["bunker"]');
    expect(line).toContain("reason=UNVERIFIED_TERM");
    expect(line).toContain("verified=false");
  });

  it("TEST 37 — a refusal is logged even when nothing else is", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ctx = buildVerifiedQueryContextForBeat("Churchill visited Berlin in 1945.");
      withStrict(true, () => {
        withSearchProvenance(ctx, () => admitProviderQuery("wikimedia", "Churchill bunker", "test"));
      });
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("[SearchQueryAudit]"))).toBe(true);
      expect(lines.some((l) => l.includes("[SearchQueryRejected]"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("TEST 38 — the API key never appears in an audit line", () => {
    const line = formatSearchQueryAudit({
      query: "Churchill Berlin", provider: "wikimedia", route: "test", verified: true, terms: ["Churchill"],
    });
    expect(line).not.toMatch(/api[_-]?key|access[_-]?token|secret/i);
  });
});

/* ═══════════ §18 — THE INVARIANT ═══════════ */

describe("RONDE 90 §18 — NO UNPROVEN CONTENT MAY REACH A SEARCH PROVIDER", () => {
  /** Did the provider actually get asked? The only question this section cares about. */
  async function searchHappened(ctx: VerifiedQueryContext | undefined, query: string): Promise<boolean> {
    let called = false;
    const run = () =>
      cachedProviderSearch(undefined, "wikimedia", query, async () => {
        called = true;
        return [];
      }, "invariant");
    await withStrict(true, async () => {
      if (ctx) await withSearchProvenance(ctx, run);
      else await run();
    });
    return called;
  }

  const beat = "Churchill visited Berlin in 1945.";

  it("TEST 39 — the search function is NOT called for an unproven term", async () => {
    const ctx = buildVerifiedQueryContextForBeat(beat);
    expect(await searchHappened(ctx, "Churchill Berlin bunker")).toBe(false);
  });

  it("TEST 40 — the search function IS called for a fully proven query", async () => {
    const ctx = buildVerifiedQueryContextForBeat(beat);
    expect(await searchHappened(ctx, "Churchill Berlin")).toBe(true);
  });

  it("TEST 41 — no context at all means no search, for any query however innocent", async () => {
    expect(await searchHappened(undefined, "Churchill Berlin")).toBe(false);
    expect(await searchHappened(undefined, "archival footage")).toBe(false);
  });

  it("TEST 42 — blocking is enforcement, not logging: the refusal returns an empty result", async () => {
    const ctx = buildVerifiedQueryContextForBeat(beat);
    const out = await withStrict(true, async () =>
      withSearchProvenance(ctx, () =>
        cachedProviderSearch(undefined, "wikimedia", "Churchill bunker", async () => ["SHOULD NOT EXIST"], "invariant")
      )
    );
    expect(out).toEqual([]);
  });

  it("TEST 43 — none of the audit's four measured failures is BUILT any more", () => {
    // The gate proves TERMS; the builder proves STRUCTURE, and these four are structural
    // failures — every word in "Eva Braun Just" does stand in its source text, so no
    // term-by-term check can refuse it. What refuses it is that a person's name never spans a
    // function word, which is decided where the query is assembled.
    const cases: Array<[string, string]> = [
      ["Why Hitler Married Eva Braun Just Before The End", "Eva Braun Just"],
      ["Inside The Final Hours Of Adolf Hitler", "Of Adolf"],
      ["Why Stalin Purged His Own Generals", "Stalin Purged"],
      ["She addressed the nation after the fall of France", "She France"],
    ];
    for (const [source, badQuery] of cases) {
      const built = buildPrioritisedQueries(buildVerifiedQueryContextForBeat(source)).map((q) => q.query);
      expect(built.join(" | "), `${badQuery} was built`).not.toContain(badQuery);
    }
  });

  it("TEST 43b — the pronoun case is refused at the gate as well as at the builder", async () => {
    const ctx = buildVerifiedQueryContextForBeat("She addressed the nation after the fall of France.");
    expect(await searchHappened(ctx, "She France")).toBe(false);
  });
});

/* ═══════════ §16 — mutation tests: revert the fix, the test must fail ═══════════ */

describe("RONDE 90 §16 — M1–M15, each pinned to one thing that must not be undone", () => {
  it("M1 — strict mode defaulting back to off is caught", () => {
    expect(CONTRACT_SRC).toContain('return process.env.SEARCH_GATE_STRICT !== "false";');
    expect(CONTRACT_SRC).not.toContain('return process.env.SEARCH_GATE_STRICT === "true";');
  });

  it("M2 — removing the ambient scope from the gate is caught", () => {
    // RONDE 91: the decision lives in searchQueryContract now — same body, reachable by every
    // module rather than only by the file that happens to hold the beat loop.
    const idx = CONTRACT_SRC.indexOf("function searchGateDecision(");
    const body = CONTRACT_SRC.slice(idx, CONTRACT_SRC.indexOf("\n}", idx));
    expect(body).toContain("getSearchProvenance()");
    expect(body).toContain("mintVerifiedQuery(");
  });

  it("M3 — making an unverified ticket sendable in strict mode is caught", () => {
    withStrict(true, () => {
      expect(admitProviderQuery("pexels", legacyQueryTicket("Berlin", "m3"), "m3")).toBeNull();
    });
  });

  it("M4 — dropping the evidence field from the context is caught", () => {
    const ctx = buildVerifiedQueryContextForBeat("Churchill visited Berlin.");
    expect(typeof ctx.evidence).toBe("string");
    expect(ctx.evidence.length).toBeGreaterThan(0);
  });

  it("M5 — letting the video title back in as evidence is caught", () => {
    const src = PIPELINE_SRC.slice(PIPELINE_SRC.indexOf("export function buildVerifiedQueryContextForBeat("));
    const body = src.slice(0, src.indexOf("\n}\n"));
    expect(body).toContain("emptyQueryContext([text, (opts.sceneText ?? \"\").trim()]");
    expect(body).not.toMatch(/emptyQueryContext\(\[[^\]]*videoTitle/);
  });

  it("M6 — weakening the pronoun check is caught", () => {
    expect(validateSearchQuery("She France").ok).toBe(false);
    expect(validateSearchQuery("They Berlin").ok).toBe(false);
  });

  it("M7 — dropping the person-after-place ordering rule is caught", () => {
    const ctx = buildVerifiedQueryContextForBeat("Churchill visited Berlin in 1945.");
    expect(validateSearchQuery("Berlin Churchill", ctx).ok).toBe(false);
  });

  it("M8 — putting a SUBJECT word into the production vocabulary is caught", () => {
    for (const word of ["canal", "war", "bridge", "protest", "city", "people"]) {
      expect(PRODUCTION_VOCABULARY.has(word), `${word} must still need proof`).toBe(false);
    }
  });

  it("M9 — deepening the stemmer until different words collide is caught", () => {
    expect(evidenceStem("berlin")).toBe("berlin");
    // The relation must be symmetric — a canonical stem that only works in one direction is the
    // bug this replaced: "bridges" reduced to "bridge" while "bridge" stayed itself, so a beat
    // saying one never proved a query saying the other.
    const ctx = buildVerifiedQueryContextForBeat("The city rebuilt its bridges.");
    expect(validateSearchQuery("bridge", ctx).ok).toBe(true);
  });

  it("M10 — turning the rebuild into a silent in-gate repair is caught", () => {
    const idx = CONTRACT_SRC.indexOf("function searchGateDecision(");
    const body = CONTRACT_SRC.slice(idx, CONTRACT_SRC.indexOf("\n}", idx));
    expect(body).not.toContain("rebuildFromVerifiedTokens(");
  });

  it("M11 — removing the blockedTerms list from the validator is caught", () => {
    const ctx = buildVerifiedQueryContextForBeat("Churchill visited Berlin in 1945.");
    expect(validateSearchQuery("Churchill bunker submarine", ctx).blockedTerms).toHaveLength(2);
  });

  it("M12 — mintVerifiedQuery verifying without a context is caught", () => {
    const minted = mintVerifiedQuery("Berlin", undefined, { route: "m12" });
    expect(minted.verified).toBe(false);
    expect(minted.rejectReason).toBe("NO_SEARCH_CONTEXT");
  });

  it("M13 — un-scoping any of the beat entry points is caught", () => {
    for (const fn of [
      "beatPrimaryFetch",
      "tryBeatTopicRealFootage",
      "fetchHistoricalBeatVideo",
      "researchBeatClipUnified",
      "fetchBeatClip",
      "adoptInternetArchiveBeatClip",
      "adoptEuropeanaBeatClip",
      "fetchPersonCelebrityVideoClips",
      "fetchUniqueStockForBeat",
      "fetchBeatInternetStillsFirst",
    ]) {
      const idx = PIPELINE_SRC.indexOf(`function ${fn}(`);
      expect(idx, `${fn} not found`).toBeGreaterThan(-1);
      const body = PIPELINE_SRC.slice(idx, PIPELINE_SRC.indexOf("\n}", idx));
      expect(body, `${fn} lost its provenance scope`).toContain("withSearchProvenance(");
    }
  });

  it("M14 — validating the cache-key suffix as content again is caught", () => {
    const ctx = buildVerifiedQueryContextForBeat("The Golden Gate Bridge opened in 1937.");
    expect(validateSearchQuery("Golden Gate#creative_common#n5", ctx).ok).toBe(true);
  });

  it("M15 — a second, divergent gate implementation is caught", () => {
    // One decision function, called by both entry points. Two copies is how RONDE 89's gap
    // survived a round; the count is asserted so a third path cannot appear unnoticed.
    expect((CONTRACT_SRC.match(/function searchGateDecision\(/g) ?? []).length).toBe(1);
    expect((PIPELINE_SRC.match(/function searchGateDecision\(/g) ?? []).length).toBe(0);
    expect((PIPELINE_SRC.match(/searchGateDecision\(provider, query, route\)/g) ?? []).length).toBe(2);
  });
});

/* ═══════════ §19 — the earlier rounds still stand ═══════════ */

describe("RONDE 90 §19 — RONDE 87/88/89 untouched", () => {
  it("TEST 44 — lineage, funnel and final-video proof are still wired", () => {
    for (const anchor of [
      "markFinalVideo",
      "formatFunnelReport",
      "formatSourceSummary",
      "recordProviderDownloadOutcome",
      "tagPathWithProviderAsset",
    ]) {
      expect(PIPELINE_SRC, anchor).toContain(anchor);
    }
  });

  it("TEST 45 — the global budget and render concurrency are unchanged", () => {
    for (const anchor of ["withGlobalMediaFetch(", "withGlobalVisionGate(", "formatGlobalBudget("]) {
      expect(PIPELINE_SRC, anchor).toContain(anchor);
    }
  });

  it("TEST 46 — the render-scoped query cache still runs a query once", async () => {
    const ctx = buildVerifiedQueryContextForBeat("Churchill visited Berlin in 1945.");
    const cache = { queries: new Map(), assets: new Map(), metrics: new Map(),
      totals: { queryCacheHits: 0, queryCacheMisses: 0 } } as never;
    let calls = 0;
    await withStrict(true, async () =>
      withSearchProvenance(ctx, async () => {
        const run = () => cachedProviderSearch(cache, "wikimedia", "Churchill Berlin", async () => { calls++; return []; }, "r90");
        await run();
        await run();
      })
    );
    expect(calls).toBe(1);
  });

  it("TEST 47 — the gate counters still separate sent from blocked", () => {
    expect(CONTRACT_SRC).toContain('searchGateAudit.record("queriesSent"');
    expect(CONTRACT_SRC).toContain('searchGateAudit.record("queriesBlocked"');
    expect(CONTRACT_SRC).toContain('searchGateAudit.record("bypassAttempts"');
  });
});
