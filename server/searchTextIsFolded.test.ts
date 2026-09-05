/**
 * RONDE 88A P1/P2 — "FÜHRERBUNKER" IS ONE WORD, EVERYWHERE OR NOWHERE.
 *
 * ── What render 568 measured ─────────────────────────────────────────────────────────────────
 *
 *     blockedTerms=["hrerbunker"]    ×6
 *     blockedTerms=["fuhrerbunker"]  ×6
 *
 * Two different corruptions of one word, in one render, from one script. Neither is a word any
 * archive contains, and the second is not even a corruption — it is the CORRECT folded spelling,
 * refused by a gate that was comparing it against an unfolded script.
 *
 * ── The two halves ───────────────────────────────────────────────────────────────────────────
 *
 * `hrerbunker` is what an ASCII-only word class does to "Führerbunker": `ü` is not in `[a-z0-9]`
 * and not in `\w`, so the word splits into "f" and "hrerbunker" and the one-letter fragment falls
 * to the next `length >= 4` filter. `searchTextNormalize` was written for exactly this in RONDE 51,
 * and its own header names this exact string. It reached two builders. Seven more kept their own
 * ASCII class, including the one that turns a video TITLE into a provider query.
 *
 * `fuhrerbunker` is the opposite failure. The builders that DID fold emit the folded spelling; the
 * query gate's `evidenceStems` did not fold, so it compared `fuhrerbunker` against the script's
 * `führerbunker`, found nothing, and reported UNVERIFIED_TERM about a word the beat contains.
 *
 * ── What this does NOT do ────────────────────────────────────────────────────────────────────
 *
 * Folding is not loosening. A term still has to be IN the evidence to be proven — an invented word,
 * an LLM's guess, a title inference are all refused exactly as before, and the tests below prove
 * that as carefully as they prove the fix. What changed is that "the same word" now survives an
 * umlaut, in both directions.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  evidenceStem,
  evidenceStems,
  validateSearchQuery,
  type VerifiedQueryContext,
} from "./searchQueryContract";
import { foldSearchText } from "./searchTextNormalize";

/* ═══════════════ the gate proves a word the script actually says ═══════════════ */

/** Minimal context: nothing typed, only the beat's own words as evidence. */
const ctxWith = (evidence: string): VerifiedQueryContext => ({
  persons: [],
  places: [],
  countries: [],
  events: [],
  actions: [],
  objects: [],
  time: [],
  years: [],
  evidence,
});

const SCRIPT = "Hitler spent his final days in the Führerbunker beneath Berlin.";

describe("an umlaut does not make the script's own word a guess", () => {
  it("proves the folded spelling from the accented script", () => {
    expect(validateSearchQuery("fuhrerbunker", ctxWith(SCRIPT)).ok).toBe(true);
  });

  it("proves the accented spelling from the accented script", () => {
    expect(validateSearchQuery("Führerbunker", ctxWith(SCRIPT)).ok).toBe(true);
  });

  /** Symmetric: a folded script proves an accented query too. */
  it("proves the accented spelling from a folded script", () => {
    expect(validateSearchQuery("Führerbunker", ctxWith(foldSearchText(SCRIPT))).ok).toBe(true);
  });

  it("is not confused by ß, ø or æ either", () => {
    expect(validateSearchQuery("strasse", ctxWith("They marched down the Straße.")).ok).toBe(true);
    expect(validateSearchQuery("Straße", ctxWith("They marched down the strasse.")).ok).toBe(true);
  });

  /**
   * THE GATE IS NOT LOOSER. Folding changes the spelling of a comparison, never its answer about
   * whether the script said the thing. If any of these start passing, the fix has become a hole.
   */
  it("still refuses a word the script does not contain", () => {
    const v = validateSearchQuery("reichstag", ctxWith(SCRIPT));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("UNVERIFIED_TERM");
  });

  /**
   * Folding is not stemming and it is not word-splitting. "Führerbunker" is one word: it proves
   * itself and nothing else. A gate that let "fuhrer" through here would be inventing a term out
   * of a compound, which is a different fix and not one this round makes.
   */
  it("still refuses a fragment of a compound the script does say", () => {
    expect(validateSearchQuery("fuhrer", ctxWith(SCRIPT)).ok).toBe(false);
    expect(validateSearchQuery("bunker", ctxWith(SCRIPT)).ok).toBe(false);
  });

  /** RONDE 90's inflection rule still applies on top of folding, not instead of it. */
  it("still proves an inflection of an accented word", () => {
    const script = "They sheltered in the Führerbunker and in other Bunker positions.";
    expect(validateSearchQuery("bunkers", ctxWith(script)).ok).toBe(true);
  });

  it("still refuses an accented word the script never used", () => {
    expect(validateSearchQuery("München", ctxWith(SCRIPT)).ok).toBe(false);
    expect(validateSearchQuery("munchen", ctxWith(SCRIPT)).ok).toBe(false);
  });

  /** An unverified typed token keeps naming WHO guessed it, folded or not. */
  it("still names the route that guessed an accented term", () => {
    const ctx: VerifiedQueryContext = {
      ...ctxWith("Hitler spent his final days beneath Berlin."),
      persons: [{ term: "Göring", type: "person", source: "llm_generated", verified: false }],
    };
    const v = validateSearchQuery("Göring", ctx);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("LLM_GENERATED_TERM");
  });
});

