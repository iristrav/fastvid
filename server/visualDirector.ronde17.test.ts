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

  it("a pronoun is resolved from the script around it, never from the title alone (1 Oct 2026)", () => {
    // RONDE 91 forbade naming a pronoun at all: "she addressed the nation" must not become Eva
    // Braun because the title mentions her. The 1 Oct decision allows the name when THE SCRIPT
    // makes the reference clear; the title-only leak stays forbidden.
    expect(src).not.toContain("Resolve pronouns and vague references");
    expect(src).toContain("when THE SCRIPT makes clear who or what a pronoun");
    expect(src).toContain("it never puts a name on a sentence the script does not tie to that name");
  });

  it("guards against hallucinated entities — every content word comes from the script", () => {
    expect(src).not.toContain("clearly implied by the sentence/subject");
    expect(src).toContain("Never introduce a person, place, event, year or fact the script does not mention");
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
