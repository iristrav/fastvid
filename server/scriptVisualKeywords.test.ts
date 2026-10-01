import { describe, expect, it } from "vitest";
import { buildSentenceIntentMap, beatVisualSearchSubjects, extractNarrationSentences, fallbackVisualIntent, intentSearchQueries, sanitizeVisualKeyword, mergeVisualIntentsIntoMetadata, mergeVisualKeywordsIntoMetadata, normalizeSentenceKey, parseVisualIntentsFromMetadata, beatVisualSearchSubjects, hydrateBeatScriptVisuals, resolveBeatScriptVisualAnchor, splitBeatSentences } from "./scriptVisualKeywords";

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

  it("fallback intent produces searchable keywords for entrepreneur sentence", () => {
    const intent = fallbackVisualIntent(
      "Veel ondernemers verspillen uren per week aan handmatig werk."
    );
    expect(intent.primary_keyword.length).toBeGreaterThan(5);
    expect(intent.visual_intent.length).toBeGreaterThan(10);
    expect(intent.scene_type).toBe("office");
    expect(intentSearchQueries(intent).length).toBeGreaterThanOrEqual(2);
  });

  it("hydrateBeatScriptVisuals fills searchQuery and visualDescription from script", () => {
    const beat = hydrateBeatScriptVisuals({
      text: "Amsterdam has more bikes than people, with dedicated cycling lanes everywhere.",
      searchQuery: "",
      powerWord: "",
      keywords: [],
    });
    expect(beat.searchQuery.length).toBeGreaterThan(5);
    expect(beat.powerWord).toBe(beat.searchQuery);
    expect(beat.visualDescription?.length ?? 0).toBeGreaterThan(4);
    expect(beat.keywords?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("resolveBeatScriptVisualAnchor returns at most two search subjects", () => {
    const anchor = resolveBeatScriptVisualAnchor(
      "Dutch cyclists cross a bridge while cars wait at a suburban intersection."
    );
    expect(anchor.searchSubjects.length).toBeLessThanOrEqual(2);
    expect(anchor.primarySubject.length).toBeGreaterThan(4);
  });

  it("beatVisualSearchSubjects returns at most two script-anchored queries", () => {
    const subjects = beatVisualSearchSubjects(
      "Amsterdam has more bikes than people, and cyclists have their own dedicated lanes."
    );
    expect(subjects.length).toBeGreaterThanOrEqual(1);
    expect(subjects.length).toBeLessThanOrEqual(2);
    expect(subjects[0]!.toLowerCase()).toMatch(/amsterdam|cycl|cycling|bike/);
  });

  it("fallback avoids bare abstract terms", () => {
    const intent = fallbackVisualIntent("Het bedrijf groeide snel door strategie.");
    expect(intent.primary_keyword).not.toMatch(/^(success|growth|strategy|bedrijf)$/i);
    expect(intent.primary_keyword.length).toBeGreaterThan(5);
  });

  it("splitBeatSentences mirrors pipeline sentence splitting", () => {
    expect(splitBeatSentences("Eerste zin. Tweede zin!")).toEqual(["Eerste zin.", "Tweede zin!"]);
  });
});
