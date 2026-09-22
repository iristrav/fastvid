/**
 * A COMPOUND PROVES ITS PARTS — RONDE 610.
 *
 * ── What render 597 measured ────────────────────────────────────────────────────────────────
 *
 *     [BeatRelevance] attempts=118 answered=117 fits=21 does_not_fit=96 never_asked=60
 *
 * Four in five pictures refused. The picture editor was right every time — a baby on an
 * upholstered chair, a drop of black liquid, a title card about Kamikaze pilots, all offered for
 * a scene about Hitler's last hours in the Führerbunker. The editor was not too strict; it was
 * being handed the wrong pictures.
 *
 * ── Where the wrong pictures came from ──────────────────────────────────────────────────────
 *
 * The query builder does its job. It built contextual queries and the gate refused them:
 *
 *     [SearchQueryRejected] query="hitler bunker"                term="bunker" UNVERIFIED_TERM
 *     [SearchQueryRejected] query="fuhrer historical photograph" term="fuhrer" UNVERIFIED_TERM
 *     [SearchQueryRejected] query="fuhrer documentary footage"   term="fuhrer" UNVERIFIED_TERM
 *
 * The narration says "Führerbunker". Folded, the evidence holds `fuhrerbunker`; the query holds
 * `bunker` and `fuhrer`. `evidenceStems` compares whole words and strips suffixes, so a German
 * compound proved neither of its own parts. Strip the context and `Adolf` is what is left.
 *
 * This is RONDE 568's failure one level down. That round made `führerbunker` and `fuhrerbunker`
 * one word. This makes `Führerbunker` prove the words it is built from.
 *
 * ── WHAT THIS ROUND DOES NOT DO ─────────────────────────────────────────────────────────────
 *
 * It does not relax the gate. `documentary`, `establishing`, `history`, `military`, `street`,
 * `building` and `1930s` were refused in the same render and are refused still — generic filler
 * with nothing anchoring it to the beat, which is the exact thing this module was built to stop.
 * NO_CONTENT_ANCHOR is untouched.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  compoundEvidenceFor,
  emptyQueryContext,
  evidenceStems,
  validateSearchQuery,
} from "./searchQueryContract";

const SRC = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");

/** Evidence words arrive folded and cleaned, the way `addProven` stores them. */
const evidence = (...words: string[]) =>
  words.map((w) =>
    w
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}'-]/gu, "")
  );

/* ═══════════ §1 — the defect, named ═══════════ */

describe("§1 — render 597's two refusals", () => {
  it("THE OLD RULE: a compound proves neither of its parts", () => {
    /** Unchanged behaviour of `evidenceStems`, kept here as the baseline this round works from. */
    const stems = new Set(evidenceStems("Führerbunker"));
    expect(evidenceStems("bunker").some((s) => stems.has(s))).toBe(false);
    expect(evidenceStems("fuhrer").some((s) => stems.has(s))).toBe(false);
  });

  it("THE NEW RULE: the script's own compound proves them", () => {
    expect(compoundEvidenceFor("bunker", evidence("Führerbunker"))).toBe("fuhrerbunker");
    expect(compoundEvidenceFor("fuhrer", evidence("Führerbunker"))).toBe("fuhrerbunker");
  });

  it("and it still folds, so the umlaut is not a second barrier", () => {
    expect(compoundEvidenceFor("bunker", evidence("fuhrerbunker"))).toBe("fuhrerbunker");
    expect(compoundEvidenceFor("bünker", evidence("Führerbunker"))).toBe("fuhrerbunker");
  });
});

/* ═══════════ §2 — ONE DIRECTION, which is the whole safety property ═══════════ */

