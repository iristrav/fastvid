/**
 * ONE SUBJECT STAYS ONE SUBJECT.
 *
 * ── What render 595 sent to six providers ───────────────────────────────────────────────────
 *
 *     [SearchQueryCanonical] provider=wikimedia route=… was="Kylie Jenner" now="Kris Jenner Kylie"
 *
 * Two different people, merged into one query, by a function whose entire job is to make a query
 * NARROWER. The bug is mine, from the round before: `narrowToCanonicalQuery` took the render's
 * primary subject as the anchor whatever the query said, completed the query "towards" it, and the
 * subset rule saw nothing wrong because `Kylie` came from the query and `Kris`/`Jenner` are the
 * anchor's own words.
 *
 * ── The rule ────────────────────────────────────────────────────────────────────────────────
 *
 *     Subject completion may ONLY remove unsupported padding and complete missing parts of the
 *     SAME subject. Never replace a subject, never introduce another person, never combine two.
 *
 * Two independent guards enforce it, because one of them needs a fact the system does not always
 * have:
 *
 *   1. THE ANCHOR IS THE PERSON THE QUERY NAMES. Word overlap against the beat's verified people,
 *      so a beat carrying the whole family still sends each member their own query.
 *   2. A WORD BESIDE PART OF A NAME IS PART OF THAT NAME. Works on the words alone, so it holds
 *      when the second person was never verified at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { narrowToCanonicalQuery } from "./searchQueryContract";
import type { VerifiedQueryContext } from "./searchQueryContract";

const CONTRACT = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");

/** A verified context with the persons this beat proved, and the beat's own words as evidence. */
function ctx(persons: string[], evidence: string): VerifiedQueryContext {
  const tok = (terms: string[]) => terms.map((term) => ({ term, verified: true }));
  return {
    persons: tok(persons),
    events: [], objects: [], places: [], countries: [], time: [], years: [], actions: [],
    evidence,
  } as unknown as VerifiedQueryContext;
}

/* ═══════════════════ THE PRODUCTION DEFECT ═══════════════════ */

describe("render 595's query", () => {
  it("KYLIE JENNER STAYS KYLIE JENNER when both women are verified", () => {
    /**
     * The ordinary case for a family documentary: the beat proves several people and the query
     * says which one it is about. `Kylie Jenner` overlaps `Kylie Jenner` on two words and
     * `Kris Jenner` on one, so the query keeps its own subject.
     */
    const out = narrowToCanonicalQuery(
      "Kylie Jenner",
      ctx(["Kris Jenner", "Kylie Jenner"], "Kris Jenner and Kylie Jenner built the empire.")
    );
    expect(out.query.toLowerCase()).toContain("kylie");
    expect(out.query.toLowerCase()).not.toContain("kris");
  });

  it("AND IT STAYS KYLIE JENNER WHEN ONLY KRIS IS VERIFIED — the exact production case", () => {
    /**
     * This is the harder half and the one that actually fired. With `Kris Jenner` as the only
     * verified person the anchor choice cannot help: `Kylie Jenner` shares `jenner` with it, so
     * `Kris Jenner` is still picked. The second guard is what refuses — `kylie` survives the
     * narrowing and stands immediately beside `jenner`, which is part of the anchor's name.
     */
    const out = narrowToCanonicalQuery(
      "Kylie Jenner",
      ctx(["Kris Jenner"], "Kris Jenner watched Kylie Jenner take over.")
    );
    expect(out.query).toBe("Kylie Jenner");
    expect(out.narrowed).toBe(false);
  });

  it("IT IS NOT 'REPAIRED' TO THE OTHER PERSON EITHER", () => {
    /**
     * Falling back to the subject alone — "Kris Jenner" — would be the same defect wearing the
     * other face: the caller asked about one person and a different one would be searched for.
     * A refusal here returns the query exactly as it arrived.
     */
    for (const persons of [["Kris Jenner"], ["Kris Jenner", "Kylie Jenner"]]) {
      const out = narrowToCanonicalQuery("Kylie Jenner", ctx(persons, "Kris and Kylie Jenner."));
      expect(out.query.toLowerCase(), persons.join("/")).toContain("kylie");
    }
  });

  it("neither person is dropped when both are named in full", () => {
    /** A query that carries a second verified person's complete identity is left alone. */
    const out = narrowToCanonicalQuery(
      "Kris Jenner Kylie Jenner",
      ctx(["Kris Jenner", "Kylie Jenner"], "Kris Jenner and Kylie Jenner.")
    );
    expect(out.query).toBe("Kris Jenner Kylie Jenner");
    expect(out.narrowed).toBe(false);
  });
});

/* ═══════════════════ WHAT COMPLETION IS STILL FOR ═══════════════════ */

