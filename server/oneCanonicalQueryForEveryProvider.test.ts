/**
 * ONE CANONICAL QUERY, AT THE ONE BOUNDARY EVERY PROVIDER PASSES.
 *
 * ── The claim this file exists to stop me repeating ─────────────────────────────────────────
 *
 * The previous round reported that the two-concept policy sat "before every provider adapter".
 * Render 594 measured it and it was false. `narrowToSubjectPlusConcept` was applied inside
 * `buildVisualSearchPlan`, and the plan is ONE consumer; these went out to real providers:
 *
 *     single documentary footage        → fetchWikimediaVideos
 *     kanye documentary footage         → fetchWikimediaVideos
 *     tweet documentary footage         → fetchWikimediaVideos
 *     Rumors kardashians Kardashian     → fetchWikimediaVideos
 *     kanye other                       → fetchWikimediaVideos
 *     Kris Jenner New York City bombard → pexels · pixabay · europeana · sepiasearch · web_wide
 *     Kris Jenner Kardashian Rumors about the → internet_archive
 *
 * None of those came from the plan. The previous round's test measured
 * `buildBeatQueryEscalationTiers` and found it clean — a true statement about the wrong builder.
 *
 * ── What is asserted here instead ───────────────────────────────────────────────────────────
 *
 * The boundary, not a builder. `searchGateDecision` is the one function every provider route
 * already calls, so these tests drive IT and check the text a provider would actually receive.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  emptyQueryContext,
  narrowToCanonicalQuery,
  searchGateDecision,
  semanticConceptCount,
  withSearchProvenance,
  type QueryToken,
  type VerifiedQueryContext,
} from "./searchQueryContract";

const token = (term: string, type: QueryToken["type"]): QueryToken => ({
  term,
  type,
  source: "beat_text",
  verified: true,
});

/** A beat's proven context, in the shape the pipeline puts on the ambient scope. */
function contextFor(
  evidence: string,
  over: Partial<Record<"persons" | "places" | "events" | "objects" | "time", string[]>> = {}
): VerifiedQueryContext {
  return {
    ...emptyQueryContext(evidence),
    persons: (over.persons ?? []).map((t) => token(t, "person")),
    places: (over.places ?? []).map((t) => token(t, "place")),
    events: (over.events ?? []).map((t) => token(t, "event")),
    objects: (over.objects ?? []).map((t) => token(t, "object")),
    time: (over.time ?? []).map((t) => token(t, "time")),
  };
}

/**
 * What this provider would actually be sent, through the real gate — or null when it is refused.
 *
 * Refusal and narrowing are BOTH correct answers, and the gate reaches them in that order:
 * RONDE 91 §5 refuses a query carrying an unproven term outright, and only what survives that is
 * narrowed. Reading `.text` without `.admitted` would report a refused query as if it had been
 * sent, which is the opposite of what happened.
 */
function sentTo(
  provider: string,
  route: string,
  query: string,
  ctx: VerifiedQueryContext
): string | null {
  return withSearchProvenance(ctx, () => {
    const d = searchGateDecision(provider, query, route);
    return d.admitted ? d.text : null;
  });
}

/* ═══════════════════ §4 — THE WORKED EXAMPLES, THROUGH THE REAL BOUNDARY ═══════════════════ */