describe("§2 — a query may never be broader than the script", () => {
  it("the script's compound proves the query's part", () => {
    expect(compoundEvidenceFor("bunker", evidence("Führerbunker"))).not.toBeNull();
  });

  it("THE SCRIPT'S PART PROVES NOTHING ABOUT A COMPOUND THE QUERY INVENTED", () => {
    /**
     * If this ever returns a word, the gate has been inverted: a render whose script merely says
     * "bunker" could search for "Führerbunker", which is a claim about the world nobody made.
     */
    expect(compoundEvidenceFor("fuhrerbunker", evidence("bunker"))).toBeNull();
    expect(compoundEvidenceFor("reichstag", evidence("reich"))).toBeNull();
  });

  it("an evidence word the same length proves nothing either", () => {
    expect(compoundEvidenceFor("bunker", evidence("bunker"))).toBeNull();
  });
});

/* ═══════════ §3 — a compound rule, not a substring rule ═══════════ */

describe("§3 — both halves must mean something", () => {
  it("RESEARCH DOES NOT PROVE EAR — the test this rule would fail as a substring match", () => {
    expect(compoundEvidenceFor("ear", evidence("research"))).toBeNull();
    expect(compoundEvidenceFor("sear", evidence("research"))).toBeNull();
  });

  it("a term shorter than five letters is never proven this way", () => {
    expect(compoundEvidenceFor("war", evidence("warplane", "postwar"))).toBeNull();
    expect(compoundEvidenceFor("eva", evidence("evacuation"))).toBeNull();
  });

  it("and the REMAINDER must clear the same bar", () => {
    /** `researcher` minus `research` is `er` — two letters, so it is a suffix, not a compound. */
    expect(compoundEvidenceFor("research", evidence("researcher"))).toBeNull();
    /** `bunkers` minus `bunker` is `s`. A plural is `evidenceStems`' job, not this one. */
    expect(compoundEvidenceFor("bunker", evidence("bunkers"))).toBeNull();
  });

  it("only at the start or the end, never floating in the middle", () => {
    /** `reichskanzlei` contains `kanzl` in the middle; a boundary rule must refuse it. */
    expect(compoundEvidenceFor("skanz", evidence("reichskanzlei"))).toBeNull();
  });

  it("a genuine two-part compound works from either side", () => {
    expect(compoundEvidenceFor("kanzlei", evidence("reichskanzlei"))).toBe("reichskanzlei");
    expect(compoundEvidenceFor("reichs", evidence("reichskanzlei"))).toBe("reichskanzlei");
  });
});

/* ═══════════ §4 — the gate still refuses what it should ═══════════ */

describe("§4 — nothing was relaxed", () => {
  /** The narration of render 597's scene 2, near enough for the terms it proves. */
  const script = evidence(
    "April",
    "30th",
    "1945",
    "In",
    "the",
    "austere",
    "confines",
    "of",
    "the",
    "Führerbunker",
    "Adolf",
    "Hitler",
    "and",
    "Eva",
    "Braun"
  );

  it("the generic filler render 597 refused is refused still", () => {
    for (const term of [
      "documentary",
      "establishing",
      "history",
      "military",
      "street",
      "building",
      "suicide",
      "poison",
    ]) {
      expect(compoundEvidenceFor(term, script), `${term} became provable`).toBeNull();
    }
  });

  it("and a word from a different subject entirely is not smuggled in", () => {
    for (const term of ["gigafactory", "tesla", "rocket", "flamingo"]) {
      expect(compoundEvidenceFor(term, script), `${term} became provable`).toBeNull();
    }
  });

  it("but the two words that carry the beat's context now are", () => {
    expect(compoundEvidenceFor("bunker", script)).toBe("fuhrerbunker");
    expect(compoundEvidenceFor("fuhrer", script)).toBe("fuhrerbunker");
  });
});

/* ═══════════ §5 — the wiring, and that it is loud ═══════════ */

