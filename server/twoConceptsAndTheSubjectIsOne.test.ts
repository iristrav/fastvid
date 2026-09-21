/**
 * TWO CONCEPTS, AND THE SUBJECT IS ONE OF THEM.
 *
 * ── What render 593 sent to real providers ──────────────────────────────────────────────────
 *
 *     "Rumors kardashians Kardashians"     a sentence, with the subject said twice
 *     "it's documentary footage"           four words, and not one of them a subject
 *     "masterclass other"                  two content words that name nothing to photograph
 *     "single day" · "news other"          the same failure, twice more
 *     "sword tuned" · "shaped"             the sentence's grammar standing in for its picture
 *
 * Those are two different defects wearing one symptom. Some queries are too long; the rest are
 * the wrong two words. A cap repairs only the first kind, and `ensureSubjectAnchor` — which puts
 * the subject back in front — repairs only the last. `narrowToSubjectPlusConcept` is where the
 * two meet: keep the subject whole, then CHOOSE one concept to stand beside it.
 *
 * ── The line this file exists to hold ───────────────────────────────────────────────────────
 *
 * `query.split(" ").slice(0, 2)` would pass a naive length test and fail every case that matters:
 * on "Kim Kardashian launched a new beauty collection" it returns the subject and nothing about
 * the beat; on "The Titanic sank in 1912" it returns "The Titanic". So the tests below are not
 * about length. Each one names the concept that must survive, and several assert that a
 * truncation could not have produced the answer.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { narrowToSubjectPlusConcept, semanticConceptCount } from "./searchQueryContract";
import { buildVisualSearchPlan, ensureSubjectAnchor, searchPlanRounds } from "./visualSearchPlan";

/** A beat's typed concepts, in the shape the planner produces them. */
function intent(over: Record<string, string[]> = {}) {
  return { event: [], location: [], period: [], objects: [], action: [], people: [], ...over };
}

/* ═══════════════════════ §14 — the five worked examples ═══════════════════════ */

describe("subject + sentence concept", () => {
  const CASES: Array<{
    label: string;
    sentence: string;
    anchor: string;
    intent: ReturnType<typeof intent>;
    expected: string;
  }> = [
    {
      label: "Kim Kardashian + beauty",
      sentence: "Kim Kardashian launched a new beauty collection in Los Angeles",
      anchor: "Kim Kardashian",
      intent: intent({ objects: ["beauty"], location: ["Los Angeles"] }),
      expected: "Kim Kardashian beauty",
    },
    {
      label: "Marie Curie + experiments",
      sentence: "Marie Curie conducted experiments in Paris in 1910",
      anchor: "Marie Curie",
      intent: intent({ event: ["experiments"], location: ["Paris"], period: ["1910"] }),
      expected: "Marie Curie experiments",
    },
    {
      label: "Elon Musk + factory",
      sentence: "Elon Musk unveiled a new Tesla factory",
      anchor: "Elon Musk",
      intent: intent({ objects: ["factory"] }),
      expected: "Elon Musk factory",
    },
    {
      label: "Titanic + sinking",
      sentence: "The Titanic sank in 1912 after hitting an iceberg",
      anchor: "Titanic",
      intent: intent({ event: ["sinking"], period: ["1912"], objects: ["iceberg"] }),
      expected: "Titanic sinking",
    },
    {
      label: "NASA + Jupiter",
      sentence: "NASA released new images of Jupiter",
      anchor: "NASA",
      intent: intent({ objects: ["Jupiter"] }),
      expected: "NASA Jupiter",
    },
  ];

  for (const c of CASES) {
    it(`${c.label} — from a whole sentence`, () => {
      /** The sentence goes in anchored, exactly as the plan builder hands it over. */
      const anchored = ensureSubjectAnchor(c.sentence, c.anchor);
      const out = narrowToSubjectPlusConcept(anchored, c.anchor, c.intent);
      expect(out.query).toBe(c.expected);
      expect(out.concepts).toHaveLength(2);
      expect(semanticConceptCount(out.query, c.anchor)).toBe(2);
    });

    it(`${c.label} — the answer is CHOSEN, not the first two words`, () => {
      /**
       * The assertion that separates this from a truncation. If the expected concept is not among
       * the sentence's first words, `slice(0, 2)` could not have produced it.
       */
      const anchored = ensureSubjectAnchor(c.sentence, c.anchor);
      const truncated = anchored.split(" ").slice(0, 2).join(" ");
      const out = narrowToSubjectPlusConcept(anchored, c.anchor, c.intent);
      expect(out.query).not.toBe(truncated);
    });
  }
});

