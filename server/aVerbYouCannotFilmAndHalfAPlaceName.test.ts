/**
 * RONDE 248 — WHAT RENDER 584 ACTUALLY ASKED THE PROVIDERS FOR.
 *
 * Scene 2 downloaded thirty-five candidates and the picture editor rejected 29 of the 32 it was
 * shown across the film. The queries say why. From the render's own provenance line:
 *
 *   [QueryProvenance] s2b0 subject=Kris Jenner place=Los Angeles action=watches
 *
 * The sentence was "Inside a Los Angeles conference room, Kris Jenner watches…", and two separate
 * defects turned that into queries no archive can answer:
 *
 *   1. "watches" became a searchable action. `extractActionCue` draws its verbs from
 *      PERSON_ACTION_VERBS — a list RONDE 72 built to RECOGNISE PEOPLE, where greed is correct —
 *      and reused it to decide what to photograph, where greed is the bug. It carries "believed",
 *      "hoped", "knew", "remained" and "watches". The verb then reached `terms=[…,"watches",…]`
 *      on 496 audit lines, which is the vocabulary candidates are SCORED against.
 *
 *   2. "Los Angeles" was chopped in half. `beatSubjectCandidates` walked token by token, so the
 *      subject extractor built `"Kris Jenner los"` — half a place name is not a place.
 *
 * Both are measured against the real sentence, not against a paraphrase of it.
 */
import { describe, expect, it } from "vitest";
import { extractActionCue, scriptStockSearchQueries } from "./videoPipeline";

/** Render 584, scene 2, beat 0 — the sentence the provenance line was printed for. */
const RENDER_584 = "Inside a Los Angeles conference room, Kris Jenner watches the Beverly Hills deal close in 2022.";

describe("1. a verb only travels when the act has its own picture", () => {
  it("the sentence that produced action=watches now produces no action", () => {
    expect(extractActionCue(RENDER_584), "footage of someone watching is footage of someone").toBe("");
  });

  it("and the verbs with nothing to show are refused as a class", () => {
    for (const [verb, sentence] of [
      ["believed", "Kris Jenner believed the deal would close."],
      ["knew", "Kris Jenner knew the deal would close."],
      ["wanted", "Kris Jenner wanted the deal to close."],
      ["remained", "Kris Jenner remained in the room."],
      ["waited", "Kris Jenner waited for the call."],
      ["watched", "Kris Jenner watched the room."],
      ["said", "Kris Jenner said the deal was done."],
    ] as const) {
      expect(extractActionCue(sentence), verb).toBe("");
    }
  });

  /**
   * THE DIRECTION THAT MUST NOT MOVE. This is a narrowing, and a narrowing that took the filmable
   * verbs with it would be worse than the bug — those are what the historical documentaries this
   * pipeline mostly makes are searched on.
   */
  it("but an act a camera can point at still travels", () => {
    for (const [verb, sentence] of [
      ["married", "In April 1945, Adolf Hitler married Eva Braun in the Berlin bunker."],
      ["surrendered", "The garrison surrendered to Soviet troops."],
      ["signed", "The delegates signed the instrument of surrender."],
      ["fled", "The staff fled the compound before dawn."],
      ["addressed", "Churchill addressed the Commons that evening."],
    ] as const) {
      expect(extractActionCue(sentence), verb).toBe(verb);
    }
  });

  /**
   * The list that caused this is used for something else entirely, and that use is untouched:
   * a name followed by any action verb is still person evidence, "watches" included.
   */
  it("and the person-evidence list it came from is not modified", () => {
    const src = (require("fs") as typeof import("fs")).readFileSync(
      (require("path") as typeof import("path")).join(__dirname, "videoPipeline.ts"),
      "utf8"
    );
    const list = src.slice(src.indexOf("PERSON_ACTION_VERBS = new Set"));
    expect(list.slice(0, list.indexOf("]);")), "person classification must not change").toContain(
      '"watched","watches"'
    );
  });
});

describe("2. a name of two words is one name", () => {
  it("the subject query keeps the place whole instead of taking its first half", () => {
    const [first] = scriptStockSearchQueries(RENDER_584, ["Kris Jenner"], RENDER_584, "Rumors");
    expect(first, 'render 584 built "Kris Jenner los"').toBe("Kris Jenner los angeles");
  });

  /** The bare subject is still offered beside it — it is the query that needs no repair. */
  it("and the person alone is still asked for", () => {
    expect(scriptStockSearchQueries(RENDER_584, ["Kris Jenner"], RENDER_584, "Rumors")).toContain(
      "Kris Jenner"
    );
  });

  /**
   * WHAT KEEPING NAMES WHOLE MUST NOT COST. Three entries used to mean three words; with names
   * kept together it could mean six, and the first run of this change produced
   * "los angeles kris jenner beverly hills" — longer than the bug it replaced and no better.
   */
  it("a query does not grow just because its parts got longer", () => {
    for (const q of scriptStockSearchQueries(RENDER_584, [], RENDER_584, "Rumors")) {
      expect(q.split(/\s+/).length, q).toBeLessThanOrEqual(4);
    }
  });

  /**
   * THE REGRESSION KEEPING NAMES WHOLE CAUSED, CAUGHT BY RONDE 71 AND KEPT HERE.
   *
   * `notPerson` looked the whole candidate up in a set of single words. Correct while "Eva" and
   * "Braun" were two entries; wrong the moment they became one, because "eva braun" is not in
   * {eva, braun}. The extractor then appended the person's own name to itself — "Eva Braun eva
   * braun" — and pushed "bunker", the beat's actual second entity, out of the query.
   */
  it("a person's own name is not appended to itself once it is one entry", () => {
    const qs = scriptStockSearchQueries(
      "Eva Braun came to the bunker against his wishes.", ["Eva Braun"], "", "History"
    );
    expect(qs.join(" | ").toLowerCase(), "the beat's other entity must survive").toContain("bunker");
    for (const q of qs) expect(q.toLowerCase()).not.toBe("eva braun eva braun");
  });

  /** Sharing a word with the person is not being the person. */
  it("a different entity that shares a word keeps its place", () => {
    const [q] = scriptStockSearchQueries(
      "Adolf Hitler reviewed the Hitler Youth on the terrace.", ["Adolf Hitler"], "", "History"
    );
    expect((q ?? "").toLowerCase()).toContain("hitler youth");
  });

  /** A run is adjacency in the sentence, so two names either side of other words stay apart. */
  it("words that were not side by side are not joined into a name", () => {
    const [q] = scriptStockSearchQueries(
      "Berlin fell before Dresden burned.", [], "", "History"
    );
    expect(q ?? "", "Berlin and Dresden are two places, not one").not.toBe("berlin dresden");
  });
});
