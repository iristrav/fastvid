/**
 * WHAT A SENTENCE OPENS WITH IS NOT WHAT IT IS ABOUT — RONDE 614.
 *
 * Two defects in `beatSubjectCandidates`, found while measuring RONDE 613 and fixed here. Both
 * are the opening of a sentence contaminating the subject the query is built from, and both are
 * the failure RONDE 71 named when it removed the positional heuristic: a query assembled out of
 * grammar instead of meaning.
 *
 * ── 1. THE NAME APPENDED TO ITSELF ──────────────────────────────────────────────────────────
 *
 * RONDE 248 joins adjacent capitalised words so "Los Angeles" is one name. Adjacency was tested
 * on the token index, and tokens split on whitespace, so a comma between them was invisible:
 *
 *     "In April, Adolf Hitler spoke to the crowd."   ->   "Adolf Hitler april adolf hitler"
 *
 * "April," and "Adolf" are adjacent tokens, so they joined into the entry "april adolf hitler".
 * `notPerson` then answered true — correctly, the entry is not the person, it carries a month the
 * person's name does not — and the person's own name was appended to the person. Three of the
 * query's words are the subject's name and the budget is gone.
 *
 * That is RONDE 88A's and RONDE 248's failure reached a third time by a third route, which is why
 * the fix is the run-breaking rule itself and not a filter at the reading end. RONDE 248's own
 * note already states the principle — "two capitalised words with a stop word between them are
 * not one name" — and it was simply never enforced for punctuation.
 *
 * ── 2. THE ADVERB READ AS A NAME ────────────────────────────────────────────────────────────
 *
 * A capitalised word in position 0 is a name unless `SENTENCE_OPENER_WORDS` knows better, and
 * that list held function words and almost nothing else. Measured: of sixty-three ordinary
 * openers placed in front of a sentence whose subject was plainly "Reactor Four", twenty-seven
 * became the subject themselves. "Deep inside Reactor Four, Anatoly Dyatlov ordered the test"
 * searched for `Anatoly Dyatlov deep`. All twenty-seven were added to the list; none was added on
 * a suspicion that it might leak.
 *
 * ── WHAT WAS MEASURED ───────────────────────────────────────────────────────────────────────
 *
 * Nineteen beats through `scriptStockSearchQueries`, before and after, one harness. Six changed,
 * five of them to a strictly better query; the sixth is the known cost in §5. Every sentence
 * quoted from a real render — RONDE 248's render 584, RONDE 71's three measured sentences,
 * RONDE 88A's Göring — came out unchanged.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { scriptStockSearchQueries } from "./videoPipeline";

const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

const subjectFor = (beat: string, person: string) =>
  (scriptStockSearchQueries(beat, [person], "", "documentary")[0] ?? "").toLowerCase();

/* ═══════════ §1 — a name may not be appended to itself ═══════════ */

describe("§1 — the person's own name, back inside the query", () => {
  it("A COMMA ENDS THE NAME — this produced 'Adolf Hitler april adolf hitler'", () => {
    expect(subjectFor("In April, Adolf Hitler spoke to the crowd.", "Adolf Hitler")).toBe(
      "adolf hitler april"
    );
  });

  it("and on render 597's own beat, which RONDE 613 had only half fixed", () => {
    expect(
      subjectFor(
        "April 30th, 1945. In the austere confines of the Führerbunker, Adolf Hitler and Eva Braun spent their last hours.",
        "Adolf Hitler"
      )
    ).toBe("adolf hitler führerbunker");
  });

  it("THE PERSON'S NAME APPEARS ONCE, whatever the punctuation does", () => {
    /** The invariant behind both: a query may not spend its budget repeating its own subject. */
    for (const beat of [
      "In April, Adolf Hitler spoke to the crowd.",
      "In March, Adolf Hitler toured the Gigafactory.",
      "Deep in 1945, Adolf Hitler remained in Berlin.",
    ]) {
      const q = subjectFor(beat, "Adolf Hitler");
      expect([...q.matchAll(/hitler/g)].length, `"${beat}" -> "${q}"`).toBe(1);
    }
  });

  it("and it is the raw token that is tested, because stripping punctuation is what hid this", () => {
    expect(SRC).toContain("const prevRaw = tokens[i - 1] ?? \"\";");
    expect(SRC).toContain("const runBrokenByPunctuation =");
  });
});

/* ═══════════ §2 — RONDE 248's rule is intact ═══════════ */

