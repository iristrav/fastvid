/**
 * RONDE 103 phases 9–13, 19–20, 23 — ask the narrow question first.
 *
 * A production render sent 1667 provider queries to fill roughly twenty slots. The reason is not
 * that twenty slots need 1667 questions; it is that the broad questions were being asked first.
 * "Berlin" returns everything ever shot in Berlin, so every one of its results costs a download
 * and a judgement to throw away, and the shot the beat is actually about — "Hitler Berlin bunker
 * 1945" — is somewhere below the fold.
 *
 * The ladder is a reading of what the beat proved, not a new source of terms. That distinction is
 * the point of half the tests here: a rung may not contain a word the beat did not say, or the
 * whole provenance contract RONDE 90 built is undone by a helper that looked harmless.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  buildBeatSearchLadder,
  buildPrioritisedQueries,
  emptyQueryContext,
  formatSearchLadder,
  provenToken,
  type VerifiedQueryContext,
} from "./searchQueryContract";
import { typedQueryLadder, typedQueryPrefix } from "./videoPipeline";

/** A context whose tokens all carry the beat text as their evidence. */
function ctxOf(
  beatText: string,
  parts: Partial<Record<keyof VerifiedQueryContext, Array<[string, string]>>>
): VerifiedQueryContext {
  const ctx = emptyQueryContext(beatText);
  for (const [field, entries] of Object.entries(parts)) {
    if (!Array.isArray(entries)) continue;
    (ctx[field as "persons"] as ReturnType<typeof provenToken>[]) = entries.map(([term, type]) =>
      provenToken(term, type as "person", "beat_text", beatText)
    );
  }
  return ctx;
}

const BERLIN_TEXT =
  "Hitler directed the defence of Berlin from the bunker during the battle of Berlin in 1945.";
const BERLIN = ctxOf(BERLIN_TEXT, {
  persons: [["Hitler", "person"]],
  places: [["Berlin", "place"]],
  events: [["battle of Berlin", "event"]],
  years: [["1945", "year"]],
});

describe("RONDE 103 phases 9–13 — the four rungs", () => {
  it("TEST 1 — a beat that proves an event gets a level-4 rung", () => {
    /**
     * Only the levels this beat actually supports appear — there is no padding, which is the
     * whole difference between a ladder and a list of guesses. This beat names a person, so the
     * priority builder emits no bare-event and no bare-person query (a verb without its subject
     * and a name without its place are both forms earlier rounds removed), and its ladder is
     * therefore 4 then 2.
     */
    expect(buildBeatSearchLadder(BERLIN).map((r) => r.level)).toEqual([4, 2]);
    const l4 = buildBeatSearchLadder(BERLIN).find((r) => r.level === 4)!;
    expect(l4.queries.map((q) => q.query)).toContain("Hitler battle of Berlin 1945");
  });

  it("TEST 2 — the rungs come back most specific FIRST", () => {
    const levels = buildBeatSearchLadder(BERLIN).map((r) => r.level);
    expect(levels).toEqual([...levels].sort((a, b) => b - a));
  });

  it("TEST 3 — level 4 is an event WITH its context", () => {
    const l4 = buildBeatSearchLadder(BERLIN).find((r) => r.level === 4)!;
    for (const q of l4.queries) {
      const types = new Set(q.tokens.map((t) => t.type));
      expect(types.has("event")).toBe(true);
      expect(types.size).toBeGreaterThan(1);
    }
  });

  it("TEST 4 — level 1 is a bare entity, and nothing else", () => {
    // A beat that names a person and nothing else is the case that HAS a level-1 rung.
    const text = "Hitler spoke for barely a minute.";
    const ladder = buildBeatSearchLadder(ctxOf(text, { persons: [["Hitler", "person"]] }));
    const l1 = ladder.find((r) => r.level === 1)!;
    expect(l1).toBeDefined();
    for (const q of l1.queries) {
      const content = q.tokens.filter((t) => t.type !== "technical");
      expect(content).toHaveLength(1);
    }
  });

  it("TEST 4b — level 3 is the event on its own, when the beat names nobody", () => {
    const text = "The battle of Berlin ended in May.";
    const ladder = buildBeatSearchLadder(
      ctxOf(text, { events: [["battle of Berlin", "event"]] })
    );
    const l3 = ladder.find((r) => r.level === 3)!;
    expect(l3).toBeDefined();
    expect(l3.queries.map((q) => q.query)).toContain("battle of Berlin");
  });

  it("TEST 5 — a beat that proves no event has no level 4 or 3 to offer", () => {
    const text = "Hitler was in Berlin in 1945.";
    const ladder = buildBeatSearchLadder(
      ctxOf(text, {
        persons: [["Hitler", "person"]],
        places: [["Berlin", "place"]],
        years: [["1945", "year"]],
      })
    );
    expect(ladder.map((r) => r.level)).not.toContain(4);
    expect(ladder.map((r) => r.level)).not.toContain(3);
    expect(ladder.map((r) => r.level)).toContain(2);
  });

  it("TEST 6 — a beat that proves nothing gets no ladder, not a padded one", () => {
    expect(buildBeatSearchLadder(emptyQueryContext(""))).toEqual([]);
  });

  it("TEST 7 — a rung never contains a word the beat did not say", () => {
    const said = BERLIN_TEXT.toLowerCase();
    for (const rung of buildBeatSearchLadder(BERLIN)) {
      for (const q of rung.queries) {
        for (const token of q.tokens) {
          if (token.type === "technical") continue;
          expect(said, `"${token.term}" is not in the beat`).toContain(token.term.toLowerCase());
        }
      }
    }
  });

  it("TEST 8 — every rung's queries are the SAME objects the priority builder produced", () => {
    // The ladder groups; it does not build. Anything else would be a second query builder.
    const all = buildPrioritisedQueries(BERLIN);
    const flat = buildBeatSearchLadder(BERLIN).flatMap((r) => r.queries);
    expect(flat.map((q) => q.query).sort()).toEqual(all.map((q) => q.query).sort());
    expect(flat).toHaveLength(all.length);
  });

  it("TEST 9 — priority order is preserved INSIDE each rung", () => {
    for (const rung of buildBeatSearchLadder(BERLIN)) {
      const priorities = rung.queries.map((q) => q.priority);
      expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    }
  });

  it("TEST 10 — the descent is loggable, one line per rung", () => {
    const ladder = buildBeatSearchLadder(BERLIN);
    const lines = formatSearchLadder(ladder);
    expect(lines).toHaveLength(ladder.length);
    expect(lines[0]).toContain("level 4");
    expect(lines.at(-1)).toContain("level 2");
    for (const line of lines) expect(line).toContain("[SearchLadder]");
  });
});

