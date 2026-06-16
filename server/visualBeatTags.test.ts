import { describe, expect, it } from "vitest";
import {
  extractBeatGeoPlaceTags,
  extractPrimaryGeoSearchTag,
  extractPrimaryVisualAnchor,
  extractSceneSearchTags,
  extractVisualSearchTags,
  extractVoiceLabelTerms,
  inferVideoVisualTopic,
  isWrongGeoForBeat,
  isWwiiWarArchiveAsset,
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

  it("extracts salient tokens for any topic sentence", () => {
    expect(extractPrimaryVisualAnchor("The Titanic struck an iceberg in the Atlantic.")).toContain("titanic");
    expect(extractVisualSearchTags("SpaceX launched Starship from Texas")).toEqual(
      expect.arrayContaining(["spacex", "starship", "texas"])
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

  it("detects geography urban topic from Netherlands vs US title", () => {
    const title = "Why the Netherlands is the Opposite of the U.S.";
    expect(inferVideoVisualTopic(title)).toBe("geography_urban");
    expect(extractBeatGeoPlaceTags("In the Netherlands, cycling is normal.")).toEqual(
      expect.arrayContaining(["netherlands", "amsterdam", "holland"])
    );
    expect(extractBeatGeoPlaceTags("American cities rely on cars.")).toEqual(
      expect.arrayContaining(["america", "usa", "united states"])
    );
  });

  it("flags wrong-country archive clips for geo beats", () => {
    const nlBeatTags = extractBeatGeoPlaceTags("The Netherlands invests in bike lanes.");
    const charlotteClip = {
      title: "Charlotte skyline Bank of America Stadium",
      tags: ["charlotte", "usa", "city skyline", "stadium"],
    };
    const amsterdamClip = {
      title: "Amsterdam canal bikes and trams",
      tags: ["amsterdam", "netherlands", "canal", "cycling"],
    };
    expect(isWrongGeoForBeat(charlotteClip, nlBeatTags)).toBe(true);
    expect(isWrongGeoForBeat(amsterdamClip, nlBeatTags)).toBe(false);
  });

  it("detects geography urban topic from Berlin vs US city title", () => {
    const title = "Why Berlin is the Opposite of Every US City";
    expect(inferVideoVisualTopic(title)).toBe("geography_urban");
    const tags = extractVisualSearchTags("Berlin has excellent public transit.", title);
    expect(tags).toEqual(expect.arrayContaining(["berlin city", "urban berlin", "public transport"]));
    expect(tags.some((t) => t.includes("hitler") || t === "germany")).toBe(false);
  });

  it("flags WWII archive assets for geography filtering", () => {
    expect(
      isWwiiWarArchiveAsset({
        title: "Hitler speech at Nuremberg rally",
        tags: ["hitler", "nazi", "propaganda"],
        mediaType: "video",
      })
    ).toBe(true);
    expect(
      isWwiiWarArchiveAsset({
        title: "Berlin skyline modern architecture",
        tags: ["berlin", "city", "skyline"],
        mediaType: "video",
      })
    ).toBe(false);
  });
});