describe("evidenceStems folds without losing its inflection rules", () => {
  it("folds", () => {
    expect(evidenceStems("Führerbunker")).toContain("fuhrerbunker");
    expect(evidenceStems("Führerbunker")).toEqual(evidenceStems("fuhrerbunker"));
    expect(evidenceStems("Führerbunker").every((s) => /^[a-z]+$/.test(s))).toBe(true);
  });

  /** RONDE 90's rules are untouched — these are the same expectations that file asserts. */
  it("still stems only inflections", () => {
    expect(evidenceStem("canals")).toBe("canal");
    expect(evidenceStem("bus")).toBe("bus");
    expect(evidenceStem("berlin")).toBe("berlin");
    expect(evidenceStem("cycling")).not.toBe(evidenceStem("cyclists"));
  });

  /** Non-Latin scripts have no diacritics to strip and must survive intact. */
  it("leaves a non-Latin word alone", () => {
    expect(evidenceStem("Берлин")).toBe("берлин");
  });
});

/* ═══════════════ and no builder mangles the word on the way in ═══════════════ */

/**
 * Every module that turns TEXT into WORDS for searching, matching or scoring. A module joins this
 * list when it starts doing that — which is the moment it also acquires the defect this file is
 * about.
 */
const SEARCH_TEXT_MODULES = [
  "videoPipeline.ts",
  "scenePool.ts",
  "curatedMediaSourcing.ts",
  "mediaResearchEngine.ts",
  "scriptGuidedClipFinder.ts",
  "scriptVisualKeywords.ts",
  "searchQueryContract.ts",
  "clipGoodCache.ts",
  "localClipVision.ts",
  "replacementCandidates.ts",
  "scriptWriter.ts",
  "archiveUsageMemory.ts",
  "candidateTopicalRelevance.ts",
];

/** An ASCII-only letter class — the shape that cuts an accented word in half. */
const ASCII_WORD_CLASS = /\[\^a-zA-Z0-9|\[\^a-z0-9|\[\^a-zA-Z|\[\^a-z |\\W/;

type Site = { module: string; line: number; text: string; context: string };

function asciiClassSites(): Site[] {
  const out: Site[] = [];
  for (const module of SEARCH_TEXT_MODULES) {
    const lines = fs.readFileSync(path.join(__dirname, module), "utf8").split("\n");
    lines.forEach((text, i) => {
      // A comment ABOUT the defect is not the defect — this file and the fixes it guards both
      // quote `\W` and `[^a-z0-9]` in prose, and matching those would make the scan unreadable.
      const code = text.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      if (!ASCII_WORD_CLASS.test(text)) return;
      out.push({
        module,
        line: i + 1,
        text: text.trim(),
        context: lines.slice(Math.max(0, i - 3), i + 1).join("\n"),
      });
    });
  }
  return out;
}

describe("no search-text builder splits words on an ASCII class", () => {
  /** The scan has to find something, or every assertion below is vacuously true. */
  it("finds the ASCII classes that exist", () => {
    expect(asciiClassSites().length).toBeGreaterThanOrEqual(10);
  });

  /**
   * THE RULE, IN ONE PLACE.
   *
   * An ASCII-only word class is correct in exactly two situations: the text was folded first, or it
   * is not search text at all (a filename, an id, a slug). The first is visible in the code; the
   * second is a judgement, so it has to be written down as `// ascii-safe: <why>`. Everything else
   * is the render-568 defect waiting to happen, and this test is where the next one is caught
   * instead of being found in a production log.
   */
  it("every ASCII class is folded first or marked ascii-safe", () => {
    const unexplained = asciiClassSites().filter(
      (s) =>
        !/foldSearchText\(|foldToSearchTokensText\(/.test(s.context) &&
        !/ascii-safe:/.test(s.context)
    );
    expect(
      unexplained.map((s) => `${s.module}:${s.line}  ${s.text}`),
      "an ASCII-only word class with no fold and no ascii-safe reason — see this file's header"
    ).toEqual([]);
  });

  /** A marker without a reason is a way to switch the rule off, so it has to say something. */
  it("every ascii-safe marker gives a reason", () => {
    for (const module of SEARCH_TEXT_MODULES) {
      const src = fs.readFileSync(path.join(__dirname, module), "utf8");
      for (const m of src.matchAll(/ascii-safe:(.*)/g)) {
        expect(m[1]!.trim().length, `${module}: an ascii-safe marker with no reason`).toBeGreaterThan(15);
      }
    }
  });

  /** The line that produced `hrerbunker`, named so it cannot quietly come back. */
  it("the title-to-query builder folds", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const at = src.indexOf("const titleWords = ");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toContain("foldSearchText(videoTitle");
  });
});
