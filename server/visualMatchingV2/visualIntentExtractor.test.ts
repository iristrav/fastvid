import { describe, expect, it, vi } from "vitest";
import { extractVisualIntentsForScene } from "./visualIntentExtractor";
import type { VideoContext } from "./types";

vi.mock("../_core/llm", () => ({ invokeLLM: vi.fn() }));
vi.mock("../db", () => ({
  createVisualIntentCache: vi.fn().mockResolvedValue(undefined),
  getVisualIntentCacheByIntentHash: vi.fn().mockResolvedValue(undefined),
}));

const videoContext: VideoContext = {
  videoId: "1",
  topicHash: "hash",
  era: "2024",
  setting: "tech conference",
  keySubjects: ["Elon Musk"],
  recurringLocations: ["stage"],
  visualStyleNotes: "cinematic",
  cacheHit: false,
};

describe("Visual Intent Extractor — Phase 3 entity extraction", () => {
  it("extracts the richer entity fields (brands/companies/people/countries/events/objects) alongside the original fields", async () => {
    const { invokeLLM } = await import("../_core/llm");
    vi.mocked(invokeLLM).mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              intents: [
                {
                  beatId: "b0",
                  visualSubject: "Elon Musk",
                  visualAction: "speaking on stage",
                  visualLocation: "conference hall",
                  visualTime: "present day",
                  historicalContext: "AI product launch",
                  emotion: "confident",
                  visualDescription: "Elon Musk speaking into a microphone on a conference stage",
                  primaryKeyword: "Elon Musk keynote",
                  secondaryKeyword: "Elon Musk stage",
                  negativeKeywords: ["cartoon"],
                  secondaryVisualSubjects: ["audience"],
                  objects: ["microphone"],
                  brands: ["Grok"],
                  companies: ["xAI"],
                  people: ["Elon Musk"],
                  countries: ["United States"],
                  events: ["Grok 5 announcement"],
                },
              ],
            }),
          },
        },
      ],
    } as never);

    const [intent] = await extractVisualIntentsForScene(
      [{ beatId: "b0", spokenText: "Elon Musk announced Grok 5" }],
      videoContext
    );

    expect(intent).toBeDefined();
    expect(intent!.companies).toEqual(["xAI"]);
    expect(intent!.brands).toEqual(["Grok"]);
    expect(intent!.people).toEqual(["Elon Musk"]);
    expect(intent!.objects).toEqual(["microphone"]);
    expect(intent!.countries).toEqual(["United States"]);
    expect(intent!.events).toEqual(["Grok 5 announcement"]);
    // Original fields stay intact — this is additive, not a breaking change.
    expect(intent!.visualSubject).toBe("Elon Musk");
    expect(intent!.primaryKeyword).toBe("Elon Musk keynote");
  });

  it("backfills empty entity arrays for cache rows written before Phase 3's richer schema", async () => {
    const { getVisualIntentCacheByIntentHash } = await import("../db");
    vi.mocked(getVisualIntentCacheByIntentHash).mockResolvedValue({
      intentJson: {
        visualSubject: "old cached subject",
        visualAction: "action",
        visualLocation: "location",
        visualTime: "time",
        historicalContext: "context",
        emotion: "neutral",
        visualDescription: "desc",
        primaryKeyword: "kw1",
        secondaryKeyword: "kw2",
        negativeKeywords: [],
        // no secondaryVisualSubjects/objects/brands/companies/people/countries/events — old row
      },
    } as never);

    const [intent] = await extractVisualIntentsForScene(
      [{ beatId: "b0", spokenText: "some text" }],
      videoContext
    );

    expect(intent!.brands).toEqual([]);
    expect(intent!.companies).toEqual([]);
    expect(intent!.people).toEqual([]);
    expect(intent!.visualSubject).toBe("old cached subject");
  });
});