describe("§5 — how the gate uses it", () => {
  it("the whole-word test runs FIRST — this only sees terms it already refused", () => {
    const stemAt = SRC.indexOf("if (evidenceStems(w).some((form) => proven.has(form))) {");
    const compoundAt = SRC.indexOf("const compound = compoundEvidenceFor(w, provenWords);");
    expect(stemAt).toBeGreaterThan(-1);
    expect(compoundAt).toBeGreaterThan(-1);
    expect(stemAt, "the compound rule runs before the rule it is a fallback for").toBeLessThan(
      compoundAt
    );
  });

  it("EVERY admission is announced — a rule that widens a gate quietly is the defect itself", () => {
    expect(SRC).toContain("[QueryTermProvenByCompound]");
    expect(SRC, "the log must name the evidence, not just the term").toContain('provenBy="${evidence}"');
  });

  it("the evidence it reads is the SAME evidence, written at the same moment", () => {
    /**
     * `provenWords` is filled inside `addProven`, one line after `proven` — narration, scene,
     * verified entities and the user's own prompt. No new source, no second registry.
     */
    const at = SRC.indexOf("const addProven = (term: string) => {");
    const body = SRC.slice(at, SRC.indexOf("\n  };", at));
    expect(body).toContain("for (const form of evidenceStems(clean)) proven.add(form);");
    expect(body).toContain("provenWords.add(folded)");
  });

  it("NO_CONTENT_ANCHOR is untouched", () => {
    /** Generic filler with nothing anchoring it to a beat is a different refusal, and stays. */
    expect(SRC).toContain('return { ok: false, reason: "NO_CONTENT_ANCHOR"');
  });

  it("and the minimum part length is stated once", () => {
    expect(SRC).toContain("const COMPOUND_MIN_PART = 5;");
    /** Once declared, twice read — the term's length and the remainder's. No literal 5 anywhere. */
    expect([...SRC.matchAll(/COMPOUND_MIN_PART/g)].length, "the bar was spelled twice").toBe(3);
    const at = SRC.indexOf("export function compoundEvidenceFor(");
    const body = SRC.slice(at, SRC.indexOf("\n}", at));
    expect(body, "the bar was inlined as a number").not.toMatch(/length\s*[<>]=?\s*5\b/);
  });
});

/* ═══════════ §6 — a part is a refinement, never the whole query ═══════════ */

describe("§6 — the two ways a compound part is NOT a refinement", () => {
  /**
   * A first version of this rule had only `compoundEvidenceFor` and admitted anything it matched.
   * Two EXISTING tests caught it — `searchTextIsFolded` ("still refuses a fragment of a compound
   * the script does say") and `historicalEntityAndPreflight` (refuses "fuhrer bunker Berlin").
   * Both were right. They are unchanged; what they protect is asserted here as well, so the rule
   * cannot be widened later without this file objecting too.
   */
  const script = "In April 1945 Hitler retreated to the Führerbunker beneath Berlin.";
  const ctx = () => emptyQueryContext(script, "Second World War");

  it("A PART MAY NOT STAND ALONE — bunker alone fetches golf bunkers", () => {
    expect(validateSearchQuery("bunker", ctx()).ok).toBe(false);
    expect(validateSearchQuery("fuhrer", ctx()).ok).toBe(false);
  });

  it("TWO PARTS OF ONE COMPOUND IS THE WORD SPLIT, NOT A QUERY", () => {
    const v = validateSearchQuery("fuhrer bunker Berlin", ctx());
    expect(v.ok, "Führerbunker cut in half with a space").toBe(false);
    expect(v.ok === false && v.reason).toBe("UNVERIFIED_TERM");
  });

  it("BUT THE CASE RENDER 597 LOST NOW PASSES — a part narrowing a proven anchor", () => {
    /** `hitler` is proven outright; `bunker` narrows it. This was refused, and `Adolf` remained. */
    expect(validateSearchQuery("Hitler bunker", ctx()).ok).toBe(true);
  });

  it("and the whole compound still proves itself, as it always did", () => {
    expect(validateSearchQuery("Führerbunker Berlin 1945", ctx()).ok).toBe(true);
    expect(validateSearchQuery("fuhrerbunker Berlin", ctx()).ok).toBe(true);
  });

  it("the ASCII-truncation artefact RONDE 568 caught is still refused", () => {
    /** `hrebunker` is not a boundary component of `fuhrerbunker` — it is a corruption. */
    expect(validateSearchQuery("hrebunker Berlin", ctx()).ok).toBe(false);
    expect(compoundEvidenceFor("hrebunker", evidence("Führerbunker"))).toBeNull();
  });
});
