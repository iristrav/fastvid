import { describe, expect, it } from "vitest";
import {
  extractPrimaryGeoSearchTag,
  extractPrimaryVisualAnchor,
  extractSceneSearchTags,
  extractVisualSearchTags,
  extractVoiceLabelTerms,
  termStartInBeat,
} from "./visualBeatTags";

describe("visualBeatTags", () => {
  it("maps Duitsland to germany search tags", () => {
    const text = "In Duitsland begon alles te veranderen.";
    expect(extractPrimaryGeoSearchTag(text)).toBe("germany");
    expect(extractVisualSearchTags(text)).toEqual(
      expect.arrayContaining(["germany", "german", "deutschland", "berlin"])
    );
  });

  it("extracts bunker scene tags for archive search", () => {
    const text = "Hitler zat in zijn bunker en gaf orders.";
    expect(extractSceneSearchTags(text)).toEqual(
      expect.arrayContaining(["bunker", "fuhrerbunker", "hitler bunker"])
    );
    expect(extractPrimaryVisualAnchor(text)).toBe("hitler bunker");
  });

  it("extracts place label with spoken match text (no person names as labels)", () => {
    const terms = extractVoiceLabelTerms("Hitler trok naar Berlijn in 1933.");
    const berlin = terms.find((t) => t.label.includes("BERLIJ"));
    expect(berlin?.searchTags).toEqual(expect.arrayContaining(["berlin", "germany"]));
    expect(berlin?.matchText?.toLowerCase()).toBe("berlijn");
    expect(terms.some((t) => t.label.includes("HITLER"))).toBe(false);
  });

  it("does not surface stock slugs or title words as labels", () => {
    const terms = extractVoiceLabelTerms("De situatie escaleerde snel.");
    expect(terms.some((t) => t.label === "GERMANY")).toBe(false);
    expect(terms.some((t) => t.label === "HITLER")).toBe(false);
  });

  it("times label when the place name is spoken later in the beat", () => {
    const beatText = "Eerst was het rustig, maar in Duitsland veranderde alles snel.";
    const beatStart = 4;
    const beatDur = 8;
    const start = termStartInBeat(beatText, "DUITSland", beatStart, beatDur, "Duitsland");
    expect(start).toBeGreaterThan(beatStart + 2);
    expect(start).toBeLessThan(beatStart + beatDur - 0.5);
  });
});
