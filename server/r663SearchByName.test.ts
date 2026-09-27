/**
 * RONDE 663 — RENDER 607: A BEAT THAT NAMES SOMETHING IS SEARCHED BY NAME.
 *
 *     [AssetTrace] … query="his inner"       → File:London Big Ben Inner Clock Face.jpg
 *     [AssetTrace] … query="suffered"        → File:Dramaten mask 2008a.jpg
 *     [AssetTrace] … query="suicide"         → File:Edouard Manet - Le Suicidé.jpg
 *
 * Of 501 admitted queries in render 607, about 90 named nothing the beat names. Every word stood in
 * the script, so the gate proved them. Check I refuses them when the beat names a subject, reading
 * the subjects from the context — typed tokens, the script's proper nouns, years — never from a list
 * of topics. A beat that names nothing keeps the old rule.
 */
import { describe, expect, it } from "vitest";

import { emptyQueryContext, provenToken, validateSearchQuery } from "./searchQueryContract";

const BEAT =
  "In the Führerbunker beneath Berlin, Adolf Hitler faced the monumental task of escape while " +
  "millions suffered above, his inner circle watching his ideology twisted into ruin across Germany in 1945.";

function beat607() {
  const ctx = emptyQueryContext(BEAT);
  ctx.persons.push(provenToken("Adolf Hitler", "person", "beat_text", BEAT));
  ctx.events.push(provenToken("suicide", "event", "beat_text", BEAT));
  return ctx;
}

const verdict = (q: string, ctx = beat607()) => validateSearchQuery(q, ctx);

describe("RONDE 663 — render 607's queries that named nothing are refused", () => {
  for (const q of ["his inner", "monumental task", "millions suffered above", "ideology twisted escape", "escape"]) {
    it(`"${q}" is refused as SUBJECT_NOT_NAMED`, () => {
      const v = verdict(q);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe("SUBJECT_NOT_NAMED");
    });
  }

  it("an event alone is not a subject — it names what happened, not what is on screen", () => {
    expect(verdict("escape").ok).toBe(false);
    expect(verdict("hitler suicide").ok).toBe(true);
  });
});

describe("RONDE 663 — what the beat names still gets through", () => {
  for (const q of ["Adolf Hitler", "hitler suicide", "germany", "fuhrerbunker", "Führerbunker Berlin", "Berlin ruins", "1945", "Adolf Hitler 1945"]) {
    it(`"${q}" is allowed`, () => {
      expect(verdict(q).ok, JSON.stringify(verdict(q))).toBe(true);
    });
  }

  it("a name that opens a sentence is still a name", () => {
    /** ronde173's beat: skipping the first word refused "Churchill" while "Stalin" counted. */
    const ctx = emptyQueryContext("Churchill and Stalin");
    expect(validateSearchQuery("Churchill", ctx).ok).toBe(true);
    expect(validateSearchQuery("Stalin", ctx).ok).toBe(true);
  });

  it("a function word or pronoun that opens a sentence is never a subject", () => {
    const ctx = emptyQueryContext("His inner circle stayed. The people of Germany waited.");
    expect(validateSearchQuery("germany", ctx).ok).toBe(true);
    expect(validateSearchQuery("inner circle", ctx).reason).toBe("SUBJECT_NOT_NAMED");
  });
});

describe("RONDE 663 — a beat that names nothing keeps the old rule", () => {
  const plain = emptyQueryContext("Cyclists ride along the canal at dawn while the city wakes up slowly.");
  it("common nouns from the script are still enough", () => {
    expect(validateSearchQuery("canal cyclists", plain).ok).toBe(true);
    expect(validateSearchQuery("city dawn", plain).ok).toBe(true);
  });

  it("and every earlier rule still applies before this one", () => {
    expect(validateSearchQuery("aerial footage", plain).reason).toBe("NO_CONTENT_ANCHOR");
    expect(validateSearchQuery("canal tulips", plain).ok).toBe(false);
  });
});
