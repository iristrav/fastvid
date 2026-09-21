/**
 * A CATEGORY IS NOT A SEARCH.
 *
 * ── What render 593 sent to every provider ──────────────────────────────────────────────────
 *
 * `BeatSemanticProfile.searchTiers` is `string[][]`. Each inner array is one PRIORITY TIER — a
 * group of terms at the same rung of specificity, assembled per entity category by
 * `analyzeBeatSemanticsFallback` or written whole by the model. It was never a list of finished
 * queries.
 *
 * The plan builder read it as one:
 *
 *     tier0.map((q) => scored(q, 0.9, "direct semantic match from narration"))
 *
 * and identically for tier1, tier2 and `searchTiers.slice(3).flat()`. So a tier reading
 *
 *     ["news", "kim kardashian", "medium"]
 *
 * became three standalone searches: `news`, `kim kardashian`, `medium`. Two of the three name a
 * category and no subject. There is no degradation step to look for — the subject was never in
 * that query, because the query was one word of a list.
 *
 * The visible cost is at both ends of the gate. `documentary archive` and `historical footage`,
 * which `domainFallbackTiers` appends to every general-topic profile, fail `hasContentAnchor` and
 * are refused — built, gated, logged and thrown away once per beat per provider. `news` passes,
 * and is answered with whatever stock footage a provider files under news.
 *
 * ── What is asserted here ───────────────────────────────────────────────────────────────────
 *
 *   1. `ensureSubjectAnchor` — the invariant itself, including the three ways it must not fire:
 *      a query that already names the subject, a query whose words are all inside the subject,
 *      and an absent subject.
 *   2. `buildVisualSearchPlan` — the real builder, because a helper that passes in isolation
 *      proves nothing about what reaches a provider.
 *   3. The two things this round is not allowed to have done: rescue an action-only query, and
 *      anchor the geographic round.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────────────────────
 *
 * Touch the Search Gate. `validateSearchQuery` still judges every query afterwards, on the same
 * terms; every word the anchor adds comes from a subject the beat itself proves, checked with the
 * gate's own `termProvableFrom`. Confidences, bands, ranking and vision thresholds are unchanged.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  buildVisualSearchPlan,
  ensureSubjectAnchor,
  searchPlanRounds,
  subjectAnchorForBeat,
} from "./visualSearchPlan";
import { hasContentAnchor } from "./searchQueryContract";
import type { BeatSemanticProfile, SemanticEntityList } from "./semanticVisualMatching";

const ANCHOR = "Kim Kardashian";

/** Every list empty — a test names the two or three it actually cares about. */
function entities(overrides: Partial<SemanticEntityList> = {}): SemanticEntityList {
  return {
    persons: [],
    locations: [],
    companies: [],
    events: [],
    objects: [],
    emotions: [],
    timePeriods: [],
    years: [],
    ...overrides,
  };
}

function profileOf(
  beatText: string,
  searchTiers: string[][],
  overrides: Partial<SemanticEntityList> = {}
): BeatSemanticProfile {
  return {
    beatText,
    summary: beatText.slice(0, 120),
    entities: entities(overrides),
    searchTiers,
    topicDomain: "general",
    summarySource: "beat",
    searchTiersSource: "beat",
  };
}

/* ═══════════════════ 1–8. the invariant itself ═══════════════════ */

