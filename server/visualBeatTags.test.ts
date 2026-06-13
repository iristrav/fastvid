import { describe, expect, it } from "vitest";
import {
  extractPrimaryGeoSearchTag,
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

  it("extracts geo voice label with spoken match text", () => {
    const terms = extractVoiceLabelTerms("Hitler trok naar Berlijn in 1933.");
    const berlin = terms.find((t) => t.label.includes("BERLIJ"));
    const hitler = terms.find((t) => t.label.includes("HITLER"));
    expect(berlin?.searchTags).toEqual(expect.arrayContaining(["berlin", "germany"]));
    expect(berlin?.matchText?.toLowerCase()).toBe("berlijn");
    expect(hitler).toBeDefined();
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