describe("§4 — the canonical query, per provider", () => {
  const CASES: Array<{ label: string; beat: string; ctx: VerifiedQueryContext; raw: string; want: string }> = [
    {
      label: "Kim Kardashian + beauty",
      beat: "Kim Kardashian launched a beauty collection in Los Angeles.",
      ctx: contextFor("Kim Kardashian launched a beauty collection in Los Angeles.", {
        persons: ["Kim Kardashian"],
        objects: ["beauty"],
        places: ["Los Angeles"],
      }),
      raw: "Kim Kardashian launched a beauty collection in Los Angeles",
      want: "Kim Kardashian beauty",
    },
    {
      label: "Marie Curie + experiments",
      beat: "Marie Curie conducted experiments in Paris in 1910.",
      ctx: contextFor("Marie Curie conducted experiments in Paris in 1910.", {
        persons: ["Marie Curie"],
        events: ["experiments"],
        places: ["Paris"],
        time: ["1910"],
      }),
      raw: "Marie Curie conducted experiments in Paris in 1910",
      want: "Marie Curie experiments",
    },
    {
      label: "Elon Musk + factory",
      beat: "Elon Musk unveiled a new Tesla factory.",
      ctx: contextFor("Elon Musk unveiled a new Tesla factory.", {
        persons: ["Elon Musk"],
        objects: ["factory"],
      }),
      raw: "Elon Musk unveiled a new Tesla factory",
      want: "Elon Musk factory",
    },
  ];

  /** Every route that carried a polluted query in render 594. */
  const ROUTES: Array<[string, string]> = [
    ["wikimedia", "fetchWikimediaVideos"],
    ["europeana", "fetchEuropeanaVideos"],
    ["sepiasearch", "fetchSepiaSearchVideos"],
    ["internet_archive", "fetchInternetArchiveClips"],
    ["web_wide", "searchWebWideVideoClips"],
    ["pexels", "fetchPexelsClips"],
    ["pixabay", "fetchPixabayClips"],
    ["youtube_cc", "fetchYouTubeCCClips"],
    ["openverse", "scenePool:searchOpenverseCandidates"],
  ];

  for (const c of CASES) {
    it(`${c.label} — same canonical query at EVERY provider`, () => {
      const seen = new Map<string, string | null>();
      for (const [provider, route] of ROUTES) {
        seen.set(provider, sentTo(provider, route, c.raw, c.ctx));
      }
      for (const [provider, got] of seen) {
        expect(got, `${provider} refused a query it should have narrowed`).not.toBeNull();
        expect(got, `${provider} was sent something else`).toBe(c.want);
        expect(semanticConceptCount(got!, c.ctx.persons[0]!.term), provider).toBeLessThanOrEqual(2);
      }
      /** One policy means one answer — not nine that happen to agree. */
      expect(new Set(seen.values()).size, "providers disagree about the canonical query").toBe(1);
    });
  }
});

/* ═══════════════════ RENDER 594'S OWN QUERIES, BY NAME ═══════════════════ */

describe("the queries render 594 sent cannot reach a provider again", () => {
  const KANYE = contextFor(
    "A single tweet can crash Kanye West's net worth by millions overnight.",
    { persons: ["Kanye West"], events: ["crash"], objects: ["tweet"] }
  );
  const JENNER = contextFor(
    "Sensational headlines bombard us from New York City to Los Angeles.",
    { persons: ["Kris Jenner"], places: ["New York City"] }
  );

  const FORBIDDEN: Array<[string, VerifiedQueryContext]> = [
    ["kanye documentary footage", KANYE],
    ["west documentary footage", KANYE],
    ["tweet documentary footage", KANYE],
    ["single documentary footage", KANYE],
    ["kanye other", KANYE],
    ["Rumors kardashians Kardashian", KANYE],
    ["Kris Jenner New York City bombard", JENNER],
    ["Kris Jenner Kardashian Rumors about the", JENNER],
  ];

  for (const [raw, ctx] of FORBIDDEN) {
    it(`"${raw}" does not survive the boundary`, () => {
      const got = sentTo("wikimedia", "fetchWikimediaVideos", raw, ctx);
      /**
       * Two acceptable answers, and the gate reaches them in order: REFUSED outright when a term
       * cannot be proven from the beat, or NARROWED to the subject plus one concept. What is
       * forbidden is the third: reaching the provider unchanged.
       */
      expect(got, "the query reached the provider unchanged").not.toBe(raw);
      if (got === null) return;
      const anchor = ctx.persons[0]!.term;
      /** If it was sent at all, the subject survives. */
      expect(got.toLowerCase()).toContain(anchor.split(" ")[0]!.toLowerCase());
      /**
       * And what is left is the subject plus at most one concept. Counted as CONCEPTS rather
       * than words: "Kris Jenner New York City" is a person and a place — two concepts — and a
       * word count would call it four and be wrong about what the rule says.
       */
      const beyondAnchor = got
        .toLowerCase()
        .replace(anchor.toLowerCase(), "")
        .trim();
      expect(
        beyondAnchor === "" || ctx.evidence.toLowerCase().includes(beyondAnchor),
        `"${beyondAnchor}" is not in this beat — it was invented, not chosen`
      ).toBe(true);
      /**
       * Not a word count. Anchoring legitimately GROWS the string — "kanye other" becomes
       * "Kanye West crash", where a half-name is completed and a padding word is exchanged for
       * the beat's own concept. What is bounded is concepts, and the remainder beyond the
       * subject carries no padding.
       */
      for (const pad of ["documentary", "footage", "news", "other", "archive", "video"]) {
        expect(beyondAnchor, `"${pad}" survived`).not.toContain(pad);
      }
    });
  }

  it("PADDING NEVER BECOMES THE CONCEPT, whichever provider asks", () => {
    /**
     * What replaces it is the beat's own typed concept where there is one — this beat is typed
     * `crash`, and `crash` stands in its narration. That is the policy choosing a concept rather
     * than escorting a category, which is the whole point; what matters is that the padding word
     * never survives and that whatever does is provable from the beat.
     */
    for (const pad of ["documentary", "footage", "news", "archive", "other", "video"]) {
      const got = sentTo("europeana", "fetchEuropeanaVideos", `Kanye West ${pad}`, KANYE);
      /** Refused is also an answer — the padding word is simply never sent. */
      if (got === null) continue;
      expect(got.toLowerCase(), `"${pad}" became the concept`).not.toContain(pad);
      expect(got).toContain("Kanye West");
      const concept = got.replace("Kanye West", "").trim();
      expect(
        concept === "" || KANYE.evidence.toLowerCase().includes(concept.toLowerCase()),
        `"${concept}" is not in this beat`
      ).toBe(true);
    }
  });

  it("AND A CATEGORY IS NOT SWAPPED FOR AN INVENTED CONCEPT when the beat has none", () => {
    /** No typed concept and no provable word: the subject searches alone. */
    const bare = contextFor("Kanye West appeared.", { persons: ["Kanye West"] });
    expect(sentTo("wikimedia", "fetchWikimediaVideos", "Kanye West documentary", bare)).toBe(
      "Kanye West"
    );
  });
});