/* ═══════════════════════ §9 — the subject is never traded away ═══════════════════════ */

describe("the main subject survives everything", () => {
  it("a beat with a subject and no usable concept searches for the subject alone", () => {
    const out = narrowToSubjectPlusConcept(
      "Kim Kardashian other stuff things",
      "Kim Kardashian",
      intent()
    );
    expect(out.query).toBe("Kim Kardashian");
    expect(out.concepts).toEqual(["Kim Kardashian"]);
  });

  it("A CATEGORY CANNOT REPLACE THE SUBJECT", () => {
    /**
     * The defect `de1c88b` closed, asserted again at this layer. Nothing in this function reads a
     * category table, so the only way "celebrity" could reach the output is by being in the
     * narration — and then it is a concept beside the subject, never instead of it.
     */
    const out = narrowToSubjectPlusConcept(
      "Kim Kardashian celebrity",
      "Kim Kardashian",
      intent({ objects: ["celebrity"] })
    );
    expect(out.query.startsWith("Kim Kardashian")).toBe(true);
    expect(out.concepts[0]).toBe("Kim Kardashian");
    expect(out.query).not.toBe("celebrity");
  });

  it("a multi-word subject is ONE concept, not two terms", () => {
    const out = narrowToSubjectPlusConcept(
      "Kim Kardashian beauty",
      "Kim Kardashian",
      intent({ objects: ["beauty"] })
    );
    expect(semanticConceptCount(out.query, "Kim Kardashian")).toBe(2);
    /** Without the anchor the same string is three content words — which is why it is passed. */
    expect(semanticConceptCount(out.query, "")).toBe(3);
  });

  it("no proven subject means no invented one", () => {
    /** §6's rule, reaching this function unchanged from `ensureSubjectAnchor`. */
    const out = narrowToSubjectPlusConcept("Berlin 1945", "", intent({
      location: ["Berlin"],
      period: ["1945"],
    }));
    expect(out.query).toBe("Berlin 1945");
    expect(out.concepts).toEqual(["Berlin", "1945"]);
  });
});

/* ═══════════════════════ §14 — the negative cases, by name ═══════════════════════ */

describe("the queries render 593 actually sent cannot be produced", () => {
  const FORBIDDEN: Array<[string, string, ReturnType<typeof intent>]> = [
    ["news other", "", intent()],
    ["masterclass other", "", intent()],
    ["single day", "", intent()],
    ["sword tuned", "", intent()],
    ["it's documentary footage", "", intent()],
    ["news kim", "", intent()],
  ];

  for (const [query, anchor, i] of FORBIDDEN) {
    it(`"${query}" does not survive as a query`, () => {
      const out = narrowToSubjectPlusConcept(query, anchor, i);
      expect(out.query).not.toBe(query);
    });
  }

  it("a sentence with the subject said twice says it once", () => {
    const anchored = ensureSubjectAnchor("Rumors kardashians Kardashians", "Kardashians");
    const out = narrowToSubjectPlusConcept(anchored, "Kardashians", intent({ objects: ["rumors"] }));
    expect(out.query).toBe("Kardashians Rumors");
    expect(semanticConceptCount(out.query, "Kardashians")).toBe(2);
  });

  it("PADDING WORDS ARE NOT CONCEPTS", () => {
    /** §11's list, each one measured in a production log rather than imagined. */
    for (const pad of [
      "news", "video", "footage", "documentary", "latest", "official",
      "other", "single", "day", "masterclass", "tuned", "thing", "stuff",
    ]) {
      const out = narrowToSubjectPlusConcept(`Marie Curie ${pad}`, "Marie Curie", intent());
      expect(out.query, `"${pad}" became a search term`).toBe("Marie Curie");
    }
  });
});

/* ═══════════════════════ §15 — the invariant, over every band ═══════════════════════ */

