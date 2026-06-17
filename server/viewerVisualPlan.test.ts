import { describe, expect, it } from "vitest";
import { filterCandidatesByArchiveTier } from "./curatedMediaSourcing";
import type { CuratedCandidatePick } from "./curatedMediaSourcing";
import {
  applyLiteralViewerVisualToBeat,
  inferLiteralViewerVisual,
  isAbstractVisualText,
  isConcreteViewerVisual,
  literalVisualSearchTags,
} from "./viewerVisualPlan";

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

  it("applyLiteralViewerVisualToBeat sets search from literal visual", () => {
    const beat = {
      text: "Companies adopt AI automation across Europe.",
      searchQuery: "ai automation",
      powerWord: "automation",
    };
    const literal = applyLiteralViewerVisualToBeat(beat, "Tech documentary");
    expect(beat.visualDescription).toBe(literal.description);
    expect(beat.searchQuery).toBe(literal.searchQuery);
    expect(beat.searchQuery).not.toMatch(/^ai automation$/i);
    expect(literalVisualSearchTags(literal).length).toBeGreaterThan(0);
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

  it("filters archive candidates by exact then semantic tiers", () => {
    const picks: CuratedCandidatePick[] = [
      {
        asset: {
          id: 1,
          title: "Person laptop office work",
          tags: ["laptop", "office", "person", "desk"],
          mediaType: "video",
          storageUrl: "a1",
        },
        score: 80,
        semantic: {
          relevanceScore: 85,
          tier: 1,
          tierLabel: "laptop office",
          embeddingSimilarity: 0.7,
          matchedEntities: ["laptop"],
        },
      },
      {
        asset: {
          id: 2,
          title: "Generic city skyline",
          tags: ["city", "skyline"],
          mediaType: "video",
          storageUrl: "a2",
        },
        score: 40,
        semantic: {
          relevanceScore: 35,
          tier: 5,
          tierLabel: "generic",
          embeddingSimilarity: 0.2,
          matchedEntities: [],
        },
      },
    ];
    const tags = ["person", "laptop", "office", "desk"];
    const exact = filterCandidatesByArchiveTier(picks, "exact", tags);
    expect(exact.some((p) => p.asset.id === 1)).toBe(true);
    expect(exact.some((p) => p.asset.id === 2)).toBe(false);
    const related = filterCandidatesByArchiveTier(picks, "related", tags);
    expect(related.length).toBeGreaterThanOrEqual(1);
  });
});
