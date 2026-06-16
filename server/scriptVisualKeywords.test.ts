import { describe, expect, it } from "vitest";
import {
  buildSentenceKeywordMap,
  extractNarrationSentences,
  fallbackVisualKeyword,
  lookupBeatVisualKeyword,
  lookupSentenceKeyword,
  mergeVisualKeywordsIntoMetadata,
  normalizeSentenceKey,
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
    expect(lookupSentenceKeyword("  de klant bekijkt producten. ", map)).toBe(
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

  it("parses visualKeywords from stored metadata", () => {
    const parsed = parseVisualKeywordsFromMetadata({
      visualKeywords: [{ sentence: "Amsterdam canals.", keyword: "amsterdam canal bikes" }],
    });
    expect(parsed).toEqual([
      { sentence: "Amsterdam canals.", keyword: "amsterdam canal bikes" },
    ]);
  });

  it("fallback avoids bare abstract terms", () => {
    const kw = fallbackVisualKeyword("Het bedrijf groeide snel door strategie.");
    expect(kw).not.toMatch(/^(success|growth|strategy|bedrijf)$/i);
    expect(kw.length).toBeGreaterThan(5);
  });

  it("normalizeSentenceKey is stable", () => {
    expect(normalizeSentenceKey("  Hello   World. ")).toBe("hello world.");
  });

  it("picks dominant keyword when beat merges multiple sentences", () => {
    const map = buildSentenceKeywordMap([
      { sentence: "Het weer was grijs.", keyword: "cloudy sky weather" },
      {
        sentence: "In Amsterdam fietsten duizenden mensen door de regen.",
        keyword: "amsterdam cyclists rain",
      },
    ]);
    const merged =
      "Het weer was grijs. In Amsterdam fietsten duizenden mensen door de regen.";
    expect(lookupBeatVisualKeyword(merged, map)).toBe("amsterdam cyclists rain");
  });

  it("matches keyword when beat text is a split fragment of one sentence", () => {
    const map = buildSentenceKeywordMap([
      {
        sentence: "De ondernemer werkt laat door aan zijn nieuwe webshop.",
        keyword: "entrepreneur working laptop",
      },
    ]);
    expect(
      lookupBeatVisualKeyword("De ondernemer werkt laat door aan zijn nieuwe webshop.", map)
    ).toBe("entrepreneur working laptop");
    expect(lookupBeatVisualKeyword("De ondernemer werkt laat door", map)).toBe(
      "entrepreneur working laptop"
    );
  });

  it("splitBeatSentences mirrors pipeline sentence splitting", () => {
    expect(splitBeatSentences("Eerste zin. Tweede zin!")).toEqual(["Eerste zin.", "Tweede zin!"]);
  });
});
