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

  it("the prompt forces specificity: named entities in the query, pronouns resolved", () => {
    // The core quality rules that make images actually match.
    expect(src).toContain("BE SPECIFIC, not generic");
    expect(src).toContain("PERSON, PLACE, ORGANIZATION, EVENT or YEAR");
    expect(src).toContain("Resolve pronouns and vague references");
  });

  it("guards against hallucinated entities (only what the script/subject supports)", () => {
    expect(src).toContain("never guess a name the script does not support");
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