describe("§2 — a run still joins where nothing separates the words", () => {
  it("LOS ANGELES IS STILL ONE PLACE — render 584's sentence, unchanged", () => {
    expect(
      subjectFor("Inside a Los Angeles conference room, Kris Jenner opened the meeting.", "Kris Jenner")
    ).toBe("kris jenner los angeles");
  });

  it("but two places with a comma between them are two places", () => {
    expect(
      subjectFor("He travelled from Munich, Berlin and Vienna in one week.", "Adolf Hitler")
    ).toBe("adolf hitler munich");
  });

  it("and a full stop breaks a run as surely as a comma", () => {
    expect(subjectFor("In Berlin, Reichstag guards raised the alarm.", "Adolf Hitler")).toBe(
      "adolf hitler berlin"
    );
  });
});

/* ═══════════ §3 — the openers ═══════════ */

describe("§3 — an adverb in position 0 is not the subject", () => {
  /** The measurement itself, as an invariant: no opener may beat the subject beside it. */
  const OPENERS = [
    "Deep", "Far", "High", "Low", "Here", "Long", "Alone", "Together", "Everywhere", "Nowhere",
    "Somewhere", "Slowly", "Quickly", "Quietly", "Barely", "Within", "Behind", "Along", "Amid",
    "Despite", "Without", "Around", "Deeper", "Further", "Elsewhere", "Nevertheless", "Thus",
  ];

  it("ALL TWENTY-SEVEN MEASURED OPENERS NOW YIELD THE REACTOR, NOT THEMSELVES", () => {
    const leaks: string[] = [];
    for (const w of OPENERS) {
      const q = subjectFor(
        `${w} inside Reactor Four, Anatoly Dyatlov ordered the test to continue.`,
        "Anatoly Dyatlov"
      );
      if (!q.includes("reactor")) leaks.push(`${w} -> ${q}`);
    }
    expect(leaks, "openers that still beat the subject").toEqual([]);
  });

  it("the one render 597 would have hit: Deep inside Reactor Four", () => {
    expect(
      subjectFor(
        "April 26th, 1986. Deep inside Reactor Four, Anatoly Dyatlov ordered the test to continue.",
        "Anatoly Dyatlov"
      )
    ).toBe("anatoly dyatlov reactor");
  });

  it("A REAL NAME IN POSITION 0 IS UNTOUCHED — RONDE 71's own measured sentence", () => {
    /** If this ever answers "april", the list has swallowed names along with the adverbs. */
    expect(
      subjectFor("Berlin was under constant bombardment in the last week of April 1945.", "Adolf Hitler")
    ).toBe("adolf hitler berlin");
  });
});

/* ═══════════ §4 — demoted, not deleted ═══════════ */

describe("§4 — nothing was removed from the vocabulary", () => {
  it("an opener is still reachable when the beat offers nothing else", () => {
    /** Excluded from the proper tier, it still goes to the common tier. */
    expect(subjectFor("Deep was the silence that followed.", "Adolf Hitler")).toContain("deep");
  });

  it("and RONDE 613's month rule still holds on the same beats", () => {
    expect(subjectFor("April arrived.", "Adolf Hitler")).toBe("adolf hitler april");
    expect(subjectFor("in april hitler returned to berlin", "Adolf Hitler")).toBe(
      "adolf hitler april"
    );
  });
});

/* ═══════════ §5 — THE KNOWN COST, STATED RATHER THAN HIDDEN ═══════════ */

describe("§5 — what this change costs", () => {
  it("a sentence OPENING with a name that begins with an opener loses that first word", () => {
    /**
     * Written down because it is a real loss, not an oversight: "High Command" opening a sentence
     * keeps only "command". Pinned so the size of the cost stays visible if the list grows.
     */
    expect(subjectFor("High Command ordered the retreat from the eastern front.", "Adolf Hitler")).toBe(
      "adolf hitler command"
    );
  });

  it("BUT THE FORM NARRATION ACTUALLY USES IS UNHARMED — 'the High Command'", () => {
    expect(
      subjectFor("The High Command ordered the retreat from the eastern front.", "Adolf Hitler")
    ).toBe("adolf hitler high command");
  });
});

/* ═══════════ §6 — the additions are the measured ones ═══════════ */

describe("§6 — the list says where its words came from", () => {
  it("each group of additions is attributed to the measurement", () => {
    expect(SRC).toContain("// RONDE 614, measured: place and manner adverbs.");
    expect(SRC).toContain("// RONDE 614, measured: prepositions the list had skipped.");
    expect(SRC).toContain("// RONDE 614, measured: discourse connectives.");
  });

  it("and no subject is named in the rule, so it holds on any topic", () => {
    const at = SRC.indexOf("const SENTENCE_OPENER_WORDS = new Set([");
    const body = SRC.slice(at, SRC.indexOf("]);", at)).toLowerCase();
    for (const word of ["hitler", "berlin", "reactor", "tesla", "armstrong"]) {
      expect(body, `${word} was added to a general word list`).not.toContain(word);
    }
  });
});