describe("ensureSubjectAnchor — a tier term is asked about the subject, once", () => {
  it("TEST 1 — a category query is given the subject", () => {
    expect(ensureSubjectAnchor("news", ANCHOR)).toBe("Kim Kardashian news");
  });

  it("TEST 2 — a query that already names the subject is left exactly as it is", () => {
    expect(ensureSubjectAnchor("Kim Kardashian 2018", ANCHOR)).toBe("Kim Kardashian 2018");
  });

  it("TEST 3 — the subject is never said twice", () => {
    const out = ensureSubjectAnchor("Kim Kardashian acquisition", ANCHOR);
    expect(out).toBe("Kim Kardashian acquisition");
    expect(out.toLowerCase().split("kim kardashian").length - 1).toBe(1);
  });

  it("TEST 4 — every term of a tier is anchored, not just the first", () => {
    expect(["news", "medium", "business"].map((q) => ensureSubjectAnchor(q, ANCHOR))).toEqual([
      "Kim Kardashian news",
      "Kim Kardashian medium",
      "Kim Kardashian business",
    ]);
  });

  it("TEST 6 — NO ANCHOR, NO REWRITE: nothing is invented to stand in for a subject", () => {
    /**
     * §6. A beat that proves no subject searches exactly as it did before. The tempting wrong fix
     * is to reach for the video title or the nearest capitalised word; both are how one beat's
     * subject ends up in another beat's query, which RONDE 90 refused the title as evidence to
     * prevent.
     */
    for (const empty of ["", "   ", undefined as unknown as string, null as unknown as string]) {
      expect(ensureSubjectAnchor("news", empty)).toBe("news");
    }
  });

  it("TEST 7 — the duplicate check is case- and diacritic-insensitive", () => {
    expect(ensureSubjectAnchor("kim kardashian 2018", ANCHOR)).toBe("kim kardashian 2018");
    expect(ensureSubjectAnchor("KIM KARDASHIAN 2018", ANCHOR)).toBe("KIM KARDASHIAN 2018");
    /** The same rule, on a name this pipeline's own history turns on: Führerbunker folds to u. */
    expect(ensureSubjectAnchor("fuhrerbunker 1945", "Führerbunker")).toBe("fuhrerbunker 1945");
  });

  it("TEST 8 — whitespace and punctuation produce no spurious spaces or repeats", () => {
    expect(ensureSubjectAnchor("  Kim Kardashian   2018  ", ANCHOR)).toBe("Kim Kardashian 2018");
    expect(ensureSubjectAnchor("  news  ", ANCHOR)).toBe("Kim Kardashian news");
    expect(ensureSubjectAnchor("news", "  Kim  Kardashian ")).toBe("Kim Kardashian news");
    /** "Kardashian's" is the same word as "Kardashian" for this comparison. */
    expect(ensureSubjectAnchor("Kim Kardashian's 2018", ANCHOR)).toBe("Kim Kardashian's 2018");
    for (const out of [
      ensureSubjectAnchor("  news  ", ANCHOR),
      ensureSubjectAnchor("news", "  Kim  Kardashian "),
    ]) {
      expect(out).not.toMatch(/\s{2,}|^\s|\s$/);
    }
  });

  it("A QUERY THAT IS A PIECE OF THE SUBJECT COLLAPSES ONTO IT", () => {
    /**
     * `analyzeBeatSemanticsFallback` splits a name across a tier — "hitler" beside "adolf hitler"
     * is the case RONDE 62 already documented. Naively prefixing would produce "Kim Kardashian
     * kim", which says one word twice; `buildPrioritisedQueries` refuses that shape for the same
     * reason ("a query that says the same word twice is not a better query").
     */
    expect(ensureSubjectAnchor("kim", ANCHOR)).toBe(ANCHOR);
    expect(ensureSubjectAnchor("kardashian", ANCHOR)).toBe(ANCHOR);
    expect(ensureSubjectAnchor("kardashian kim", ANCHOR)).toBe(ANCHOR);
  });

  it("an empty query stays empty — anchoring never manufactures a search", () => {
    expect(ensureSubjectAnchor("", ANCHOR)).toBe("");
    expect(ensureSubjectAnchor("   ", ANCHOR)).toBe("");
  });

  it("§7 — THE DOMAIN FALLBACK STOPS BEING A QUERY ABOUT NOTHING", () => {
    /**
     * These two are appended to every general-topic profile by `domainFallbackTiers`, and both are
     * refused by the gate's own subject check — every word in them is production vocabulary. They
     * were built and thrown away, per beat, per provider. Behind a subject they become answerable.
     */
    for (const generic of ["documentary archive", "historical footage"]) {
      expect(hasContentAnchor(generic), generic).toBe(false);
      const anchored = ensureSubjectAnchor(generic, ANCHOR);
      expect(anchored).toBe(`${ANCHOR} ${generic}`);
      expect(hasContentAnchor(anchored), anchored).toBe(true);
    }
  });
});

/* ═══════════════════ the anchor is proven, or there is none ═══════════════════ */

