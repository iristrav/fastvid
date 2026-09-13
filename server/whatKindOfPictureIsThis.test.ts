import { describe, it, expect } from "vitest";
import {
  mediaFormsForIntent,
  formatMediaFormNeed,
  type MediaForm,
} from "./beatVisualIntent";

/**
 * THE BEAT SAYS WHAT KIND OF PICTURE IT NEEDS.
 *
 * The audit's finding in one sentence: FastVid has a good need-taxonomy (`BeatVisualIntent`), a
 * good ranking engine and a good evidence chain, and NO statement anywhere of what kind of picture
 * a beat requires. `mediaType` is video-or-still — a fact about encoding. It cannot separate an
 * archive reel from a portrait from a map, so retrieval asked the same fourteen providers in
 * source-code order for every beat of every topic.
 *
 * This is the missing statement, derived from fields the intent already holds. These tests pin the
 * two properties that make it safe: it is DETERMINISTIC, and it stays SILENT when the beat proved
 * nothing rather than inventing a form.
 */

const need = (i: Parameters<typeof mediaFormsForIntent>[0]) => mediaFormsForIntent(i);

describe("a dated beat wants material from that date", () => {
  it("PERIOD MAKES IT ARCHIVAL — the sharpest routing signal there is", () => {
    expect(need({ period: ["1945"] }).preferred).toContain("ARCHIVAL_FOOTAGE");
  });

  it("and archival comes first, ahead of the other forms the beat also names", () => {
    /**
     * Order is the routing's input, so it is asserted rather than left to chance: a beat about a
     * person in 1945 should be asked of an archive before a portrait library.
     */
    expect(need({ period: ["1945"], people: ["Hitler"] }).preferred[0]).toBe("ARCHIVAL_FOOTAGE");
  });

  it("THE SAME EVENT WORD MEANS NEWS WHEN THE BEAT IS NOT DATED", () => {
    /**
     * "the vote", "the launch" — a news clip this year, an archive reel in 1945. Only the period
     * field can tell them apart, and this is the rule that uses it.
     */
    expect(need({ event: ["the vote"] }).preferred).toContain("NEWS");
    expect(need({ event: ["the vote"] }).preferred).not.toContain("ARCHIVAL_FOOTAGE");
    expect(need({ event: ["the vote"], period: ["1945"] }).preferred).toContain("ARCHIVAL_FOOTAGE");
    expect(need({ event: ["the vote"], period: ["1945"] }).preferred).not.toContain("NEWS");
  });
});

describe("the other fields each name their own kind of picture", () => {
  it("people → PERSON", () => {
    expect(need({ people: ["Marie Curie"] }).preferred).toEqual(["PERSON"]);
  });

  it("location → LOCATION", () => {
    expect(need({ location: ["Tokyo"] }).preferred).toEqual(["LOCATION"]);
  });

  it("objects → OBJECT", () => {
    expect(need({ objects: ["a printing press"] }).preferred).toEqual(["OBJECT"]);
  });

  it("a verb and no noun → PROCESS", () => {
    expect(need({ action: ["smelting"] }).preferred).toEqual(["PROCESS"]);
  });

  it("but a verb NEXT TO a noun does not — the noun is the picture", () => {
    /**
     * The same asymmetry the term source applies: "shaped" is how the sentence moves, "bunker" is
     * what a viewer can be shown.
     */
    expect(need({ action: ["shaped"], objects: ["bunker"] }).preferred).toEqual(["OBJECT"]);
  });

  it("a beat naming several things keeps all of them, in a fixed order", () => {
    expect(
      need({ period: ["1945"], people: ["Hitler"], location: ["Berlin"], objects: ["bunker"] })
        .preferred
    ).toEqual(["ARCHIVAL_FOOTAGE", "PERSON", "LOCATION", "OBJECT"]);
  });

  it("and never lists a form twice", () => {
    const p = need({ period: ["1945"], event: ["the surrender"] }).preferred;
    expect(p).toEqual([...new Set(p)]);
  });
});