describe("RONDE 103 phase 9 — what the pipeline actually asks first", () => {
  it("a beat that supports a narrow question leads with it, not with the broad one", () => {
    const flat = typedQueryPrefix(BERLIN_TEXT);
    const ladder = typedQueryLadder(BERLIN_TEXT);
    expect(ladder.length).toBeGreaterThan(0);
    const firstLadder = ladder[0]!.queries[0]!;
    // The ladder's lead is at least as specific as the priority list's lead.
    const words = (s: string): number => s.split(/\s+/).length;
    expect(words(firstLadder)).toBeGreaterThanOrEqual(words(flat[0] ?? ""));
  });

  it("the level-ordered list holds exactly the queries the flat list holds", () => {
    const flat = new Set(typedQueryPrefix(BERLIN_TEXT));
    const laddered = typedQueryLadder(BERLIN_TEXT).flatMap((r) => r.queries);
    expect(new Set(laddered)).toEqual(flat);
  });

  it("the two-query cap in buildBeatVisualQueryList now spends its slots on the narrow rungs", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const idx = src.indexOf("export function buildBeatVisualQueryList(");
    const body = src.slice(idx, idx + 2200);
    expect(body).toContain("const typed = typedQueryLead(beatText, scenePersons);");
    // Still two — the change is WHICH two, not how many. Phase 23 is about asking fewer broad
    // questions, not about asking more questions.
    expect(body).not.toContain("typedQueryPrefix(beatText, { scenePersons }).slice(0, 2)");

    // And the selection descends one rung at a time, so slot 2 is the NEXT question rather than
    // a second variant of the first — a beat whose narrow question misses keeps its fallback.
    const lead = src.indexOf("export function typedQueryLead(");
    expect(lead).toBeGreaterThan(-1);
    const leadBody = src.slice(lead, src.indexOf("\n}", lead));
    expect(leadBody).toContain("for (const rung of ladder) {");
    expect(leadBody).toContain("const pick = rung.queries.find((q) => !out.includes(q));");
    expect(leadBody).toContain("if (out.length >= 2) break;");
  });
});

describe("RONDE 103 phase 10 — extractBeatSubject stops guessing by position", () => {
  const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const body = (() => {
    const i = src.indexOf("function extractBeatSubject(");
    return src.slice(i, src.indexOf("\nexport function scriptStockSearchQueries(", i));
  })();

  it("the positional fallback is gone, not extended with more stop words", () => {
    /**
     * RONDE 71 replaced "the first three words of four letters or more" because it produced
     * "berlin under constant" and "hitler received military" — and then kept it as the fallback.
     * A beat whose every concrete word was filtered out is exactly the beat whose leftovers are
     * grammar, so running the discredited rule only when the good one fails is worse, not safer.
     */
    expect(body).not.toContain('clean.split(/\\s+/).slice(0, 2).join(" ")');
    expect(body).toContain("if (ranked.length === 0) {");
    expect(body).toContain('return "";');
  });

  it("the fix is structural — no new stop word was added to paper over it", () => {
    // The commentary says so explicitly, and the code shows it: the branch returns rather than
    // filtering harder.
    expect(body).toContain("Deliberately NOT another stop word");
  });

  it("both callers treat an empty subject as a cascade, not as a crash", () => {
    expect(src).toContain("const primaryQuery = subject;");
    expect(src).toContain("const sceneSubject = sceneText ? extractBeatSubject(sceneText, persons) : \"\";");
    // And the end of that cascade asks for nothing rather than for "documentary".
    expect(src).toContain("  return [];\n}");
  });
});
