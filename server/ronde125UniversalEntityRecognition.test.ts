/**
 * RONDE 125 — the word boundary that hid every non-ASCII name.
 *
 * RONDE 123 made the character CLASS Unicode-aware, and that worked for "Hermann Göring" — but
 * only because "Hermann" starts with an ASCII H. Measured against the real extractor afterwards:
 *
 *     "Charles de Gaulle"        →  []
 *     "Vincent van Gogh …"       →  ["Starry Night", "Gogh"]      ← a painting, and half a name
 *     "Jean-Luc Godard …"        →  []
 *     "Łukasz Fabiański …"       →  []
 *     "İsmet İnönü …"            →  []
 *     "Иосиф Сталин …"           →  []
 *
 * Two causes, both measured rather than guessed:
 *
 *  1. `\b`. JavaScript's word boundary is defined on ASCII word characters and the `u` flag does
 *     not change it, so a name STARTING with a non-ASCII letter is invisible however good the
 *     character class behind it is:
 *
 *         /\bŁ/.test(" Łukasz")  →  false
 *         /\bG/.test(" Göring")  →  true
 *
 *  2. Name particles. A run of capitalised tokens breaks at "de" and "van", leaving two
 *     single-token halves that both fall below the two-token minimum — which is why
 *     "Charles de Gaulle" produced nothing at all.
 */
import { describe, expect, it } from "vitest";

import {
  NAME_PARTICLES,
  isNameShapedToken as extractionTokenShape,
  isNameParticle,
  nameRunRegex,
  singleNameTokenRegex,
  stripToNameSafeText,
} from "./personNameChars";
import { checkPersonName, isNameParticleToken, isNameShapedToken } from "./searchQueryContract";
import { extractPersonNamesFromText } from "./videoPipeline";

/* ═══════════ 1. the production case that started all of this ═══════════ */

