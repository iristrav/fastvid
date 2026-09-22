/**
 * A MONTH IS NOT A PLACE TO FILM — RONDE 613.
 *
 * ── What render 597 asked for ───────────────────────────────────────────────────────────────
 *
 * The beat: "April 30th, 1945. In the austere confines of the Führerbunker, Adolf Hitler and Eva
 * Braun spent their last hours." What `extractBeatSubject` built from it, measured:
 *
 *     "Adolf Hitler april"
 *
 * And what the picture editor then said, ninety-six times across that render:
 *
 *     "The clip shows Adolf Hitler at a public event, which does not match the description of him
 *      huddling with Eva Braun in the Führerbunker."
 *
 * The judge was right every time. `Adolf Hitler april` returns Hitler in some April, of some year,
 * in some place. `Führerbunker` was in the beat, one entry further down a list read in sentence
 * order, and was never reached because "April" opens the sentence.
 *
 * ── WHAT THIS ROUND CHANGES ─────────────────────────────────────────────────────────────────
 *
 * The ORDER of the proper-noun tier, and nothing else. A bare month is taken last instead of
 * first. Nothing is filtered out: a beat whose only proper noun is a month still searches for the
 * month. `MONTH_NAMES` is RONDE 71's existing list, not a new vocabulary.
 *
 * ── MEASURED, NOT ARGUED ────────────────────────────────────────────────────────────────────
 *
 * Every expectation below was measured through `scriptStockSearchQueries` before and after the
 * change, with one harness and one variable. Of the four beats of render 597 that were measured,
 * exactly one moved — the one above — and three were untouched.
 *
 * ── A NEIGHBOURING DEFECT THAT IS NOT THIS ROUND'S ──────────────────────────────────────────
 *
 * Two things were found next to this and are deliberately NOT fixed here, because each needs its
 * own measurement and mixing them makes neither evaluable:
 *
 *   1. The person's own name can come back inside the chosen entry — "In April, Adolf Hitler
 *      spoke" yields `Adolf Hitler april adolf hitler`. That is RONDE 88A's and 248's failure
 *      reached by a third route: a capitalised run crosses a comma, so the entry is "April Adolf
 *      Hitler", which `notPerson` correctly calls "not the person" because of the month. It is
 *      unchanged by this round — before and after produce it identically.
 *   2. A sentence-initial capitalised word is read as a proper noun, so "Deep inside Reactor Four"
 *      offers "Deep". With the month demoted this can now win where the month used to. Asserted
 *      nowhere below, because it is a defect and pinning it would make it permanent.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { scriptStockSearchQueries } from "./videoPipeline";

const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** The subject query is the first entry; the second is always the bare person fallback. */
const subjectFor = (beat: string, person: string) =>
  (scriptStockSearchQueries(beat, [person], "", "documentary")[0] ?? "").toLowerCase();

/* ═══════════ §1 — the beat render 597 lost ═══════════ */

describe("§1 — render 597, scene 2", () => {
  const BEAT =
    "April 30th, 1945. In the austere confines of the Führerbunker, Adolf Hitler and Eva Braun spent their last hours.";

  it("THE PLACE THE BEAT IS ABOUT IS NOW IN THE QUERY", () => {
    expect(subjectFor(BEAT, "Adolf Hitler")).toContain("führerbunker");
  });

  it("AND THE MONTH IS NOT — this is the word that was there instead", () => {
    expect(subjectFor(BEAT, "Adolf Hitler")).not.toContain("april");
  });
});

/* ═══════════ §2 — topic-agnostic, which is the whole requirement ═══════════ */

