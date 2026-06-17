import { describe, it, expect } from "vitest";
import {
  buildScriptLengthRefinePrompt,
  scriptStillOnTopic,
  checkScriptMeetsBudget,
  stripVisualTagsFromScript,
  getScriptLengthBudget,
} from "./scriptWriter";

describe("scriptStillOnTopic", () => {
  it("accepts narration that mentions the prompt subject", () => {
    const prompt = "Elon Musk: Tesla, SpaceX and the future of humanity";
    const script = `# Musk\n## Opening\nElon Musk built Tesla and SpaceX.`;
    expect(scriptStillOnTopic(prompt, script)).toBe(true);
  });

  it("rejects unrelated Salvator Mundi draft for a Musk prompt", () => {
    const prompt = "Elon Musk: Tesla, SpaceX and the future of humanity";
    const script = `# Art\n## Opening\nSalvator Mundi sold for $450 million. Leonardo da Vinci experts disagree.`;
    expect(scriptStillOnTopic(prompt, script)).toBe(false);
  });
});

describe("checkScriptMeetsBudget", () => {
  it("rejects scripts below minimum word count", () => {
    const budget = getScriptLengthBudget("8-10");
    const short = "## Opening\nThis is far too short for an eight minute documentary video.\n";
    const check = checkScriptMeetsBudget(short, budget);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain("incomplete");
  });
});

describe("stripVisualTagsFromScript", () => {
  it("removes inline and standalone visual tags", () => {
    const raw = "## Opening\nLine one.\n[VISUAL: rocket launch]\nLine two.";
    expect(stripVisualTagsFromScript(raw)).not.toMatch(/\[visual:/i);
    expect(stripVisualTagsFromScript(raw)).toContain("Line one");
    expect(stripVisualTagsFromScript(raw)).toContain("Line two");
  });
});

describe("buildScriptLengthRefinePrompt", () => {
  it("includes topic and the script body to revise", () => {
    const budget = getScriptLengthBudget("1");
    const script = "# Test\n## Opening\nHello world about Tesla.";
    const prompt = buildScriptLengthRefinePrompt(script, budget, 50, "Elon Musk Tesla");
    expect(prompt).toContain("Elon Musk Tesla");
    expect(prompt).toContain("SCRIPT TO REVISE");
    expect(prompt).toContain("Hello world about Tesla");
  });
});
