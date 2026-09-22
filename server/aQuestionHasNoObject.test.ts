/**
 * A QUESTION HAS NO OBJECT — RONDE 626.
 *
 * ── What render 599 asked every provider for ────────────────────────────────────────────────
 *
 *     [VisualIntent]     s1b1 subject=he issue event=he issue action=orders
 *     [MismatchResearch] s1b1 correctedQuery="Heinrich Himmler Führerbunker he issue"
 *                             results=2 eligible=0 adopted=0
 *
 * The beat is "Yet, in his darkest hour, what orders did he issue?" — a rhetorical question.
 * `extractEventPhraseForQuery`'s second rule takes the run of lower-case words after the beat's
 * verb as that verb's direct object, which is true of a declarative sentence and false of an
 * interrogative one: a question moves the auxiliary and the subject into the object's position.
 * So `\borders\b\s+(…)` returned "did he issue", the last two words of that were kept, and
 * "he issue" became the beat's event, its subject, and part of the query sent to every provider.
 *
 * ── Why this was not visible as a retrieval failure ─────────────────────────────────────────
 *
 * Nothing downstream misbehaved. The two YouTube clips that came back were judged and refused —
 * a young soldier wearing an Iron Cross, and a map of the 1st Belorussian Front — and the
 * refusals were correct, because neither depicts anything the narration is about. The gates were
 * working on candidates that were fetched for a phrase the beat never meant. The beat took a
 * placeholder, and the log recorded a quality problem where there was a grammar problem.
 *
 * ── What did NOT change ─────────────────────────────────────────────────────────────────────
 *
 * No threshold, no gate and no ranking. Rule 1 (the named event) and rule 3 (the bare cue) are
 * untouched, and a beat whose object phrase is genuinely two content words still yields it —
 * §2 is the test that says so on the codebase's own worked example.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { extractEventPhraseForQuery } from "./mediaResearchEngine";

const SRC = readFileSync(join(__dirname, "mediaResearchEngine.ts"), "utf8");

/* ═══════════ §1 — render 599's own beat ═══════════ */

describe("§1 — the beat that sent 'he issue' to nine providers", () => {
  const BEAT = "Yet, in his darkest hour, what orders did he issue?";

  it("NO LONGER YIELDS 'he issue'", () => {
    expect(extractEventPhraseForQuery(BEAT, "orders")).not.toBe("he issue");
  });

  it("and yields no event phrase at all, which is the truth about this beat", () => {
    /**
     * The sentence names no event. Falling through to rule 3, which finds nothing in
     * EVENT_CUE_RE either, is the honest answer — and it lets `subject` fall to the beat's
     * proven person instead of to a fragment.
     */
    expect(extractEventPhraseForQuery(BEAT, "orders")).toBe("");
  });

  it("a pronoun never survives into a phrase, whichever question form asks it", () => {
    for (const [text, verb] of [
      ["What orders did he issue?", "orders"],
      ["Which plans had they drawn up?", "plans"],
      ["What decision was she about to take?", "decision"],
      ["What terms would we accept?", "terms"],
    ] as const) {
      const phrase = extractEventPhraseForQuery(text, verb);
      expect(phrase.split(/\s+/).filter(Boolean), `${text} -> "${phrase}"`).not.toContain("he");
      expect(phrase, `${text} -> "${phrase}"`).not.toMatch(
        /\b(?:did|had|was|would|he|she|they|we)\b/
      );
    }
  });
});

/* ═══════════ §2 — THE LINE: a real object phrase is untouched ═══════════ */

describe("§2 — declarative beats keep the phrase they always produced", () => {
  it("THE CODEBASE'S OWN WORKED EXAMPLE STILL WORKS", () => {
    /** RONDE 78 wrote this example into the function's doc comment as what rule 2 is for. */
    expect(
      extractEventPhraseForQuery("dictated his final political testament in the bunker", "dictated")
    ).toBe("political testament");
  });

  it("possessives are stepped over, not stopped on — that is why the line above passes", () => {
    for (const w of ["his", "her", "its", "their"]) {
      expect(SRC.slice(SRC.indexOf("const EVENT_PHRASE_STOP"), SRC.indexOf("const EVENT_PHRASE_SKIP")))
        .not.toContain(`"${w}"`);
    }
  });

  it("rule 1 is untouched — a named event still outranks everything", () => {
    expect(
      extractEventPhraseForQuery("The Brandenburg Gate stood in ruins after the Battle of Berlin.", "")
    ).toBe("Battle of Berlin");
  });

  it("rule 3 is untouched — the bare cue is still the last resort", () => {
    expect(extractEventPhraseForQuery("Hitler died in the bunker.", "")).toBe("died");
  });
});

/* ═══════════ §3 — the guard is wired in, not merely declared ═══════════ */

describe("§3 — the stop list is actually consulted", () => {
  it("THE BREAK IS IN THE LOOP", () => {
    /**
     * Written after RONDE 624, where a test passed with its own fix reverted. A predicate that
     * nothing reads proves nothing, so this asserts the call site and not only the set.
     */
    expect(SRC).toContain("if (EVENT_PHRASE_STOP.has(lower)) break;");
  });

  it("and it breaks rather than skipping — skipping is what produced 'he issue'", () => {
    /**
     * `skip` would have walked past "did" and "he" and kept "issue" alongside whatever followed.
     * The distinction is the whole fix, so it is asserted rather than left to the reader.
     */
    const at = SRC.indexOf("if (EVENT_PHRASE_STOP.has(lower)) break;");
    expect(at).toBeGreaterThan(-1);
    expect(SRC.slice(at, at + 60)).not.toContain("continue");
  });
});
