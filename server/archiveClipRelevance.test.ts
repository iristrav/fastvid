import { describe, expect, it } from "vitest";
import {
  archiveSubjectFilterEnabled,
  buildArchiveSubjectPrompt,
  hasArchiveSubjectContext,
} from "./archiveClipRelevance";

describe("archiveClipRelevance", () => {
  it("hasArchiveSubjectContext is true when name or tags exist", () => {
    expect(hasArchiveSubjectContext({ archiveName: "WOII", nicheTags: [] })).toBe(true);
    expect(hasArchiveSubjectContext({ archiveName: "", nicheTags: ["titanic"] })).toBe(true);
    expect(hasArchiveSubjectContext({ archiveName: "  ", nicheTags: [] })).toBe(false);
  });

  it("buildArchiveSubjectPrompt includes archive name and tags", () => {
    const prompt = buildArchiveSubjectPrompt({
      archiveName: "Medische geschiedenis",
      archiveDescription: "Injecties en vaccinaties",
      nicheTags: ["injectie", "vaccin"],
    });
    expect(prompt).toContain("Medische geschiedenis");
    expect(prompt).toContain("Injecties en vaccinaties");
    expect(prompt).toContain("injectie");
    expect(prompt).toContain("matchesArchiveSubject = false");
  });

  it("archiveSubjectFilterEnabled is false without API key", () => {
    const orig = process.env.BUILT_IN_FORGE_API_KEY;
    const origLlm = process.env.LLM_API_KEY;
    delete process.env.BUILT_IN_FORGE_API_KEY;
    delete process.env.LLM_API_KEY;
    expect(archiveSubjectFilterEnabled()).toBe(false);
    if (orig === undefined) delete process.env.BUILT_IN_FORGE_API_KEY;
    else process.env.BUILT_IN_FORGE_API_KEY = orig;
    if (origLlm === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = origLlm;
  });
});