describe("subjectAnchorForBeat — the subject the beat itself states", () => {
  const BEAT = "Rumors about Kim Kardashian filled the news in 2018.";

  it("takes the planner's stated subject first", () => {
    expect(
      subjectAnchorForBeat(profileOf(BEAT, []), {
        beatText: BEAT,
        sceneText: BEAT,
        topic: "celebrity",
        intent: { subject: ANCHOR, people: ["Kanye West"] },
      })
    ).toBe(ANCHOR);
  });

  it("then the typed people, then the profile's own persons", () => {
    expect(
      subjectAnchorForBeat(profileOf(BEAT, []), {
        beatText: BEAT,
        sceneText: BEAT,
        topic: "celebrity",
        intent: { people: [ANCHOR] },
      })
    ).toBe(ANCHOR);
    expect(
      subjectAnchorForBeat(profileOf(BEAT, [], { persons: ["kim kardashian"] }), {
        beatText: BEAT,
        sceneText: BEAT,
        topic: "celebrity",
      })
    ).toBe("kim kardashian");
  });

  it("AN UNPROVEN NAME IS NOT AN ANCHOR, WHOEVER SUPPLIED IT", () => {
    /**
     * The whole round rests on this. An anchor is prefixed onto most of a beat's queries, so an
     * invented one would contaminate every search the beat makes — the largest possible version of
     * the mistake `termProvableFrom` exists to prevent. Same measure as the gate: the script says
     * it, or it is not a term.
     */
    const other = "Berlin was divided in 1961.";
    expect(
      subjectAnchorForBeat(profileOf(other, [], { persons: ["kim kardashian"] }), {
        beatText: other,
        sceneText: other,
        topic: "history",
        intent: { subject: ANCHOR, people: ["Kanye West"] },
      })
    ).toBe("");
  });

  it("the video context is NOT a source of anchors", () => {
    /** LLM-derived from the TITLE. RONDE 90 refused the title as evidence; this does not re-open it. */
    expect(
      subjectAnchorForBeat(profileOf(BEAT, []), {
        beatText: BEAT,
        sceneText: BEAT,
        topic: "celebrity",
        videoContext: {
          people: ["Kanye West"],
          period: "2018",
          locations: ["Paris"],
          visualStyles: [],
          synopsis: "",
        },
      })
    ).toBe("");
  });

  it("THE BEAT'S OWN SUBJECT OUTRANKS THE VIDEO'S", () => {
    /**
     * Added because a mutation survived without it, and the mutation is worth recording: admitting
     * `videoContext.people` to the candidate list changes nothing when the name is unproven, since
     * `termProvableFrom` refuses it either way. The exclusion is only OBSERVABLE when the name does
     * appear in the beat — and then it decides WHICH of two proven people anchors the round.
     *
     * It has to be this beat's. The plan is cached per beat and built from this beat's words; a
     * video-level name winning here would anchor every beat of a two-hander on whichever of the two
     * the title happened to mention.
     */
    const both = "Kim Kardashian and Kanye West arrived together.";
    expect(
      subjectAnchorForBeat(profileOf(both, [], { persons: ["kim kardashian"] }), {
        beatText: both,
        sceneText: both,
        topic: "celebrity",
        videoContext: {
          people: ["Kanye West"],
          period: "",
          locations: [],
          visualStyles: [],
          synopsis: "",
        },
      })
    ).toBe("kim kardashian");
  });

  it("a place is not a subject", () => {
    const beat = "The canals of Amsterdam froze that winter.";
    expect(
      subjectAnchorForBeat(profileOf(beat, [], { locations: ["amsterdam"] }), {
        beatText: beat,
        sceneText: beat,
        topic: "netherlands",
      })
    ).toBe("");
  });
});

/* ═══════════════════ 10. through the real builder ═══════════════════ */