describe("§2 — the same rule on subjects that share nothing with render 597", () => {
  it("a moon landing: the lander, not the month", () => {
    const q = subjectFor(
      "July 20th, 1969. Inside the cramped Eagle lander, Neil Armstrong began the descent.",
      "Neil Armstrong"
    );
    expect(q).toContain("eagle");
    expect(q).not.toContain("july");
  });

  it("a reactor: the reactor, not the month", () => {
    const q = subjectFor(
      "April 26th, 1986. Inside Reactor Four, Anatoly Dyatlov ordered the test to continue.",
      "Anatoly Dyatlov"
    );
    expect(q).toContain("reactor");
    expect(q).not.toContain("april");
  });

  it("and it is a fact about calendars, so no subject is named in the rule", () => {
    const at = SRC.indexOf("const isBareMonth = (w: string) =>");
    /** The EXECUTABLE rule. The prose around it quotes render 597 by name, which is the point. */
    const code = SRC.slice(at, SRC.indexOf("return extra ?", at))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .toLowerCase();
    for (const word of ["hitler", "bunker", "1945", "armstrong", "reactor", "april"]) {
      expect(code, `${word} was hardcoded into the rule`).not.toContain(word);
    }
  });
});

/* ═══════════ §3 — NOTHING WAS FILTERED OUT ═══════════ */

describe("§3 — a demotion, not a removal", () => {
  it("A MONTH IS STILL TAKEN WHEN IT IS ALL THE BEAT HAS", () => {
    /**
     * If this ever returns the bare person, the round stopped being an ordering and became a
     * filter — and a beat that genuinely only says "April" would search for nothing.
     */
    expect(subjectFor("April arrived.", "Adolf Hitler")).toBe("adolf hitler april");
  });

  it("the fallback that makes that true is present and comes second", () => {
    const demoted = SRC.indexOf("proper.find((w) => notPerson(w) && !isBareMonth(w))");
    const plain = SRC.indexOf("proper.find(notPerson)", demoted);
    expect(demoted).toBeGreaterThan(-1);
    expect(plain, "the unfiltered pass must still exist, after the demoted one").toBeGreaterThan(
      demoted
    );
  });

  it("a beat with no month at all is untouched", () => {
    expect(subjectFor("Adolf Hitler and Eva Braun spent their last hours.", "Adolf Hitler")).toBe(
      "adolf hitler eva braun"
    );
  });
});

/* ═══════════ §4 — the tier that was deliberately left alone ═══════════ */

describe("§4 — the common-noun tier is unchanged, and that was measured too", () => {
  it("A LOWERCASE BEAT STILL YIELDS THE MONTH", () => {
    /**
     * The same demotion in the `common` tier was written, measured, and reverted: on this beat it
     * produced `Adolf Hitler returned` — a bare verb, which is the one thing
     * `aVerbYouCannotFilmAndHalfAPlaceName` exists to keep out of a query. A date is a poor
     * subject; a verb is not a subject at all. This pins the revert so it cannot be undone as a
     * tidiness improvement without this test objecting.
     */
    expect(subjectFor("in april hitler returned to berlin", "Adolf Hitler")).toBe(
      "adolf hitler april"
    );
  });

  it("and the reason is written down where the code is, not only here", () => {
    expect(SRC).toContain("THE PROPER TIER ONLY, AND THAT ASYMMETRY IS MEASURED");
  });
});

/* ═══════════ §5 — no new vocabulary ═══════════ */

describe("§5 — RONDE 71's list, not a second one", () => {
  it("MONTH_NAMES is declared exactly once in this file", () => {
    expect([...SRC.matchAll(/const MONTH_NAMES\s*=/g)].length).toBe(1);
  });

  it("and the demotion reads it rather than listing months of its own", () => {
    const at = SRC.indexOf("const isBareMonth = (w: string) =>");
    const body = SRC.slice(at, SRC.indexOf("\n    const extra =", at));
    expect(body).toContain("MONTH_NAMES.has(");
    for (const m of ["january", "february", "march", "april"]) {
      expect(body.toLowerCase(), `${m} was spelled out again`).not.toContain(`"${m}"`);
    }
  });

  it("only a SINGLE word is a bare month — a dated phrase is a subject, not a calendar", () => {
    const at = SRC.indexOf("const isBareMonth = (w: string) =>");
    const body = SRC.slice(at, SRC.indexOf("\n    /**", at));
    expect(body).toContain("split(/\\s+/).length === 1");
  });
});
