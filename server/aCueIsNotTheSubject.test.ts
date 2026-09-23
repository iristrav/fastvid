/**
 * A CUE IS NOT THE SUBJECT, AND A MODIFIER IS NOT A VERB — RONDE 634.
 *
 * ── Render 600's remaining weak subjects ────────────────────────────────────────────────────
 *
 *     s1b2  subject=distorted   → query "his distorted"  → a random Openverse photo
 *     s2b1  subject=capture     ┐
 *     s2b2  subject=capture     ├ on beats that also named Adolf Hitler and the Führerbunker
 *     s2b3  subject=capture     ┘
 *
 * Two different defects that produced the same symptom, and each one is contradicted by a doc
 * comment already in the file it lives in.
 *
 * ── "capture" ───────────────────────────────────────────────────────────────────────────────
 *
 * `extractEventPhraseForQuery` answers in three rules: a NAMED event ("Battle of Berlin"), the
 * verb's two-word object ("political testament"), or — when neither matched — `extractEventCue`'s
 * bare vocabulary hit. `captur\w*` is in that vocabulary. And `extractEventCue`'s own comment says
 * what its answer is worth:
 *
 *     "Returns null when the beat doesn't center on a recognizable action — that is the common
 *      case, and callers must treat it as 'no event signal to check', not evidence of anything."
 *
 * `buildBeatVisualIntent` treated it as the strongest evidence in the beat, above a person the
 * beat names and a place it names — while `buildPrioritisedQueries`, downstream, mandates
 * PERSON > PLACE/COUNTRY > EVENT. Two orderings of the same six token types, disagreeing.
 *
 * ── "distorted" ─────────────────────────────────────────────────────────────────────────────
 *
 * `extractActionCue`'s morphological branch takes any lower-case word of five letters or more
 * ending in "ed". Its comment defends that generosity like this:
 *
 *     "An action only ever appears in a query behind an entity that anchors it, so a loose verb
 *      costs a low-ranked query and never the subject of the search."
 *
 * The subject chain ends on `action[0]`, so on a beat with no event, person, place or object the
 * action IS the subject. The generosity was fine; the claim about where it could land was not.
 *
 * ── What is NOT changed ─────────────────────────────────────────────────────────────────────
 *
 * Nothing is dropped from any list, no threshold moves, and no gate is touched. A named event
 * still outranks the person and the place, which is the reasoning the subject chain was built on
 * — "a beat about the Battle of Berlin is about the battle even when it also names Berlin".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { buildBeatVisualIntent } from "./beatVisualIntent";
import { extractActionCue } from "./videoPipeline";
import { extractEventCue, extractEventPhraseForQuery } from "./mediaResearchEngine";
import type { VerifiedQueryContext } from "./searchQueryContract";

const INTENT = readFileSync(join(__dirname, "beatVisualIntent.ts"), "utf8");
const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

const token = (term: string) => ({ term, type: "x", source: "beat_text", verified: true });
const ctxOf = (over: Record<string, string[]>): VerifiedQueryContext =>
  ({
    persons: (over.persons ?? []).map(token),
    places: (over.places ?? []).map(token),
    countries: (over.countries ?? []).map(token),
    events: (over.events ?? []).map(token),
    actions: (over.actions ?? []).map(token),
    objects: (over.objects ?? []).map(token),
    time: [],
    years: [],
  }) as unknown as VerifiedQueryContext;

const subjectOf = (over: Record<string, string[]>) =>
  buildBeatVisualIntent({ sceneIndex: 0, beatIndex: 0, ctx: ctxOf(over) }).subject;

/* ═══════════ §1 — the three-rule shape the word count reads ═══════════ */