describe("§15 — no production query carries more than two concepts", () => {
  /**
   * Driven through the real plan builder rather than the policy function alone, because §15 asks
   * about production query paths and the bands are what those paths read.
   */
  it("every anchored band of a real plan is within the ceiling", () => {
    const anchor = "Marie Curie";
    const plan = buildVisualSearchPlan(
      {
        entities: {
          persons: ["Marie Curie"],
          companies: [],
          objects: ["radium", "laboratory"],
          locations: ["Paris"],
          events: ["experiments"],
          years: [],
          timePeriods: [],
        },
        searchTiers: [
          ["Marie Curie conducted experiments in Paris", "experiments", "radium"],
          ["laboratory", "science"],
          ["discovery"],
        ],
      } as never,
      {
        beatText: "Marie Curie conducted experiments with radium in her Paris laboratory.",
        sceneText: "Marie Curie conducted experiments with radium in her Paris laboratory.",
        intent: {
          subject: "Marie Curie",
          event: ["experiments"],
          objects: ["radium", "laboratory"],
          location: ["Paris"],
        },
      } as never,
      anchor
    );

    const offenders: string[] = [];
    for (const band of ["primary", "secondary", "concepts"] as const) {
      for (const q of plan[band]) {
        const count = semanticConceptCount(q.query, anchor);
        if (count > 2) offenders.push(`${band}: "${q.query}" = ${count} concepts`);
      }
    }
    expect(offenders, `over the two-concept ceiling — ${offenders.join(" | ")}`).toEqual([]);
  });

  it("and the subject is still in every one of them", () => {
    const anchor = "Marie Curie";
    const plan = buildVisualSearchPlan(
      {
        entities: {
          persons: ["Marie Curie"], companies: [], objects: [], locations: [], events: [],
          years: [], timePeriods: [],
        },
        searchTiers: [["experiments", "radium"], [], []],
      } as never,
      {
        beatText: "Marie Curie conducted experiments with radium.",
        sceneText: "Marie Curie conducted experiments with radium.",
        intent: { subject: "Marie Curie", event: ["experiments"], objects: ["radium"] },
      } as never,
      anchor
    );
    const subjectless = plan.primary.filter((q) => !/marie curie/i.test(q.query));
    expect(subjectless.map((q) => q.query), "a primary query lost its subject").toEqual([]);
  });
});

/* ═══════════════════════ §20 — the last hop before the adapters ═══════════════════════ */

describe("§20 — nothing re-expands the query between the plan and the providers", () => {
  /**
   * `searchPlanRounds` is what `tryStockSources` iterates: the adapters receive `round.queries` and
   * nothing else. So if the ceiling holds HERE it holds at every provider, and a provider adapter
   * that wanted to widen a query would have to invent terms of its own rather than find them in
   * what it was handed.
   */
  function planFor(anchor: string) {
    return buildVisualSearchPlan(
      {
        entities: {
          persons: ["Marie Curie"],
          companies: [],
          objects: ["radium", "laboratory"],
          locations: ["Paris"],
          events: ["experiments"],
          years: ["1910"],
          timePeriods: ["1910s"],
        },
        searchTiers: [
          ["Marie Curie conducted experiments in Paris in 1910", "experiments", "radium"],
          ["laboratory", "science"],
          ["discovery"],
        ],
      } as never,
      {
        beatText: "Marie Curie conducted experiments with radium in her Paris laboratory in 1910.",
        sceneText: "Marie Curie conducted experiments with radium in her Paris laboratory in 1910.",
        intent: {
          subject: "Marie Curie",
          event: ["experiments"],
          objects: ["radium", "laboratory"],
          location: ["Paris"],
          period: ["1910"],
        },
      } as never,
      anchor
    );
  }

  it("every ANCHORED round handed to a provider is within the two-concept ceiling", () => {
    const anchor = "Marie Curie";
    const rounds = searchPlanRounds(planFor(anchor));
    /**
     * The anchored rounds only. `period+style` carries detected locations, periods and visual
     * styles — single terms that were never subject-anchored and are a different instrument; §15
     * asks about the query bands, and widening this assertion to cover them would be asserting
     * something the round does not claim.
     */
    const offenders: string[] = [];
    for (const round of rounds) {
      if (!["exact", "synonyms", "concepts"].includes(round.label)) continue;
      for (const q of round.queries) {
        const count = semanticConceptCount(q, anchor);
        if (count > 2) offenders.push(`${round.label}: "${q}" = ${count}`);
      }
    }
    expect(offenders, `over the ceiling at the adapter boundary — ${offenders.join(" | ")}`).toEqual([]);
  });

  it("AND THE SUBJECT IS STILL THERE at the adapter boundary", () => {
    const anchor = "Marie Curie";
    const rounds = searchPlanRounds(planFor(anchor));
    const exact = rounds.find((r) => r.label === "exact");
    expect(exact, "the plan produced no exact round at all").toBeTruthy();
    expect(exact!.queries.length, "the exact round is empty").toBeGreaterThan(0);
    const subjectless = exact!.queries.filter((q) => !/marie curie/i.test(q));
    expect(subjectless, "a query reached the adapters without its subject").toEqual([]);
  });

  it("an unanchored beat is not given an invented subject on the way out", () => {
    /** §6 again, at the boundary: no proven subject means the queries go out as they are. */
    const rounds = searchPlanRounds(planFor(""));
    const all = rounds.flatMap((r) => r.queries);
    expect(all.length).toBeGreaterThan(0);
    /** Nothing here may name a person the anchor never proved. */
    expect(all.filter((q) => /kardashian|elon musk|nasa/i.test(q))).toEqual([]);
  });
});