describe("§10 — buildVisualSearchPlan no longer sends a category on its own", () => {
  const BEAT = "Rumors about Kim Kardashian and her 2018 media business filled the news.";
  const TIERS = [
    ["kim kardashian", "news"],
    ["medium", "business"],
    ["celebrity"],
    ["documentary archive", "historical footage"],
  ];

  const CATEGORIES = [
    "news",
    "medium",
    "business",
    "celebrity",
    "documentary archive",
    "historical footage",
  ];

  const plan = buildVisualSearchPlan(
    profileOf(BEAT, TIERS, { persons: ["kim kardashian"], years: ["2018"] }),
    { beatText: BEAT, sceneText: BEAT, topic: "Kim Kardashian" }
  );
  /** Every query the plan holds, across all six bands. */
  const everyPlannedQuery = [
    ...plan.primary,
    ...plan.secondary,
    ...plan.concepts,
    ...plan.context,
    ...plan.historical,
    ...plan.fallback,
  ].map((q) => q.query);
  /** Every query a provider is actually asked — the rounds, as the retrieval loop consumes them. */
  const everyQuery = searchPlanRounds(plan).flatMap((round) => round.queries);

  it("THE CATEGORIES NAMED IN THE BRIEF DO NOT OCCUR AS QUERIES OF THEIR OWN", () => {
    for (const category of CATEGORIES) {
      expect(everyPlannedQuery, `"${category}" is still a query of its own`).not.toContain(category);
      expect(everyQuery, `"${category}" still goes out on its own`).not.toContain(category);
    }
  });

  it("and each of them goes out asking about the subject instead", () => {
    /**
     * ── SUPERSEDED IN PART, AND SAID SO RATHER THAN DELETED ─────────────────────────────────
     *
     * When this test was written, the answer to a bare category was to put the subject in front
     * of it: `news` became `kim kardashian news`. That fixed the half of the defect this file is
     * named for — a category never goes out alone — and that half is unchanged and still asserted
     * directly above.
     *
     * The two-concept round that followed answers the other half. `[MAIN SUBJECT] + [SENTENCE
     * VISUAL CONCEPT]` asks what the second term is FOR, and `news` is not something anybody can
     * photograph: "kim kardashian news" carries the subject and then spends its only remaining
     * slot on a word that returns generic newsroom footage. That is the query shape render 593
     * sent and got nothing usable back from. So a padding word is now dropped rather than
     * escorted, and the subject searches alone — which is a narrower question, not a broader one.
     *
     * Categories split in two accordingly, and BOTH halves are asserted, because "it was dropped"
     * would otherwise be indistinguishable from "it was lost".
     */
    /** Words that name something filmable keep their place beside the subject, as before. */
    for (const category of ["medium", "business", "celebrity"]) {
      expect(everyPlannedQuery, category).toContain(`kim kardashian ${category}`);
    }
    /** `news` is padding: it leaves, and the subject's own query is what remains. */
    expect(everyPlannedQuery).not.toContain("kim kardashian news");
    expect(everyPlannedQuery).toContain("kim kardashian");
    /**
     * And the beat's actual visual concept — the one the narration supplies and a category never
     * could — is now asked about, which is the point of the exchange.
     */
    expect(everyPlannedQuery).toContain("kim kardashian Rumors");
    /** The unnarrowed fallback band still anchors its phrases whole; that band is not this round's. */
    expect(everyPlannedQuery).toContain("kim kardashian documentary archive");
    expect(everyPlannedQuery).toContain("kim kardashian historical footage");
  });

  it("the subject's own query survives, and is not doubled", () => {
    expect(everyQuery).toContain("kim kardashian");
    for (const q of everyPlannedQuery) {
      expect(q.toLowerCase().split("kim kardashian").length - 1, q).toBeLessThanOrEqual(1);
    }
  });

  it("MEASURED, NOT ASSUMED: searchPlanRounds does not consume plan.fallback", () => {
    /**
     * Found by this test failing, and recorded rather than worked around. RONDE 88 §10 removed the
     * "visual-equiv" round — "The field remains on the type so plans stored before this round still
     * parse; nothing reads it into a query any more." So a tier at index 3 or beyond reaches
     * `plan.fallback` and stops there.
     *
     * The anchoring of that band is still correct and still required by §7, and it is NOT where
     * §7's two phrases actually do damage. `domainFallbackTiers` appends them to the END of a
     * profile's tier list, and a beat whose extractors typed little has FEW tiers — so they land at
     * tier0, tier1 or tier2 and go out at confidence 0.9, 0.75 or 0.6. That case is asserted below.
     */
    expect(everyQuery).not.toContain("kim kardashian documentary archive");
    expect(everyPlannedQuery).toContain("kim kardashian documentary archive");
  });

  it("A LOW-ENTITY BEAT IS THE ONE THAT SENT documentary archive AT 0.9", () => {
    /**
     * Render 593's shape: a beat the extractors could say little about, so `domainFallbackTiers`
     * is tier0 and its two phrases lead the round every provider is asked FIRST. Both are refused
     * by the gate's subject check on their own; behind the subject they are answerable.
     */
    const sparse = buildVisualSearchPlan(
      profileOf(BEAT, [["documentary archive", "historical footage"]], {
        persons: ["kim kardashian"],
      }),
      { beatText: BEAT, sceneText: BEAT, topic: "Kim Kardashian" }
    );
    const asked = searchPlanRounds(sparse).flatMap((r) => r.queries);
    /**
     * The invariant this test exists for, unchanged: neither phrase goes out on its own, and both
     * go out about the subject.
     */
    expect(asked).not.toContain("documentary archive");
    expect(asked).not.toContain("historical footage");
    expect(asked.every((q) => q.startsWith("kim kardashian"))).toBe(true);
    /**
     * What the two-concept round changed: `documentary` and `footage` are padding — they describe
     * the KIND of material wanted, not the thing to be seen in it — so each phrase is now asked as
     * the subject plus its one substantive word. The query is shorter and names the same picture.
     */
    expect(asked).toContain("kim kardashian archive");
    expect(asked).toContain("kim kardashian historical");
  });

  it("every band keeps its confidences — this round changed query text, not ranking", () => {
    /** §8. The bands and their numbers are the previous rounds' decisions and are not this one's. */
    expect(plan.primary.every((q) => q.confidence === 0.9 || q.confidence === 0.85)).toBe(true);
    expect(plan.secondary.every((q) => q.confidence === 0.75)).toBe(true);
    expect(plan.concepts.every((q) => q.confidence === 0.6)).toBe(true);
    expect(plan.fallback.every((q) => q.confidence === 0.3)).toBe(true);
  });

  it("and the plan still has all six rounds populated the way it did", () => {
    expect(plan.primary.length).toBeGreaterThan(0);
    expect(plan.secondary.length).toBeGreaterThan(0);
    expect(plan.concepts.length).toBeGreaterThan(0);
    expect(plan.fallback.length).toBeGreaterThan(0);
    expect(plan.people).toEqual(["kim kardashian"]);
  });

  it("A BEAT WITH NO PROVEN SUBJECT BEHAVES EXACTLY AS IT DID", () => {
    /**
     * §6 again, at the level that matters: not a single query changes when there is no anchor, so
     * this round cannot have quietly narrowed the coverage of the beats it does not help.
     */
    const bare = "It filled the news that year.";
    const unanchored = buildVisualSearchPlan(profileOf(bare, TIERS), {
      beatText: bare,
      sceneText: bare,
      topic: "media",
    });
    expect(unanchored.primary.map((q) => q.query)).toContain("news");
    expect(unanchored.fallback.map((q) => q.query)).toContain("documentary archive");
    expect(searchPlanRounds(unanchored).flatMap((r) => r.queries)).toContain("medium");
  });
});