describe("§1 — a single-word event is rule 3's bare cue, by construction", () => {
  it("RULE 1 NAMES AN EVENT AND RETURNS MORE THAN ONE WORD", () => {
    const named = extractEventPhraseForQuery(
      "The Brandenburg Gate stood in ruins after the Battle of Berlin.",
      ""
    );
    expect(named).toBe("Battle of Berlin");
    expect(named.split(/\s+/).length).toBeGreaterThan(1);
  });

  it("rule 2 returns the verb's object, and that is two words", () => {
    const phrase = extractEventPhraseForQuery(
      "He dictated his final political testament in the bunker.",
      "dictated"
    );
    expect(phrase).toBe("political testament");
  });

  it("RULE 3 RETURNS ONE WORD, AND IT IS THE CUE ITSELF", () => {
    const beat = "Soviet forces pressed on, and the capture was only days away.";
    const phrase = extractEventPhraseForQuery(beat, "");
    expect(phrase).toBe(extractEventCue(beat));
    expect(phrase.split(/\s+/)).toHaveLength(1);
  });
});

/* ═══════════ §2 — render 600's scene 2 ═══════════ */

describe("§2 — a bare cue no longer outranks what the beat names", () => {
  it("SUBJECT=CAPTURE LOSES TO THE PERSON THE BEAT NAMES", () => {
    expect(
      subjectOf({ events: ["capture"], persons: ["Adolf Hitler"], places: ["Berlin Führerbunker"] })
    ).toBe("Adolf Hitler");
  });

  it("and to the place, when the beat names no person", () => {
    expect(subjectOf({ events: ["capture"], places: ["Berlin Führerbunker"] })).toBe(
      "Berlin Führerbunker"
    );
  });

  it("A NAMED EVENT STILL OUTRANKS BOTH — THAT REASONING IS UNCHANGED", () => {
    expect(
      subjectOf({ events: ["Battle of Berlin"], persons: ["Adolf Hitler"], places: ["Berlin"] })
    ).toBe("Battle of Berlin");
  });

  it("so does the verb's two-word object", () => {
    expect(subjectOf({ events: ["political testament"], persons: ["Adolf Hitler"] })).toBe(
      "political testament"
    );
  });

  it("the planner's hard requirement still outranks everything", () => {
    const intent = buildBeatVisualIntent({
      sceneIndex: 0,
      beatIndex: 0,
      ctx: ctxOf({ events: ["Battle of Berlin"], persons: ["Adolf Hitler"] }),
      contract: { mustContain: ["Reichstag"] } as never,
    });
    expect(intent.subject).toBe("Reichstag");
    expect(intent.evidenceRequirement).toBe("hard");
  });

  it("AND THE CUE IS NOT THROWN AWAY — IT IS STILL THE BEAT'S EVENT", () => {
    const intent = buildBeatVisualIntent({
      sceneIndex: 0,
      beatIndex: 0,
      ctx: ctxOf({ events: ["capture"], persons: ["Adolf Hitler"] }),
    });
    expect(intent.event).toContain("capture");
    expect(intent.foldedTerms.join(" ")).toContain("capture");
  });

  it("a beat with nothing but the cue still takes it, rather than having no subject", () => {
    expect(subjectOf({ events: ["capture"] })).toBe("capture");
  });

  it("and the cue keeps its place above objects and the action", () => {
    expect(subjectOf({ events: ["capture"], objects: ["bunker"], actions: ["ordered"] })).toBe(
      "capture"
    );
  });

  it("an empty context still yields no subject rather than an invented one", () => {
    expect(subjectOf({})).toBe("");
    expect(
      buildBeatVisualIntent({ sceneIndex: 0, beatIndex: 0, ctx: ctxOf({}) }).evidenceRequirement
    ).toBe("none");
  });
});

/* ═══════════ §3 — the participle that was read as a verb ═══════════ */

