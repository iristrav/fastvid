/**
 * FINAL VALIDATION §5 / §6 / §7 — FastVid is not a WWII system.
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────────
 *
 * Every production render this programme has debugged has been about the July 20 plot, and every
 * fix has been measured against it. That is the exact condition under which a subject-specific hack
 * gets written without anyone meaning to: a special case for "WWII", a list of historical terms, a
 * rule that happens to hold for 1944 and for nothing else. The brief forbids all of it —
 * `if topic === WWII`, `if person === "Elon Musk"`, hardcoded YouTube winners, manual asset ids.
 *
 * So this drives the REAL retrieval contract — the same `buildVerifiedQueryContextForBeat`,
 * `buildPrioritisedQueries` and `validateSearchQuery` the pipeline calls — across six subject
 * domains, and asserts the behaviour is the same shape in all of them. No provider is contacted:
 * these are the pure decision functions, which is precisely the layer where a subject-specific
 * shortcut would live.
 */
import { describe, expect, it } from "vitest";

import {
  buildPrioritisedQueries,
  validateSearchQuery,
  withRenderTopic,
} from "./searchQueryContract";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";
import { MAX_YOUTUBE_QUERIES_PER_BEAT } from "./youtubePoolSource";

/**
 * One beat per domain, each written the way a script actually writes one, with the words a real
 * narration would use. Nothing here is tuned to pass: the beat is the input, the terms are what it
 * names, and every assertion below is derived from the beat rather than from a fixture table.
 */
const DOMAINS = [
  {
    domain: "historical",
    prompt: "A documentary about Stauffenberg and the July 20 plot",
    beat: "Claus von Stauffenberg placed the briefcase beside Hitler at the Wolf's Lair in 1944.",
    mustProve: ["Stauffenberg", "Hitler"],
    topicTerm: "July",
  },
  {
    domain: "modern people",
    prompt: "A documentary about Elon Musk and the rise of Tesla",
    beat: "Elon Musk unveiled the Cybertruck to a stunned audience in Los Angeles.",
    mustProve: ["Elon", "Cybertruck"],
    topicTerm: "Tesla",
  },
  {
    domain: "technology",
    prompt: "A film about the iPhone and how Apple changed computing",
    beat: "Steve Jobs introduced the iPhone on stage in San Francisco in 2007.",
    mustProve: ["Jobs", "iPhone"],
    topicTerm: "Apple",
  },
  {
    domain: "sports",
    prompt: "A documentary about Formula 1 and the Monaco Grand Prix",
    beat: "Ayrton Senna took pole position at Monaco in 1988.",
    mustProve: ["Senna", "Monaco"],
    topicTerm: "Formula",
  },
  {
    domain: "places",
    prompt: "A travel documentary about Tokyo",
    beat: "Crowds crossed the Shibuya intersection under the neon signs.",
    mustProve: ["Shibuya"],
    topicTerm: "Tokyo",
  },
  {
    domain: "science",
    prompt: "A documentary about the James Webb Space Telescope and Mars exploration",
    beat: "The James Webb Space Telescope returned its first deep field image in 2022.",
    mustProve: ["Webb", "Telescope"],
    topicTerm: "Mars",
  },
] as const;

/* ═══════════════════════ §5 — the same architecture in every domain ═══════════════════════ */

describe("§5 — retrieval is topic-neutral", () => {
  /**
   * The beat's own words are admissible in EVERY domain. A gate that proved historical nouns and
   * refused modern ones would look fine on the July 20 render and block half of a Tesla film.
   */
  for (const d of DOMAINS) {
    it(`${d.domain}: the beat's own words can be searched for`, () => {
      const ctx = buildVerifiedQueryContextForBeat(d.beat, { sceneText: d.beat });
      for (const term of d.mustProve) {
        const v = validateSearchQuery(term, ctx);
        expect(v.ok, `${d.domain}: "${term}" is in the beat and was refused`).toBe(true);
      }
    });

    /** And the user's own prompt authorises its words in every domain, not only for WWII. */
    it(`${d.domain}: the prompt's words are admitted through the topic channel`, () => {
      withRenderTopic(d.prompt, () => {
        const ctx = buildVerifiedQueryContextForBeat(d.beat, { sceneText: d.beat });
        expect(
          validateSearchQuery(d.topicTerm, ctx).ok,
          `${d.domain}: "${d.topicTerm}" is in the prompt and was refused`
        ).toBe(true);
      });
    });

    /** The gate stays a gate everywhere: a word from neither the beat nor the prompt is refused. */
    it(`${d.domain}: an unproven word is still refused`, () => {
      withRenderTopic(d.prompt, () => {
        const ctx = buildVerifiedQueryContextForBeat(d.beat, { sceneText: d.beat });
        const v = validateSearchQuery("submarine pineapple", ctx);
        expect(v.ok, `${d.domain}: an invented term was admitted`).toBe(false);
      });
    });

    /** Every domain produces usable queries — not just the one the fixes were debugged against. */
    it(`${d.domain}: produces at least one prioritised query the gate accepts`, () => {
      withRenderTopic(d.prompt, () => {
        const ctx = buildVerifiedQueryContextForBeat(d.beat, { sceneText: d.beat });
        const queries = buildPrioritisedQueries(ctx).map((q) => q.query);
        expect(queries.length, `${d.domain}: no queries at all`).toBeGreaterThan(0);
        const accepted = queries.filter((q) => validateSearchQuery(q, ctx).ok);
        expect(
          accepted.length,
          `${d.domain}: the builder produced ${queries.length} queries and the gate refused all of them: ${queries.join(" | ")}`
        ).toBeGreaterThan(0);
      });
    });
  }

  /**
   * The structural claim, made once: no subject, person or era is named in the retrieval contract's
   * own source. A `topic === "WWII"` branch anywhere here would be invisible to every test above,
   * because it would simply make the historical case pass a little more easily.
   */
  it("names no specific subject, person or era in its decision code", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const sources = ["searchQueryContract.ts", "youtubePoolSource.ts", "poolRanking.ts"];
    for (const file of sources) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      /** Comments cite real production examples; only executable code is searched. */
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      for (const subject of ["WWII", "Stauffenberg", "Hitler", "Elon Musk", "Tesla", "World War"]) {
        expect(code, `${file} hardcodes "${subject}"`).not.toContain(`"${subject}"`);
      }
    }
  });
});