/* ═══════════════════ 5 + 5C. what this round may not have broken ═══════════════════ */

describe("§4 TEST 5 — an action-only query is not rescued by acquiring a subject", () => {
  const BEAT = "Rumors about Kim Kardashian filled the news.";

  const plan = buildVisualSearchPlan(
    profileOf(BEAT, [["illuminate", "news"]], { persons: ["kim kardashian"] }),
    {
      beatText: BEAT,
      sceneText: BEAT,
      topic: "Kim Kardashian",
      intent: { subject: ANCHOR, action: ["illuminate"] },
    }
  );

  it("THE VERB IS GONE, IN EVERY FORM — not turned into a valid query by the anchor", () => {
    /**
     * Render 580's `query="illuminate"` is why `dropActionOnlyQueries` exists. Anchoring runs
     * AFTER it for precisely this reason: "Kim Kardashian illuminate" is technically constructible,
     * and constructing it would undo the earlier round rather than build on it.
     */
    for (const q of searchPlanRounds(plan).flatMap((r) => r.queries)) {
      expect(q.toLowerCase(), q).not.toContain("illuminate");
    }
  });

  it("while the tier's real term is still asked, now about the subject", () => {
    /**
     * The tier is `["illuminate", "news"]` — a verb and a padding word, which between them name no
     * picture at all. The verb was already gone (above). `news` now goes too, and what is left is
     * the subject, asked alone.
     *
     * That IS the tier's real term here: this beat gave the planner nothing filmable beyond the
     * person, and searching for the person is the honest question. The failure mode this round
     * closes is the opposite one — filling the second slot with whatever word was nearest so the
     * query would look specific.
     */
    expect(plan.primary.map((q) => q.query)).toContain("Kim Kardashian");
    expect(plan.primary.map((q) => q.query)).not.toContain("Kim Kardashian news");
  });
});