describe("§3 — a word in the modifier slot describes the noun after it", () => {
  it("HIS DISTORTED VIEW IS NOT AN ACTION", () => {
    expect(extractActionCue("His distorted view of reality was all that remained.")).toBe("");
  });

  it.each([
    ["the shattered remains lay across the square", "the"],
    ["a ruined city beneath a grey sky", "a"],
    ["their abandoned positions along the river", "their"],
    ["this fortified line was all they still held", "this"],
  ])("%s — the word after '%s' modifies, it does not act", (beat) => {
    expect(extractActionCue(beat)).toBe("");
  });

  /**
   * THE MORE INTERESTING HALF: the modifier is stepped OVER, not taken as the end of the search.
   * Both of these were the test's own first draft, and the answers are better than the "" it
   * expected — the participle is refused and the sentence's real verb is found behind it.
   */
  it.each([
    ["His distorted view of reality had hardened by then.", "hardened"],
    ["A ruined city stretched to the horizon.", "stretched"],
  ])("%s — the modifier is skipped and the real verb is found", (beat, expected) => {
    expect(extractActionCue(beat)).toBe(expected);
  });

  it("A REAL VERB IS UNTOUCHED — THE SLOT BEFORE IT IS NEVER A DETERMINER", () => {
    expect(extractActionCue("he dictated his final political testament")).toBe("dictated");
  });

  it.each([
    ["Soviet troops advanced through the outskirts", "advanced"],
    ["the garrison surrendered the following morning", "surrendered"],
    ["Berlin's defenders retreated toward the centre", "retreated"],
  ])("%s still yields '%s'", (beat, expected) => {
    expect(extractActionCue(beat)).toBe(expected);
  });

  it("and a determiner two words back does not disqualify anything", () => {
    /* "the garrison surrendered" — the slot before the verb is the noun, not the determiner. */
    expect(extractActionCue("the garrison surrendered at dawn")).toBe("surrendered");
  });
});

/* ═══════════ §4 — the two orderings now agree ═══════════ */

describe("§4 — one order for the same six token types", () => {
  it("THE SUBJECT CHAIN PUTS PERSON AND PLACE ABOVE A BARE CUE", () => {
    const at = INTENT.indexOf("const subject =");
    expect(at).toBeGreaterThan(-1);
    const chain = INTENT.slice(at, at + 260);
    for (const [before, after] of [
      ["namedEvent", "people[0]"],
      ["people[0]", "location[0]"],
      ["location[0]", "eventCue"],
      ["eventCue", "objects[0]"],
      ["objects[0]", "action[0]"],
    ]) {
      expect(chain.indexOf(before)).toBeLessThan(chain.indexOf(after));
    }
    expect(chain.indexOf("mustContain[0]")).toBeLessThan(chain.indexOf("namedEvent"));
  });

  it("and the word count is what separates a named event from a cue", () => {
    expect(INTENT).toContain("const namedEvent = event.find((e) => words(e) > 1);");
    expect(INTENT).toContain("const eventCue = event.find((e) => words(e) === 1);");
  });

  it("the modifier slot is positional, not another word list to maintain", () => {
    expect(PIPE).toContain("!ACTION_CUE_MODIFIER_SLOT.has(precededBy)");
    const at = PIPE.indexOf("const ACTION_CUE_MODIFIER_SLOT = new Set([");
    const set = PIPE.slice(at, PIPE.indexOf("]);", at));
    /* Determiners and possessives only — no verbs, no topic words, nothing subject-specific. */
    for (const word of ["a", "an", "the", "his", "her", "its", "their"]) {
      expect(set).toContain(`"${word}"`);
    }
    expect(set).not.toMatch(/hitler|berlin|war/i);
  });

  it("the previous token is tracked over every token, not only the accepted ones", () => {
    expect(PIPE).toContain("const precededBy = previous;");
    expect(PIPE).toContain("previous = word.toLowerCase();");
    const at = PIPE.indexOf("const precededBy = previous;");
    /* Both lines sit before the first `continue`, or a skipped token would break the chain. */
    expect(PIPE.indexOf("previous = word.toLowerCase();")).toBeGreaterThan(at);
    expect(PIPE.indexOf("if (word.length < 3) continue;", at)).toBeGreaterThan(
      PIPE.indexOf("previous = word.toLowerCase();")
    );
  });
});