describe("a half-name still completes, because that is the same subject", () => {
  it("KANYE → KANYE WEST, with the padding gone", () => {
    /**
     * The case the function exists for. `kanye` is part of the anchor's own name, and
     * `documentary`/`footage` are padding the policy drops — nothing survives beside a name part,
     * so completion is allowed and the query gets smaller.
     */
    const out = narrowToCanonicalQuery(
      "kanye documentary footage",
      ctx(["Kanye West"], "kanye documentary footage of the tour")
    );
    expect(out.narrowed).toBe(true);
    expect(out.query.toLowerCase()).toContain("kanye");
    expect(out.query.toLowerCase()).toContain("west");
  });

  it("A QUERY THAT NAMES NO PART OF THE ANCHOR STILL ANCHORS — production render 595's good half", () => {
    /**
     * `Rumors kardashians Kardashians` → `Kris Jenner Rumors` was correct and is unchanged: the
     * query holds no anchor word at all, so nothing in it can be standing beside a name part.
     * Forty-one of these lines were right; the round must not cost them.
     */
    const out = narrowToCanonicalQuery(
      "Rumors kardashians Kardashians",
      ctx(["Kris Jenner"], "Rumors about the Kardashians followed Kris Jenner everywhere.")
    );
    expect(out.narrowed).toBe(true);
    expect(out.query.toLowerCase()).toContain("kris");
    expect(out.query.toLowerCase()).toContain("jenner");
  });

  it("a query already equal to the anchor is left alone", () => {
    const out = narrowToCanonicalQuery("Kris Jenner", ctx(["Kris Jenner"], "Kris Jenner."));
    expect(out.query).toBe("Kris Jenner");
  });

  it("a beat with no proven person narrows nothing at all", () => {
    const out = narrowToCanonicalQuery("archival footage", ctx([], "It filled the news that year."));
    expect(out).toEqual({ query: "archival footage", narrowed: false });
  });

  it("provider syntax is never touched", () => {
    const out = narrowToCanonicalQuery("mediatype:movies AND subject:war", ctx(["Kris Jenner"], "x"));
    expect(out.narrowed).toBe(false);
  });
});

/* ═══════════════════ THE GUARDS ARE THE EXACT CONDITIONALS ═══════════════════ */

describe("the guards are present and switched on", () => {
  const FN = (() => {
    const at = CONTRACT.indexOf("export function narrowToCanonicalQuery(");
    return at < 0 ? "" : CONTRACT.slice(at, CONTRACT.indexOf("\nexport function searchGateDecision("));
  })();

  it("THE ANCHOR IS CHOSEN BY OVERLAP, not taken from position zero", () => {
    expect(FN, "narrowToCanonicalQuery is gone").not.toBe("");
    /**
     * The exact conditional, not merely the name: a mutation proved that a presence check passes
     * while the branch is disabled, so this asserts the comparison that does the choosing.
     */
    expect(FN).toContain("const overlap = conceptWords(person).filter((w) => originalSet.has(w)).length;");
    expect(FN).toContain("if (overlap > bestOverlap) {");
    expect(FN, "the anchor is back to persons[0] unconditionally").not.toContain(
      'const anchor = verifiedTerms(ctx.persons)[0] ?? "";'
    );
  });

  it("A SECOND PERSON NAMED IN FULL BLOCKS NARROWING OUTRIGHT", () => {
    expect(FN).toContain("const namesSomeoneElseInFull = persons.some((person) => {");
    expect(FN).toContain("return words.length > 0 && words.every((w) => originalSet.has(w));");
    expect(FN).toContain("if (namesSomeoneElseInFull) return { query: original, narrowed: false };");
  });

  it("AND A SURVIVING WORD BESIDE A NAME PART REFUSES THE COMPLETION", () => {
    expect(FN).toContain("const absorbsANeighbour = originalWords.some((w, i) => {");
    expect(FN).toContain("if (anchorWords.has(w) || !outWords.has(w)) return false;");
    expect(FN).toContain(
      "return (before != null && anchorWords.has(before)) || (after != null && anchorWords.has(after));"
    );
    expect(FN).toContain("if (absorbsANeighbour) return { query: original, narrowed: false };");
  });

  it("the RONDE 91 order is untouched — refuse first, narrow only what was admitted", () => {
    /**
     * §11: the gate may not be relaxed. Narrowing runs AFTER `validateSearchQuery` has admitted the
     * text, so an unproven term still blocks the WHOLE query and the proven prefix is not quietly
     * sent instead. Asserted on the gate's own body because that is where the order lives.
     */
    const gate = CONTRACT.slice(CONTRACT.indexOf("export function searchGateDecision("));
    const validate = gate.indexOf("const verdict = validateSearchQuery(text");
    const narrow = gate.indexOf("const canonical = narrowToCanonicalQuery(text, ambient);");
    expect(validate).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(validate);
  });
});
