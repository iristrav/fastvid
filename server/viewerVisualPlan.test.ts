import { describe, expect, it } from "vitest";

import type { CuratedCandidatePick } from "./curatedMediaSourcing";
import { inferLiteralViewerVisual, isAbstractVisualText, isConcreteViewerVisual } from "./viewerVisualPlan";

describe("viewerVisualPlan", () => {
  it("maps AI automation narration to person at laptop", () => {
    const literal = inferLiteralViewerVisual(
      "Steeds meer bedrijven investeren in AI-automatisering.",
      "Future of Work"
    );
    expect(isAbstractVisualText(literal.searchQuery)).toBe(false);
    expect(literal.description.toLowerCase()).toMatch(/laptop|person|office|desk/);
    expect(literal.searchQuery).toMatch(/laptop|person|office/);
  });

  it("maps supply chain narration to port containers", () => {
    const literal = inferLiteralViewerVisual(
      "If this supply chain hub fails, the whole country feels it.",
      "Why This One US City Could Shut Down the Entire Country"
    );
    expect(literal.searchQuery).toMatch(/port|container|shipping|freight/i);
    expect(literal.description.toLowerCase()).toMatch(/port|container|crane|shipping/);
  });

  it("rejects abstract-only labels", () => {
    expect(isAbstractVisualText("AI automation")).toBe(true);
    expect(isAbstractVisualText("innovation strategy")).toBe(true);
    expect(isConcreteViewerVisual("A person working on a laptop at a desk.")).toBe(true);
  });

  it("prefers Visual Director plan over narration keyword rules", () => {
    const directorIntent = {
      sentence: "Steeds meer bedrijven investeren in AI-automatisering.",
      visual_intent: "Shipping containers being loaded at a busy freight port with cranes.",
      visual_description: "Shipping containers being loaded at a busy freight port with cranes.",
      search_query: "shipping port containers cranes",
      primary_keyword: "shipping port containers cranes",
      secondary_keyword: "port freight",
      fallback_keyword: "port broll",
      scene_type: "industrial",
      priority_subject: "port",
    };
    const literal = inferLiteralViewerVisual(
      directorIntent.sentence,
      "Supply Chain",
      directorIntent
    );
    expect(literal.searchQuery).toMatch(/port|container|shipping/i);
    expect(literal.searchQuery).not.toMatch(/^person laptop/i);
    expect(literal.description.toLowerCase()).toMatch(/port|container|crane/);
  });
});
