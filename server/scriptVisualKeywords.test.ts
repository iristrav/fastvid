import { describe, expect, it } from "vitest";
import {
  buildRelevanceKeywordsFromIntent,
  buildSentenceIntentMap,
  buildSentenceKeywordMap,
  buildVisualIntentSegments,
  extractNarrationSentences,
  fallbackVisualIntent,
  fallbackVisualKeyword,
  intentSearchQueries,
  lookupBeatVisualIntent,
  lookupBeatVisualKeyword,
  mergeVisualIntentsIntoMetadata,
  mergeVisualKeywordsIntoMetadata,
  normalizeSentenceKey,
  parseVisualIntentsFromMetadata,
  parseVisualKeywordsFromMetadata,
  sanitizeVisualKeyword,
  splitBeatSentences,
} from "./scriptVisualKeywords";

describe("scriptVisualKeywords", () => {
  it("extracts narration sentences from markdown script", () => {
    const script = `# Test Title

## Opening
De ondernemer werkt laat door aan zijn nieuwe webshop.
De klant bekijkt verschillende producten op zijn telefoon.

## Body
Het team bespreekt de resultaten tijdens een vergadering.`;

    const sentences = extractNarrationSentences(script);
    expect(sentences).toHaveLength(3);
    expect(sentences[0]).toMatch(/ondernemer werkt laat/i);
    expect(sentences[1]).toMatch(/klant bekijkt/i);
    expect(sentences[2]).toMatch(/team bespreekt/i);
  });

  it("sanitizes keywords for stock search", () => {
    expect(sanitizeVisualKeyword("  Entrepreneur Working LAPTOP  ")).toBe("entrepreneur working laptop");
    expect(sanitizeVisualKeyword("success")).toBe("");
    expect(sanitizeVisualKeyword("growth strategy")).toBe("");
    expect(sanitizeVisualKeyword("online shopping smartphone")).toBe("online shopping smartphone");
  });

  it("builds lookup map with normalized sentence keys", () => {
    const entries = [
      { sentence: "De klant bekijkt producten.", keyword: "online shopping smartphone" },
    ];
    const map = buildSentenceKeywordMap(entries);
    expect(map.get(normalizeSentenceKey("  de klant bekijkt producten. "))).toBe(
      "online shopping smartphone"
    );
  });

  it("merges keywords into metadata without dropping existing fields", () => {
    const merged = mergeVisualKeywordsIntoMetadata(
      { title: "Test", tags: ["a"] },
      [{ sentence: "Line one.", keyword: "city skyline night" }]
    );
    expect(merged.title).toBe("Test");
    expect(merged.tags).toEqual(["a"]);
    expect(merged.visualKeywords).toEqual([
      { sentence: "Line one.", keyword: "city skyline night" },
    ]);
  });

  it("merges full visual intents into metadata", () => {
    const intent = {
      sentence: "Veel ondernemers verspillen uren per week aan handmatig werk.",
      visual_intent: "frustrated entrepreneur working late at laptop",
      primary_keyword: "frustrated entrepreneur laptop",
      secondary_keyword: "office worker overwhelmed",
      fallback_keyword: "busy business owner",
      scene_type: "office",
      priority_subject: "entrepreneur",
    };
    const merged = mergeVisualIntentsIntoMetadata({ title: "Test" }, [intent]);
    expect(merged.visualIntents).toEqual([intent]);
    expect(merged.visualKeywords).toEqual([
      { sentence: intent.sentence, keyword: "frustrated entrepreneur laptop" },
    ]);
  });

  it("parses visualIntents from stored metadata", () => {
    const parsed = parseVisualIntentsFromMetadata({
      visualIntents: [
        {
          sentence: "Veel ondernemers verspillen uren per week aan handmatig werk.",
          visual_intent: "frustrated entrepreneur working late at laptop",
          primary_keyword: "frustrated entrepreneur laptop",
          secondary_keyword: "office worker overwhelmed",
          fallback_keyword: "busy business owner",
          scene_type: "office",
          priority_subject: "entrepreneur",
        },
      ],
    });
    expect(parsed[0]?.primary_keyword).toBe("frustrated entrepreneur laptop");
    expect(parsed[0]?.scene_type).toBe("office");
  });

  it("parses visualKeywords from intents when visualIntents present", () => {
    const parsed = parseVisualKeywordsFromMetadata({
      visualIntents: [
        {
          sentence: "Amsterdam canals.",
          visual_intent: "amsterdam canal bikes timelapse",
          primary_keyword: "amsterdam canal bikes",
          secondary_keyword: "netherlands canal aerial",
          fallback_keyword: "dutch city canal",
          scene_type: "city",
          priority_subject: "amsterdam",
        },
      ],
    });
    expect(parsed).toEqual([{ sentence: "Amsterdam canals.", keyword: "amsterdam canal bikes" }]);
  });

  it("fallback intent produces searchable keywords for entrepreneur sentence", () => {
    const intent = fallbackVisualIntent(
      "Veel ondernemers verspillen uren per week aan handmatig werk."
    );
    expect(intent.primary_keyword.length).toBeGreaterThan(5);
    expect(intent.visual_intent.length).toBeGreaterThan(10);
    expect(intent.scene_type).toBe("office");
    expect(intentSearchQueries(intent).length).toBeGreaterThanOrEqual(2);
  });

  it("fallback avoids bare abstract terms", () => {
    const intent = fallbackVisualIntent("Het bedrijf groeide snel door strategie.");
    expect(intent.primary_keyword).not.toMatch(/^(success|growth|strategy|bedrijf)$/i);
    expect(intent.primary_keyword.length).toBeGreaterThan(5);
  });

  it("picks dominant intent when beat merges multiple sentences", () => {
    const intentMap = buildSentenceIntentMap([
      {
        sentence: "Het weer was grijs.",
        visual_intent: "cloudy grey sky over city",
        primary_keyword: "cloudy sky weather",
        secondary_keyword: "overcast city skyline",
        fallback_keyword: "grey weather broll",
        scene_type: "city",
        priority_subject: "sky",
      },
      {
        sentence: "In Amsterdam fietsten duizenden mensen door de regen.",
        visual_intent: "cyclists riding through rainy amsterdam street",
        primary_keyword: "amsterdam cyclists rain",
        secondary_keyword: "people cycling wet street",
        fallback_keyword: "netherlands cycling street",
        scene_type: "street",
        priority_subject: "cyclists",
      },
    ]);
    const merged =
      "Het weer was grijs. In Amsterdam fietsten duizenden mensen door de regen.";
    expect(lookupBeatVisualIntent(merged, intentMap)?.primary_keyword).toBe("amsterdam cyclists rain");
  });

  it("lookupBeatVisualKeyword still works via keyword map", () => {
    const map = buildSentenceKeywordMap([
      {
        sentence: "De ondernemer werkt laat door aan zijn nieuwe webshop.",
        keyword: "entrepreneur working laptop",
      },
    ]);
    expect(
      lookupBeatVisualKeyword("De ondernemer werkt laat door aan zijn nieuwe webshop.", map)
    ).toBe("entrepreneur working laptop");
  });

  it("buildRelevanceKeywordsFromIntent includes intent fields and beat text", () => {
    const intent = fallbackVisualIntent("De ondernemer werkt laat door aan zijn webshop.");
    const keywords = buildRelevanceKeywordsFromIntent(intent, intent.sentence, ["shop"], "Test title");
    expect(keywords).toEqual(expect.arrayContaining([intent.primary_keyword, "ondernemer", "shop"]));
  });

  it("buildVisualIntentSegments assigns cumulative timestamps", () => {
    const intent = fallbackVisualIntent("Eerste zin over treinen.");
    const segments = buildVisualIntentSegments(
      [
        { text: "Eerste zin.", holdSec: 4, visualIntent: intent },
        { text: "Tweede zin.", holdSec: 3.5 },
      ],
      12
    );
    expect(segments[0]).toMatchObject({ start_time: 12, end_time: 16 });
    expect(segments[1]).toMatchObject({ start_time: 16, end_time: 19.5 });
    expect(segments[0]?.keywords.length).toBeGreaterThan(0);
  });

  it("splitBeatSentences mirrors pipeline sentence splitting", () => {
    expect(splitBeatSentences("Eerste zin. Tweede zin!")).toEqual(["Eerste zin.", "Tweede zin!"]);
  });
});
