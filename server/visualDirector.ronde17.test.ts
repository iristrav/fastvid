import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { generateVisualDirectorPlan, type DirectorVideoContext } from "./visualDirector";

// RONDE 17 — "op welke woorden zoekt hij, en hoe laten we de beelden echt kloppen?"
//
// The Visual Director LLM turns each narration sentence into a `search_query` (3-6 English words)
// that drives all footage search. Production logs showed a bimodal VisionGate: ~half the beats
// scored 7-10 (good match) and ~95 beats scored a flat 0.0 (generic/off query -> irrelevant
// footage -> gray fallback). The director prompt forbade abstract concepts but never anchored the
// query to the documentary's real subject, so pronouns and vague references ("he", "the city",
// "that year") produced generic B-roll ("man giving orders") instead of matching footage ("Adolf
// Hitler bunker 1945").
//
// Fix: thread the video's subject (title + topic) into the director prompt so it resolves pronouns
// and bakes the real named entities (person/place/org/event/year) INTO each search_query. Optional
// and backward-compatible — no context reproduces the old behaviour.

const src = readFileSync(path.join(__dirname, "visualDirector.ts"), "utf8");

function codeOnly(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("RONDE 17 — the director prompt is entity-anchored and subject-aware", () => {
  it("exposes a DirectorVideoContext type and threads it through the plan entrypoint", () => {
    // Type-level: generateVisualDirectorPlan accepts an optional videoContext (compile-time check).
    const ctx: DirectorVideoContext = { title: "t", topic: "x" };
    expect(typeof generateVisualDirectorPlan).toBe("function");
    expect(ctx.title).toBe("t");
  });

  it("the prompt builder takes videoContext and emits a DOCUMENTARY SUBJECT block when present", () => {
    const code = codeOnly(src);
    expect(code).toContain("function buildDirectorBatchPrompt(");
    expect(code).toContain("videoContext?: DirectorVideoContext");
    expect(code).toContain("DOCUMENTARY SUBJECT:");
  });

  it("the prompt forces specificity: named entities in the query, no bare pronouns", () => {
    // The core quality rules that make images actually match.
    expect(src).toContain("BE SPECIFIC, not generic");
    expect(src).toContain("PERSON, PLACE, ORGANIZATION, EVENT or YEAR");
    expect(src).toContain("Never emit a query built on a bare pronoun");
  });

  it("RONDE 91 §3 — the pronoun rule no longer tells the model to substitute a name", () => {
    // RONDE 17 asked the model to resolve "he"/"the leader"/"that year" to a named entity FROM
    // THE DOCUMENTARY SUBJECT. That instruction is the title leak §8 forbids, written into the
    // prompt: the subject is a claim about the video, not about this sentence, and a beat that
    // says "she addressed the nation" does not become a beat about Eva Braun because the title
    // mentions her. A pronoun now yields a described scene, not a borrowed name.
    expect(src).not.toContain("Resolve pronouns and vague references");
    expect(src).toContain("do NOT substitute a name from the documentary subject");
  });

  it("guards against hallucinated entities — every content word must be IN the sentence", () => {
    // RONDE 17's wording ("never guess a name the script does not support") left "clearly
    // implied" as an opening, and an implication is a guess with better manners. RONDE 91
    // closes it: stated in this sentence, or discarded before it reaches a provider.
    expect(src).not.toContain("clearly implied by the sentence/subject");
    expect(src).toContain("EVERY content word in search_query must appear in THIS SENTENCE");
    expect(src).toContain("a guess is discarded before it reaches a provider");
  });

  it("keeps the existing anti-abstract / anti-narration guarantees", () => {
    expect(src).toContain("not abstract concepts (no: success, growth, strategy)");
    expect(src).toContain("Do NOT search on voice-over words");
  });

  it("empty/absent context reproduces the old behaviour (no subject block)", () => {
    // The context block is conditional on a non-empty topicLine.
    const code = codeOnly(src);
    expect(code).toContain("const contextBlock = topicLine");
    expect(code).toContain('? `DOCUMENTARY SUBJECT:');
    expect(code).toContain(': ""');
  });
});
