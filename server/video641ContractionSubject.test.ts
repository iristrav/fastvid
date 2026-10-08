import { describe, expect, it } from "vitest";

import { intentFrom, type ProductionBeat } from "./cinematicPipelineInputs";
import { chapterCardFallbackFor } from "./cinematicEditingEngine/motionGraphicsPlanner";
import { fallbackVisualIntent } from "./scriptVisualKeywords";
import { inferLiteralViewerVisual } from "./viewerVisualPlan";
import { extractPrimaryVisualAnchor, extractSalientBeatTokens } from "./visualBeatTags";
import { beatNamedEntitiesByKind, extractActionCue, extractPersonNamesFromText, extractVisualPlacePhrase } from "./videoPipeline";

/**
 * VIDEO 641 (W2) — A CONTRACTION IS GRAMMAR, NOT A SUBJECT.
 *
 * s1b1 "So, what's holding back their fortune …? Let's delve deeper …" became, in production:
 *
 *     [VisualIntent] s1b1 subject=let lets
 *     query="Let lets"   (YouTube pool, Internet Archive, Wikimedia, SerpAPI)
 *     [CHAPTER_CARD_FALLBACK] s1b1 8.60s … title="Let"
 *
 * `extractSalientBeatTokens` read the capital of "Let's" as a name and kept "let's" as a word.
 * A contraction is now dropped; a possessive keeps its name ("Kim's" → "kim").
 */

const LET = "Let's delve deeper to understand the real financial dynamics.";
const S1B1 = "So, what's holding back their fortune from being more tangible? " + LET;

/** The keyword chain the VisualDirector's fallback and the literal viewer plan both use. */
const chain = (t: string) => ({
  anchor: extractPrimaryVisualAnchor(t),
  primary: fallbackVisualIntent(t).primary_keyword,
  subject: fallbackVisualIntent(t).priority_subject,
  query: inferLiteralViewerVisual(t).searchQuery,
});
const words = (s: string | null | undefined) => (s ?? "").toLowerCase().split(/\s+/).filter(Boolean);

describe("W2 — a contraction at the start of a sentence is never the visual subject", () => {
  it("1. Let's delve deeper → no let, no 'let lets' (straight and typographic apostrophe)", () => {
    for (const t of [LET, LET.replace("'", "’"), S1B1]) {
      const c = chain(t);
      for (const v of [c.anchor, c.primary, c.subject, c.query]) {
        expect(words(v), `${t} → ${v}`).not.toContain("let");
        expect(words(v), `${t} → ${v}`).not.toContain("lets");
        expect(words(v), `${t} → ${v}`).not.toContain("let's");
      }
    }
    expect(chain(LET).primary).toBe("delve deeper");
    expect(chain(S1B1).query).not.toMatch(/let/i);
  });

  it("2. Don't forget → no don, no don't", () => {
    const c = chain("Don't forget the money.");
    expect(c.anchor).toBe("forget money");
    for (const v of [c.anchor, c.primary, c.subject]) expect(words(v)).not.toContain("don");
  });

  it("3. It's the empire → empire stays, it's does not lead", () => {
    const c = chain("It's the empire they built.");
    expect(c.anchor).toBe("empire built");
    expect(c.subject).toBe("empire");
  });

  it("4. They're still rich → not 'they're still'; rich stays", () => {
    const c = chain("They're still rich.");
    expect(c.anchor).toBe("still rich");
    expect(words(c.primary)).not.toContain("theyre");
  });

  it("5. We've built an empire → no we've", () => {
    expect(chain("We've built an empire.").anchor).toBe("built empire");
    expect(extractSalientBeatTokens("We've built an empire.")).not.toContain("we've");
  });

  it("6. I'll explain → no i'll", () => {
    expect(extractSalientBeatTokens("I'll explain.")).toEqual(["explain"]);
    expect(words(chain("I'll explain.").primary)).not.toContain("ill");
  });

  it("7. I'm talking about Kim → Kim stays, no i'm", () => {
    const c = chain("I'm talking about Kim.");
    expect(c.anchor).toBe("kim talking");
    expect(c.subject).toBe("kim");
  });

  it("8. Kim's empire → Kim stays as the name, the possessive does not break it", () => {
    for (const t of ["Kim's empire keeps growing.", "Kim’s empire keeps growing."]) {
      expect(chain(t).anchor, t).toBe("kim empire");
      expect(chain(t).subject, t).toBe("kim");
      expect(extractSalientBeatTokens(t), t).not.toContain("kim's");
    }
  });

  it("9. a name without an apostrophe is unchanged", () => {
    expect(chain("Kris Jenner controls the family business.").anchor).toBe("kris jenner");
    expect(extractSalientBeatTokens("Kris Jenner controls the family business.").slice(0, 2)).toEqual(["kris", "jenner"]);
  });

  it("10. a sentence without a contraction is unchanged", () => {
    expect(chain("Despite their billion-dollar empire, the Kardashians may not be as cash-flush as you think.").anchor).toBe(
      "despite kardashians"
    );
    expect(chain("In the Calabasas corporate office, accountants lay out the stark reality.").anchor).toBe("calabasas corporate");
    expect(chain("The tanks rolled into Berlin in 1945.").anchor).toBe("soldiers");
  });

  it("an apostrophe that is no contraction stays as it was", () => {
    expect(extractSalientBeatTokens("Conan O'Brien laughed.")).toContain("o'brien");
  });
});

describe("W2 — the 641 chapter card no longer reads \"Let\"", () => {
  const EXTRACTORS = {
    people: (t: string) => extractPersonNamesFromText(t),
    place: (t: string) => extractVisualPlacePhrase(t),
    action: (t: string) => extractActionCue(t),
    namedEntities: (t: string) => beatNamedEntitiesByKind(t),
  };
  const beat = (text: string): ProductionBeat => ({
    index: 1, text, searchQuery: "", powerWord: "", keywords: [], holdSec: 8.6,
    visualDescription: "", voiceStartSec: 0, voiceEndSec: 8.6,
  });
  /** In production the card's subject is the plan's search_query — the literal viewer plan's query. */
  const card = (text: string, visualSubject: string) =>
    chapterCardFallbackFor({ ...intentFrom(beat(text), 1, 1, null, EXTRACTORS), visualSubject }, 0, 8.6);

  it("the old subject made a card titled \"Let …\" — the mechanism (production printed title=\"Let\")", () => {
    expect(card(S1B1, "let lets")?.data.title).toMatch(/^Let\b/);
    expect(card(S1B1, "let")?.data.title).toBe("Let");
  });

  it("with the repaired subject the card is not titled \"Let\"", () => {
    const subject = inferLiteralViewerVisual(S1B1).searchQuery;
    expect(subject).not.toMatch(/\blets?\b/i);
    expect(card(S1B1, subject)?.data.title ?? "").not.toMatch(/^Let\b/);
  });
});
