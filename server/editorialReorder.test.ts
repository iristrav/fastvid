import { describe, expect, it } from "vitest";
import { buildPrompt, type ClipMeta } from "./editorialReorder";

function clip(overrides: Partial<ClipMeta> = {}): ClipMeta {
  return {
    originalIndex: 0,
    beatIndex: 0,
    beatText: "Beat text",
    shotType: "wide",
    visualDescription: "a wide shot",
    duration: 4,
    isFallback: false,
    isCard: false,
    ...overrides,
  };
}

describe("editorialReorder — cold open prompt rule (Phase 9)", () => {
  it("tells the editor to lead with the most striking shot for the opening scene", () => {
    const prompt = buildPrompt([clip()], "Scene text", "My Documentary", 20, true);
    expect(prompt).toContain("VIDEO'S OPENING SCENE");
    expect(prompt).toContain("lead with the single most visually striking or emotionally charged clip");
    expect(prompt).not.toContain("1. Open with a wide/establishing shot if one exists");
  });

  it("keeps the original wide/establishing-first rule for every other scene", () => {
    const prompt = buildPrompt([clip()], "Scene text", "My Documentary", 20, false);
    expect(prompt).toContain("1. Open with a wide/establishing shot if one exists");
    expect(prompt).not.toContain("VIDEO'S OPENING SCENE");
  });

  it("keeps every other numbered rule unchanged regardless of opening-scene status", () => {
    const opening = buildPrompt([clip()], "Scene text", "My Documentary", 20, true);
    const nonOpening = buildPrompt([clip()], "Scene text", "My Documentary", 20, false);
    for (const rule of [
      "2. Prefer wide → medium → close-up progression",
      "3. Never place two CARD clips adjacent",
      "8. Build emotional arc",
    ]) {
      expect(opening).toContain(rule);
      expect(nonOpening).toContain(rule);
    }
  });
});