/* ═══════════════════════ §13 — the policy runs before the adapters ═══════════════════════ */

describe("§13 — one policy, applied once, where the adapters cannot undo it", () => {
  const PLAN = readFileSync(join(__dirname, "visualSearchPlan.ts"), "utf8");

  it("the plan builder narrows its own bands", () => {
    expect(PLAN).toContain("narrowToSubjectPlusConcept");
    expect(PLAN).toContain("function narrowBand(");
  });

  it("all three anchored bands go through it, not one or two", () => {
    const body = PLAN.slice(
      PLAN.indexOf("export function buildVisualSearchPlan"),
      PLAN.indexOf("function logPlan")
    );
    const calls = [...body.matchAll(/narrowBand\(/g)].length;
    expect(calls, "a band was left un-narrowed").toBe(3);
  });

  it("THE RESCUE PATH BUILDS NO QUERIES OF ITS OWN", () => {
    /**
     * §20's stock-fallback case, answered structurally rather than by re-testing the same policy
     * through a second door.
     *
     * `refillSceneStrictVoiceMatch` is the rescue layer — it re-runs a whole scene's fill when the
     * first pass came up short, and it is the obvious place for a second, laxer set of queries to
     * grow. It has none: 528 lines that delegate to `fillBeatVisual`/`ensureBeatVisualFilled`, the
     * same per-beat fill the primary path uses. So the subject anchor and the two-concept ceiling
     * reach the rescue path by construction, and this test fails the moment that stops being true.
     */
    const src = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    const at = src.indexOf("async function refillSceneStrictVoiceMatch");
    expect(at, "refillSceneStrictVoiceMatch is gone — this test needs rewriting, not deleting")
      .toBeGreaterThan(0);
    let depth = 0;
    let end = at;
    for (let n = src.indexOf("{", at); n < src.length; n++) {
      if (src[n] === "{") depth++;
      else if (src[n] === "}" && --depth === 0) {
        end = n + 1;
        break;
      }
    }
    const body = src.slice(at, end);
    for (const forbidden of [
      "buildVisualSearchPlan",
      "ensureSubjectAnchor",
      "narrowToSubjectPlusConcept",
      "simplifyStockSearchWord",
      "searchPlanRounds",
    ]) {
      expect(
        body.includes(forbidden),
        `the rescue path now builds its own queries via ${forbidden} — it must go through the ` +
          `same per-beat fill, or the subject can be lost on the way to a fallback`
      ).toBe(false);
    }
    /** And it still delegates, rather than having grown a private fill. */
    expect(body).toContain("fillBeatVisual");
  });

  it("NO TRUNCATION ANYWHERE IN THE POLICY", () => {
    /**
     * §16, as a property of the source. A `slice(0, 2)` over words would satisfy every count in
     * this file and none of its meaning, so the shape itself is forbidden.
     */
    const contract = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");
    const policy = contract.slice(contract.indexOf("export function narrowToSubjectPlusConcept"));
    expect(policy).not.toMatch(/\.split\([^)]*\)\s*\.slice\(0,\s*2\)/);
    expect(policy).not.toMatch(/words\.slice\(0,\s*2\)/);
  });
});