/* ═══════════════════════ §6 — the prompt proves, the title does not ═══════════════════════ */

describe("§6 — the exact prompt/title pair from the brief", () => {
  /** The brief's first case: the prompt names the era, so the era is authorised. */
  it("prompt names WWII → WWII is admissible", () => {
    withRenderTopic("A documentary about World War II and the July 20 plot", () => {
      const beat = "Stauffenberg placed the briefcase beside Hitler.";
      const ctx = buildVerifiedQueryContextForBeat(beat, { sceneText: beat });
      expect(validateSearchQuery("World War archival footage", ctx).ok).toBe(true);
    });
  });

  /**
   * The brief's second case, and the one that matters: the prompt is generic and only the TITLE
   * says WWII. The title is not evidence about any sentence, so the word stays unproven — which is
   * the RONDE 90 rule this round was forbidden from loosening.
   */
  it('prompt "European history" + title "WWII" → WWII is NOT admissible', () => {
    withRenderTopic("A documentary about European history", () => {
      const beat = "Stauffenberg placed the briefcase beside Hitler.";
      const ctx = buildVerifiedQueryContextForBeat(beat, { sceneText: beat });
      /** The title is not passed anywhere — that is the point, and this pins the outcome of it. */
      expect(ctx.topic).toBe("A documentary about European history");
      const v = validateSearchQuery("WWII archival footage", ctx);
      expect(v.ok, "a title-only term was admitted").toBe(false);
      expect(v.ok === false && v.blockedTerms).toContain("WWII");
    });
  });

  /** A person the title would supply and the script never states stays refused, in any domain. */
  it("a person only a title would name is still refused", () => {
    withRenderTopic("A documentary about the rise of Tesla", () => {
      const beat = "The factory floor ran through the night.";
      const ctx = buildVerifiedQueryContextForBeat(beat, { sceneText: beat });
      expect(validateSearchQuery("Elon Musk factory", ctx).ok).toBe(false);
    });
  });
});

/* ═══════════════════════ §7 — query quality ═══════════════════════ */

describe("§7 — queries are varied, bounded and not keyword soup", () => {
  const CAP = MAX_YOUTUBE_QUERIES_PER_BEAT;

  it("the per-beat YouTube query cap is six", () => {
    expect(CAP).toBe(6);
  });

  for (const d of DOMAINS) {
    /**
     * "WWII WWII WWII Hitler Berlin war 1945" is the failure mode the brief names. A query that
     * repeats a word is padding, and padding is what makes a provider return the generic result.
     */
    it(`${d.domain}: no query repeats a word`, () => {
      withRenderTopic(d.prompt, () => {
        const ctx = buildVerifiedQueryContextForBeat(d.beat, { sceneText: d.beat });
        for (const { query } of buildPrioritisedQueries(ctx)) {
          const words = query.toLowerCase().split(/\s+/).filter(Boolean);
          expect(new Set(words).size, `stuffed query: "${query}"`).toBe(words.length);
        }
      });
    });

    /** Distinct queries, not the same string in different orders — variety is the whole purpose. */
    it(`${d.domain}: the queries differ from one another`, () => {
      withRenderTopic(d.prompt, () => {
        const ctx = buildVerifiedQueryContextForBeat(d.beat, { sceneText: d.beat });
        const queries = buildPrioritisedQueries(ctx).map((q) => q.query.toLowerCase().trim());
        expect(new Set(queries).size, `duplicate queries: ${queries.join(" | ")}`).toBe(queries.length);
      });
    });

    /** And each one has to be short enough to be a query rather than a sentence. */
    it(`${d.domain}: no query is a whole sentence`, () => {
      withRenderTopic(d.prompt, () => {
        const ctx = buildVerifiedQueryContextForBeat(d.beat, { sceneText: d.beat });
        for (const { query } of buildPrioritisedQueries(ctx)) {
          const words = query.split(/\s+/).filter(Boolean);
          expect(words.length, `query is a sentence: "${query}"`).toBeLessThanOrEqual(10);
        }
      });
    });
  }
});