describe("RONDE 125 — the exact production text", () => {
  const TITLE_CASE = "The Influential Choice Hermann Göring Made To Join Hitler";

  it("no fabricated person survives it", () => {
    const names = extractPersonNamesFromText(TITLE_CASE);
    expect(names).not.toContain("Influential");
    expect(names).not.toContain("Choice");
    expect(names).not.toContain("Hermann");
    expect(names).not.toContain("Influential Choice Hermann");
    expect(names).not.toContain("Join Hitler");
  });

  it("and the sentence form yields the person the film is about", () => {
    expect(extractPersonNamesFromText("The real reason Hermann Göring joined Hitler")).toContain(
      "Hermann Göring"
    );
    expect(
      extractPersonNamesFromText("In 1922 Hermann Göring met Adolf Hitler at a rally in Munich.")
    ).toEqual(expect.arrayContaining(["Hermann Göring", "Adolf Hitler"]));
  });

  it("Göring is never mangled to G ring", () => {
    // The ASCII strip that used to run in front of the pattern.
    expect("Göring".replace(/[^\w\s:'-]/g, " ")).toBe("G ring");
    expect(stripToNameSafeText("Göring, 1935.")).toBe("Göring 1935");
  });
});

/* ═══════════ 2. the boundary ═══════════ */

describe("RONDE 125 — a name may start with any letter, in any alphabet", () => {
  it("THE ROOT CAUSE: \\b is ASCII-only even with the u flag", () => {
    expect(/\bG/u.test(" Göring")).toBe(true);
    expect(/\bŁ/u.test(" Łukasz")).toBe(false);
    // ...which is why the old pattern found nothing here.
    const asciiBoundary = /\b(\p{Lu}[\p{Ll}\p{M}]+(?:\s+\p{Lu}[\p{Ll}\p{M}]+)+)\b/gu;
    expect("Łukasz Fabiański saved".match(asciiBoundary)).toBeNull();
    expect("Иосиф Сталин in 1943".match(asciiBoundary)).toBeNull();
  });

  it("the lookaround boundary finds them", () => {
    expect("Łukasz Fabiański saved".match(nameRunRegex(1))).toEqual(["Łukasz Fabiański"]);
    expect("İsmet İnönü succeeded".match(nameRunRegex(1))).toEqual(["İsmet İnönü"]);
    expect("Иосиф Сталин in 1943".match(nameRunRegex(1))).toEqual(["Иосиф Сталин"]);
  });

  it("and the real extractor returns them", () => {
    expect(extractPersonNamesFromText("Łukasz Fabiański saved the penalty")).toContain(
      "Łukasz Fabiański"
    );
    expect(extractPersonNamesFromText("İsmet İnönü succeeded Atatürk")).toContain("İsmet İnönü");
    expect(
      extractPersonNamesFromText("Иосиф Сталин met Winston Churchill in 1943")
    ).toEqual(expect.arrayContaining(["Иосиф Сталин", "Winston Churchill"]));
  });

  it("single-token matching reads non-ASCII initials too", () => {
    expect("Łukasz spoke.".match(singleNameTokenRegex(3))).toContain("Łukasz");
  });
});

/* ═══════════ 3. particles ═══════════ */

describe("RONDE 125 — the lower-case words inside a surname", () => {
  it("REGRESSION: a run no longer breaks at de / van / bin", () => {
    for (const [text, want] of [
      ["The famous French president Charles de Gaulle", "Charles de Gaulle"],
      ["Vincent van Gogh painted Starry Night", "Vincent van Gogh"],
      ["Ludwig van Beethoven wrote the Ninth", "Ludwig van Beethoven"],
      ["Marco van Basten scored the winner", "Marco van Basten"],
      ["Mohammed bin Salman visited Riyadh", "Mohammed bin Salman"],
    ] as const) {
      expect(text.match(nameRunRegex(1)), text).toEqual(expect.arrayContaining([want]));
    }
  });

  it("the extractor returns the whole name, not the surname alone", () => {
    expect(extractPersonNamesFromText("The famous French president Charles de Gaulle")).toContain(
      "Charles de Gaulle"
    );
    expect(extractPersonNamesFromText("Vincent van Gogh painted Starry Night")).toContain(
      "Vincent van Gogh"
    );
    expect(extractPersonNamesFromText("Ludwig van Beethoven wrote the Ninth")).toContain(
      "Ludwig van Beethoven"
    );
    expect(extractPersonNamesFromText("Marco van Basten scored the winner")).toContain(
      "Marco van Basten"
    );
  });

  it("a hyphen-bound particle is part of the name", () => {
    expect(extractPersonNamesFromText("Abdel Fattah el-Sisi spoke in Cairo")).toContain(
      "Abdel Fattah el-Sisi"
    );
  });

  it("CRITICAL: a particle is never a name on its own", () => {
    /**
     * The whole risk of admitting lower-case words is that one of them becomes a name. A particle
     * is accepted only BETWEEN two of the name's own words — first or last, the old refusals
     * apply unchanged.
     */
    for (const p of NAME_PARTICLES) {
      expect(isNameParticle(p)).toBe(true);
      expect(isNameShapedToken(p)).toBe(false);
      expect(checkPersonName(`${p} Gaulle`, `${p} Gaulle spoke`, "", {}).ok).toBe(false);
      expect(checkPersonName(`Charles ${p}`, `Charles ${p} spoke`, "", {}).ok).toBe(false);
    }
  });

  it("the particle list is closed — not 'any lower-case word'", () => {
    expect(isNameParticleToken("de")).toBe(true);
    expect(isNameParticleToken("van")).toBe(true);
    // Ordinary words stay ordinary, so "Hermann of the Reich" cannot become a name.
    for (const w of ["of", "the", "and", "with", "for", "influential", "choice"]) {
      expect(isNameParticleToken(w), w).toBe(false);
    }
  });
});

/* ═══════════ 4. hyphens and apostrophes ═══════════ */

describe("RONDE 125 — hyphenated and apostrophed names", () => {
  it("a capital after a hyphen or apostrophe is name-shaped", () => {
    for (const t of ["Jean-Luc", "Mary-Kate", "O'Neill", "D'Angelo", "Ben-Gurion", "el-Sisi"]) {
      expect(isNameShapedToken(t), t).toBe(true);
    }
  });

  it("...but a capital MID-word is still refused", () => {
    // The rule widened for hyphens and apostrophes only. These were refused before and still are.
    for (const t of ["McDonald", "BRAUN", "G", "of"]) {
      expect(isNameShapedToken(t), t).toBe(false);
    }
  });

  it("the extractor returns them", () => {
    expect(extractPersonNamesFromText("Jean-Luc Godard directed Breathless")).toContain(
      "Jean-Luc Godard"
    );
    expect(extractPersonNamesFromText("Mary-Kate Olsen arrived in Los Angeles")).toContain(
      "Mary-Kate Olsen"
    );
  });
});

/* ═══════════ 5. accents, and the refusals that must survive ═══════════ */

describe("RONDE 125 — accents work, and nothing new gets through", () => {
  it("accented Latin names", () => {
    expect(extractPersonNamesFromText("José Mourinho arrived in London")).toContain("José Mourinho");
    expect(extractPersonNamesFromText("François Mitterrand spoke in Paris")).toContain(
      "François Mitterrand"
    );
    expect(extractPersonNamesFromText("Saoirse Ronan starred in Brooklyn")).toContain(
      "Saoirse Ronan"
    );
  });

  it("CRITICAL: every existing refusal still refuses", () => {
    /**
     * This round widens which CHARACTERS and which PARTICLES count. It does not touch the rules,
     * and these are the cases earlier rounds put in place to prove it.
     */
    expect(extractPersonNamesFromText("Why Hitler Killed Himself")).not.toContain("Why Hitler");
    expect(extractPersonNamesFromText("The Eiffel Tower opened in 1889.")).not.toContain(
      "Eiffel Tower"
    );
    expect(extractPersonNamesFromText("He flew over New York in 1930.")).not.toContain("New York");
    /**
     * A possessive is not part of a name — RONDE 123's own regression, and it is the EXTRACTION
     * token that has to refuse it. searchQueryContract's validator has always accepted an
     * apostrophe inside a token (that is what lets "O'Neill" through it), so the refusal lives in
     * personNameChars, which is where extractPersonSurnameAnchor reads it.
     */
    expect(extractionTokenShape("Hitler's")).toBe(false);
    expect(extractionTokenShape("O'Neill")).toBe(true);
  });

  it("a lone capital and an all-caps word are still not names", () => {
    expect(checkPersonName("G Braun", "G Braun spoke", "", {}).ok).toBe(false);
    expect(checkPersonName("BRAUN HITLER", "BRAUN HITLER spoke", "", {}).ok).toBe(false);
  });
});