describe("A BEAT THAT PROVED NOTHING GETS NO OPINION", () => {
  /**
   * The property the round was explicitly told to protect: do not force one hard form on a beat
   * whose intent cannot prove it. An empty `preferred` is the router's signal to keep its default
   * order — silence, not a guess.
   */
  it("an empty intent produces no preference at all", () => {
    expect(need({}).preferred).toEqual([]);
    expect(need(null).preferred).toEqual([]);
    expect(need(undefined).preferred).toEqual([]);
  });

  it("and still declares b-roll acceptable, so nothing is left with no answer", () => {
    expect(need({}).acceptable).toEqual(["B_ROLL"]);
    expect(need(null).acceptable).toEqual(["B_ROLL"]);
  });

  it("empty lists count as nothing typed, not as a typed emptiness", () => {
    expect(need({ people: [], location: [], period: [] }).preferred).toEqual([]);
  });
});

describe("acceptable is always a superset of preferred", () => {
  const cases: Array<Parameters<typeof mediaFormsForIntent>[0]> = [
    { period: ["1945"] },
    { people: ["Curie"] },
    { location: ["Tokyo"] },
    { objects: ["press"] },
    { event: ["the launch"] },
    { action: ["smelting"] },
    { period: ["1912"], people: ["Curie"], location: ["Paris"], objects: ["radium"] },
    {},
  ];

  it("every preferred form is also acceptable — a want is never refused by its own need", () => {
    for (const c of cases) {
      const n = need(c);
      for (const form of n.preferred) {
        expect(n.acceptable, `${form} preferred but not acceptable`).toContain(form);
      }
    }
  });

  it("and b-roll closes every list, so no beat is left unroutable", () => {
    for (const c of cases) {
      expect(need(c).acceptable.at(-1)).toBe("B_ROLL");
    }
  });

  it("a still and real footage are acceptable wherever the beat has an opinion", () => {
    const n = need({ people: ["Curie"] });
    expect(n.acceptable).toContain("PHOTO");
    expect(n.acceptable).toContain("REAL_FOOTAGE");
  });
});

describe("the forms this model does NOT claim to infer", () => {
  /**
   * MAP, DOCUMENT, GRAPHIC, DATA_VISUALIZATION and INTERVIEW are in the type and are never
   * returned. Nothing in the intent can prove a beat needs a chart — the extractors do not type
   * quantities — and inferring one from a word like "percent" is the guess this codebase keeps
   * removing. Asserted so that a later round which CAN prove them has to do so deliberately.
   */
  const never: MediaForm[] = ["MAP", "DOCUMENT", "GRAPHIC", "DATA_VISUALIZATION", "INTERVIEW"];

  it("are never inferred from any combination of typed fields", () => {
    const cases: Array<Parameters<typeof mediaFormsForIntent>[0]> = [
      { objects: ["a map of Europe"] },
      { objects: ["the treaty document"] },
      { event: ["the interview"] },
      { action: ["rose by 40 percent"] },
      { period: ["1945"], objects: ["chart"], location: ["Europe"] },
    ];
    for (const c of cases) {
      const n = need(c);
      for (const form of never) {
        expect([...n.preferred, ...n.acceptable], `${form} was inferred`).not.toContain(form);
      }
    }
  });
});

describe("the need is deterministic and readable", () => {
  it("the same intent always produces the same need", () => {
    const intent = { period: ["1945"], people: ["Hitler"], location: ["Berlin"] };
    const a = need(intent);
    const b = need(intent);
    expect(a).toEqual(b);
    expect(a.preferred).toEqual(b.preferred);
  });

  it("and it prints on one line", () => {
    expect(formatMediaFormNeed(need({ period: ["1945"], people: ["Hitler"] }))).toBe(
      "want=ARCHIVAL_FOOTAGE|PERSON ok=ARCHIVAL_FOOTAGE|PERSON|REAL_FOOTAGE|PHOTO|B_ROLL"
    );
  });

  it("a beat with no opinion says so rather than printing an empty field", () => {
    expect(formatMediaFormNeed(need({}))).toBe("want=NONE ok=B_ROLL");
  });
});