/* ═══════════════════ §3 — SYNTAX IS THE PROVIDER'S, SEMANTICS IS OURS ═══════════════════ */

describe("§3 — the provider keeps its syntax and gains no semantics", () => {
  const JENNER = contextFor("Sensational headlines bombard us from New York City.", {
    persons: ["Kris Jenner"],
    places: ["New York City"],
  });

  it("provider syntax passes through untouched", () => {
    for (const q of [
      'title:(Kris Jenner) AND mediatype:movies',
      'collection:tvnews AND Kris Jenner',
      'subject:"Kris Jenner"',
      '"Kris Jenner" station:CNN',
    ]) {
      const { query, narrowed } = narrowToCanonicalQuery(q, JENNER);
      expect(narrowed, `${q} was rewritten`).toBe(false);
      expect(query).toBe(q);
    }
  });

  it("A NATURAL-LANGUAGE QUERY IS NARROWED, so the exemption is not a hole", () => {
    const { narrowed } = narrowToCanonicalQuery("Kris Jenner New York City bombard", JENNER);
    expect(narrowed, "the exemption swallowed an ordinary query").toBe(true);
  });
});

/* ═══════════════════ §6 — WHAT THE BOUNDARY MAY NOT DO ═══════════════════ */

describe("the boundary narrows and nothing else", () => {
  it("NO ANCHOR, NO NARROWING — a beat with no proven subject is untouched", () => {
    const ctx = contextFor("It filled the news that year.", {});
    const { query, narrowed } = narrowToCanonicalQuery("Berlin 1945", ctx);
    expect(narrowed).toBe(false);
    expect(query).toBe("Berlin 1945");
  });

  it("no ambient context means no narrowing at all", () => {
    const { query, narrowed } = narrowToCanonicalQuery("whatever this is", undefined);
    expect(narrowed).toBe(false);
    expect(query).toBe("whatever this is");
  });

  it("IT REFUSES FIRST AND NARROWS SECOND — RONDE 91 §5 is not reopened", () => {
    /**
     * Written the other way round first, and the RONDE 89/90/91 suites caught it in eight tests.
     * Narrowing before validation turns `Hitler Berlin Germany` on a beat that never says Germany
     * into `Hitler Berlin` and SENDS it — which is precisely TEST 16, "the proven prefix is NOT
     * quietly sent instead". A refusal has to stay a refusal.
     *
     * So the order is pinned here in the source: validate, refuse, and only then narrow what was
     * already going to be sent.
     */
    const src = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");
    const fn = src.slice(src.indexOf("export function searchGateDecision"));
    const validateAt = fn.indexOf("validateSearchQuery(text");
    const narrowAt = fn.indexOf("narrowToCanonicalQuery(text");
    expect(validateAt, "the gate does not validate").toBeGreaterThan(0);
    expect(narrowAt, "the gate does not narrow").toBeGreaterThan(0);
    expect(validateAt, "the gate narrows before it refuses").toBeLessThan(narrowAt);
    /** And the narrowed form is re-checked rather than assumed admissible. */
    expect(fn.slice(narrowAt, narrowAt + 700)).toContain("validateSearchQuery(canonical.query");
  });

  it("A TYPED CONCEPT THE BEAT NEVER SAYS CANNOT BE SMUGGLED IN BY NARROWING", () => {
    /**
     * Found by mutation, and it was a real hole. `narrowToSubjectPlusConcept` prefers the
     * planner's typed concepts and does not require them to stand in the query — right where it
     * lives, because "The Titanic sank" is typed `sinking`. At this boundary it meant
     * `Kanye West documentary` went out as `Kanye West hurricane` on a beat typed `hurricane`
     * whose words never say it: the caller asked one question and a different one was sent.
     *
     * Re-validation did not catch it, and could not: a verified token IS proof by the gate's own
     * standard. So the rule is about the QUERY — narrowing may only remove words, plus complete
     * the subject's own name.
     */
    const ctx = contextFor("Kanye West appeared on stage last night.", {
      persons: ["Kanye West"],
      events: ["hurricane"],
    });
    const got = sentTo("europeana", "fetchEuropeanaVideos", "Kanye West documentary", ctx);
    expect(got, "a concept the beat never says reached the provider").not.toContain("hurricane");
    /** And the padding still goes: the subject searches alone. */
    expect(got).toBe("Kanye West");
  });

  it("the subject's own name may still complete — kanye → Kanye West", () => {
    const ctx = contextFor("Kanye West appeared on stage last night.", { persons: ["Kanye West"] });
    expect(sentTo("wikimedia", "fetchWikimediaVideos", "kanye documentary footage", ctx)).toBe(
      "Kanye West"
    );
  });

  it("A REFUSED QUERY IS STILL REFUSED, never trimmed into an admissible one", () => {
    /** RONDE 91 §5's own case, asserted from this round's side of the boundary. */
    const ctx = contextFor("Hitler stood in Berlin as the city burned.", { persons: ["Hitler"], places: ["Berlin"] });
    expect(sentTo("wikimedia", "r91-from-canonical", "Hitler Berlin Germany", ctx)).toBeNull();
  });

  it("AND THE REWRITE IS ANNOUNCED, never silent", () => {
    const src = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");
    expect(src).toContain("[SearchQueryCanonical]");
  });
});

/* ═══════════════════ THE CALLERS ACTUALLY USE IT ═══════════════════ */

describe("every provider route adopts the canonical text, not its own string", () => {
  const POOL = readFileSync(join(__dirname, "scenePool.ts"), "utf8");
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("THE POOL'S NINE SOURCES READ gate.text", () => {
    /**
     * The stop-condition this test exists for: a boundary that rewrites while its callers keep
     * sending their own string is cosmetic. Every one of these used to do
     * `if (!searchGateDecision(...).admitted) continue;` and then search with `query`.
     */
    const gated = [...POOL.matchAll(/searchGateDecision\(/g)].length;
    const adopted = [...POOL.matchAll(/const query = gate\.text;/g)].length;
    expect(gated, "scenePool no longer calls the gate").toBeGreaterThan(0);
    expect(adopted, `${gated} gate calls but only ${adopted} adopt its text`).toBe(gated);
  });

  it("and the legacy fetchers already did — admitProviderQuery returns decision.text", () => {
    const fn = PIPE.slice(PIPE.indexOf("export function admitProviderQuery"));
    expect(fn.slice(0, 400)).toContain("decision.admitted ? decision.text : null");
  });
});