describe("§5 C — the geographic round stays a geographic question", () => {
  const BEAT = "Kim Kardashian arrived in Paris in 2016.";
  const plan = buildVisualSearchPlan(
    profileOf(BEAT, [["news"]], {
      persons: ["kim kardashian"],
      locations: ["paris"],
      years: ["2016"],
    }),
    { beatText: BEAT, sceneText: BEAT, topic: "Kim Kardashian" }
  );

  it("A PLACE IS NOT PREFIXED WITH A PERSON", () => {
    /**
     * Investigated before deciding, as §5 C requires, and the finding is in the builder's own note:
     * `historical` is the one band that maps the TYPED entity lists rather than `searchTiers`, so
     * the defect this round repairs does not exist on it; `searchQueryContract` already emits
     * place+year and place+event as questions in their own right; and two of its six sources come
     * from the title-derived `videoContext`, where joining a person to a place would manufacture a
     * claim ("Kim Kardashian Paris") that neither the beat nor the title makes.
     */
    expect(plan.historical.map((q) => q.query)).toContain("paris");
    expect(plan.historical.map((q) => q.query)).not.toContain("Kim Kardashian paris");
    expect(plan.locations).toContain("paris");
  });

  it("and it still sits behind the subject rounds in the ladder", () => {
    const labels = searchPlanRounds(plan).map((r) => r.label);
    expect(labels.indexOf("exact")).toBeLessThan(labels.indexOf("context+historical"));
  });
});

/* ═══════════════════ the gate, the engine count, the blast radius ═══════════════════ */

describe("this round changed query construction and nothing else", () => {
  const PLAN = readFileSync(join(__dirname, "visualSearchPlan.ts"), "utf8");

  it("THE SEARCH GATE IS STILL THE LAST WORD", () => {
    /** Nothing here marks a query verified, allowed, proven or exempt from validation. */
    const at = PLAN.indexOf("export function ensureSubjectAnchor");
    expect(at).toBeGreaterThan(-1);
    expect(PLAN.slice(at, PLAN.indexOf("\n}", at))).not.toMatch(
      /verified|allowed|bypass|skipGate|validateSearchQuery/i
    );
    const gate = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");
    expect(gate).toContain('return process.env.SEARCH_GATE_STRICT !== "false";');
  });

  it("the anchor is chosen with the gate's own evidence measure, not a new one", () => {
    const at = PLAN.indexOf("export function subjectAnchorForBeat");
    const body = PLAN.slice(at, PLAN.indexOf("\n}", at));
    expect(body).toContain("termProvableFrom(term, evidence)");
    /** No second vocabulary, no hardcoded subject, no topic-specific rule. */
    expect(body).not.toMatch(/"kim|kardashian|hitler|musk"/i);
  });

  it("THE ORDER IS FILTER → ANCHOR → DEDUP, and it is the order that makes TEST 5 hold", () => {
    const at = PLAN.indexOf("const primary = ");
    const block = PLAN.slice(at, at + 700);
    expect(block.indexOf("dropActionOnlyQueries")).toBeGreaterThan(-1);
    expect(block.indexOf("anchorTierQueries")).toBeLessThan(block.indexOf("dropActionOnlyQueries"));
    expect(block.indexOf("dedupScored")).toBeLessThan(block.indexOf("anchorTierQueries"));
    /** And the primary round is still built from tier0, which is what it is for. */
    expect(block).toContain("tier0.map");
  });

  it("all four tier-derived bands are anchored, and only those", () => {
    expect((PLAN.match(/anchorTierQueries\(/g) ?? []).length).toBe(5); // 1 definition + 4 uses
    const historicalAt = PLAN.indexOf("const historical = dedupScored([");
    expect(PLAN.slice(historicalAt, PLAN.indexOf("]).slice(0, 8)", historicalAt))).not.toContain(
      "anchorTierQueries"
    );
  });

  it("no second query engine was built", () => {
    /** The helper composes two strings it was handed. It reads no profile, calls no provider. */
    const at = PLAN.indexOf("export function ensureSubjectAnchor");
    const body = PLAN.slice(at, PLAN.indexOf("\n}", at));
    expect(body).not.toMatch(/fetch\(|invokeLLM|analyzeBeat|searchTiers/);
  });

  it("and the domain fallback itself is untouched — semanticVisualMatching is not restructured", () => {
    /** §11: the tiers keep coming from where they came from; only their reading changed. */
    const semantic = readFileSync(join(__dirname, "semanticVisualMatching.ts"), "utf8");
    expect(semantic).toContain('return [["documentary archive", "historical footage"]];');
    expect(semantic).not.toContain("ensureSubjectAnchor");
  });
});
